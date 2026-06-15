import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import {
  pollAutoTriggersOnce,
  RecentMessageSet,
} from '../../../src/bot/auto-trigger-poller';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache';
import type { PendingQueue } from '../../../src/bot/pending-queue';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('auto trigger poller', () => {
  it('polls recent chat messages and queues matching alarm cards in the source topic', async () => {
    const list = vi.fn(async () => ({ data: { items: [alarmItem()] } }));
    const h = harness(list, 'topic');

    const queued = await pollAutoTriggersOnce(h);

    expect(queued).toBe(1);
    expect(list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'chat',
        container_id: 'oc_alarm',
        card_msg_content_type: 'user_card_content',
        only_thread_root_messages: false,
        sort_type: 'ByCreateTimeAsc',
        page_size: 10,
      }),
    });
    expect(h.pending.push).toHaveBeenCalledTimes(1);
    const [scope, msg] = h.pending.push.mock.calls[0] as [string, NormalizedMessage];
    expect(scope).toBe('oc_alarm:omt_alarm');
    expect(msg.messageId).toBe('om_alarm');
    expect(msg.content).toContain('请自动分析');
    expect(msg.content).toContain('Service throws panic');
    expect(msg.rawContentType).toBe('interactive');
  });

  it('deduplicates already-seen polled messages', async () => {
    const list = vi.fn(async () => ({ data: { items: [alarmItem()] } }));
    const seen = new RecentMessageSet();
    const h = harness(list, 'group', seen);

    expect(await pollAutoTriggersOnce(h)).toBe(1);
    expect(await pollAutoTriggersOnce(h)).toBe(0);

    expect(h.pending.push).toHaveBeenCalledTimes(1);
  });

  it('continues through paginated list results', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { items: [], has_more: true, page_token: 'next' } })
      .mockResolvedValueOnce({ data: { items: [alarmItem({ message_id: 'om_page2' })] } });
    const h = harness(list, 'group');

    expect(await pollAutoTriggersOnce(h)).toBe(1);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1]?.[0]).toEqual({
      params: expect.objectContaining({
        page_token: 'next',
      }),
    });
    expect(h.pending.push).toHaveBeenCalledTimes(1);
  });
});

function harness(
  list: ReturnType<typeof vi.fn>,
  chatMode: 'group' | 'topic',
  seen = new RecentMessageSet(),
): {
  channel: LarkChannel;
  controls: Controls;
  pending: PendingQueue & { push: ReturnType<typeof vi.fn> };
  chatModeCache: ChatModeCache;
  seen: RecentMessageSet;
  now: () => number;
} {
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app },
    access: {
      allowedChats: ['oc_alarm'],
    },
    preferences: {
      autoTriggers: [
        {
          name: 'argos',
          chatIds: ['oc_alarm'],
          senderIds: ['cli_argos'],
          senderTypes: ['bot'],
          rawContentTypes: ['interactive'],
          contentIncludes: ['服务:', '报警时间:'],
          contentAnyIncludes: ['Argos报警值守', 'Service throws panic'],
          prompt: '请自动分析',
          polling: true,
          pollIntervalSeconds: 10,
          pollLookbackSeconds: 60,
          pollPageSize: 10,
        },
      ],
    },
  });
  const channel = {
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      im: {
        v1: {
          message: { list },
        },
      },
    },
    fetchRawMessage: vi.fn(async () => []),
  } as unknown as LarkChannel;
  const pending = {
    push: vi.fn(() => 1),
  } as unknown as PendingQueue & { push: ReturnType<typeof vi.fn> };
  const chatModeCache = {
    resolve: vi.fn(async () => chatMode),
  } as unknown as ChatModeCache;
  const controls = {
    profile: 'codex',
    profileConfig,
    cfg: profileConfig,
    ownerRefreshState: 'unknown',
    refreshOwner: vi.fn(),
    restart: vi.fn(),
    exit: vi.fn(),
    configPath: '/tmp/config.json',
    processId: 'proc',
  } as unknown as Controls;
  return {
    channel,
    controls,
    pending,
    chatModeCache,
    seen,
    now: () => Date.UTC(2026, 5, 15, 10, 40, 0),
  };
}

function alarmItem(overrides: Record<string, unknown> = {}): unknown {
  return {
    message_id: 'om_alarm',
    root_id: 'om_alarm',
    thread_id: 'omt_alarm',
    msg_type: 'interactive',
    create_time: String(Date.UTC(2026, 5, 15, 10, 39, 30)),
    chat_id: 'oc_alarm',
    sender: {
      id: 'cli_argos',
      id_type: 'open_id',
      sender_type: 'app',
      sender_name: 'Argos',
    },
    body: {
      content: JSON.stringify({
        schema: '2.0',
        body: {
          elements: [
            {
              tag: 'markdown',
              content:
                '[warning] Service throws panic\n服务: data.ecom.aigc_gateway\n报警时间: 2026-06-15 07:43:29\nArgos报警值守',
            },
          ],
        },
      }),
    },
    ...overrides,
  };
}
