import { createHash } from 'node:crypto';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type {
  AppConfig,
  LarkBotCardMatcher,
  LarkBotConfig,
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
const ALARM_RULE_ID_PREFIX = 'auto-alarm-card';

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
    if (!isAdminConfigCandidate(msg)) return false;
    if (!isAutoAnswerAdmin(controls, msg.senderId)) return false;

    const key = draftKey(msg);
    if (isConfirmAlarmRuleText(msg.content)) {
      const draft = this.drafts.get(key);
      if (!draft) {
        await replyToMessage(channel, msg, '没有待确认的报警卡片规则草案。请先描述要监听的规则。');
        return true;
      }
      await saveLarkBotRule(controls, draft.rule);
      this.drafts.delete(key);
      await replyToMessage(
        channel,
        msg,
        `已启用规则 ${draft.rule.id}。之后本群出现报警卡片时，我会自动分析并回复。`,
      );
      return true;
    }

    if (!isAlarmRuleRequestText(msg.content)) return false;
    const rule = buildAlarmCardRule(msg);
    this.drafts.set(key, { rule, createdAt: this.now() });
    await replyToMessage(
      channel,
      msg,
      [
        '已生成报警卡片自动分析规则草案，尚未启用。',
        `规则: ${rule.id}`,
        '范围: 当前群的 interactive 报警/告警卡片',
        '确认启用请回复: 确认报警卡片规则',
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

function isAlarmRuleRequestText(text: string): boolean {
  return /报警卡片|告警卡片|alarm card|alert card/i.test(text) && /每出现|出现.*分析|自动分析|分析一次/i.test(text);
}

function isConfirmAlarmRuleText(text: string): boolean {
  return /确认.*报警卡片规则|启用.*报警卡片规则|confirm.*alarm/i.test(text);
}

function buildAlarmCardRule(msg: NormalizedMessage): LarkBotTriggerRule {
  return {
    id: `${ALARM_RULE_ID_PREFIX}-${shortHash(msg.chatId)}`,
    enabled: true,
    chatIds: [msg.chatId],
    messageTypes: ['interactive'],
    cardMatchers: [
      {
        path: '$text',
        operator: 'regex',
        value: '报警|告警|alarm|alert|critical|warning|error',
        caseSensitive: false,
      },
    ],
    requireMention: false,
    promptTemplate:
      '这是一张群里的报警卡片。请结合卡片内容做一次值班分析：概括告警、判断影响面、列出可能原因、给出排查步骤和下一步建议。',
    replyInThread: true,
    cooldownMs: 5 * 60 * 1000,
  };
}

async function saveLarkBotRule(controls: Controls, rule: LarkBotTriggerRule): Promise<void> {
  await withConfigFileLock(controls.configPath, async () => {
    const root = await loadRootConfig(controls.configPath);
    if (!root) {
      const next = upsertRule(controls.cfg.larkBot, rule);
      controls.cfg = { ...controls.cfg, larkBot: next };
      controls.profileConfig = { ...controls.profileConfig, larkBot: next };
      await saveConfig(controls.cfg, controls.configPath);
      return;
    }
    const profile = root.profiles[controls.profile];
    if (!profile) throw new Error(`profile not found: ${controls.profile}`);
    root.profiles[controls.profile] = {
      ...profile,
      larkBot: upsertRule(profile.larkBot, rule),
    };
    await saveRootConfig(root, controls.configPath);
    controls.profileConfig = root.profiles[controls.profile]!;
    controls.cfg = runtimeProfileConfig(root, controls.profile);
  });
}

function upsertRule(current: LarkBotConfig | undefined, rule: LarkBotTriggerRule): LarkBotConfig {
  const rules = [...(current?.rules ?? [])].filter((item) => item.id !== rule.id);
  rules.push(rule);
  return {
    ...(current ?? {}),
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
