import { createHash } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type {
  AppConfig,
  LarkBotCardMatcher,
  LarkBotConfig,
  LarkBotMessageType,
  LarkBotTextMatcher,
  LarkBotTriggerRule,
} from '../config/schema';
import { saveConfig } from '../config/store';
import {
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  withConfigFileLock,
} from '../config/profile-store';
import { canRunAdminCommand } from '../policy/access';
import { log } from '../core/logger';

const DEFAULT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_MAX_AGE_MS = 5 * 60 * 1000;
const AUTO_RULE_ID_PREFIX = 'auto-rule';

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderOpenId: string;
  senderName?: string;
  senderType?: 'user' | 'app' | 'bot';
  createTime?: number;
  threadId?: string;
  rootId?: string;
  replyToMessageId?: string;
  messageType: string;
  plainText: string;
  mentions: Array<{ key?: string; openId?: string; name?: string; isBot?: boolean }>;
  mentionedBot: boolean;
  mentionAll: boolean;
  cardJson?: unknown;
  rawContent: unknown;
  raw: unknown;
}

export interface RuleMatch {
  rule: LarkBotTriggerRule;
  message: NormalizedMessage;
  fingerprint: string;
}

interface DraftRule {
  rule: LarkBotTriggerRule;
  createdAt: number;
  summary: DraftRuleSummary;
  pollerChatId?: string;
}

interface DraftRuleSummary {
  trigger: string;
  analysis: string;
  reply: string;
}

interface TriggerSpec {
  idHint: string;
  summary: string;
  messageTypes?: LarkBotMessageType[];
  textMatchers?: LarkBotTriggerRule['textMatchers'];
  cardMatchers?: LarkBotTriggerRule['cardMatchers'];
  settleMs?: number;
}

interface SkillSpec {
  name?: string;
  promptTemplate: string;
  summary: string;
}

export class AutoAnswerRuntime {
  private readonly drafts = new Map<string, DraftRule>();
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async tryHandleAdminConfig(input: {
    channel: LarkChannel;
    controls: Controls;
    msg: NormalizedMessage;
  }): Promise<boolean> {
    const { channel, controls, msg } = input;
    if (!isAutoAnswerAdmin(controls, msg.senderId)) return false;

    const key = draftKey(msg);
    const confirm = isConfirmAlarmRuleText(msg.content);
    if (!isAdminConfigCandidate(msg) && !(confirm && this.drafts.has(key))) return false;
    if (confirm) {
      const draft = this.drafts.get(key);
      if (!draft) {
        await replyToMessage(channel, msg, '没有待确认的自动监听规则草案。请先描述要监听什么、触发后怎么处理。');
        return true;
      }
      await saveLarkBotRule(controls, draft.rule, {
        ...(draft.pollerChatId ? { pollerChatId: draft.pollerChatId } : {}),
      });
      this.drafts.delete(key);
      await replyToMessage(
        channel,
        msg,
        [
          `已启用规则 ${draft.rule.id}。`,
          draft.pollerChatId ? '当前群已加入轮询监听；从下一轮轮询开始，只处理新出现的消息。' : '',
          `触发: ${draft.summary.trigger}`,
          `处理: ${draft.summary.analysis}`,
          `回复: ${draft.summary.reply}`,
        ].filter(Boolean).join('\n'),
      );
      return true;
    }

    if (!isAutoRuleRequestText(msg.content)) return false;
    const draft = buildAutoAnswerRuleDraft(msg);
    if (!draft) {
      await replyToMessage(
        channel,
        msg,
        [
          '我还没能可靠解析这条自动监听规则，所以没有启用。',
          '请明确说明触发对象，例如“告警卡片”“包含 XXX 的卡片”“所有卡片”，以及触发后要调用哪个 skill 或怎么分析。',
        ].join('\n'),
      );
      return true;
    }
    this.drafts.set(key, {
      ...draft,
      ...(msg.chatType === 'group' ? { pollerChatId: msg.chatId } : {}),
      createdAt: this.now(),
    });
    await replyToMessage(
      channel,
      msg,
      [
        '已生成自动监听规则草案，尚未启用。',
        `规则: ${draft.rule.id}`,
        `触发: ${draft.summary.trigger}`,
        '监听: 当前群加入 poller，仅处理规则启用后新出现的消息',
        `处理: ${draft.summary.analysis}`,
        `回复: ${draft.summary.reply}`,
        '确认启用请回复: 确认规则',
      ].join('\n'),
    );
    return true;
  }

  matchMessage(
    cfg: AppConfig,
    msg: NormalizedMessage,
    botOpenId?: string,
    activeProfile?: string,
  ): RuleMatch | undefined {
    const incoming = incomingFromNormalizedMessage(msg, botOpenId);
    if (!incoming) return undefined;
    if (isStale(incoming, cfg.larkBot?.listener?.eventMaxAgeMs ?? DEFAULT_EVENT_MAX_AGE_MS, this.now())) {
      log.info('auto-answer', 'stale-message', { messageId: incoming.messageId });
      return undefined;
    }

    for (const rule of cfg.larkBot?.rules ?? []) {
      if (rule.agentProfile && activeProfile && rule.agentProfile !== activeProfile) continue;
      if (!matchTriggerRule(rule, incoming)) continue;
      const fingerprint = fingerprintFor(rule, incoming);
      if (!this.tryRecord(`fingerprint:${fingerprint}`, rule.cooldownMs ?? cfg.larkBot?.dedupeTtlMs)) {
        log.info('auto-answer', 'dedupe-fingerprint', { ruleId: rule.id, chatId: incoming.chatId });
        return undefined;
      }
      const next = normalizedMessageFromIncoming(incoming, {
        botOpenId,
        forceMention: true,
        promptTemplate: rule.promptTemplate,
        ruleId: rule.id,
        replyInThread: rule.replyInThread,
      });
      return { rule, message: next, fingerprint };
    }
    return undefined;
  }

  tryRecordMessage(messageId: string, ttlMs?: number): boolean {
    return this.tryRecord(`message:${messageId}`, ttlMs);
  }

  tryRecordSettle(ruleId: string, messageId: string, ttlMs?: number): boolean {
    return this.tryRecord(`settle:${ruleId}:${messageId}`, ttlMs);
  }

  private tryRecord(key: string, ttlMs = DEFAULT_DEDUPE_TTL_MS): boolean {
    const now = this.now();
    this.gc(now);
    const expiresAt = this.seen.get(key);
    if (expiresAt && expiresAt > now) return false;
    this.seen.set(key, now + Math.max(1, ttlMs));
    return true;
  }

  private gc(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
    for (const [key, draft] of this.drafts) {
      if (draft.createdAt + 10 * 60 * 1000 <= now) this.drafts.delete(key);
    }
  }
}

export function normalizeIncomingMessage(payload: unknown, botOpenId?: string): IncomingMessage | undefined {
  const event = unwrapMessageEvent(payload);
  if (!event) return undefined;
  const message = event.message;
  const sender = event.sender;
  const messageId = stringValue(message.message_id);
  const chatId = stringValue(message.chat_id);
  const senderOpenId = stringValue(recordValue(sender.sender_id, 'open_id'));
  if (!messageId || !chatId || !senderOpenId) return undefined;
  if (botOpenId && senderOpenId === botOpenId) return undefined;

  const messageType = stringValue(message.message_type) || 'text';
  const rawContent = message.content;
  const parsedContent = typeof rawContent === 'string' ? parseJsonOrRaw(rawContent) : rawContent;
  const cardJson = messageType === 'interactive' ? parsedContent : undefined;
  const mentions = normalizeMentions(message.mentions);
  const mentionedBot = botOpenId
    ? mentions.some((mention) => mention.openId === botOpenId || mention.isBot)
    : mentions.some((mention) => mention.isBot);
  return {
    messageId,
    chatId,
    chatType: stringValue(message.chat_type) === 'p2p' ? 'p2p' : 'group',
    senderOpenId,
    senderType: normalizeSenderType(sender.sender_type),
    createTime: numberFromStringLike(message.create_time),
    threadId: stringValue(message.thread_id),
    rootId: stringValue(message.root_id),
    replyToMessageId: stringValue(message.parent_id ?? message.root_id),
    messageType,
    plainText: contentToPlainText(parsedContent, messageType),
    mentions,
    mentionedBot,
    mentionAll: mentions.some((mention) => mention.name === 'all' || mention.key === '@all'),
    ...(cardJson !== undefined ? { cardJson } : {}),
    rawContent,
    raw: event,
  };
}

export function incomingFromNormalizedMessage(
  msg: NormalizedMessage,
  botOpenId?: string,
): IncomingMessage | undefined {
  if (botOpenId && msg.senderId === botOpenId) return undefined;
  const raw = msg.raw as { message?: { content?: unknown }; sender?: { sender_type?: unknown } } | undefined;
  const messageType = msg.rawContentType ?? 'text';
  const rawContent = raw?.message?.content ?? msg.content;
  const parsedContent = typeof rawContent === 'string' ? parseJsonOrRaw(rawContent) : rawContent;
  const cardJson = messageType === 'interactive' ? parsedContent : undefined;
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType === 'p2p' ? 'p2p' : 'group',
    senderOpenId: msg.senderId,
    ...(msg.senderName ? { senderName: msg.senderName } : {}),
    senderType: normalizeSenderType(raw?.sender?.sender_type),
    createTime: numberFromStringLike((msg as { createTime?: unknown }).createTime),
    threadId: msg.threadId,
    rootId: (msg as { rootId?: string }).rootId,
    replyToMessageId: msg.replyToMessageId,
    messageType,
    plainText: msg.content || contentToPlainText(parsedContent, messageType),
    mentions: [...(msg.mentions ?? [])],
    mentionedBot: msg.mentionedBot === true,
    mentionAll: (msg as { mentionAll?: boolean }).mentionAll === true,
    ...(cardJson !== undefined ? { cardJson } : {}),
    rawContent,
    raw: msg.raw ?? rawContent,
  };
}

export function normalizedMessageFromIncoming(input: IncomingMessage, options: {
  botOpenId?: string;
  forceMention?: boolean;
  promptTemplate?: string;
  ruleId?: string;
  replyInThread?: boolean;
} = {}): NormalizedMessage {
  const prompt = options.promptTemplate?.trim();
  const content = prompt ? `${prompt}\n\n${input.plainText}`.trim() : input.plainText;
  const raw = {
    ...(isRecord(input.raw) ? input.raw : {}),
    sender: {
      sender_id: { open_id: input.senderOpenId },
      sender_type: input.senderType ?? 'user',
    },
    message: {
      message_id: input.messageId,
      chat_id: input.chatId,
      chat_type: input.chatType,
      message_type: input.messageType,
      content:
        typeof input.rawContent === 'string'
          ? input.rawContent
          : JSON.stringify(input.rawContent ?? input.plainText),
      ...(input.threadId ? { thread_id: input.threadId } : {}),
      ...(input.rootId ? { root_id: input.rootId } : {}),
    },
    ...(options.ruleId
      ? {
          __larkAutoAnswer: {
            ruleId: options.ruleId,
            ...(typeof options.replyInThread === 'boolean' ? { replyInThread: options.replyInThread } : {}),
          },
        }
      : {}),
  };
  return {
    messageId: input.messageId,
    chatId: input.chatId,
    chatType: input.chatType,
    senderId: input.senderOpenId,
    ...(input.senderName ? { senderName: input.senderName } : {}),
    content,
    rawContentType: input.messageType,
    resources: [],
    mentions: input.mentions,
    mentionedBot: options.forceMention ? true : input.mentionedBot,
    mentionAll: input.mentionAll,
    ...(input.createTime ? { createTime: input.createTime } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.rootId ? { rootId: input.rootId } : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    raw,
  } as unknown as NormalizedMessage;
}

export function matchTriggerRule(rule: LarkBotTriggerRule, msg: IncomingMessage): boolean {
  if (rule.enabled === false) return false;
  if (!matchesStringList(rule.chatIds, msg.chatId)) return false;
  if (!matchesStringList(rule.senderIds, msg.senderOpenId)) return false;
  if (rule.requireMention === true && !msg.mentionedBot) return false;
  if (rule.messageTypes && rule.messageTypes.length > 0 && !rule.messageTypes.includes(msg.messageType as never)) {
    return false;
  }
  if (rule.templateIds && rule.templateIds.length > 0 && !matchesTemplateId(rule.templateIds, msg.cardJson)) {
    return false;
  }
  if (rule.textMatchers && rule.textMatchers.length > 0 && !rule.textMatchers.every((m) => matchText(m, msg.plainText))) {
    return false;
  }
  if (rule.cardMatchers && rule.cardMatchers.length > 0 && !rule.cardMatchers.every((m) => matchCard(m, msg.cardJson))) {
    return false;
  }
  return true;
}

export function autoAnswerMeta(msg: NormalizedMessage): { ruleId?: string; replyInThread?: boolean } | undefined {
  const raw = msg.raw as { __larkAutoAnswer?: { ruleId?: unknown; replyInThread?: unknown } } | undefined;
  const ruleId = raw?.__larkAutoAnswer?.ruleId;
  if (typeof ruleId !== 'string') return undefined;
  const replyInThread = raw?.__larkAutoAnswer?.replyInThread;
  return {
    ruleId,
    ...(typeof replyInThread === 'boolean' ? { replyInThread } : {}),
  };
}

function isAdminConfigCandidate(msg: NormalizedMessage): boolean {
  if (msg.chatType === 'p2p') return true;
  return msg.mentionedBot === true;
}

function isAutoAnswerAdmin(controls: Controls, senderId: string): boolean {
  if (canRunAdminCommand(controls.profileConfig, controls, senderId).ok) return true;
  return controls.cfg.larkBot?.admins?.includes(senderId) === true;
}

export function isAlarmRuleRequestText(text: string): boolean {
  return isAutoRuleRequestText(text);
}

export function isAutoRuleRequestText(text: string): boolean {
  const normalized = text.trim();
  if (/^\/(?:auto-)?(?:alarm|alert)-card(?:-rule)?\b/i.test(normalized)) return true;
  if (/^\/(?:auto-)?(?:rule|listen|watch)\b/i.test(normalized)) return true;

  const hasChineseSetupVerb = /创建|新建|新增|添加|配置|设置|设定|启用|生成|监听|监控/.test(normalized);
  const hasChineseTarget = /消息|卡片|文本|富文本|报警|告警|关键词|包含/.test(normalized);
  const hasChineseAction = /规则|自动分析|自动回复|自动处理|监听|调用|使用|skill|分析|回复/.test(normalized);
  if (hasChineseSetupVerb && hasChineseTarget && hasChineseAction) return true;

  const hasEnglishSetupVerb = /\b(?:create|add|configure|setup|set up|enable|generate|monitor|watch)\b/i.test(normalized);
  const hasEnglishTarget = /\b(?:message|card|text|post|alarm|alert|keyword|contains)\b/i.test(normalized);
  const hasEnglishAction = /\b(?:rule|auto(?:matic)?(?:ly)?|analysis|analyze|reply|monitor|watch|use|call|skill)\b/i.test(normalized);
  return hasEnglishSetupVerb && hasEnglishTarget && hasEnglishAction;
}

function isConfirmAlarmRuleText(text: string): boolean {
  return /^确认(?:启用)?(?:规则|监听)?$/.test(text.trim())
    || /确认.*(?:报警卡片|告警卡片|自动监听|自动分析)?.*规则|启用.*(?:报警卡片|告警卡片|自动监听|自动分析)?.*规则|confirm.*(?:alarm|rule)/i.test(text);
}

function buildAutoAnswerRuleDraft(msg: NormalizedMessage): Omit<DraftRule, 'createdAt' | 'pollerChatId'> | undefined {
  const trigger = inferTriggerSpec(msg.content);
  if (!trigger) return undefined;
  const goal = inferActionGoal(msg.content, trigger);
  const skill = inferSkillSpec(msg.content, trigger, goal);
  const replyInThread = shouldReplyInThread(msg.content);
  const rule: LarkBotTriggerRule = {
    id: `${AUTO_RULE_ID_PREFIX}-${trigger.idHint}-${shortHash(`${msg.chatId}:${trigger.idHint}:${skill.name ?? ''}`, 8)}`,
    enabled: true,
    chatIds: [msg.chatId],
    ...(trigger.messageTypes ? { messageTypes: trigger.messageTypes } : {}),
    ...(trigger.textMatchers ? { textMatchers: trigger.textMatchers } : {}),
    ...(trigger.cardMatchers ? { cardMatchers: trigger.cardMatchers } : {}),
    requireMention: false,
    promptTemplate: skill.promptTemplate,
    replyInThread,
    cooldownMs: 5 * 60 * 1000,
    ...(trigger.settleMs ? { settleMs: trigger.settleMs } : {}),
  };
  return {
    rule,
    summary: {
      trigger: trigger.summary,
      analysis: skill.summary,
      reply: replyInThread ? '原消息/话题下' : '原消息下',
    },
  };
}

function inferTriggerSpec(text: string): TriggerSpec | undefined {
  if (/报警卡片|告警卡片|alarm card|alert card/i.test(text)) {
    return {
      idHint: 'alarm-card',
      summary: '当前群 interactive 告警/报警卡片',
      messageTypes: ['interactive'],
      cardMatchers: [
        {
          path: '$text',
          operator: 'regex',
          value: '报警|告警|alarm|alert|critical|warning|error',
          caseSensitive: false,
        },
      ],
      settleMs: 60 * 1000,
    };
  }

  const messageTypes = inferMessageTypes(text);
  if (messageTypes.includes('interactive')) {
    const keyword = extractTriggerKeyword(text);
    if (keyword) {
      return {
        idHint: `card-${shortHash(keyword, 6)}`,
        summary: `当前群 interactive 卡片，卡片文本包含“${keyword}”`,
        messageTypes,
        cardMatchers: [{ path: '$text', operator: 'contains', value: keyword, caseSensitive: false }],
        settleMs: 60 * 1000,
      };
    }
    if (/所有|全部|任意|任何|all|any/i.test(text)) {
      return {
        idHint: 'all-cards',
        summary: '当前群所有 interactive 卡片',
        messageTypes,
        settleMs: 60 * 1000,
      };
    }
    return undefined;
  }

  const keyword = extractTriggerKeyword(text);
  if (keyword) {
    return {
      idHint: `message-${shortHash(keyword, 6)}`,
      summary: `当前群消息文本包含“${keyword}”`,
      ...(messageTypes.length > 0 ? { messageTypes } : {}),
      textMatchers: [{ type: 'contains', value: keyword, caseSensitive: false }],
    };
  }
  return undefined;
}

function inferMessageTypes(text: string): LarkBotMessageType[] {
  const types: LarkBotMessageType[] = [];
  if (/卡片|card/i.test(text)) types.push('interactive');
  if (/富文本|post/i.test(text)) types.push('post');
  if (/文本|文字|text/i.test(text)) types.push('text');
  return [...new Set(types)];
}

function extractTriggerKeyword(text: string): string | undefined {
  const explicit = text.match(/(?:包含|关键词(?:是|为)?|keyword(?: is)?|contains)\s*["“']?([^"”'，,。；;\n]{2,40})/i);
  const explicitKeyword = cleanupTriggerKeyword(explicit?.[1]);
  if (explicitKeyword) return explicitKeyword;

  const phrase = text.match(/(?:对|当|每当|如果|收到|出现)\s*([^，,。；;\n]{2,40}?)(?:出现后|出现时|时|后|就|调用|使用|分析|回复|发到|$)/);
  return cleanupTriggerKeyword(phrase?.[1]);
}

function cleanupTriggerKeyword(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/^这个群(?:里|的)?/, '')
    .replace(/^群(?:里|的)?/, '')
    .replace(/^(所有|全部|任意|任何)/, '')
    .replace(/(?:的)?(?:消息|卡片|文本|出现|以后|之后|时候|时|后)+$/g, '')
    .replace(/的$/g, '')
    .trim();
  if (!cleaned || cleaned.length < 2) return undefined;
  if (/^(这个|当前|本群|消息|卡片|文本)$/.test(cleaned)) return undefined;
  return cleaned;
}

function inferSkillSpec(text: string, trigger: TriggerSpec, goal: string): SkillSpec {
  const skillName = extractSkillName(text);
  if (/lumen-aigc-infra-debug|lumen/i.test(skillName ?? text)) {
    return {
      name: 'lumen-aigc-infra-debug',
      promptTemplate: lumenAlarmPrompt(goal),
      summary: `优先使用 lumen-aigc-infra-debug skill 做只读诊断；目标: ${goal}`,
    };
  }
  if (skillName) {
    return {
      name: skillName,
      promptTemplate: genericSkillPrompt(skillName, trigger.summary, goal),
      summary: `优先使用 ${skillName} skill 处理；目标: ${goal}`,
    };
  }
  return {
    promptTemplate: genericAutoAnswerPrompt(trigger.summary, goal),
    summary: `使用默认自动分析提示；目标: ${goal}`,
  };
}

function inferActionGoal(text: string, trigger: TriggerSpec): string {
  const explicit = text.match(/(?:调用|使用|用|use|call)\s+[A-Za-z0-9][A-Za-z0-9_.-]*(?:\s*skill)?\s*([^，。；;\n]{2,80})/i);
  const fallback = text.match(/(?:出现后|出现时|后|时|then)\s*([^，。；;\n]{2,100})/i);
  const goal = cleanupActionGoal(explicit?.[1]) ?? cleanupActionGoal(fallback?.[1]);
  return goal ?? `根据${trigger.summary}进行分析并给出结论和建议`;
}

function cleanupActionGoal(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value
    .replace(/^(来|去|帮我|请|就|并|然后|，|,|\s)+/, '')
    .replace(/(?:发到|回复到|回到).*(?:话题|thread|下)$/i, '')
    .trim();
  if (!cleaned || cleaned.length < 2) return undefined;
  return cleaned;
}

function extractSkillName(text: string): string | undefined {
  const called = text.match(/(?:调用|使用|用|use|call)\s*([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\s*skill)?/i);
  const skill = called?.[1] ?? text.match(/([A-Za-z0-9][A-Za-z0-9_.-]*)\s*skill/i)?.[1];
  if (!skill) return undefined;
  if (/^(skill|message|card|text|post|alarm|alert)$/i.test(skill)) return undefined;
  return skill;
}

function shouldReplyInThread(text: string): boolean {
  if (/不要.*(?:话题|thread)|原消息下|top[- ]?level/i.test(text)) return false;
  return /话题|thread|原消息|卡片下|下面|reply/i.test(text) || /卡片|card/i.test(text);
}

const DEFAULT_AUTO_ANSWER_PROMPT =
  '这是一条自动触发的飞书群消息。请结合消息内容和触发规则进行分析，先给结论，再给证据、可能原因和下一步建议。';

function genericAutoAnswerPrompt(triggerSummary: string, goal: string): string {
  return [
    DEFAULT_AUTO_ANSWER_PROMPT,
    `触发规则: ${triggerSummary}`,
    `用户配置目标: ${goal}`,
    '请把这个目标改写成针对当前消息的执行任务来完成，不要重新创建或修改监听规则。',
  ].join('\n');
}

function genericSkillPrompt(skillName: string, triggerSummary: string, goal: string): string {
  return [
    '这是一条自动触发的飞书群消息。',
    `请优先使用 ${skillName} skill 处理这条消息；如果该 skill 不适用，请说明原因并基于消息内容给出分析。`,
    `触发规则: ${triggerSummary}`,
    `用户配置目标: ${goal}`,
    '回复时先给结论，再给证据和建议动作。不要执行有副作用的操作，除非用户明确要求。',
  ].join('\n');
}

function lumenAlarmPrompt(goal: string): string {
  return [
    '这是一张自动触发的飞书告警卡片。',
    '请优先使用 lumen-aigc-infra-debug skill，以只读方式分析报警原因。',
    `用户配置目标: ${goal}`,
    '改写后的执行要求: 提取卡片里的 PSM/服务名/region/时间窗口/rule_id/详情链接等证据，查询相关监控、日志、Argos 或 Lumen/AIGC Infra 信息，输出结论、影响面、证据链、可能原因、当前状态和建议动作。',
    '不要自动 ACK、屏蔽、改配置或执行有副作用操作，除非用户明确要求。',
  ].join('\n');
}

async function saveLarkBotRule(
  controls: Controls,
  rule: LarkBotTriggerRule,
  options: { pollerChatId?: string } = {},
): Promise<void> {
  await withConfigFileLock(controls.configPath, async () => {
    const root = await loadRootConfig(controls.configPath);
    if (!root) {
      const next = upsertRule(controls.cfg.larkBot, rule, options);
      controls.cfg = { ...controls.cfg, larkBot: next };
      controls.profileConfig = { ...controls.profileConfig, larkBot: next };
      await saveConfig(controls.cfg, controls.configPath);
      return;
    }
    const profile = root.profiles[controls.profile];
    if (!profile) throw new Error(`profile not found: ${controls.profile}`);
    root.profiles[controls.profile] = {
      ...profile,
      larkBot: upsertRule(profile.larkBot, rule, options),
    };
    await saveRootConfig(root, controls.configPath);
    controls.profileConfig = root.profiles[controls.profile]!;
    controls.cfg = runtimeProfileConfig(root, controls.profile);
  });
}

function upsertRule(
  current: LarkBotConfig | undefined,
  rule: LarkBotTriggerRule,
  options: { pollerChatId?: string } = {},
): LarkBotConfig {
  const rules = [...(current?.rules ?? [])].filter((item) => item.id !== rule.id);
  rules.push(rule);
  const poller = options.pollerChatId
    ? {
        ...(current?.poller ?? {}),
        enabled: true,
        chatIds: [...new Set([...(current?.poller?.chatIds ?? []), options.pollerChatId])],
      }
    : current?.poller;
  return {
    ...(current ?? {}),
    ...(poller ? { poller } : {}),
    rules,
  };
}

async function replyToMessage(channel: LarkChannel, msg: NormalizedMessage, text: string): Promise<void> {
  try {
    await channel.send(msg.chatId, { markdown: text }, { replyTo: msg.messageId });
  } catch {
    await channel.send(msg.chatId, { markdown: text });
  }
}

function draftKey(msg: NormalizedMessage): string {
  return `${msg.chatId}:${msg.senderId}`;
}

function unwrapMessageEvent(payload: unknown): { sender: Record<string, unknown>; message: Record<string, unknown> } | undefined {
  if (!isRecord(payload)) return undefined;
  const candidate = isRecord(payload.event) ? payload.event : payload;
  const sender = recordValue(candidate, 'sender');
  const message = recordValue(candidate, 'message');
  if (!isRecord(sender) || !isRecord(message)) return undefined;
  return { sender, message };
}

function normalizeMentions(value: unknown): IncomingMessage['mentions'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((mention) => {
      const id = recordValue(mention, 'id');
      const openId = isRecord(id) ? stringValue(id.open_id) : stringValue(mention.open_id);
      const name = stringValue(mention.name) || stringValue(mention.key);
      return {
        ...(stringValue(mention.key) ? { key: stringValue(mention.key) } : {}),
        ...(openId ? { openId } : {}),
        ...(name ? { name } : {}),
        isBot: mention.is_bot === true || mention.user_type === 'bot',
      };
    });
}

function contentToPlainText(content: unknown, messageType: string): string {
  if (typeof content === 'string') return content;
  if (!isRecord(content)) return '';
  if (messageType === 'text') return stringValue(content.text);
  if (messageType === 'post') return extractPostText(content);
  if (messageType === 'interactive') return extractCardText(content);
  return extractCardText(content) || JSON.stringify(content);
}

function extractPostText(content: Record<string, unknown>): string {
  const pieces: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!isRecord(value)) return;
    const text = stringValue(value.text) || stringValue(value.content);
    if (text) pieces.push(text);
    for (const nested of Object.values(value)) {
      if (typeof nested === 'object') collect(nested);
    }
  };
  collect(content.content);
  return pieces.join('\n').trim();
}

export function extractCardText(card: unknown): string {
  const pieces: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      if (text) pieces.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'url' || key === 'href' || key === 'image_key' || key === 'template_id') continue;
      visit(nested);
    }
  };
  visit(card);
  return [...new Set(pieces)].join('\n').trim();
}

function matchText(matcher: string | LarkBotTextMatcher, text: string): boolean {
  const normalized = typeof matcher === 'string' ? { value: matcher, type: 'contains' as const } : matcher;
  return matchScalar(text, normalized.value, normalized.type ?? 'contains', normalized.caseSensitive);
}

function matchCard(matcher: LarkBotCardMatcher, card: unknown): boolean {
  const operator = matcher.operator ?? 'exists';
  const value = matcher.path === '$text' ? extractCardText(card) : valueAtPath(card, matcher.path);
  if (operator === 'exists') return value !== undefined && value !== null && value !== '';
  return matchScalar(value, matcher.value, operator, matcher.caseSensitive);
}

function matchScalar(
  actual: unknown,
  expected: unknown,
  operator: 'equals' | 'contains' | 'regex',
  caseSensitive = false,
): boolean {
  if (operator === 'equals') return JSON.stringify(actual) === JSON.stringify(expected);
  const a = stringifyComparable(actual);
  const e = stringifyComparable(expected);
  if (!caseSensitive) {
    if (operator === 'contains') return a.toLowerCase().includes(e.toLowerCase());
    try {
      return new RegExp(e, 'i').test(a);
    } catch {
      return false;
    }
  }
  if (operator === 'contains') return a.includes(e);
  try {
    return new RegExp(e).test(a);
  } catch {
    return false;
  }
}

function matchesStringList(list: string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true;
  return list.includes('*') || list.includes(value);
}

function matchesTemplateId(templateIds: string[], card: unknown): boolean {
  const candidates = [
    valueAtPath(card, 'data.template_id'),
    valueAtPath(card, 'template_id'),
    valueAtPath(card, 'card.template_id'),
  ].map(stringValue);
  return candidates.some((candidate) => candidate && templateIds.includes(candidate));
}

function valueAtPath(input: unknown, path = ''): unknown {
  if (!path || path === '$') return input;
  const clean = path.startsWith('$.') ? path.slice(2) : path;
  return clean.split('.').reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (isRecord(current)) return current[segment];
    return undefined;
  }, input);
}

function fingerprintFor(rule: LarkBotTriggerRule, msg: IncomingMessage): string {
  return shortHash(
    JSON.stringify({
      rule: rule.id,
      chat: msg.chatId,
      type: msg.messageType,
      card: msg.cardJson ?? msg.rawContent,
      text: msg.plainText,
    }),
    24,
  );
}

function isStale(msg: IncomingMessage, maxAgeMs: number, now: number): boolean {
  if (!msg.createTime) return false;
  return now - msg.createTime > maxAgeMs;
}

function shortHash(value: string, length = 8): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function stringifyComparable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function numberFromStringLike(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSenderType(value: unknown): IncomingMessage['senderType'] {
  if (value === 'user' || value === 'app' || value === 'bot') return value;
  return undefined;
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
