import { isRecord } from './identity';
import { ClaudeOauth } from './types';

const API = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** The public OAuth client of Claude Code; the CLI and the extension use the same one. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
const DEFAULT_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];

const TIMEOUT_MS = 10_000;
/** Kept short: a refresh of the live account runs while holding the CLI's storage lock. */
const REFRESH_TIMEOUT_MS = 6_000;

/** An HTTP failure with enough structure for the caller to act on. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** `invalid_grant` and friends: the refresh token is gone for good. */
    readonly deadGrant = false,
    /** Seconds, from `Retry-After`. */
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }

  get isAuth(): boolean {
    return this.deadGrant || this.status === 401 || this.status === 403;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

let userAgent = 'claude-accounts';

export function setUserAgent(version: string): void {
  userAgent = `claude-accounts/${version} (vscode)`;
}

async function request(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    const reason = (error as Error).name === 'TimeoutError' ? 'timed out' : cause ?? (error as Error).message;
    throw new ApiError(`${init.method ?? 'GET'} ${new URL(url).pathname} failed: ${reason}`, null);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text for the error message.
  }
  if (!response.ok) {
    const error = isRecord(body) ? body.error : undefined;
    const code = typeof error === 'string' ? error : isRecord(error) && typeof error.type === 'string' ? error.type : '';
    const detail = isRecord(body) && typeof body.error_description === 'string'
      ? body.error_description
      : isRecord(error) && typeof error.message === 'string'
        ? error.message
        : typeof text === 'string' ? text.slice(0, 300) : '';
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiError(
      `${init.method ?? 'GET'} ${new URL(url).pathname} failed: ${response.status}${code ? ` ${code}` : ''}${detail ? ` — ${detail}` : ''}`,
      response.status,
      /invalid_grant|invalid_refresh_token|refresh token/i.test(`${code} ${detail}`),
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return body;
}

function bearer(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': OAUTH_BETA,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': userAgent,
  };
}

/** `GET /api/oauth/usage` — plan limits for the account that owns the token. */
export function fetchUsageRaw(accessToken: string): Promise<unknown> {
  return request(`${API}/api/oauth/usage`, { method: 'GET', headers: bearer(accessToken) });
}

/** `GET /api/oauth/profile` — who owns the token. */
export function fetchProfile(accessToken: string): Promise<unknown> {
  return request(`${API}/api/oauth/profile`, {
    method: 'GET',
    headers: { ...bearer(accessToken), 'Cache-Control': 'no-cache' },
  });
}

/**
 * Renews an access token. The answer may carry a new refresh token, and when
 * it does the old one stops working — so whatever called this has to persist
 * the result before anything else reads the old copy.
 */
export async function refreshOauth(oauth: ClaudeOauth): Promise<ClaudeOauth> {
  const scopes = (oauth.scopes?.length ? oauth.scopes : DEFAULT_SCOPES).filter(
    // A subscription token never carries this one, and asking for it fails.
    (scope) => scope !== 'org:create_api_key',
  );
  const body = await request(
    TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
        scope: scopes.join(' '),
      }),
    },
    REFRESH_TIMEOUT_MS,
  );
  if (!isRecord(body) || typeof body.access_token !== 'string') {
    throw new ApiError('Token refresh returned no access token.', null);
  }
  const now = Date.now();
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const refreshExpiresIn = typeof body.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : 0;
  return {
    ...oauth,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : oauth.refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : oauth.refreshTokenExpiresAt ?? null,
    scopes: typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim().split(/\s+/) : oauth.scopes,
  };
}
