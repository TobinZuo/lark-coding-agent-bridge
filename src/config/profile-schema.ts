import type {
  AppCredentials,
  LarkBotConfig,
  LarkBotMessageType,
  LarkBotTriggerRule,
  AppPreferences,
  MessageReplyMode,
  SecretsConfig,
} from './schema';
import {
  normalizePermissions,
  permissionsToLegacySandbox,
  type AccessMode,
  type CodexSandboxMode,
  type PermissionConfig,
  type PermissionSource,
} from './permissions';

export type AgentKind = 'claude' | 'codex';
export type SandboxMode = CodexSandboxMode;
export type { AccessMode, PermissionConfig, PermissionSource };

export interface ProfileAccess {
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  requireMentionInGroup: boolean;
}

export interface SandboxConfig {
  default?: SandboxMode;
  max?: SandboxMode;
  defaultMode: SandboxMode;
  maxMode: SandboxMode;
}

export interface CodexConfig {
  binaryPath: string;
  realpath?: string;
  version?: string;
  sha256?: string;
  owner?: number;
  mode?: number;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

export interface AttachmentConfig {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  cacheTtlMs: number;
  cacheMaxBytes: number;
}

export type CommentConfig = Record<string, never>;

export type LarkCliIdentityPreset = 'bot-only' | 'user-default';

export type LarkCliUserImportStatus =
  | 'not-needed'
  | 'imported'
  | 'skipped-existing-private-user'
  | 'skipped-no-local-user'
  | 'failed';

export interface LarkCliConfig {
  identityPreset: LarkCliIdentityPreset;
  localUserImport?: {
    status: LarkCliUserImportStatus;
    attemptedAt?: string;
    importedAt?: string;
    reason?: string;
  };
}

export interface ProfileConfig {
  schemaVersion: 2;
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  larkBot?: LarkBotConfig;
  preferences: Omit<AppPreferences, 'access' | 'requireMentionInGroup'>;
  access: ProfileAccess;
  workspaces: {
    default?: string;
  };
  sandbox: SandboxConfig;
  permissions: PermissionConfig;
  permissionSource?: PermissionSource;
  codex?: CodexConfig;
  attachments: AttachmentConfig;
  comments: CommentConfig;
  larkCli: LarkCliConfig;
}

export interface RootConfig {
  schemaVersion: 2;
  activeProfile: string;
  preferences: Record<string, never>;
  secrets?: SecretsConfig;
  migrations?: {
    permissionDefaultsV1?: string[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface CreateDefaultProfileConfigInput {
  agentKind: AgentKind;
  accounts: {
    app: AppCredentials;
  };
  preferences?: AppPreferences;
  access?: Partial<ProfileAccess>;
  sandbox?: Partial<SandboxConfig>;
  permissions?: Partial<PermissionConfig>;
  codex?: CodexConfig;
  secrets?: SecretsConfig;
  larkBot?: LarkBotConfig;
}

export function createDefaultProfileConfig(
  input: CreateDefaultProfileConfigInput,
): ProfileConfig {
  return normalizeProfileConfig({
    schemaVersion: 2,
    ...input,
  });
}

export function normalizeProfileConfig(input: unknown): ProfileConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('profile config must be an object');
  }
  const raw = input as {
    schemaVersion?: unknown;
    agentKind?: unknown;
    accounts?: unknown;
    secrets?: SecretsConfig;
    larkBot?: unknown;
    preferences?: (AppPreferences & { access?: Partial<ProfileAccess> }) | undefined;
    access?: Partial<ProfileAccess>;
    workspaces?: {
      default?: unknown;
      // Legacy workspace authorization fields are accepted for config
      // compatibility only; normalizeWorkspaces drops them.
      trusted?: unknown;
      trustedRoots?: unknown;
      riskFlags?: unknown;
    };
    sandbox?: Partial<SandboxConfig>;
    permissions?: Partial<PermissionConfig>;
    codex?: CodexConfig & { flags?: unknown };
    attachments?: Partial<AttachmentConfig>;
    comments?: unknown;
    larkCli?: unknown;
  };

  if (raw.schemaVersion !== 2) {
    throw new Error('profile schemaVersion must be 2');
  }
  if (raw.agentKind !== 'claude' && raw.agentKind !== 'codex') {
    throw new Error('agentKind must be claude or codex');
  }
  const accounts = normalizeAccounts(raw.accounts);
  if (raw.agentKind === 'codex' && !raw.codex) {
    throw new Error('codex profile requires codex configuration');
  }

  const preferences = normalizePreferences(raw.preferences);
  const larkBot = normalizeLarkBot(raw.larkBot);
  const access = normalizeAccess(
    raw.access ?? raw.preferences?.access,
    raw.preferences?.requireMentionInGroup,
  );
  const { permissions, source: permissionSource } = normalizePermissions({
    permissions: raw.permissions,
    sandbox: raw.sandbox,
  });
  const sandbox = permissionsToLegacySandbox(permissions);
  const workspaces = normalizeWorkspaces(raw.workspaces);
  const comments = normalizeComments(raw.comments);
  const larkCli = normalizeLarkCli(raw.larkCli);

  return {
    schemaVersion: 2,
    agentKind: raw.agentKind,
    accounts,
    ...(raw.secrets ? { secrets: raw.secrets } : {}),
    ...(larkBot ? { larkBot } : {}),
    preferences,
    access,
    workspaces,
    sandbox,
    permissions,
    permissionSource,
    ...(raw.codex ? { codex: normalizeCodex(raw.codex) } : {}),
    attachments: {
      maxCount: numberOr(raw.attachments?.maxCount, 10),
      maxBytes: numberOr(raw.attachments?.maxBytes, 100 * 1024 * 1024),
      maxFileBytes: numberOr(raw.attachments?.maxFileBytes, 25 * 1024 * 1024),
      imageMaxBytes: numberOr(raw.attachments?.imageMaxBytes, 25 * 1024 * 1024),
      cacheTtlMs: numberOr(raw.attachments?.cacheTtlMs, 24 * 60 * 60 * 1000),
      cacheMaxBytes: numberOr(raw.attachments?.cacheMaxBytes, 512 * 1024 * 1024),
    },
    comments,
    larkCli,
  };
}

function normalizeLarkBot(input: unknown): LarkBotConfig | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as LarkBotConfig;
  const listener = normalizeLarkBotListener(raw.listener);
  const poller = normalizeLarkBotPoller(raw.poller);
  const rules = Array.isArray(raw.rules)
    ? raw.rules
        .map(normalizeLarkBotRule)
        .filter((rule): rule is NonNullable<ReturnType<typeof normalizeLarkBotRule>> => Boolean(rule))
    : undefined;
  const admins = stringArray(raw.admins);
  const dedupeTtlMs =
    typeof raw.dedupeTtlMs === 'number' && Number.isFinite(raw.dedupeTtlMs) && raw.dedupeTtlMs > 0
      ? Math.floor(raw.dedupeTtlMs)
      : undefined;
  const defaultReplyMode = isMessageReply(raw.defaultReplyMode) ? raw.defaultReplyMode : undefined;
  const out: LarkBotConfig = {
    ...(listener ? { listener } : {}),
    ...(poller ? { poller } : {}),
    ...(rules && rules.length > 0 ? { rules } : {}),
    ...(admins.length > 0 ? { admins } : {}),
    ...(defaultReplyMode ? { defaultReplyMode } : {}),
    ...(dedupeTtlMs ? { dedupeTtlMs } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLarkBotPoller(input: LarkBotConfig['poller'] | undefined): LarkBotConfig['poller'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const intervalMs = positiveInteger(input.intervalMs);
  const overlapMs = positiveInteger(input.overlapMs);
  const maxLookbackMs = positiveInteger(input.maxLookbackMs);
  const pageSize =
    typeof input.pageSize === 'number' && Number.isFinite(input.pageSize) && input.pageSize > 0
      ? Math.min(50, Math.floor(input.pageSize))
      : undefined;
  const chatIds = stringArray(input.chatIds);
  const out: NonNullable<LarkBotConfig['poller']> = {
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(intervalMs ? { intervalMs } : {}),
    ...(overlapMs ? { overlapMs } : {}),
    ...(maxLookbackMs ? { maxLookbackMs } : {}),
    ...(pageSize ? { pageSize } : {}),
    ...(chatIds.length > 0 ? { chatIds } : {}),
    ...(typeof input.leaderId === 'string' && input.leaderId.trim() ? { leaderId: input.leaderId.trim() } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLarkBotListener(input: LarkBotConfig['listener'] | undefined): LarkBotConfig['listener'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const port =
    typeof input.port === 'number' && Number.isFinite(input.port) && input.port > 0
      ? Math.min(65535, Math.floor(input.port))
      : undefined;
  const maxBodyBytes =
    typeof input.maxBodyBytes === 'number' && Number.isFinite(input.maxBodyBytes) && input.maxBodyBytes > 0
      ? Math.floor(input.maxBodyBytes)
      : undefined;
  const eventMaxAgeMs =
    typeof input.eventMaxAgeMs === 'number' && Number.isFinite(input.eventMaxAgeMs) && input.eventMaxAgeMs > 0
      ? Math.floor(input.eventMaxAgeMs)
      : undefined;
  return {
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(typeof input.host === 'string' && input.host.trim() ? { host: input.host.trim() } : {}),
    ...(port ? { port } : {}),
    ...(typeof input.webhookPath === 'string' && input.webhookPath.trim()
      ? { webhookPath: input.webhookPath.trim() }
      : {}),
    ...(input.verificationToken ? { verificationToken: input.verificationToken } : {}),
    ...(input.encryptKey ? { encryptKey: input.encryptKey } : {}),
    ...(maxBodyBytes ? { maxBodyBytes } : {}),
    ...(eventMaxAgeMs ? { eventMaxAgeMs } : {}),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function normalizeLarkBotRule(input: unknown): LarkBotTriggerRule | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as LarkBotTriggerRule;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return undefined;
  const messageTypes = stringArray(raw.messageTypes).filter(isLarkBotMessageType);
  const textMatchers = Array.isArray(raw.textMatchers)
    ? raw.textMatchers.filter(isValidTextMatcher)
    : undefined;
  const cardMatchers = Array.isArray(raw.cardMatchers)
    ? raw.cardMatchers.filter(isValidCardMatcher)
    : undefined;
  const cooldownMs =
    typeof raw.cooldownMs === 'number' && Number.isFinite(raw.cooldownMs) && raw.cooldownMs > 0
      ? Math.floor(raw.cooldownMs)
      : undefined;
  const settleMs =
    typeof raw.settleMs === 'number' && Number.isFinite(raw.settleMs) && raw.settleMs > 0
      ? Math.floor(raw.settleMs)
      : undefined;
  return {
    id: raw.id.trim(),
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(stringArray(raw.chatIds).length > 0 ? { chatIds: stringArray(raw.chatIds) } : {}),
    ...(messageTypes.length > 0 ? { messageTypes } : {}),
    ...(textMatchers && textMatchers.length > 0 ? { textMatchers } : {}),
    ...(cardMatchers && cardMatchers.length > 0 ? { cardMatchers } : {}),
    ...(stringArray(raw.templateIds).length > 0 ? { templateIds: stringArray(raw.templateIds) } : {}),
    ...(stringArray(raw.senderIds).length > 0 ? { senderIds: stringArray(raw.senderIds) } : {}),
    ...(typeof raw.requireMention === 'boolean' ? { requireMention: raw.requireMention } : {}),
    ...(typeof raw.agentProfile === 'string' && raw.agentProfile.trim() ? { agentProfile: raw.agentProfile.trim() } : {}),
    ...(typeof raw.promptTemplate === 'string' && raw.promptTemplate.trim() ? { promptTemplate: raw.promptTemplate.trim() } : {}),
    ...(typeof raw.replyInThread === 'boolean' ? { replyInThread: raw.replyInThread } : {}),
    ...(cooldownMs ? { cooldownMs } : {}),
    ...(settleMs ? { settleMs } : {}),
  };
}

function normalizeAccounts(input: unknown): ProfileConfig['accounts'] {
  if (!input || typeof input !== 'object') {
    throw new Error('accounts.app is required');
  }
  const accounts = input as { app?: Partial<AppCredentials> };
  const app = accounts.app;
  if (!app?.id || !app.secret || (app.tenant !== 'feishu' && app.tenant !== 'lark')) {
    throw new Error('accounts.app is incomplete');
  }
  return {
    app: {
      id: app.id,
      secret: app.secret,
      tenant: app.tenant,
    },
  };
}

function normalizePreferences(
  preferences: AppPreferences | undefined,
): ProfileConfig['preferences'] {
  const {
    access: _access,
    requireMentionInGroup: _mention,
    messageReply,
    ...rest
  } = preferences ?? {};
  if (messageReply !== undefined && isMessageReply(messageReply)) {
    return {
      ...rest,
      messageReply,
    };
  }
  return rest;
}

function isMessageReply(value: unknown): value is MessageReplyMode {
  return value === 'card' || value === 'markdown' || value === 'text';
}

function isLarkBotMessageType(value: string): value is LarkBotMessageType {
  return [
    'text',
    'post',
    'interactive',
    'image',
    'file',
    'audio',
    'media',
    'sticker',
    'system',
  ].includes(value);
}

function isValidTextMatcher(value: unknown): value is NonNullable<NonNullable<LarkBotConfig['rules']>[number]['textMatchers']>[number] {
  if (typeof value === 'string') return value.trim().length > 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const matcher = value as { type?: unknown; value?: unknown; caseSensitive?: unknown };
  return (
    (matcher.type === undefined ||
      matcher.type === 'contains' ||
      matcher.type === 'equals' ||
      matcher.type === 'regex') &&
    typeof matcher.value === 'string' &&
    matcher.value.trim().length > 0 &&
    (matcher.caseSensitive === undefined || typeof matcher.caseSensitive === 'boolean')
  );
}

function isValidCardMatcher(value: unknown): value is NonNullable<NonNullable<LarkBotConfig['rules']>[number]['cardMatchers']>[number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const matcher = value as { path?: unknown; operator?: unknown; caseSensitive?: unknown };
  return (
    (matcher.path === undefined || typeof matcher.path === 'string') &&
    (matcher.operator === undefined ||
      matcher.operator === 'exists' ||
      matcher.operator === 'equals' ||
      matcher.operator === 'contains' ||
      matcher.operator === 'regex') &&
    (matcher.caseSensitive === undefined || typeof matcher.caseSensitive === 'boolean')
  );
}

function normalizeAccess(
  access: Partial<ProfileAccess> | undefined,
  legacyRequireMentionInGroup: boolean | undefined,
): ProfileAccess {
  return {
    allowedUsers: stringArray(access?.allowedUsers),
    allowedChats: stringArray(access?.allowedChats),
    admins: stringArray(access?.admins),
    requireMentionInGroup: access?.requireMentionInGroup ?? legacyRequireMentionInGroup ?? true,
  };
}

function normalizeWorkspaces(input: {
  default?: unknown;
  trusted?: unknown;
  trustedRoots?: unknown;
  riskFlags?: unknown;
} | undefined): ProfileConfig['workspaces'] {
  const defaultWorkspace = typeof input?.default === 'string' && input.default.trim()
    ? input.default.trim()
    : undefined;
  return defaultWorkspace ? { default: defaultWorkspace } : {};
}

function normalizeCodex(input: CodexConfig & { flags?: unknown }): CodexConfig {
  const codex: CodexConfig = {
    binaryPath: input.binaryPath,
    ...(typeof input.realpath === 'string' ? { realpath: input.realpath } : {}),
    ...(typeof input.version === 'string' ? { version: input.version } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256 } : {}),
    ...(typeof input.owner === 'number' ? { owner: input.owner } : {}),
    ...(typeof input.mode === 'number' ? { mode: input.mode } : {}),
    ...(typeof input.codexHome === 'string' ? { codexHome: input.codexHome } : {}),
    inheritCodexHome: input.inheritCodexHome !== false,
    ignoreUserConfig: input.ignoreUserConfig === true,
    ignoreRules: input.ignoreRules !== false,
  };
  return codex;
}

function normalizeComments(_input: unknown): CommentConfig {
  return {};
}

function normalizeLarkCli(input: unknown): LarkCliConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { identityPreset: 'bot-only' };
  }
  const raw = input as {
    identityPreset?: unknown;
    localUserImport?: unknown;
  };
  const identityPreset: LarkCliIdentityPreset =
    raw.identityPreset === 'user-default' ? 'user-default' : 'bot-only';
  const localUserImport = normalizeLarkCliUserImport(raw.localUserImport);
  return {
    identityPreset,
    ...(localUserImport ? { localUserImport } : {}),
  };
}

function normalizeLarkCliUserImport(input: unknown): LarkCliConfig['localUserImport'] | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as {
    status?: unknown;
    attemptedAt?: unknown;
    importedAt?: unknown;
    reason?: unknown;
  };
  if (!isLarkCliUserImportStatus(raw.status)) return undefined;
  return {
    status: raw.status,
    ...(typeof raw.attemptedAt === 'string' ? { attemptedAt: raw.attemptedAt } : {}),
    ...(typeof raw.importedAt === 'string' ? { importedAt: raw.importedAt } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
  };
}

function isLarkCliUserImportStatus(value: unknown): value is LarkCliUserImportStatus {
  return (
    value === 'not-needed' ||
    value === 'imported' ||
    value === 'skipped-existing-private-user' ||
    value === 'skipped-no-local-user' ||
    value === 'failed'
  );
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
