import type { NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_TRIGGER_PROMPT,
  matchAutoTrigger,
  withAutoTriggerPrompt,
} from '../../../src/bot/auto-trigger';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

describe('auto trigger matcher', () => {
  it('matches an interactive alarm card from a configured sender and chat', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
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
          },
        ],
      },
    });

    const match = matchAutoTrigger(alarmMessage(), cfg);

    expect(match?.ruleName).toBe('argos');
    expect(match?.prompt).toBe(DEFAULT_AUTO_TRIGGER_PROMPT);
  });

  it('uses raw card JSON when the rendered message content is sparse', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        autoTriggers: [
          {
            rawContentTypes: ['interactive'],
            contentIncludes: ['Service throws panic'],
          },
        ],
      },
    });

    const msg = alarmMessage({ content: '[interactive card]' });

    expect(matchAutoTrigger(msg, cfg)?.ruleName).toBe('auto-trigger-1');
  });

  it('does not match disabled rules or messages from the bridge bot itself', () => {
    const cfg = createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: { app },
      preferences: {
        autoTriggers: [
          {
            enabled: false,
            rawContentTypes: ['interactive'],
            contentIncludes: ['Service throws panic'],
          },
          {
            senderIds: ['ou_bot'],
            rawContentTypes: ['interactive'],
            contentIncludes: ['Service throws panic'],
          },
        ],
      },
    });

    expect(matchAutoTrigger(alarmMessage({ senderId: 'ou_bot' }), cfg, {
      botOpenId: 'ou_bot',
    })).toBeUndefined();
  });

  it('prepends the auto trigger prompt to the queued message content', () => {
    const msg = alarmMessage({ content: '原始告警内容' });
    const queued = withAutoTriggerPrompt(msg, {
      rule: {},
      ruleName: 'argos',
      prompt: '请自动排查',
    });

    expect(queued.content).toBe('请自动排查\n\n原始告警内容');
    expect(queued.messageId).toBe(msg.messageId);
  });
});

function alarmMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'om_alarm',
    chatId: 'oc_alarm',
    chatType: 'group',
    senderId: 'cli_argos',
    senderName: 'Argos',
    content: '[warning] Service throws panic\n服务: data.ecom.aigc_gateway\n报警时间: 2026-06-15 07:43:29\nArgos报警值守',
    rawContentType: 'interactive',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    raw: {
      sender: {
        sender_type: 'app',
      },
      message: {
        content: JSON.stringify({
          schema: '2.0',
          body: {
            elements: [
              {
                tag: 'markdown',
                content: '[warning] Service throws panic\n服务: data.ecom.aigc_gateway\n报警时间: 2026-06-15 07:43:29',
              },
            ],
          },
        }),
      },
    },
    ...overrides,
  } as unknown as NormalizedMessage;
}
