import { ClaudeAuth, ClaudeOauth, Identity, OauthAccount } from './types';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Who an account is. The OAuth token is opaque, so this comes from the
 * `oauthAccount` block the CLI writes next to it, and the plan from the
 * credential itself.
 */
export function readIdentity(auth: Partial<ClaudeAuth> | null | undefined): Identity {
  const account = auth?.oauthAccount;
  const oauth = auth?.claudeAiOauth;
  return {
    accountUuid: asString(account?.accountUuid),
    organizationUuid: asString(account?.organizationUuid),
    email: asString(account?.emailAddress),
    name: asString(account?.displayName),
    organizationName: asString(account?.organizationName),
    planType: asString(oauth?.subscriptionType),
    rateLimitTier: asString(oauth?.rateLimitTier),
  };
}

/** A credential is only useful if the session can be renewed from it. */
export function isUsableOauth(oauth: ClaudeOauth | null | undefined): oauth is ClaudeOauth {
  return Boolean(oauth && asString(oauth.accessToken) && asString(oauth.refreshToken));
}

export function isUsableAuth(auth: Partial<ClaudeAuth> | null | undefined): auth is ClaudeAuth {
  return isUsableOauth(auth?.claudeAiOauth);
}

/** Whether the access token is expired or will be within `marginMs`. */
export function isExpiring(oauth: ClaudeOauth, marginMs = 5 * 60_000): boolean {
  return typeof oauth.expiresAt !== 'number' || oauth.expiresAt - marginMs <= Date.now();
}

/**
 * Two accounts are the same when the account *and* the organization match. The
 * account UUID alone is the person: one person with a personal plan and a Team
 * seat has two separate subscriptions, with separate limits, under one UUID.
 * The organization is compared only when both sides know it.
 */
export function sameAccount(a: Identity, b: Identity): boolean {
  if (!a.accountUuid || !b.accountUuid || a.accountUuid !== b.accountUuid) {
    return false;
  }
  return !a.organizationUuid || !b.organizationUuid || a.organizationUuid === b.organizationUuid;
}

/** A stable string for an identity, used for the dismissed list. */
export function identityKey(identity: Identity): string | undefined {
  return identity.accountUuid ? `${identity.accountUuid}/${identity.organizationUuid ?? ''}` : undefined;
}

/**
 * Builds the `oauthAccount` block from a `GET /api/oauth/profile` response,
 * with the same field mapping the CLI uses when it writes `.claude.json`.
 */
export function oauthAccountFromProfile(profile: unknown): OauthAccount | null {
  if (!isRecord(profile) || !isRecord(profile.account) || !isRecord(profile.organization)) {
    return null;
  }
  const { account, organization } = profile;
  const accountUuid = asString(account.uuid);
  if (!accountUuid) {
    return null;
  }
  const block: OauthAccount = {
    accountUuid,
    emailAddress: asString(account.email),
    organizationUuid: asString(organization.uuid),
    displayName: asString(account.display_name),
    fullName: asString(account.full_name),
    organizationName: asString(organization.name),
    hasExtraUsageEnabled: organization.has_extra_usage_enabled === true,
    billingType: asString(organization.billing_type),
    accountCreatedAt: asString(account.created_at),
    subscriptionCreatedAt: asString(organization.subscription_created_at),
    profileFetchedAt: Date.now(),
  };
  // Drop what the server did not send, so a merge never blanks a known field.
  for (const key of Object.keys(block)) {
    if (block[key] === undefined) {
      delete block[key];
    }
  }
  return block;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
