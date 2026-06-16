import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter, type FakeAgentEvents } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  updatedCards: Array<{ messageId: string; card: object }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId?: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<unknown>;
  updateCard(messageId: string, card: object): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('updates a managed markdown card and leaves the IM queue unblocked when the agent fails', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.updatedCards.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(h.channel.stream).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(2);
    expect(h.channel.sent[0]?.content).toHaveProperty('card');
    expect(cardText(h.channel.updatedCards[0]?.card)).toContain('agent 失败');
    expect(cardText(h.channel.updatedCards[0]?.card)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.updatedCards.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(cardText(h.channel.updatedCards[0]?.card)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('does not call channel.stream for markdown replies', async () => {
    const h = await createHarness({
      events: [[
        { type: 'text', delta: 'final answer' },
        { type: 'done', terminationReason: 'normal' },
      ]],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.updatedCards.length > 0);

    expect(h.channel.stream).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.content).toHaveProperty('card');
    expect(cardText(h.channel.updatedCards.at(-1)?.card)).toContain('final answer');
  });

  it('sends a final fallback reply when the managed markdown final update fails', async () => {
    const h = await createHarness({
      events: [[
        { type: 'text', delta: 'final answer' },
        { type: 'done', terminationReason: 'normal' },
      ]],
      updateCard: vi.fn(async () => {
        throw new Error('update failed');
      }),
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(
      () => h.channel.sent.some((msg) => markdownText(msg.content).includes('final answer')),
      3000,
    );

    expect(h.channel.sent[0]?.content).toHaveProperty('card');
    expect(lastMarkdown(h.channel)).toContain('final answer');
  });

  it('falls back to a final markdown reply when the initial managed card send fails', async () => {
    const h = await createHarness({
      events: [[
        { type: 'text', delta: 'final answer' },
        { type: 'done', terminationReason: 'normal' },
      ]],
      failInitialSend: true,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('final answer');
    expect(h.channel.updatedCards).toHaveLength(0);
  });

  it('updates the managed markdown card after terminal success', async () => {
    const h = await createHarness({
      events: [[
        { type: 'text', delta: 'final answer' },
        { type: 'done', terminationReason: 'normal' },
      ]],
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.channel.updatedCards.length > 0);

    expect(h.channel.updatedCards.at(-1)?.messageId).toBe('om_sent_1');
    const summary = (h.channel.updatedCards.at(-1)?.card as {
      config?: { summary?: { content?: string } };
    } | undefined)?.config?.summary?.content;
    expect(summary).toContain('final answer');
    const finalCard = JSON.stringify(h.channel.updatedCards.at(-1)?.card);
    expect(finalCard).toContain('final answer');
    expect(finalCard).not.toContain('正在调用工具');
    expect(h.channel.sent).toHaveLength(1);
    expect(h.channel.sent[0]?.content).toHaveProperty('card');
  });
});

type SendFn = (
  chatId: string,
  content: unknown,
  options?: unknown,
) => Promise<{ messageId?: string }>;

type UpdateCardFn = (messageId: string, card: object) => Promise<void>;

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  send?: SendFn;
  updateCard?: UpdateCardFn;
  failInitialSend?: boolean;
  events?: FakeAgentEvents;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  send?: SendFn;
  updateCard?: UpdateCardFn;
  failInitialSend?: boolean;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const updatedCards: FakeLarkChannel['updatedCards'] = [];
  let nextMessage = 1;
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    updatedCards,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    send: options.send ?? (async (chatId, content, sendOptions) => {
      if (options.failInitialSend && nextMessage === 1) {
        nextMessage += 1;
        throw new Error('send failed');
      }
      sent.push({ chatId, content, options: sendOptions });
      return { messageId: `om_sent_${nextMessage++}` };
    }),
    stream: vi.fn(async () => {
      await new Promise<void>(() => {});
    }),
    updateCard: options.updateCard ?? (async (messageId, card) => {
      updatedCards.push({ messageId, card });
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

function markdownText(content: unknown): string {
  return ((content as { markdown?: unknown } | undefined)?.markdown as string | undefined) ?? '';
}

function cardText(card: unknown): string {
  const pieces: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      pieces.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(card);
  return pieces.join('\n');
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
