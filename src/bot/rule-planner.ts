import { createHash } from 'node:crypto';
import type {
  LarkBotCardMatcher,
  LarkBotMessageType,
  LarkBotPollerConfig,
  LarkBotRulePlannerConfig,
  LarkBotTextMatcher,
  LarkBotTriggerRule,
} from '../config/schema';

const AUTO_RULE_ID_PREFIX = 'auto-rule';
const MESSAGE_TYPES = new Set<LarkBotMessageType>([
  'text',
  'post',
  'interactive',
  'image',
  'file',
  'audio',
  'media',
  'sticker',
  'system',
]);
const TEXT_MATCHER_TYPES = new Set(['contains', 'equals', 'regex']);
const CARD_MATCHER_OPERATORS = new Set(['exists', 'equals', 'contains', 'regex']);

export interface RulePlannerRequest {
  instruction: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  messageId: string;
  profile: string;
}

export interface RulePlannerDraft {
  rule: LarkBotTriggerRule;
  summary: {
    trigger: string;
    analysis: string;
    reply: string;
  };
  poller?: LarkBotPollerConfig;
}

export type RulePlannerValidationResult =
  | { ok: true; draft: RulePlannerDraft }
  | { ok: false; error: string };

export function buildRulePlannerPrompt(
  planner: LarkBotRulePlannerConfig,
  request: RulePlannerRequest,
): string {
  if (planner.promptTemplate?.trim()) {
    return interpolatePlannerPrompt(planner.promptTemplate, request, planner.skill);
  }
  const skillLine = planner.skill
    ? `必须使用外部 skill "${planner.skill}" 来理解管理员意图并生成草案。`
    : '没有配置外部 skill 名称时，不要臆测规则；返回 rejected。';
  return [
    '你是 Lark 群消息监听任务的外部规则配置 skill runner。',
    skillLine,
    '你的唯一任务是把管理员的自然语言监听需求转换成严格 JSON。不要解释，不要输出 Markdown，不要写代码块。',
    '',
    '输出 JSON 形状如下：',
    '{',
    '  "rule": {',
    '    "id": "optional-safe-id",',
    '    "messageTypes": ["interactive"],',
    '    "textMatchers": [{ "type": "contains", "value": "keyword", "caseSensitive": false }],',
    '    "cardMatchers": [{ "path": "$text", "operator": "regex", "value": "报警|告警" }],',
    '    "templateIds": ["optional_template_id"],',
    '    "senderIds": ["optional_sender_open_id"],',
    '    "requireMention": false,',
    '    "agentProfile": "optional-profile",',
    '    "promptTemplate": "执行时注入给 agent 的完整 prompt，必须保留管理员目标并改写成针对命中消息的执行任务",',
    '    "replyInThread": true,',
    '    "cooldownMs": 300000,',
    '    "settleMs": 60000',
    '  },',
    '  "poller": {',
    '    "intervalMs": 10000,',
    '    "overlapMs": 180000,',
    '    "maxLookbackMs": 900000,',
    '    "pageSize": 20,',
    '    "leaderId": "optional-machine-id"',
    '  },',
    '  "summary": {',
    '    "trigger": "给管理员看的触发条件摘要",',
    '    "analysis": "给管理员看的处理方式摘要",',
    '    "reply": "给管理员看的回复位置摘要"',
    '  }',
    '}',
    '',
    '约束：',
    '- 只能规划当前群的监听任务；不要写入其它 chatIds，bridge 会强制覆盖为当前 chatId。',
    '- rule.promptTemplate 必须由你生成，里面应该写清楚命中消息后要做什么、用哪个业务 skill、输出格式和禁止的副作用。',
    '- 不要生成“所有文本消息都处理”的宽泛规则；文本/富文本监听必须有 textMatchers。',
    '- interactive 卡片可以监听所有卡片，也可以用 cardMatchers/templateIds 收窄。',
    '- 如果管理员意图不够明确，输出 {"rejected": true, "reason": "需要补充..."}。',
    '',
    `当前 profile: ${request.profile}`,
    `当前 chatId: ${request.chatId}`,
    `当前 chatType: ${request.chatType}`,
    `管理员 open_id: ${request.senderId}`,
    `消息 id: ${request.messageId}`,
    '管理员原话：',
    request.instruction,
  ].join('\n');
}

export function normalizeRulePlannerOutput(
  rawOutput: unknown,
  request: RulePlannerRequest,
): RulePlannerValidationResult {
  const raw = unwrapDraft(rawOutput);
  if (!isRecord(raw)) return { ok: false, error: 'planner output is not a JSON object' };
  if (raw.rejected === true) {
    const reason = stringValue(raw.reason) || '外部配置 skill 拒绝生成规则';
    return { ok: false, error: reason };
  }
  const rawRule = raw.rule;
  if (!isRecord(rawRule)) return { ok: false, error: 'planner output missing rule object' };

  const promptTemplate = stringValue(rawRule.promptTemplate).trim();
  if (!promptTemplate) return { ok: false, error: 'rule.promptTemplate is required' };

  const messageTypes = normalizeMessageTypes(rawRule.messageTypes);
  const textMatchers = normalizeTextMatchers(rawRule.textMatchers);
  const cardMatchers = normalizeCardMatchers(rawRule.cardMatchers);
  const templateIds = stringArray(rawRule.templateIds);
  const senderIds = stringArray(rawRule.senderIds);
  const hasMatcher = textMatchers.length > 0 || cardMatchers.length > 0 || templateIds.length > 0 || senderIds.length > 0;
  if (messageTypes.length === 0 && !hasMatcher) {
    return { ok: false, error: 'rule must include messageTypes or matchers' };
  }
  if (
    !hasMatcher &&
    (messageTypes.length === 0 || messageTypes.some((type) => type === 'text' || type === 'post'))
  ) {
    return { ok: false, error: 'text/post listeners require textMatchers or other narrowing matchers' };
  }

  const id = safeRuleId(stringValue(rawRule.id), request);
  const rule: LarkBotTriggerRule = {
    id,
    enabled: rawRule.enabled === false ? false : true,
    chatIds: [request.chatId],
    ...(messageTypes.length > 0 ? { messageTypes } : {}),
    ...(textMatchers.length > 0 ? { textMatchers } : {}),
    ...(cardMatchers.length > 0 ? { cardMatchers } : {}),
    ...(templateIds.length > 0 ? { templateIds } : {}),
    ...(senderIds.length > 0 ? { senderIds } : {}),
    ...(typeof rawRule.requireMention === 'boolean' ? { requireMention: rawRule.requireMention } : { requireMention: false }),
    ...(stringValue(rawRule.agentProfile) ? { agentProfile: stringValue(rawRule.agentProfile) } : {}),
    promptTemplate,
    ...(typeof rawRule.replyInThread === 'boolean' ? { replyInThread: rawRule.replyInThread } : {}),
    ...(positiveInt(rawRule.cooldownMs, 1, 24 * 60 * 60 * 1000) ? { cooldownMs: positiveInt(rawRule.cooldownMs, 1, 24 * 60 * 60 * 1000) } : {}),
    ...(positiveInt(rawRule.settleMs, 1, 10 * 60 * 1000) ? { settleMs: positiveInt(rawRule.settleMs, 1, 10 * 60 * 1000) } : {}),
  };

  return {
    ok: true,
    draft: {
      rule,
      summary: normalizeSummary(raw.summary, rule),
      ...(isRecord(raw.poller) ? { poller: normalizePoller(raw.poller) } : {}),
    },
  };
}

export function parseRulePlannerText(
  text: string,
  request: RulePlannerRequest,
): RulePlannerValidationResult {
  const parsed = extractPlannerJson(text);
  if (!parsed.ok) return parsed;
  return normalizeRulePlannerOutput(parsed.value, request);
}

export function extractPlannerJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'planner returned empty output' };
  const candidates = [
    trimmed,
    ...[...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? ''),
    firstJsonObject(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: false, error: 'planner output did not contain valid JSON' };
}

function interpolatePlannerPrompt(template: string, request: RulePlannerRequest, skill?: string): string {
  const values: Record<string, string> = {
    instruction: request.instruction,
    chatId: request.chatId,
    chatType: request.chatType,
    senderId: request.senderId,
    messageId: request.messageId,
    profile: request.profile,
    skill: skill ?? '',
  };
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_all, key: string) => values[key] ?? '');
}

function unwrapDraft(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (isRecord(raw.draft)) return raw.draft;
  return raw;
}

function normalizeMessageTypes(input: unknown): LarkBotMessageType[] {
  return [...new Set(
    (Array.isArray(input) ? input : [])
      .map(stringValue)
      .filter((value): value is LarkBotMessageType => MESSAGE_TYPES.has(value as LarkBotMessageType)),
  )];
}

function normalizeTextMatchers(input: unknown): Array<string | LarkBotTextMatcher> {
  if (!Array.isArray(input)) return [];
  const out: Array<string | LarkBotTextMatcher> = [];
  for (const item of input) {
    if (typeof item === 'string' && item.trim()) {
      out.push(item.trim());
      continue;
    }
    if (!isRecord(item)) continue;
    const value = stringValue(item.value).trim();
    if (!value) continue;
    const type = stringValue(item.type);
    out.push({
      ...(TEXT_MATCHER_TYPES.has(type) ? { type: type as LarkBotTextMatcher['type'] } : {}),
      value,
      ...(typeof item.caseSensitive === 'boolean' ? { caseSensitive: item.caseSensitive } : {}),
    });
  }
  return out;
}

function normalizeCardMatchers(input: unknown): LarkBotCardMatcher[] {
  if (!Array.isArray(input)) return [];
  const out: LarkBotCardMatcher[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const path = stringValue(item.path).trim();
    const operator = stringValue(item.operator);
    const normalizedOperator = CARD_MATCHER_OPERATORS.has(operator)
      ? operator as LarkBotCardMatcher['operator']
      : undefined;
    if (!path && !normalizedOperator && item.value === undefined) continue;
    out.push({
      ...(path ? { path } : {}),
      ...(normalizedOperator ? { operator: normalizedOperator } : {}),
      ...(item.value !== undefined ? { value: item.value } : {}),
      ...(typeof item.caseSensitive === 'boolean' ? { caseSensitive: item.caseSensitive } : {}),
    });
  }
  return out;
}

function normalizeSummary(input: unknown, rule: LarkBotTriggerRule): RulePlannerDraft['summary'] {
  const raw = isRecord(input) ? input : {};
  return {
    trigger: stringValue(raw.trigger) || summarizeTrigger(rule),
    analysis: stringValue(raw.analysis) || '使用外部配置 skill 生成的 prompt 处理',
    reply: stringValue(raw.reply) || (rule.replyInThread ? '原消息/话题下' : '原消息下'),
  };
}

function summarizeTrigger(rule: LarkBotTriggerRule): string {
  const parts = [
    rule.messageTypes?.length ? `消息类型: ${rule.messageTypes.join(', ')}` : '',
    rule.templateIds?.length ? `模板: ${rule.templateIds.join(', ')}` : '',
    rule.textMatchers?.length ? '文本匹配' : '',
    rule.cardMatchers?.length ? '卡片匹配' : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : '外部配置 skill 生成的触发条件';
}

function normalizePoller(input: Record<string, unknown>): LarkBotPollerConfig {
  return {
    ...(positiveInt(input.intervalMs, 5_000, 5 * 60_000) ? { intervalMs: positiveInt(input.intervalMs, 5_000, 5 * 60_000) } : {}),
    ...(positiveInt(input.overlapMs, 1_000, 30 * 60_000) ? { overlapMs: positiveInt(input.overlapMs, 1_000, 30 * 60_000) } : {}),
    ...(positiveInt(input.maxLookbackMs, 5_000, 60 * 60_000) ? { maxLookbackMs: positiveInt(input.maxLookbackMs, 5_000, 60 * 60_000) } : {}),
    ...(positiveInt(input.pageSize, 1, 50) ? { pageSize: positiveInt(input.pageSize, 1, 50) } : {}),
    ...(stringValue(input.leaderId).trim() ? { leaderId: stringValue(input.leaderId).trim() } : {}),
  };
}

function safeRuleId(rawId: string, request: RulePlannerRequest): string {
  const trimmed = rawId.trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(trimmed)) return trimmed;
  return `${AUTO_RULE_ID_PREFIX}-${shortHash(`${request.chatId}:${request.instruction}`, 12)}`;
}

function positiveInt(input: unknown, min: number, max: number): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined;
  return Math.min(max, Math.max(min, Math.floor(input)));
}

function stringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(stringValue).map((value) => value.trim()).filter(Boolean))];
}

function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
