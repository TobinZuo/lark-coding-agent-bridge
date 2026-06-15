import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { NormalizedMessage } from '@larksuite/channel';
import { buildLarkChannelEnv } from '../agent/lark-channel-env';
import type { AppPaths } from '../config/app-paths';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';
import { normalizeIncomingMessage, normalizedMessageFromIncoming } from './auto-answer';

const DEFAULT_EVENT_KEY = 'im.message.receive_v1';
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface LarkEventConsumer {
  stop(): Promise<void>;
}

export interface StartLarkEventConsumerOptions {
  cfg: AppConfig;
  appPaths?: Pick<
    AppPaths,
    'rootDir' | 'profile' | 'configFile' | 'larkCliConfigDir' | 'larkCliSourceConfigFile'
  >;
  configPath?: string;
  botOpenId?: string;
  onMessage(msg: NormalizedMessage): Promise<void> | void;
}

export async function startLarkEventConsumer(
  opts: StartLarkEventConsumerOptions,
): Promise<LarkEventConsumer | undefined> {
  const consumer = opts.cfg.larkBot?.eventConsumer;
  if (consumer?.enabled !== true) return undefined;

  const eventKey = consumer.eventKey?.trim() || DEFAULT_EVENT_KEY;
  const command = consumer.command?.trim() || 'lark-cli';
  const child = spawnProcess(command, ['event', 'consume', eventKey, '--as', 'bot'], {
    env: mergeProcessEnv(process.env, buildConsumerEnv(opts)),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const controller = new LarkEventConsumerProcess({
    child,
    eventKey,
    readyTimeoutMs: consumer.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    botOpenId: opts.botOpenId,
    onMessage: opts.onMessage,
  });
  try {
    await controller.start();
  } catch (err) {
    await controller.stop().catch(() => {
      /* best effort cleanup */
    });
    throw err;
  }
  return controller;
}

export function normalizedMessageFromEventConsumerPayload(
  payload: unknown,
  botOpenId?: string,
): NormalizedMessage | undefined {
  const direct = normalizeIncomingMessage(payload, botOpenId);
  if (direct) return normalizedMessageFromIncoming(direct, { botOpenId });
  if (!isRecord(payload)) return undefined;

  const messageId = stringValue(payload.message_id) || stringValue(payload.messageId);
  const chatId = stringValue(payload.chat_id) || stringValue(payload.chatId);
  const senderId = stringValue(payload.sender_id) || stringValue(payload.senderOpenId);
  if (!messageId || !chatId || !senderId) return undefined;
  if (botOpenId && senderId === botOpenId) return undefined;

  const messageType = stringValue(payload.message_type) || stringValue(payload.messageType) || 'text';
  const rawContent = payload.content ?? payload.raw_content ?? '';
  const synthetic = {
    event: {
      sender: {
        sender_id: { open_id: senderId },
        sender_type: payload.sender_type ?? payload.senderType ?? 'user',
      },
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: stringValue(payload.chat_type) || stringValue(payload.chatType) || 'group',
        message_type: messageType,
        content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
        ...(payload.create_time || payload.createTime
          ? { create_time: stringValue(payload.create_time) || stringValue(payload.createTime) }
          : {}),
        ...(payload.thread_id || payload.threadId
          ? { thread_id: stringValue(payload.thread_id) || stringValue(payload.threadId) }
          : {}),
        ...(payload.root_id || payload.rootId
          ? { root_id: stringValue(payload.root_id) || stringValue(payload.rootId) }
          : {}),
        ...(payload.parent_id || payload.parentId
          ? { parent_id: stringValue(payload.parent_id) || stringValue(payload.parentId) }
          : {}),
        ...(Array.isArray(payload.mentions) ? { mentions: payload.mentions } : {}),
      },
    },
  };
  const incoming = normalizeIncomingMessage(synthetic, botOpenId);
  return incoming ? normalizedMessageFromIncoming(incoming, { botOpenId }) : undefined;
}

class LarkEventConsumerProcess implements LarkEventConsumer {
  private stopping = false;
  private ready = false;
  private readonly stdout: ReturnType<typeof createInterface>;
  private readonly stderr: ReturnType<typeof createInterface>;

  constructor(private readonly opts: {
    child: ChildProcess;
    eventKey: string;
    readyTimeoutMs: number;
    botOpenId?: string;
    onMessage(msg: NormalizedMessage): Promise<void> | void;
  }) {
    this.stdout = createInterface({ input: opts.child.stdout! });
    this.stderr = createInterface({ input: opts.child.stderr! });
  }

  async start(): Promise<void> {
    const { child, eventKey, readyTimeoutMs } = this.opts;
    child.once('error', (err) => {
      log.fail('event-consumer', err, { eventKey });
    });
    child.once('exit', (code, signal) => {
      this.stdout.close();
      this.stderr.close();
      const fields = { eventKey, code, signal };
      if (this.stopping) log.info('event-consumer', 'stopped', fields);
      else if (code === 0) log.warn('event-consumer', 'exited', fields);
      else log.warn('event-consumer', 'failed', fields);
    });

    this.stdout.on('line', (line) => void this.handleStdoutLine(line));
    this.stderr.on('line', (line) => this.handleStderrLine(line));

    await this.waitUntilReady(readyTimeoutMs);
    log.info('event-consumer', 'ready', { eventKey });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stdout.close();
    this.stderr.close();
    const { child } = this.opts;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill('SIGTERM');
    await Promise.race([
      once(child, 'exit').then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_STOP_TIMEOUT_MS)),
    ]);
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const { child, eventKey } = this.opts;
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`lark event consumer did not become ready for ${eventKey}`));
      }, timeoutMs);
      const check = (): void => {
        if (!this.ready) return;
        cleanup();
        resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`lark event consumer exited before ready: code=${code ?? '-'} signal=${signal ?? '-'}`));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.stderr.off('line', check);
        child.off('exit', onExit);
      };
      this.stderr.on('line', check);
      child.once('exit', onExit);
      check();
    });
  }

  private async handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed) as unknown;
    } catch {
      log.warn('event-consumer', 'bad-json', { sample: trimmed.slice(0, 200) });
      return;
    }
    const msg = normalizedMessageFromEventConsumerPayload(payload, this.opts.botOpenId);
    if (!msg) {
      log.info('event-consumer', 'ignored-event');
      return;
    }
    try {
      await this.opts.onMessage(msg);
    } catch (err) {
      log.fail('event-consumer', err, { step: 'on-message' });
    }
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.includes(`[event] ready event_key=${this.opts.eventKey}`)) {
      this.ready = true;
      return;
    }
    log.info('event-consumer', 'stderr', { line: trimmed.slice(0, 500) });
  }
}

function buildConsumerEnv(opts: StartLarkEventConsumerOptions): NodeJS.ProcessEnv {
  const appPaths = opts.appPaths;
  if (!appPaths) return {};
  return buildLarkChannelEnv({
    profile: appPaths.profile,
    rootDir: appPaths.rootDir,
    configPath: opts.configPath ?? appPaths.configFile,
    larkCliConfigDir: appPaths.larkCliConfigDir,
    larkCliSourceConfigFile: appPaths.larkCliSourceConfigFile,
  });
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
