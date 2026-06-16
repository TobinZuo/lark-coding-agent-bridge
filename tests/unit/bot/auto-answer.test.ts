import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import {
  AutoAnswerRuntime,
  extractCardText,
  isAlarmRuleRequestText,
  matchTriggerRule,
  normalizeIncomingMessage,
} from '../../../src/bot/auto-answer';
import type { AppConfig, LarkBotTriggerRule } from '../../../src/config/schema';
import type { Controls } from '../../../src/commands';
import { RulePlannerRejectedError, type RulePlannerDraft } from '../../../src/bot/rule-planner';

const app = {
  id: 'cli_test',
  secret: '${APP_SECRET}',
  tenant: 'feishu' as const,
};

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
            settleMs: 60_000,
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
    expect(first?.rule.settleMs).toBe(60_000);
    expect(second).toBeUndefined();
  });

  it('does not drop settled auto messages only because the original create time is stale', () => {
    const runtime = new AutoAnswerRuntime(() => 10 * 60 * 1000);
    const cfg: AppConfig = {
      accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
      larkBot: {
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            promptTemplate: '请分析报警',
          },
        ],
      },
    };
    const msg = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ content: '数据库报警' }] } }),
      rawContentType: 'interactive',
    }) as NormalizedMessage & { createTime?: number };
    msg.createTime = 1;
    msg.raw = {
      ...(msg.raw as Record<string, unknown>),
      __larkAutoSettle: { settled: true },
    };

    const match = runtime.matchMessage(cfg, msg);

    expect(match?.rule.id).toBe('alarm-card');
  });

  it('previews a rule match without consuming its fingerprint', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        dedupeTtlMs: 60_000,
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            promptTemplate: '请分析报警',
            settleMs: 60_000,
          },
        ],
      },
    };
    const normalized = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ content: '数据库报警' }] } }),
      rawContentType: 'interactive',
    });

    const preview = runtime.matchMessage(cfg, normalized, undefined, 'codex', { recordFingerprint: false });
    const first = runtime.matchMessage(cfg, normalized, undefined, 'codex');
    const second = runtime.matchMessage(cfg, normalized, undefined, 'codex');

    expect(preview?.fingerprint).toBe(first?.fingerprint);
    expect(first?.message.content).toContain('请分析报警');
    expect(second).toBeUndefined();
  });

  it('dedupes ingress separately from processing records', () => {
    let now = 1000;
    const runtime = new AutoAnswerRuntime(() => now);

    expect(runtime.tryRecordIngress('om_alarm', 60_000)).toBe(true);
    expect(runtime.tryRecordIngress('om_alarm', 60_000)).toBe(false);
    expect(runtime.tryRecordMessage('om_alarm', 60_000)).toBe(true);

    now = 62_000;
    expect(runtime.tryRecordIngress('om_alarm', 60_000)).toBe(true);
  });

  it('keeps metadata for duplicate fingerprint hits', () => {
    let now = 1000;
    const runtime = new AutoAnswerRuntime(() => now);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        dedupeTtlMs: 60_000,
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            cooldownMs: 300_000,
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ content: '数据库报警' }] } }),
      rawContentType: 'interactive',
    });
    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    if (!firstMatch) throw new Error('expected first match');

    const first = runtime.tryRecordFingerprint(firstMatch.rule, firstMatch.fingerprint, firstMsg, cfg.larkBot?.dedupeTtlMs);

    now = 11_000;
    const duplicateMsg = { ...firstMsg, messageId: 'om_alarm_dup' } as NormalizedMessage;
    const second = runtime.tryRecordFingerprint(
      firstMatch.rule,
      firstMatch.fingerprint,
      duplicateMsg,
      cfg.larkBot?.dedupeTtlMs,
    );

    expect(first.ok).toBe(true);
    expect(first.record.ttlMs).toBe(300_000);
    expect(second.ok).toBe(false);
    expect(second.record).toMatchObject({
      firstSeenAt: 1000,
      lastSeenAt: 11_000,
      duplicateCount: 1,
      ruleId: 'alarm-card',
      chatId: 'oc_alarm',
      messageId: 'om_alarm',
      lastMessageId: 'om_alarm_dup',
      ttlMs: 300_000,
    });
  });

  it('fingerprints interactive cards by configured paths instead of volatile card JSON', () => {
    let now = 1000;
    const runtime = new AutoAnswerRuntime(() => now);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        dedupeTtlMs: 60_000,
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            templateIds: ['tpl_alarm'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            cooldownMs: 300_000,
            fingerprint: { mode: 'paths', paths: ['$templateId', '$text'] },
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: '数据库报警' }] },
        volatile: { updated_at: 1000, trace: 'a' },
      }),
      rawContentType: 'interactive',
    });
    const duplicateMsg = {
      ...normalizedMessage({
        content: JSON.stringify({
          data: { template_id: 'tpl_alarm' },
          body: { elements: [{ tag: 'markdown', content: '数据库报警' }] },
          volatile: { updated_at: 2000, trace: 'b' },
        }),
        rawContentType: 'interactive',
      }),
      messageId: 'om_alarm_dup',
    } as NormalizedMessage;

    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    const duplicateMatch = runtime.matchMessage(cfg, duplicateMsg, undefined, undefined, { recordFingerprint: false });
    if (!firstMatch || !duplicateMatch) throw new Error('expected matches');

    const first = runtime.tryRecordFingerprint(firstMatch.rule, firstMatch.fingerprint, firstMsg, cfg.larkBot?.dedupeTtlMs);
    now = 11_000;
    const duplicate = runtime.tryRecordFingerprint(
      duplicateMatch.rule,
      duplicateMatch.fingerprint,
      duplicateMsg,
      cfg.larkBot?.dedupeTtlMs,
    );

    expect(duplicateMatch.fingerprint).toBe(firstMatch.fingerprint);
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.record.lastMessageId).toBe('om_alarm_dup');
  });

  it('supports path-based card fingerprints', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: '报警' }],
            fingerprint: { mode: 'paths', paths: ['$templateId', '$text'] },
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: '数据库报警' }] },
        volatile: { trace: 'a' },
      }),
      rawContentType: 'interactive',
    });
    const duplicateMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: '数据库报警' }] },
        volatile: { trace: 'b' },
      }),
      rawContentType: 'interactive',
    });

    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    const duplicateMatch = runtime.matchMessage(cfg, duplicateMsg, undefined, undefined, { recordFingerprint: false });

    expect(duplicateMatch?.fingerprint).toBe(firstMatch?.fingerprint);
  });

  it('fingerprints alert cards by stable labeled text lines', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: 'ignored' }],
            fingerprint: { mode: 'paths', paths: ['$line:服务', '$line:集群', '$line:规则'] },
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
        volatile: { trace: 'a' },
      }),
      rawContentType: 'interactive',
      text: [
        '[warning] [argos inject] go service panic log',
        '服务: data.ecom.aigc_gateway',
        '集群: Singapore-Central: default',
        '规则: [[argos inject] go service panic log](https://open.example/rule?rule_id=70369296138915&send_item_id=a)',
        '报警时间: 2026-06-16 03:19:05',
        'q: 0.0333',
      ].join('\n'),
    });
    const duplicateMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
        volatile: { trace: 'b' },
      }),
      rawContentType: 'interactive',
      text: [
        '[已恢复][warning] [argos inject] go service panic log',
        '服务: data.ecom.aigc_gateway',
        '集群: Singapore-Central: default',
        '规则: [[argos inject] go service panic log](https://open.example/rule?rule_id=70369296138915&send_item_id=b)',
        '报警时间: 2026-06-16 03:22:05',
        'q: 0.0666',
      ].join('\n'),
    });
    const differentRuleMsg = normalizedMessage({
      content: JSON.stringify({
        data: { template_id: 'tpl_alarm' },
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
      }),
      rawContentType: 'interactive',
      text: [
        '[warning] [MS inject]Service throws panic',
        '服务: data.ecom.aigc_gateway',
        '集群: Singapore-Central: default',
        '规则: [[MS inject]Service throws panic](https://open.example/rule?rule_id=70369296138916)',
      ].join('\n'),
    });

    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    const duplicateMatch = runtime.matchMessage(cfg, duplicateMsg, undefined, undefined, { recordFingerprint: false });
    const differentRuleMatch = runtime.matchMessage(cfg, differentRuleMsg, undefined, undefined, { recordFingerprint: false });

    expect(duplicateMatch?.fingerprint).toBe(firstMatch?.fingerprint);
    expect(differentRuleMatch?.fingerprint).not.toBe(firstMatch?.fingerprint);
  });

  it('fingerprints lark markdown labeled alert cards by configured profile paths', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: 'ignored' }],
            fingerprint: { mode: 'paths', paths: ['$line:服务', '$line:集群', '$line:规则'] },
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
        trace: 'a',
      }),
      rawContentType: 'interactive',
      text: [
        '<font color=\'grey\'>服务:</font> data.ecom.aigc_gateway',
        '<font color=\'grey\'>集群:</font> Singapore-Central: default',
        '<font color=\'grey\'>规则:</font> [MS inject]Service throws panic [[查看规则配置]](https://cloud.example/argos/alarm/detail?rule_id=70369296138916&send_item_id=a)',
        '<font color=\'grey\'>报警时间:</font> 2026-06-15 07:43:29 (UTC+0)',
        '<font color=\'grey\'>q:</font> 0.0333',
      ].join('\n'),
    });
    const duplicateMsg = normalizedMessage({
      content: JSON.stringify({
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
        trace: 'b',
      }),
      rawContentType: 'interactive',
      text: [
        '<font color=\'grey\'>服务:</font> data.ecom.aigc_gateway',
        '<font color=\'grey\'>集群:</font> Singapore-Central: default',
        '<font color=\'grey\'>规则:</font> [MS inject]Service throws panic [[查看规则配置]](https://cloud.example/argos/alarm/detail?rule_id=70369296138916&send_item_id=b)',
        '<font color=\'grey\'>报警时间:</font> 2026-06-15 07:46:29 (UTC+0)',
        '<font color=\'grey\'>q:</font> 0.0666',
      ].join('\n'),
    });
    const differentRuleMsg = normalizedMessage({
      content: JSON.stringify({
        body: { elements: [{ tag: 'markdown', content: 'ignored' }] },
      }),
      rawContentType: 'interactive',
      text: [
        '<font color=\'grey\'>服务:</font> data.ecom.aigc_gateway',
        '<font color=\'grey\'>集群:</font> Singapore-Central: default',
        '<font color=\'grey\'>规则:</font> [Other inject]Service throws panic [[查看规则配置]](https://cloud.example/argos/alarm/detail?rule_id=70369296138917)',
      ].join('\n'),
    });

    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    const duplicateMatch = runtime.matchMessage(cfg, duplicateMsg, undefined, undefined, { recordFingerprint: false });
    const differentRuleMatch = runtime.matchMessage(cfg, differentRuleMsg, undefined, undefined, { recordFingerprint: false });

    expect(duplicateMatch?.fingerprint).toBe(firstMatch?.fingerprint);
    expect(differentRuleMatch?.fingerprint).not.toBe(firstMatch?.fingerprint);
  });

  it('falls back to full fingerprints when configured paths are absent', () => {
    const runtime = new AutoAnswerRuntime(() => 1000);
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: {
        rules: [
          {
            id: 'alarm-card',
            chatIds: ['oc_alarm'],
            messageTypes: ['interactive'],
            cardMatchers: [{ path: '$text', operator: 'contains', value: 'ignored' }],
            fingerprint: { mode: 'paths', paths: ['$line:服务', '$line:集群', '$line:规则'] },
          },
        ],
      },
    };
    const firstMsg = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: 'ignored' }] }, trace: 'a' }),
      rawContentType: 'interactive',
      text: '没有稳定标签的卡片 A',
    });
    const secondMsg = normalizedMessage({
      content: JSON.stringify({ body: { elements: [{ tag: 'markdown', content: 'ignored' }] }, trace: 'b' }),
      rawContentType: 'interactive',
      text: '没有稳定标签的卡片 B',
    });

    const firstMatch = runtime.matchMessage(cfg, firstMsg, undefined, undefined, { recordFingerprint: false });
    const secondMatch = runtime.matchMessage(cfg, secondMsg, undefined, undefined, { recordFingerprint: false });

    expect(secondMatch?.fingerprint).not.toBe(firstMatch?.fingerprint);
  });

  it('only treats explicit alarm-card setup commands as rule requests', () => {
    expect(isAlarmRuleRequestText('请配置这个群的告警卡片自动分析规则')).toBe(false);
    expect(isAlarmRuleRequestText('/alarm-card-rule 告警卡片 自动分析')).toBe(true);
    expect(isAlarmRuleRequestText('configure alarm card auto analysis rule')).toBe(false);
    expect(
      isAlarmRuleRequestText(
        '你监听这个群的消息，对告警卡片出现后，调用lumen-aigc-infra-debug skill分析报警原因发到报警卡片话题下',
      ),
    ).toBe(false);

    expect(isAlarmRuleRequestText('出现告警卡片你就在下方根据告警卡片分析问题原因')).toBe(false);
    expect(isAlarmRuleRequestText('新的报警卡片出来，你好像没看到')).toBe(false);
    expect(isAlarmRuleRequestText('我看出现了新卡片你也没有自动分析和回复啊')).toBe(false);
    expect(isAlarmRuleRequestText('你怎么立刻就生成自动分析规则草案了。不对吧')).toBe(false);
  });

  it('uses the planner to semantically decide natural-language listener requests', async () => {
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: { admins: ['ou_admin'] },
    };
    const channel = { send: vi.fn(async () => {}) };
    const runtime = new AutoAnswerRuntime(() => 1000);
    const draft: RulePlannerDraft = {
      rule: {
        id: 'semantic-rule',
        chatIds: ['oc_alarm'],
        messageTypes: ['interactive'],
        cardMatchers: [{ path: '$text', operator: 'contains', value: '告警' }],
        promptTemplate: 'Analyze alert card.',
      },
      summary: {
        trigger: '当前群告警卡片',
        analysis: '分析告警',
        reply: '卡片话题下',
      },
    };
    const planRule = vi.fn(async () => draft);

    const handled = await runtime.tryHandleAdminConfig({
      channel: channel as never,
      controls: controlsFor(cfg),
      msg: adminMessage('你监听这个群的消息，对告警卡片出现后，分析原因发到卡片话题下'),
      planRule,
    });

    expect(handled).toBe(true);
    expect(planRule).toHaveBeenCalled();
    expect(channel.send).toHaveBeenCalledWith(
      'oc_alarm',
      { markdown: expect.stringContaining('当前群告警卡片') },
      { replyTo: 'om_admin' },
    );
  });

  it('lets ordinary config discussion continue when the planner says it is not a listener task', async () => {
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: { admins: ['ou_admin'] },
    };
    const channel = { send: vi.fn(async () => {}) };
    const runtime = new AutoAnswerRuntime(() => 1000);
    const planRule = vi.fn(async () => {
      throw new RulePlannerRejectedError('not_listener_task', 'not_listener_task');
    });

    const handled = await runtime.tryHandleAdminConfig({
      channel: channel as never,
      controls: controlsFor(cfg),
      msg: adminMessage('全局 larkBot.dedupeTtlMs 和当前告警规则 cooldownMs 是怎么配合的'),
      planRule,
    });

    expect(handled).toBe(false);
    expect(planRule).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('persists a draft returned by the external rule planner', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'bridge-auto-rule-'));
    try {
      const cfg: AppConfig = {
        accounts: { app },
        larkBot: { admins: ['ou_admin'] },
      };
      const controls = {
        profile: 'codex',
        configPath: join(tmp, 'config.json'),
        cfg,
        profileConfig: {
          ...cfg,
          access: { admins: ['ou_admin'], allowedUsers: [], allowedChats: [] },
        },
        ownerRefreshState: 'unknown',
      };
      const channel = { send: vi.fn(async () => {}) };
      const runtime = new AutoAnswerRuntime(() => 1000);
      const draft: RulePlannerDraft = {
        rule: {
          id: 'planner-rule',
          chatIds: ['oc_alarm'],
          messageTypes: ['interactive'],
          cardMatchers: [{ path: '$text', operator: 'contains', value: '支付失败' }],
          promptTemplate: 'planner generated prompt for foo-debug skill',
          replyInThread: true,
          settleMs: 30_000,
        },
        poller: {
          intervalMs: 15_000,
          pageSize: 10,
          chatIds: ['oc_other'],
        },
        summary: {
          trigger: '当前群支付失败卡片',
          analysis: '使用 foo-debug skill 分析',
          reply: '卡片话题下',
        },
      };
      const planRule = vi.fn(async () => draft);

      const drafted = await runtime.tryHandleAdminConfig({
        channel: channel as never,
        controls: controls as never,
        msg: adminMessage('监听这个群，包含支付失败的卡片出现后，调用foo-debug skill分析，发到卡片话题下'),
        planRule,
      });
      const confirmed = await runtime.tryHandleAdminConfig({
        channel: channel as never,
        controls: controls as never,
        msg: adminMessage('确认规则', { mentionedBot: false }),
      });

      expect(drafted).toBe(true);
      expect(confirmed).toBe(true);
      expect(planRule).toHaveBeenCalledWith(expect.objectContaining({
        instruction: '监听这个群，包含支付失败的卡片出现后，调用foo-debug skill分析，发到卡片话题下',
        chatId: 'oc_alarm',
        profile: 'codex',
      }));
      expect(channel.send).toHaveBeenCalledWith(
        'oc_alarm',
        { markdown: expect.stringContaining('使用 foo-debug skill 分析') },
        { replyTo: 'om_admin' },
      );
      expect(controls.cfg.larkBot?.poller).toMatchObject({
        enabled: true,
        enabledAtMs: 1000,
        intervalMs: 15_000,
        pageSize: 10,
        chatIds: ['oc_alarm'],
      });
      const rule = controls.cfg.larkBot?.rules?.[0];
      expect(rule).toMatchObject({
        id: 'planner-rule',
        chatIds: ['oc_alarm'],
        messageTypes: ['interactive'],
        replyInThread: true,
        settleMs: 30_000,
      });
      expect(rule?.cardMatchers?.[0]).toMatchObject({ path: '$text', operator: 'contains', value: '支付失败' });
      expect(rule?.promptTemplate).toContain('planner generated prompt');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not intercept natural-language listener text when the planner is unavailable', async () => {
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: { admins: ['ou_admin'] },
    };
    const channel = { send: vi.fn(async () => {}) };
    const runtime = new AutoAnswerRuntime(() => 1000);

    const handled = await runtime.tryHandleAdminConfig({
      channel: channel as never,
      controls: {
        profile: 'codex',
        cfg,
        profileConfig: {
          ...cfg,
          access: { admins: ['ou_admin'], allowedUsers: [], allowedChats: [] },
        },
        ownerRefreshState: 'unknown',
      } as never,
      msg: adminMessage('监听这个群的告警卡片并自动分析'),
    });

    expect(handled).toBe(false);
    expect(channel.send).not.toHaveBeenCalled();
    expect(cfg.larkBot?.rules).toBeUndefined();
  });

  it('reports unavailable planner for explicit listener commands', async () => {
    const cfg: AppConfig = {
      accounts: { app },
      larkBot: { admins: ['ou_admin'] },
    };
    const channel = { send: vi.fn(async () => {}) };
    const runtime = new AutoAnswerRuntime(() => 1000);

    const handled = await runtime.tryHandleAdminConfig({
      channel: channel as never,
      controls: controlsFor(cfg),
      msg: adminMessage('/listen 告警卡片并自动分析'),
    });

    expect(handled).toBe(true);
    expect(channel.send).toHaveBeenCalledWith(
      'oc_alarm',
      { markdown: expect.stringContaining('rulePlanner.enabled') },
      { replyTo: 'om_admin' },
    );
    expect(cfg.larkBot?.rules).toBeUndefined();
  });
});

function controlsFor(cfg: AppConfig): Controls {
  return {
    profile: 'codex',
    cfg,
    profileConfig: {
      ...cfg,
      access: { admins: ['ou_admin'], allowedUsers: [], allowedChats: [] },
    },
    ownerRefreshState: 'unknown',
  } as unknown as Controls;
}

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
  text?: string;
}): NormalizedMessage {
  return {
    messageId: 'om_alarm',
    chatId: 'oc_alarm',
    chatType: 'group',
    senderId: 'ou_alert_bot',
    content: input.text ?? '数据库报警',
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

function adminMessage(content: string, options: { mentionedBot?: boolean } = {}): NormalizedMessage {
  return {
    messageId: 'om_admin',
    chatId: 'oc_alarm',
    chatType: 'group',
    senderId: 'ou_admin',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: options.mentionedBot ?? true,
    raw: {
      sender: {
        sender_id: { open_id: 'ou_admin' },
        sender_type: 'user',
      },
      message: {
        content: JSON.stringify({ text: content }),
      },
    },
  } as unknown as NormalizedMessage;
}
