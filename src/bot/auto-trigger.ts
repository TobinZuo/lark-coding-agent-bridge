import type { NormalizedMessage } from '@larksuite/channel';
import type { AppConfig, AutoTriggerRule } from '../config/schema';

export interface AutoTriggerMatch {
  rule: AutoTriggerRule;
  ruleName: string;
  prompt: string;
}

export interface AutoTriggerContext {
  botOpenId?: string;
}

export const DEFAULT_AUTO_TRIGGER_PROMPT =
  '这是自动触发的飞书告警卡片。请按只读方式排查报警原因：优先使用告警中的 PSM、region、时间窗口、host、rule_id、详情链接等 live evidence 校验；输出结论、影响窗口、证据链、当前状态和建议动作。不要自动 ACK、屏蔽、改配置或执行有副作用操作，除非用户明确要求。';

export function matchAutoTrigger(
  msg: NormalizedMessage,
  cfg: AppConfig,
  context: AutoTriggerContext = {},
): AutoTriggerMatch | undefined {
  if (context.botOpenId && msg.senderId === context.botOpenId) return undefined;

  const rules = cfg.preferences?.autoTriggers ?? [];
  for (const [index, rule] of rules.entries()) {
    if (rule.enabled === false) continue;
    if (!matchesList(rule.chatIds, msg.chatId)) continue;
    if (!matchesList(rule.senderIds, msg.senderId)) continue;
    if (!matchesList(rule.senderTypes, senderTypeOf(msg))) continue;
    if (!matchesList(rule.rawContentTypes, msg.rawContentType)) continue;

    const haystack = searchableMessageText(msg);
    if (!includesAll(haystack, rule.contentIncludes)) continue;
    if (!includesAnyWhenConfigured(haystack, rule.contentAnyIncludes)) continue;

    return {
      rule,
      ruleName: rule.name || `auto-trigger-${index + 1}`,
      prompt: rule.prompt || DEFAULT_AUTO_TRIGGER_PROMPT,
    };
  }
  return undefined;
}

export function withAutoTriggerPrompt(
  msg: NormalizedMessage,
  match: AutoTriggerMatch,
): NormalizedMessage {
  const body = msg.content.trim() || '（自动触发消息没有可读正文，请解析 interactive_card 块。）';
  return {
    ...msg,
    content: `${match.prompt}\n\n${body}`,
  } as NormalizedMessage;
}

function matchesList(values: readonly string[] | undefined, actual: string | undefined): boolean {
  if (!values || values.length === 0) return true;
  if (!actual) return false;
  return values.includes(actual);
}

function searchableMessageText(msg: NormalizedMessage): string {
  const rawContent = (msg.raw as { message?: { content?: unknown } } | undefined)?.message
    ?.content;
  return [msg.content, typeof rawContent === 'string' ? rawContent : undefined]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function includesAll(haystack: string, needles: readonly string[] | undefined): boolean {
  if (!needles || needles.length === 0) return true;
  return needles.every((needle) => haystack.includes(needle));
}

function includesAnyWhenConfigured(
  haystack: string,
  needles: readonly string[] | undefined,
): boolean {
  if (!needles || needles.length === 0) return true;
  return needles.some((needle) => haystack.includes(needle));
}

function senderTypeOf(msg: NormalizedMessage): 'user' | 'bot' | undefined {
  const raw = msg.raw as { sender?: { sender_type?: unknown } } | undefined;
  const senderType = raw?.sender?.sender_type;
  if (senderType === 'user') return 'user';
  if (senderType === 'app' || senderType === 'bot') return 'bot';
  return undefined;
}
