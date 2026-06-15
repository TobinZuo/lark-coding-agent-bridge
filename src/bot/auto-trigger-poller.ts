import type {
  ApiMessageItem,
  LarkChannel,
  NormalizedMessage,
  RawMessageEvent,
} from '@larksuite/channel';
import { normalize } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { AppConfig, AutoTriggerRule } from '../config/schema';
import { log } from '../core/logger';
import { canUseGroup } from '../policy/access';
import { expandInteractiveCard } from './interactive-card';
import type { ChatModeCache } from './chat-mode-cache';
import type { PendingQueue } from './pending-queue';
import { matchAutoTrigger, withAutoTriggerPrompt } from './auto-trigger';

const DEFAULT_POLL_INTERVAL_SECONDS = 30;
const DEFAULT_POLL_LOOKBACK_SECONDS = 180;
const DEFAULT_POLL_PAGE_SIZE = 20;
const SEEN_MESSAGE_LIMIT = 5_000;
const MAX_POLL_PAGES = 10;

export interface AutoTriggerPoller {
  stop(): void;
  pollNow(): Promise<number>;
}

export interface AutoTriggerPollerDeps {
  channel: LarkChannel;
  controls: Controls;
  pending: PendingQueue;
  chatModeCache: ChatModeCache;
  seen?: RecentMessageSet;
  now?: () => number;
}

interface PollableRule {
  rule: AutoTriggerRule;
  ruleName: string;
  chatId: string;
  pollIntervalSeconds: number;
  pollLookbackSeconds: number;
  pollPageSize: number;
}

type ListedMessageItem = Omit<ApiMessageItem, 'mentions' | 'sender'> & {
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  deleted?: boolean;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
    sender_name?: string;
  };
  mentions?: Array<{
    key?: string;
    id?: string | { open_id?: string; user_id?: string; union_id?: string };
    id_type?: string;
    name?: string;
    tenant_key?: string;
  }>;
};

export class RecentMessageSet {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = SEEN_MESSAGE_LIMIT) {}

  add(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    this.order.push(messageId);
    while (this.order.length > this.maxEntries) {
      const expired = this.order.shift();
      if (expired) this.seen.delete(expired);
    }
    return true;
  }
}

export function startAutoTriggerPoller(deps: AutoTriggerPollerDeps): AutoTriggerPoller {
  const seen = deps.seen ?? new RecentMessageSet();
  const now = deps.now ?? Date.now;
  const initialRules = pollableRules(deps.controls.cfg);
  if (initialRules.length === 0) {
    return {
      stop() {},
      pollNow: () => pollAutoTriggersOnce({ ...deps, seen, now }),
    };
  }

  const intervalMs =
    Math.min(...initialRules.map((rule) => rule.pollIntervalSeconds)) * 1000;
  let stopped = false;
  let inFlight = false;

  const runOnce = async (): Promise<number> => {
    if (stopped || inFlight) return 0;
    inFlight = true;
    try {
      return await pollAutoTriggersOnce({ ...deps, seen, now });
    } catch (err) {
      log.warn('auto-trigger-poll', 'failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  void runOnce();
  log.info('auto-trigger-poll', 'started', {
    rules: initialRules.length,
    intervalMs,
  });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      log.info('auto-trigger-poll', 'stopped');
    },
    pollNow: runOnce,
  };
}

export async function pollAutoTriggersOnce(deps: AutoTriggerPollerDeps): Promise<number> {
  const rules = pollableRules(deps.controls.cfg);
  if (rules.length === 0) return 0;

  let queued = 0;
  const seen = deps.seen ?? new RecentMessageSet();
  const now = deps.now ?? Date.now;
  for (const rule of rules) {
    const access = canUseGroup(
      deps.controls.profileConfig,
      deps.controls,
      rule.chatId,
      rule.rule.senderIds?.[0] ?? '',
    );
    if (!access.ok) {
      log.info('auto-trigger-poll', 'skip-chat-not-allowed', {
        chatId: rule.chatId,
        rule: rule.ruleName,
        reason: access.reason,
      });
      continue;
    }

    const items = await listRecentMessages(deps.channel, rule, now());
    for (const item of items) {
      const messageId = item.message_id;
      if (!messageId || item.deleted) continue;
      if (!seen.add(messageId)) continue;

      const msg = await normalizeListedMessage(deps.channel, item, rule.chatId);
      if (!msg) continue;
      const match = matchAutoTrigger(msg, deps.controls.cfg, {
        botOpenId: deps.channel.botIdentity?.openId,
      });
      if (!match || match.rule !== rule.rule) continue;

      const mode = await deps.chatModeCache.resolve(deps.channel, msg.chatId);
      const scope = mode === 'topic' && msg.threadId ? `${msg.chatId}:${msg.threadId}` : msg.chatId;
      const queuedMsg = withAutoTriggerPrompt(msg, match);
      const size = deps.pending.push(scope, queuedMsg);
      queued++;
      log.info('auto-trigger-poll', 'queued', {
        chatId: msg.chatId,
        messageId: msg.messageId,
        scope,
        queueSize: size,
        rule: match.ruleName,
      });
    }
  }
  return queued;
}

function pollableRules(cfg: AppConfig): PollableRule[] {
  const out: PollableRule[] = [];
  for (const [index, rule] of (cfg.preferences?.autoTriggers ?? []).entries()) {
    if (rule.enabled === false || rule.polling !== true) continue;
    for (const chatId of rule.chatIds ?? []) {
      out.push({
        rule,
        ruleName: rule.name || `auto-trigger-${index + 1}`,
        chatId,
        pollIntervalSeconds: rule.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
        pollLookbackSeconds: rule.pollLookbackSeconds ?? DEFAULT_POLL_LOOKBACK_SECONDS,
        pollPageSize: rule.pollPageSize ?? DEFAULT_POLL_PAGE_SIZE,
      });
    }
  }
  return out;
}

async function listRecentMessages(
  channel: LarkChannel,
  rule: PollableRule,
  nowMs: number,
): Promise<ListedMessageItem[]> {
  const endTime = Math.floor(nowMs / 1000);
  const startTime = Math.max(0, endTime - rule.pollLookbackSeconds);
  const items: ListedMessageItem[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_POLL_PAGES; page++) {
      const response = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: rule.chatId,
          start_time: String(startTime),
          end_time: String(endTime),
          sort_type: 'ByCreateTimeAsc',
          page_size: rule.pollPageSize,
          card_msg_content_type: 'user_card_content',
          only_thread_root_messages: false,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const data = response.data as
        | { items?: ListedMessageItem[]; has_more?: boolean; page_token?: string }
        | undefined;
      items.push(...(data?.items ?? []));
      if (!data?.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return items;
  } catch (err) {
    log.warn('auto-trigger-poll', 'list-failed', {
      chatId: rule.chatId,
      rule: rule.ruleName,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function normalizeListedMessage(
  channel: LarkChannel,
  item: ListedMessageItem,
  fallbackChatId: string,
): Promise<NormalizedMessage | undefined> {
  const messageId = item.message_id;
  if (!messageId) return undefined;
  const raw = rawMessageEventFromItem(item, fallbackChatId);
  try {
    const normalized = await normalize(raw, {
      botIdentity: channel.botIdentity ?? { openId: '', name: '' },
      fetchSubMessages: async (mid) => {
        try {
          return await channel.fetchRawMessage(mid, {
            cardContentType: 'user_card_content',
          });
        } catch {
          return [];
        }
      },
      stripBotMentions: false,
    });
    return {
      ...normalized,
      chatId: item.chat_id || normalized.chatId || fallbackChatId,
      chatType: 'group',
      senderName: item.sender?.sender_name ?? normalized.senderName,
      rootId: item.root_id ?? normalized.rootId,
      threadId: item.thread_id ?? normalized.threadId,
      replyToMessageId: item.parent_id ?? normalized.replyToMessageId,
      content: expandInteractiveCard(normalized.content, item.body?.content),
      raw,
    };
  } catch (err) {
    log.warn('auto-trigger-poll', 'normalize-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function rawMessageEventFromItem(
  item: ListedMessageItem,
  fallbackChatId: string,
): RawMessageEvent {
  return {
    sender: {
      sender_id: { open_id: item.sender?.id },
      sender_type: item.sender?.sender_type,
      tenant_key: item.sender?.tenant_key,
    },
    message: {
      message_id: item.message_id ?? '',
      root_id: item.root_id,
      parent_id: item.parent_id,
      thread_id: item.thread_id,
      chat_id: item.chat_id ?? fallbackChatId,
      chat_type: 'group',
      message_type: item.msg_type ?? 'text',
      content: item.body?.content ?? '',
      create_time: item.create_time !== undefined ? String(item.create_time) : undefined,
      mentions: normalizeRawMentions(item.mentions),
    },
  };
}

function normalizeRawMentions(
  mentions: ListedMessageItem['mentions'],
): RawMessageEvent['message']['mentions'] {
  if (!mentions) return undefined;
  const out: NonNullable<RawMessageEvent['message']['mentions']> = [];
  for (const mention of mentions) {
    if (!mention.key) continue;
    const id = mention.id;
    if (id && typeof id === 'object') {
      out.push({
        key: mention.key,
        id,
        name: mention.name,
        tenant_key: mention.tenant_key,
      });
      continue;
    }
    if (typeof id !== 'string') continue;
    out.push({
      key: mention.key,
      id: idObject(mention.id_type, id),
      name: mention.name,
      tenant_key: mention.tenant_key,
    });
  }
  return out.length > 0 ? out : undefined;
}

function idObject(idType: string | undefined, id: string): {
  open_id?: string;
  user_id?: string;
  union_id?: string;
} {
  if (idType === 'user_id') return { user_id: id };
  if (idType === 'union_id') return { union_id: id };
  return { open_id: id };
}
