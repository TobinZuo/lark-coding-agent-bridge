import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage as HttpIncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppConfig, LarkBotListenerConfig } from '../config/schema';
import { resolveSecretInput } from '../config/secret-resolver';
import type { AppPaths } from '../config/app-paths';
import { log } from '../core/logger';
import { normalizeIncomingMessage, normalizedMessageFromIncoming } from './auto-answer';

const DEFAULT_WEBHOOK_PATH = '/lark/events';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface WebhookListener {
  host: string;
  port: number;
  path: string;
  url: string;
  stop(): Promise<void>;
}

export interface StartWebhookListenerOptions {
  cfg: AppConfig;
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>;
  botOpenId?: string;
  onMessage(msg: NormalizedMessage): Promise<void> | void;
}

export interface ProcessWebhookPayloadOptions {
  headers?: IncomingHttpHeaders;
  body: Buffer | string;
  listener: LarkBotListenerConfig;
  verificationToken?: string;
  encryptKey?: string;
  botOpenId?: string;
}

export interface ProcessWebhookPayloadResult {
  status: number;
  response: unknown;
  message?: NormalizedMessage;
}

export async function startWebhookListener(
  opts: StartWebhookListenerOptions,
): Promise<WebhookListener | undefined> {
  const listener = opts.cfg.larkBot?.listener;
  if (listener?.enabled !== true) return undefined;

  const secrets = await resolveListenerSecrets(opts.cfg, listener, opts.appPaths);
  const server = createServer((req, res) => {
    void handleRequest({
      req,
      res,
      cfg: opts.cfg,
      listener,
      secrets,
      botOpenId: opts.botOpenId,
      onMessage: opts.onMessage,
    }).catch((err) => {
      log.fail('webhook', err);
      sendJson(res, 500, { ok: false, error: 'internal_error' });
    });
  });
  const host = listener.host || process.env.LARK_CHANNEL_WEBHOOK_HOST || DEFAULT_HOST;
  const port = listener.port ?? portFromEnv() ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const boundPort = boundServerPort(server, port);
  const path = listener.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  log.info('webhook', 'listening', {
    host,
    port: boundPort,
    path,
  });
  return {
    host,
    port: boundPort,
    path,
    url: `http://${publicHostForUrl(host)}:${boundPort}${path}`,
    stop: () => closeServer(server),
  };
}

async function handleRequest(input: {
  req: HttpIncomingMessage;
  res: ServerResponse;
  cfg: AppConfig;
  listener: LarkBotListenerConfig;
  secrets: ListenerSecrets;
  botOpenId?: string;
  onMessage(msg: NormalizedMessage): Promise<void> | void;
}): Promise<void> {
  const { req, res, listener, secrets } = input;
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true, listener: true });
    return;
  }
  const webhookPath = listener.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  if (req.method !== 'POST' || path !== webhookPath) {
    sendJson(res, 404, { ok: false, error: 'not_found' });
    return;
  }

  const body = await readBody(req, listener.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const result = processWebhookPayload({
    headers: req.headers,
    body,
    listener,
    verificationToken: secrets.verificationToken,
    encryptKey: secrets.encryptKey,
    botOpenId: input.botOpenId,
  });
  if (result.message) await input.onMessage(result.message);
  sendJson(res, result.status, result.response);
}

export function processWebhookPayload(input: ProcessWebhookPayloadOptions): ProcessWebhookPayloadResult {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body, 'utf8');
  const secrets: ListenerSecrets = {
    ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
    ...(input.encryptKey ? { encryptKey: input.encryptKey } : {}),
  };
  if (!verifySignature(input.headers ?? {}, body, secrets.encryptKey)) {
    return { status: 401, response: { ok: false, error: 'invalid_signature' } };
  }

  const payload = decodePayload(body, secrets.encryptKey);
  if (!verifyToken(payload, secrets.verificationToken)) {
    return { status: 401, response: { ok: false, error: 'invalid_token' } };
  }

  const challenge = challengeFromPayload(payload);
  if (challenge) return { status: 200, response: { challenge } };

  const eventType = eventTypeFromPayload(payload);
  if (eventType !== 'im.message.receive_v1') {
    return { status: 200, response: { ok: true, ignored: true } };
  }

  const incoming = normalizeIncomingMessage(payload, input.botOpenId);
  if (!incoming) {
    return { status: 200, response: { ok: true, ignored: true } };
  }

  return {
    status: 200,
    response: { ok: true },
    message: normalizedMessageFromIncoming(incoming, { botOpenId: input.botOpenId }),
  };
}

interface ListenerSecrets {
  verificationToken?: string;
  encryptKey?: string;
}

async function resolveListenerSecrets(
  cfg: AppConfig,
  listener: LarkBotListenerConfig,
  appPaths?: Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>,
): Promise<ListenerSecrets> {
  const resolve = async (value: LarkBotListenerConfig['verificationToken']): Promise<string | undefined> => {
    if (!value) return undefined;
    return resolveSecretInput(value, cfg.secrets, cfg.accounts.app.id, appPaths);
  };
  return {
    verificationToken: await resolve(listener.verificationToken),
    encryptKey: await resolve(listener.encryptKey),
  };
}

function eventTypeFromPayload(payload: unknown): string {
  if (!isRecord(payload)) return '';
  return (
    stringValue(recordValue(payload, 'event_type')) ||
    stringValue(recordValue(recordValue(payload, 'header'), 'event_type')) ||
    stringValue(recordValue(payload, 'type'))
  );
}

function challengeFromPayload(payload: unknown): string {
  if (!isRecord(payload)) return '';
  return stringValue(payload.challenge);
}

function verifyToken(payload: unknown, verificationToken: string | undefined): boolean {
  if (!verificationToken) return true;
  if (!isRecord(payload)) return false;
  const token =
    stringValue(payload.token) ||
    stringValue(recordValue(recordValue(payload, 'header'), 'token'));
  return token === verificationToken;
}

function verifySignature(headers: IncomingHttpHeaders, body: Buffer, encryptKey: string | undefined): boolean {
  const signature = headerValue(headers, 'x-lark-signature') || headerValue(headers, 'x-tt-signature');
  if (!signature) return true;
  if (!encryptKey) return false;
  const timestamp = headerValue(headers, 'x-lark-request-timestamp') || headerValue(headers, 'x-tt-request-timestamp') || '';
  const nonce = headerValue(headers, 'x-lark-request-nonce') || headerValue(headers, 'x-tt-request-nonce') || '';
  const expected = createHash('sha256')
    .update(timestamp)
    .update(nonce)
    .update(encryptKey)
    .update(body)
    .digest('hex');
  return safeEqualHex(signature, expected);
}

function decodePayload(body: Buffer, encryptKey: string | undefined): unknown {
  const parsed = JSON.parse(body.toString('utf8')) as unknown;
  if (!encryptKey || !isRecord(parsed) || typeof parsed.encrypt !== 'string') return parsed;
  const decrypted = decryptFeishuPayload(parsed.encrypt, encryptKey);
  return JSON.parse(decrypted) as unknown;
}

function decryptFeishuPayload(encrypted: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function readBody(req: HttpIncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(payload)}\n`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function portFromEnv(): number | undefined {
  const raw = process.env.LARK_CHANNEL_WEBHOOK_PORT;
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(65535, Math.floor(parsed)) : undefined;
}

function boundServerPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

function publicHostForUrl(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recordValue(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
