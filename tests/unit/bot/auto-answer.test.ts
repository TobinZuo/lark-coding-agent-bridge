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

  it('only treats explicit alarm-card setup commands as rule requests', () => {
    expect(isAlarmRuleRequestText('请配置这个群的告警卡片自动分析规则')).toBe(true);
    expect(isAlarmRuleRequestText('/alarm-card-rule 告警卡片 自动分析')).toBe(true);
    expect(isAlarmRuleRequestText('configure alarm card auto analysis rule')).toBe(true);
    expect(
      isAlarmRuleRequestText(
        '你监听这个群的消息，对告警卡片出现后，调用lumen-aigc-infra-debug skill分析报警原因发到报警卡片话题下',
      ),
    ).toBe(true);

    expect(isAlarmRuleRequestText('出现告警卡片你就在下方根据告警卡片分析问题原因')).toBe(false);
    expect(isAlarmRuleRequestText('新的报警卡片出来，你好像没看到')).toBe(false);
    expect(isAlarmRuleRequestText('我看出现了新卡片你也没有自动分析和回复啊')).toBe(false);
    expect(isAlarmRuleRequestText('你怎么立刻就生成自动分析规则草案了。不对吧')).toBe(false);
  });

  it('drafts a non-lumen skill rule from admin natural language', async () => {
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

      const drafted = await runtime.tryHandleAdminConfig({
        channel: channel as never,
        controls: controls as never,
        msg: adminMessage('监听这个群，包含支付失败的卡片出现后，调用foo-debug skill分析，发到卡片话题下'),
      });
      const confirmed = await runtime.tryHandleAdminConfig({
        channel: channel as never,
        controls: controls as never,
        msg: adminMessage('确认规则', { mentionedBot: false }),
      });

      expect(drafted).toBe(true);
      expect(confirmed).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(
        'oc_alarm',
        { markdown: expect.stringContaining('foo-debug skill') },
        { replyTo: 'om_admin' },
      );
      expect(controls.cfg.larkBot?.poller).toMatchObject({
        enabled: true,
        chatIds: ['oc_alarm'],
      });
      const rule = controls.cfg.larkBot?.rules?.[0];
      expect(rule).toMatchObject({
        chatIds: ['oc_alarm'],
        messageTypes: ['interactive'],
        replyInThread: true,
      });
      expect(rule?.cardMatchers?.[0]).toMatchObject({ path: '$text', operator: 'contains', value: '支付失败' });
      expect(rule?.promptTemplate).toContain('foo-debug skill');
      expect(rule?.promptTemplate).not.toContain('lumen-aigc-infra-debug');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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
