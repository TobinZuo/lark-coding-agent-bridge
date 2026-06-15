import type { ApiMessageItem, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { AppConfig, LarkBotPollerConfig } from '../config/schema';
import { log } from '../core/logger';
import { normalizeIncomingMessage, normalizedMessageFromIncoming } from './auto-answer';

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_OVERLAP_MS = 180_000;
const DEFAULT_MAX_LOOKBACK_MS = 900_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGES = 10;
const MAX_SEEN_MESSAGES = 5_000;
const TIMER_GRANULARITY_MS = 5_000;

export interface LarkMessagePoller {
  stop(): void;
  pollNow(): Promise<number>;
}

export interface StartLarkMessagePollerOptions {
  channel: LarkChannel;
  controls: Controls;
  botOpenId?: string;
  onMessage(msg: NormalizedMessage): Promise<void> | void;
  now?: () => number;
}

export interface PollLarkMessagesOptions extends StartLarkMessagePollerOptions {
  state: PollerState;
}

interface PollerChatState {
  lastSeenCreateTime: number;
  backoffUntil?: number;
  backoffMs?: number;
}

export class PollerState {
  readonly startedAtMs: number;
  private readonly chats = new Map<string, PollerChatState>();
  private readonly seen = new RecentMessageSet();

  constructor(startedAtMs = Date.now()) {
    this.startedAtMs = startedAtMs;
  }

  getChat(chatId: string): PollerChatState | undefined {
    return this.chats.get(chatId);
  }

  initChat(chatId: string, lastSeenCreateTime: number): PollerChatState {
    const state = { lastSeenCreateTime };
    this.chats.set(chatId, state);
    return state;
  }

  markSeen(messageId: string): boolean {
    return this.seen.add(messageId);
  }
}

class RecentMessageSet {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxEntries = MAX_SEEN_MESSAGES) {}

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

interface PollTarget {
  chatId: string;
  overlapMs: number;
  maxLookbackMs: number;
  pageSize: number;
}

interface ListedMessageItem {
  message_id?: string;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  message_type?: string;
  create_time?: string | number;
  deleted?: boolean;
  body?: { content?: unknown };
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
    is_bot?: boolean;
    user_type?: string;
  }>;
}

export function startLarkMessagePoller(opts: StartLarkMessagePollerOptions): LarkMessagePoller {
  const now = opts.now ?? Date.now;
  const state = new PollerState(now());
  let stopped = false;
  let inFlight = false;
  let nextRunAt = 0;

  const run = async (force = false): Promise<number> => {
    if (stopped || inFlight) return 0;
    const current = now();
    const intervalMs = pollIntervalMs(opts.controls.cfg.larkBot?.poller);
    if (!force && current < nextRunAt) return 0;
    nextRunAt = current + intervalMs;
    inFlight = true;
    try {
      return await pollLarkMessagesOnce({ ...opts, now, state });
    } catch (err) {
      log.warn('message-poller', 'failed', { err: errorMessage(err) });
      return 0;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void run(), TIMER_GRANULARITY_MS);
  void run(true);
  log.info('message-poller', 'started', { startedAtMs: state.startedAtMs });

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      log.info('message-poller', 'stopped');
    },
    pollNow: () => run(true),
  };
}

export async function pollLarkMessagesOnce(opts: PollLarkMessagesOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  const current = now();
  const targets = pollTargets(opts.controls.cfg);
  if (targets.length === 0) return 0;

  let handled = 0;
  for (const target of targets) {
    let chatState = opts.state.getChat(target.chatId);
    if (!chatState) {
      chatState = opts.state.initChat(target.chatId, current);
      log.info('message-poller', 'chat-warmup', {
        chatId: target.chatId,
        lastSeenCreateTime: chatState.lastSeenCreateTime,
      });
      continue;
    }
    if (chatState.backoffUntil && chatState.backoffUntil > current) continue;
    const windowStartMs = Math.max(
      opts.state.startedAtMs,
      chatState.lastSeenCreateTime - target.overlapMs,
      current - target.maxLookbackMs,
    );
    let items: ListedMessageItem[];
    try {
      items = await listMessages(opts.channel, target, windowStartMs, current);
      chatState.backoffMs = undefined;
      chatState.backoffUntil = undefined;
    } catch (err) {
      const backoffMs = Math.min(Math.max(chatState.backoffMs ?? 5_000, 5_000) * 2, 5 * 60_000);
      chatState.backoffMs = backoffMs;
      chatState.backoffUntil = current + backoffMs;
      log.warn('message-poller', 'list-failed', {
        chatId: target.chatId,
        backoffMs,
        err: errorMessage(err),
      });
      continue;
    }

    let maxSeenCreateTime = chatState.lastSeenCreateTime;
    for (const item of sortItems(items)) {
      const messageId = stringValue(item.message_id);
      const createTime = timestampMs(item.create_time);
      if (!messageId || item.deleted === true) continue;
      if (createTime) maxSeenCreateTime = Math.max(maxSeenCreateTime, createTime);
      if (!createTime || createTime <= opts.state.startedAtMs) continue;
      if (!opts.state.markSeen(messageId)) continue;

      const msg = await normalizePolledMessage(opts.channel, item, target.chatId, opts.botOpenId);
      if (!msg) continue;
      await opts.onMessage(msg);
      handled++;
    }
    chatState.lastSeenCreateTime = Math.max(maxSeenCreateTime, current);
    log.info('message-poller', 'polled', {
      chatId: target.chatId,
      count: items.length,
      handled,
      lastSeenCreateTime: chatState.lastSeenCreateTime,
    });
  }
  return handled;
}

function pollTargets(cfg: AppConfig): PollTarget[] {
  const poller = cfg.larkBot?.poller;
  if (poller?.enabled !== true) return [];
  if (poller.leaderId && process.env.LARK_CHANNEL_INSTANCE_ID !== poller.leaderId) return [];
  const chatIds = [...new Set((poller.chatIds ?? []).filter((id) => id.trim()))];
  if (chatIds.length === 0) return [];
  return chatIds.map((chatId) => ({
    chatId,
    overlapMs: positiveMs(poller.overlapMs, DEFAULT_OVERLAP_MS),
    maxLookbackMs: positiveMs(poller.maxLookbackMs, DEFAULT_MAX_LOOKBACK_MS),
    pageSize: pageSize(poller.pageSize),
  }));
}

function pollIntervalMs(poller: LarkBotPollerConfig | undefined): number {
  return Math.max(5_000, positiveMs(poller?.intervalMs, DEFAULT_INTERVAL_MS));
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function pageSize(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(50, Math.floor(value))
    : DEFAULT_PAGE_SIZE;
}

async function listMessages(
  channel: LarkChannel,
  target: PollTarget,
  startMs: number,
  endMs: number,
): Promise<ListedMessageItem[]> {
  const items: ListedMessageItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await callMessageList(channel, {
      container_id_type: 'chat',
      container_id: target.chatId,
      start_time: String(Math.floor(startMs / 1000)),
      end_time: String(Math.ceil(endMs / 1000)),
      sort_type: 'ByCreateTimeAsc',
      page_size: target.pageSize,
      card_msg_content_type: 'user_card_content',
      only_thread_root_messages: false,
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    const data = responseData(response);
    items.push(...data.items);
    if (!data.hasMore || !data.pageToken) break;
    pageToken = data.pageToken;
  }
  return items;
}

async function callMessageList(channel: LarkChannel, params: Record<string, unknown>): Promise<unknown> {
  const rawClient = channel.rawClient as {
    im?: { v1?: { message?: { list?: (input: unknown) => Promise<unknown> } } };
    request?: (input: unknown) => Promise<unknown>;
  };
  const list = rawClient.im?.v1?.message?.list;
  if (list) return list.call(rawClient.im?.v1?.message, { params });
  if (rawClient.request) {
    return rawClient.request({
      method: 'GET',
      url: '/open-apis/im/v1/messages',
      params,
    });
  }
  throw new Error('channel raw client does not support im.v1.message.list');
}

function responseData(response: unknown): { items: ListedMessageItem[]; hasMore: boolean; pageToken?: string } {
  const data = isRecord(response) && isRecord(response.data) ? response.data : response;
  if (!isRecord(data)) return { items: [], hasMore: false };
  const items = Array.isArray(data.items) ? data.items.filter(isRecord).map((item) => item as ListedMessageItem) : [];
  const pageToken = stringValue(data.page_token) || stringValue(data.pageToken);
  return {
    items,
    hasMore: data.has_more === true || data.hasMore === true,
    ...(pageToken ? { pageToken } : {}),
  };
}

async function normalizePolledMessage(
  channel: LarkChannel,
  item: ListedMessageItem,
  fallbackChatId: string,
  botOpenId?: string,
): Promise<NormalizedMessage | undefined> {
  const messageId = stringValue(item.message_id);
  if (!messageId) return undefined;
  const enriched = await enrichInteractiveItem(channel, item);
  const incoming = normalizeIncomingMessage(rawEventFromItem(enriched, fallbackChatId), botOpenId);
  if (!incoming) return undefined;
  return normalizedMessageFromIncoming({
    ...incoming,
    ...(enriched.sender?.sender_name ? { senderName: enriched.sender.sender_name } : {}),
  }, { botOpenId });
}

async function enrichInteractiveItem(channel: LarkChannel, item: ListedMessageItem): Promise<ListedMessageItem> {
  const type = stringValue(item.msg_type) || stringValue(item.message_type);
  const messageId = stringValue(item.message_id);
  if (type !== 'interactive' || !messageId) return item;
  try {
    const items = await channel.fetchRawMessage(messageId, { cardContentType: 'user_card_content' });
    const parent = items[0] as (ApiMessageItem & ListedMessageItem) | undefined;
    if (!parent?.message_id) return item;
    return {
      ...item,
      ...parent,
      chat_id: item.chat_id ?? parent.chat_id,
      root_id: item.root_id ?? parent.root_id,
      parent_id: item.parent_id ?? parent.parent_id,
      thread_id: item.thread_id ?? parent.thread_id,
      sender: item.sender ?? parent.sender,
      mentions: item.mentions ?? parent.mentions,
      body: {
        ...(item.body ?? {}),
        ...(parent.body ?? {}),
        content: parent.body?.content ?? item.body?.content,
      },
    };
  } catch (err) {
    log.warn('message-poller', 'fetch-raw-failed', {
      messageId,
      err: errorMessage(err),
    });
    return item;
  }
}

function rawEventFromItem(item: ListedMessageItem, fallbackChatId: string): unknown {
  return {
    event: {
      sender: {
        sender_id: { open_id: item.sender?.id },
        sender_type: item.sender?.sender_type,
        tenant_key: item.sender?.tenant_key,
      },
      message: {
        message_id: item.message_id,
        chat_id: item.chat_id ?? fallbackChatId,
        chat_type: 'group',
        message_type: item.msg_type ?? item.message_type ?? 'text',
        content: typeof item.body?.content === 'string'
          ? item.body.content
          : JSON.stringify(item.body?.content ?? ''),
        create_time: item.create_time !== undefined ? String(timestampMs(item.create_time) ?? item.create_time) : undefined,
        ...(item.thread_id ? { thread_id: item.thread_id } : {}),
        ...(item.root_id ? { root_id: item.root_id } : {}),
        ...(item.parent_id ? { parent_id: item.parent_id } : {}),
        ...(item.mentions ? { mentions: normalizeMentions(item.mentions) } : {}),
      },
    },
  };
}

function normalizeMentions(mentions: ListedMessageItem['mentions']): unknown[] | undefined {
  if (!mentions) return undefined;
  const out = mentions
    .filter((mention) => mention.key)
    .map((mention) => ({
      key: mention.key,
      id: typeof mention.id === 'string' ? idObject(mention.id_type, mention.id) : mention.id,
      name: mention.name,
      tenant_key: mention.tenant_key,
      is_bot: mention.is_bot,
      user_type: mention.user_type,
    }));
  return out.length > 0 ? out : undefined;
}

function idObject(idType: string | undefined, id: string): { open_id?: string; user_id?: string; union_id?: string } {
  if (idType === 'user_id') return { user_id: id };
  if (idType === 'union_id') return { union_id: id };
  return { open_id: id };
}

function sortItems(items: ListedMessageItem[]): ListedMessageItem[] {
  return [...items].sort((a, b) => {
    const at = timestampMs(a.create_time) ?? 0;
    const bt = timestampMs(b.create_time) ?? 0;
    if (at !== bt) return at - bt;
    return stringValue(a.message_id).localeCompare(stringValue(b.message_id));
  });
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
