import { isRecord } from './identity';
import { ApiError } from './oauth';
import { UsageSnapshot, UsageWindow } from './types';

function clampPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** ISO 8601 → Unix seconds; `null` when the window is not running. */
function toSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The label of a window scoped to one model or surface ("Fable", "Cowork"). */
function scopeName(scope: unknown): string | null {
  if (!isRecord(scope)) {
    return null;
  }
  for (const key of ['model', 'surface']) {
    const part = scope[key];
    if (isRecord(part)) {
      const name = part.display_name ?? part.name ?? part.id;
      if (typeof name === 'string' && name) {
        return name;
      }
    }
  }
  return null;
}

const KINDS: Record<string, UsageWindow['kind']> = {
  session: 'session',
  weekly_all: 'weekly',
  weekly_scoped: 'scoped',
};

/**
 * `limits[]` is the list the CLI itself renders ("Current week (Fable)"): one
 * entry per window, already labelled, scoped windows carrying their model.
 */
function fromLimits(limits: unknown[]): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const raw of limits) {
    if (!isRecord(raw)) {
      continue;
    }
    const usedPercent = clampPercent(raw.percent);
    if (usedPercent === null) {
      continue;
    }
    const kind = KINDS[String(raw.kind)] ?? 'other';
    const scoped = scopeName(raw.scope);
    let label: string;
    if (kind === 'session') {
      label = '5h';
    } else if (kind === 'weekly') {
      label = '7d';
    } else {
      label = scoped ?? String(raw.group ?? raw.kind ?? 'limit').replace(/_/g, ' ');
    }
    windows.push({ kind: kind === 'other' && scoped ? 'scoped' : kind, label, usedPercent, resetsAt: toSeconds(raw.resets_at) });
  }
  return windows;
}

/** The named objects, for a response that comes without `limits[]`. */
const NAMED: Array<[string, UsageWindow['kind'], string]> = [
  ['five_hour', 'session', '5h'],
  ['seven_day', 'weekly', '7d'],
  ['seven_day_opus', 'scoped', 'Opus'],
  ['seven_day_sonnet', 'scoped', 'Sonnet'],
];

function fromNamed(response: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const [key, kind, label] of NAMED) {
    const raw = response[key];
    if (!isRecord(raw)) {
      continue;
    }
    const usedPercent = clampPercent(raw.utilization);
    if (usedPercent !== null) {
      windows.push({ kind, label, usedPercent, resetsAt: toSeconds(raw.resets_at) });
    }
  }
  return windows;
}

const ORDER: Record<UsageWindow['kind'], number> = { session: 0, weekly: 1, scoped: 2, other: 3 };

/** Normalizes a `GET /api/oauth/usage` response. */
export function normalizeUsage(response: unknown, now = Date.now()): UsageSnapshot {
  const snapshot: UsageSnapshot = { fetchedAt: now, windows: [] };
  if (!isRecord(response)) {
    return { ...snapshot, error: 'Unexpected response from the usage endpoint.', errorKind: 'other' };
  }
  const limits = Array.isArray(response.limits) ? fromLimits(response.limits) : [];
  snapshot.windows = limits.length > 0 ? limits : fromNamed(response);
  snapshot.windows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);

  const extra = response.extra_usage;
  if (isRecord(extra)) {
    snapshot.extraUsage = {
      enabled: extra.is_enabled === true,
      utilization: clampPercent(extra.utilization),
      spendLimitReached: extra.spend_limit_reached === true,
    };
  }
  return snapshot;
}

/**
 * Turns a failure into something worth showing. The distinction the panel acts
 * on is whether the credentials themselves are dead — nothing but a login
 * recovers from that — versus the endpoint asking us to back off.
 */
export function describeFailure(error: unknown): Pick<UsageSnapshot, 'error' | 'errorKind' | 'errorDetail'> {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError) {
    if (error.isAuth) {
      return { error: 'Signed out — this account needs to log in again.', errorKind: 'auth', errorDetail: detail };
    }
    if (error.isRateLimit) {
      return { error: 'Rate-limited by Anthropic — trying again later.', errorKind: 'rate', errorDetail: detail };
    }
    if (error.status === null) {
      return /timed out/.test(detail)
        ? { error: 'Timed out reading usage.', errorKind: 'other', errorDetail: detail }
        : { error: 'Could not reach Anthropic.', errorKind: 'other', errorDetail: detail };
    }
    if (error.status >= 500) {
      return { error: `Anthropic returned ${error.status}.`, errorKind: 'other', errorDetail: detail };
    }
  }
  return { error: 'Could not read usage.', errorKind: 'other', errorDetail: detail };
}
