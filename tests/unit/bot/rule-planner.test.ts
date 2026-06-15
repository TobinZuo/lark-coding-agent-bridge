import { describe, expect, it } from 'vitest';
import {
  buildRulePlannerPrompt,
  parseRulePlannerText,
} from '../../../src/bot/rule-planner';

const request = {
  instruction: '监听这个群的告警卡片并自动分析',
  chatId: 'oc_current',
  chatType: 'group' as const,
  senderId: 'ou_admin',
  messageId: 'om_config',
  profile: 'codex',
};

describe('external auto-answer rule planner', () => {
  it('builds a prompt that delegates planning to the configured skill', () => {
    const prompt = buildRulePlannerPrompt({
      enabled: true,
      skill: 'lark-listener-configurator',
    }, request);

    expect(prompt).toContain('lark-listener-configurator');
    expect(prompt).toContain('当前 chatId: oc_current');
    expect(prompt).toContain(request.instruction);
    expect(prompt).toContain('"promptTemplate"');
  });

  it('parses and sanitizes a planner JSON draft', () => {
    const result = parseRulePlannerText(
      [
        '```json',
        JSON.stringify({
          rule: {
            id: 'payment-card',
            chatIds: ['oc_other'],
            messageTypes: ['interactive', 'unknown'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '支付失败' }],
            promptTemplate: 'Use foo-debug skill. Analyze the matched card only.',
            replyInThread: true,
            cooldownMs: 300000,
            settleMs: 60000,
          },
          poller: {
            intervalMs: 1000,
            pageSize: 999,
          },
          summary: {
            trigger: '支付失败卡片',
            analysis: 'foo-debug skill',
            reply: '话题下',
          },
        }),
        '```',
      ].join('\n'),
      request,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.draft.rule).toMatchObject({
      id: 'payment-card',
      chatIds: ['oc_current'],
      messageTypes: ['interactive'],
      replyInThread: true,
    });
    expect(result.draft.poller).toMatchObject({
      intervalMs: 5000,
      pageSize: 50,
    });
    expect(result.draft.summary.analysis).toBe('foo-debug skill');
  });

  it('rejects broad text listeners without matchers', () => {
    const result = parseRulePlannerText(
      JSON.stringify({
        rule: {
          messageTypes: ['text'],
          promptTemplate: 'Analyze every text message.',
        },
      }),
      request,
    );

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('text/post listeners require'),
    });
  });

  it('accepts explicit rejection from the planner skill', () => {
    const result = parseRulePlannerText(
      JSON.stringify({ rejected: true, reason: '需要补充触发条件' }),
      request,
    );

    expect(result).toMatchObject({
      ok: false,
      error: '需要补充触发条件',
    });
  });
});
