import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import {
  PollerState,
  pollLarkMessagesOnce,
} from '../../../src/bot/message-poller';
import type { Controls } from '../../../src/commands';
import type { AppConfig } from '../../../src/config/schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('lark message poller', () => {
  it('ignores messages created before this bridge start', async () => {
    const onMessage = vi.fn();
    const h = harness({
      startedAtMs: 1_700_000_000_000,
      items: [alarmItem({ create_time: '1699999999000' })],
      onMessage,
    });

    expect(await pollLarkMessagesOnce(h)).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('polls configured chats and emits new interactive alert cards', async () => {
    const onMessage = vi.fn();
    const list = vi.fn(async () => ({ data: { items: [alarmItem()] } }));
    const fetchRawMessage = vi.fn(async () => [alarmItem({
      body: {
        content: JSON.stringify({
          schema: '2.0',
          body: { elements: [{ tag: 'markdown', content: 'Service throws panic\n告警卡片' }] },
        }),
      },
    })]);
    const h = harness({
      startedAtMs: 1_700_000_000_000,
      list,
      fetchRawMessage,
      onMessage,
    });

    expect(await pollLarkMessagesOnce(h)).toBe(1);

    expect(list).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'chat',
        container_id: 'oc_alarm',
        sort_type: 'ByCreateTimeAsc',
        card_msg_content_type: 'user_card_content',
        only_thread_root_messages: false,
      }),
    });
    expect(fetchRawMessage).toHaveBeenCalledWith('om_alarm', { cardContentType: 'user_card_content' });
    const msg = onMessage.mock.calls[0]?.[0] as NormalizedMessage;
    expect(msg).toMatchObject({
      messageId: 'om_alarm',
      chatId: 'oc_alarm',
      senderId: 'ou_argos',
      rawContentType: 'interactive',
      threadId: 'omt_alarm',
    });
    expect(msg.content).toContain('Service throws panic');
  });

  it('deduplicates overlap results within the current process', async () => {
    const onMessage = vi.fn();
    const list = vi.fn(async () => ({ data: { items: [alarmItem()] } }));
    const h = harness({
      startedAtMs: 1_700_000_000_000,
      list,
      onMessage,
    });

    expect(await pollLarkMessagesOnce(h)).toBe(1);
    expect(await pollLarkMessagesOnce(h)).toBe(0);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('warms up newly-enabled chats without replaying existing messages', async () => {
    const onMessage = vi.fn();
    const h = harness({
      startedAtMs: 1_700_000_000_000,
      items: [alarmItem()],
      onMessage,
      primeChat: false,
    });

    expect(await pollLarkMessagesOnce(h)).toBe(0);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('processes messages created after a newly enabled poller boundary', async () => {
    const onMessage = vi.fn();
    const h = harness({
      startedAtMs: 1_700_000_000_000,
      items: [
        alarmItem({ message_id: 'om_before', create_time: '1700000030000' }),
        alarmItem({ message_id: 'om_after', create_time: '1700000050000' }),
      ],
      onMessage,
      primeChat: false,
      cfg: {
        accounts: { app },
        larkBot: {
          poller: {
            enabled: true,
            enabledAtMs: 1_700_000_040_000,
            chatIds: ['oc_alarm'],
            intervalMs: 10_000,
            overlapMs: 120_000,
            maxLookbackMs: 600_000,
            pageSize: 10,
          },
        },
      },
    });

    expect(await pollLarkMessagesOnce(h)).toBe(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect((onMessage.mock.calls[0]?.[0] as NormalizedMessage).messageId).toBe('om_after');
  });

  it('honors leaderId for two-machine deployments', async () => {
    const prev = process.env.LARK_CHANNEL_INSTANCE_ID;
    process.env.LARK_CHANNEL_INSTANCE_ID = 'machine-b';
    try {
      const onMessage = vi.fn();
      const h = harness({
        startedAtMs: 1_700_000_000_000,
        items: [alarmItem()],
        onMessage,
        cfg: {
          accounts: { app },
          larkBot: {
            poller: {
              enabled: true,
              chatIds: ['oc_alarm'],
              leaderId: 'machine-a',
            },
          },
        },
      });

      expect(await pollLarkMessagesOnce(h)).toBe(0);
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LARK_CHANNEL_INSTANCE_ID;
      else process.env.LARK_CHANNEL_INSTANCE_ID = prev;
    }
  });
});

function harness(input: {
  startedAtMs: number;
  items?: unknown[];
  list?: ReturnType<typeof vi.fn>;
  fetchRawMessage?: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
  cfg?: AppConfig;
  primeChat?: boolean;
}): Parameters<typeof pollLarkMessagesOnce>[0] {
  const list = input.list ?? vi.fn(async () => ({ data: { items: input.items ?? [] } }));
  const fetchRawMessage = input.fetchRawMessage ?? vi.fn(async () => []);
  const cfg = input.cfg ?? {
    accounts: { app },
    larkBot: {
      poller: {
        enabled: true,
        chatIds: ['oc_alarm'],
        intervalMs: 10_000,
        overlapMs: 120_000,
        maxLookbackMs: 600_000,
        pageSize: 10,
      },
    },
  };
  const state = new PollerState(input.startedAtMs);
  if (input.primeChat !== false) state.initChat('oc_alarm', input.startedAtMs);
  return {
    channel: {
      botIdentity: { openId: 'ou_bot', name: 'Bridge' },
      rawClient: {
        im: {
          v1: {
            message: { list },
          },
        },
      },
      fetchRawMessage,
    } as unknown as LarkChannel,
    controls: {
      profile: 'codex',
      cfg,
      profileConfig: cfg,
    } as unknown as Controls,
    botOpenId: 'ou_bot',
    onMessage: input.onMessage,
    state,
    now: () => input.startedAtMs + 100_000,
  };
}

function alarmItem(overrides: Record<string, unknown> = {}): unknown {
  return {
    message_id: 'om_alarm',
    chat_id: 'oc_alarm',
    root_id: 'om_alarm',
    thread_id: 'omt_alarm',
    msg_type: 'interactive',
    create_time: '1700000050000',
    sender: {
      id: 'ou_argos',
      id_type: 'open_id',
      sender_type: 'app',
      sender_name: 'Argos',
    },
    body: {
      content: JSON.stringify({
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: '告警卡片' }] },
      }),
    },
    ...overrides,
  };
}
