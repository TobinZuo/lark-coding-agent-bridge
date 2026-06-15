import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  AutoAnswerRuntime,
  extractCardText,
  matchTriggerRule,
  normalizeIncomingMessage,
} from '../../../src/bot/auto-answer';
import type { AppConfig, LarkBotTriggerRule } from '../../../src/config/schema';

describe('auto-answer bot rules', () => {
  it('normalizes Feishu interactive message callbacks', () => {
    const payload = messagePayload({
      content: {
        schema: '2.0',
        header: { title: { content: 'P0 报警' } },
        body: { elements: [{ tag: 'markdown', content: 'error rate > 10%' }] },
      },
    });

    const msg = normalizeIncomingMessage(payload, 'ou_bot');

    expect(msg).toMatchObject({
      messageId: 'om_alarm',
      chatId: 'oc_alarm',
      chatType: 'group',
      senderOpenId: 'ou_alert_bot',
      messageType: 'interactive',
      plainText: expect.stringContaining('error rate'),
    });
    expect(msg?.cardJson).toMatchObject({ schema: '2.0' });
  });

  it('matches card text and json paths', () => {
    const msg = normalizeIncomingMessage(
      messagePayload({
        content: {
          data: { template_id: 'tpl_alarm' },
          body: { elements: [{ tag: 'markdown', content: '服务报警: 5xx spike' }] },
        },
      }),
    );
    if (!msg) throw new Error('expected normalized message');

    const rule: LarkBotTriggerRule = {
      id: 'alarm-card',
      chatIds: ['oc_alarm'],
      messageTypes: ['interactive'],
      templateIds: ['tpl_alarm'],
      cardMatchers: [
        { path: '$text', operator: 'regex', value: '报警|alarm' },
        { path: 'data.template_id', operator: 'equals', value: 'tpl_alarm' },
      ],
    };

    expect(matchTriggerRule(rule, msg)).toBe(true);
    expect(extractCardText(msg.cardJson)).toContain('服务报警');
  });

  it('injects the rule prompt and dedupes repeated auto runs', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      larkBot: {
        dedupeTtlMs: 60_000,
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            agentProfile: 'codex',
            promptTemplate: '请分析报警',
          },
        ],
      },
    };

    const normalized = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ content: '数据库报警' }] } }),
      rawContentType: 'interactive',
    });

    const skipped = runtime.matchMessage(cfg, normalized, undefined, 'claude');
    const first = runtime.matchMessage(cfg, normalized, undefined, 'codex');
    const second = runtime.matchMessage(cfg, normalized, undefined, 'codex');

    expect(skipped).toBeUndefined();
    expect(first?.message.content).toContain('请分析报警');
    expect(first?.message.mentionedBot).toBe(true);
    expect(second).toBeUndefined();
  });
});

function messagePayload(input: { content: unknown }): unknown {
  return {
    schema: '2.0',
    header: {
      event_type: 'im.message.receive_v1',
      token: 'token',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_alert_bot' },
        sender_type: 'app',
      },
      message: {
        message_id: 'om_alarm',
        chat_id: 'oc_alarm',
        chat_type: 'group',
        message_type: 'interactive',
        content: JSON.stringify(input.content),
        create_time: '1000',
      },
    },
  };
}

function normalizedMessage(input: {
  content: string;
  rawContentType: string;
}): NormalizedMessage {
  return {
    messageId: 'om_alarm',
    chatId: 'oc_alarm',
    chatType: 'group',
    senderId: 'ou_alert_bot',
    content: '数据库报警',
    rawContentType: input.rawContentType,
    resources: [],
    mentionedBot: false,
    raw: {
      sender: {
        sender_id: { open_id: 'ou_alert_bot' },
        sender_type: 'app',
      },
      message: {
        content: input.content,
      },
    },
  } as unknown as NormalizedMessage;
}
