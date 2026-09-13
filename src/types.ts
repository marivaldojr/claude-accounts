/** `claudeAiOauth` in `.credentials.json`, as the CLI writes it. */
export interface ClaudeOauth {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  /** Milliseconds since the epoch, when the server reports one. */
  refreshTokenExpiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  [key: string]: unknown;
}

/** The whole `.credentials.json`. Other keys (MCP tokens) are left alone on a switch. */
export interface CredentialsFile {
  claudeAiOauth?: ClaudeOauth;
  [key: string]: unknown;
}

/** `oauthAccount` in `.claude.json` — who the signed-in account is. */
export interface OauthAccount {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  displayName?: string;
  organizationName?: string;
  [key: string]: unknown;
}

/**
 * What one profile keeps in SecretStorage: the credential plus the identity
 * block, because a switch has to write both — Claude Code reads the tokens from
 * one file and the account it shows from the other.
 */
export interface ClaudeAuth {
  claudeAiOauth: ClaudeOauth;
  oauthAccount?: OauthAccount;
}

export interface Identity {
  accountUuid?: string;
  organizationUuid?: string;
  email?: string;
  name?: string;
  organizationName?: string;
  planType?: string;
  rateLimitTier?: string;
}

/** A normalized limit window. */
export interface UsageWindow {
  /** `session` (5h), `weekly` (all models), `scoped` (one model/surface), `other`. */
  kind: 'session' | 'weekly' | 'scoped' | 'other';
  label: string;
  usedPercent: number;
  /** Unix timestamp in seconds. */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
  extraUsage?: { enabled: boolean; utilization: number | null; spendLimitReached: boolean };
  /** Short, readable reason. The raw text goes in `errorDetail`. */
  error?: string;
  /** `auth`: only a login fixes it. `rate`: the endpoint said slow down. */
  errorKind?: 'auth' | 'rate' | 'other';
  errorDetail?: string;
  /** The windows are from an earlier reading, kept because this one failed. */
  stale?: boolean;
}

/** Profile metadata. The secret (a `ClaudeAuth`) lives in SecretStorage, never here. */
export interface Profile {
  id: string;
  label: string;
  order: number;
  addedAt: number;
  accountUuid?: string;
  organizationUuid?: string;
  email?: string;
  name?: string;
  organizationName?: string;
  planType?: string;
  lastUsage?: UsageSnapshot;
}

/** A profile decorated for the webview. */
export interface ProfileView extends Profile {
  active: boolean;
}
