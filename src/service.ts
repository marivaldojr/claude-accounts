import * as vscode from 'vscode';
import {
  credentialStore,
  describeLocation,
  readLive,
  resolveConfigLocation,
  writeLive,
} from './claude-home';
import { resolveClaudeCommand } from './cli';
import {
  isExpiring,
  isUsableAuth,
  isUsableOauth,
  oauthAccountFromProfile,
  readIdentity,
  sameAccount,
} from './identity';
import { withPrivateLock, withStorageLock } from './lock';
import { isolatedLogin } from './login';
import { ApiError, fetchProfile, fetchUsageRaw, refreshOauth } from './oauth';
import { ProfileStore } from './store';
import { ClaudeAuth, ClaudeOauth, OauthAccount, Profile, ProfileView, UsageSnapshot } from './types';
import { describeFailure, normalizeUsage } from './usage';

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface PanelState {
  profiles: ProfileView[];
  unsaved: { email?: string; planType?: string } | null;
  warning: string | null;
  location: string;
}

/** How many accounts to query at once. */
const USAGE_CONCURRENCY = 2;

/** Window in which a live-file change is assumed to be our own write. */
const SELF_WRITE_ECHO_MS = 2000;

/** Renew a little before expiry, so a request never races the clock. */
const EXPIRY_MARGIN_MS = 60_000;

/** How long to leave a profile alone after a 429 without Retry-After. */
const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** A token rotation re-reads usage, but not if a reading is this fresh. */
const ADOPT_MIN_AGE_MS = 60_000;

/** Messages the panel swallows instead of surfacing as a warning. */
const SILENT_MESSAGES = new Set(['Canceled.', 'Switch canceled.', 'Login canceled.']);

export class AccountsService {
  private refreshing = false;
  /** Profiles with a reading in flight, so the panel can say so. */
  private readonly pending = new Set<string>();
  /** When this extension last wrote the live files, to ignore its own echo. */
  private selfWriteAt = 0;
  /** Profiles the usage endpoint told to back off, and until when. */
  private readonly cooldown = new Map<string, number>();
  /**
   * Access tokens already checked against `/api/oauth/profile`, and who owns
   * each. The token is opaque, and `.claude.json` can name one account while
   * the credential belongs to another (see `ownerOf`).
   */
  private readonly owners = new Map<string, OauthAccount>();
  /** Set when the live token and the live identity disagree. */
  private mismatch: string | null = null;

  constructor(
    private readonly store: ProfileStore,
    /** Directory for locks shared with this extension in other windows. */
    private readonly lockDir: string,
    private readonly log: vscode.LogOutputChannel,
    private readonly onChange: () => void,
  ) {}

  // -------------------------------------------------------------------------
  // Panel state

  async panelState(): Promise<PanelState> {
    const location = resolveConfigLocation();
    const live = await readLive(location).catch(() => null);
    const usable = isUsableAuth(live);
    const identity = usable ? readIdentity({ ...live, oauthAccount: this.knownOwner(live) }) : {};
    const active = usable ? this.store.findByIdentity(identity) : undefined;
    return {
      profiles: this.store.list().map((profile) => ({ ...profile, active: profile.id === active?.id })),
      unsaved: usable && !active ? { email: identity.email, planType: identity.planType } : null,
      warning: this.mismatch,
      location: describeLocation(location),
    };
  }

  /** The owner of the live token if already verified, else what `.claude.json` says. */
  private knownOwner(live: ClaudeAuth): OauthAccount | undefined {
    return this.owners.get(live.claudeAiOauth.accessToken) ?? live.oauthAccount;
  }

  // -------------------------------------------------------------------------
  // Profile actions

  async saveCurrent(): Promise<ActionResult> {
    const live = await this.liveWithOwner();
    if (!live) {
      return {
        ok: false,
        message: `No Claude account signed in at ${describeLocation(resolveConfigLocation())}. Sign in to Claude Code first, or use "Log in".`,
      };
    }
    const identity = readIdentity(live);
    if (!identity.accountUuid) {
      return { ok: false, message: 'Could not tell which account is signed in. Try again once online.' };
    }
    const existing = this.store.findByIdentity(identity);
    if (existing) {
      await this.store.updateAuth(existing.id, live);
      this.onChange();
      return { ok: true, message: `"${existing.label}" was already saved — tokens updated.` };
    }

    const label = await vscode.window.showInputBox({
      prompt: 'Profile name',
      value: this.uniqueLabel(identity.email ?? identity.name ?? 'Claude account'),
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
    });
    if (!label) {
      return { ok: false, message: 'Canceled.' };
    }
    const profile = await this.store.add(label.trim(), live);
    await this.store.undismiss(identity);
    this.onChange();
    void this.refreshOne(profile.id);
    return { ok: true, message: `"${profile.label}" saved.` };
  }

  /**
   * Makes a profile the signed-in account: its credential into the store, its
   * identity into `.claude.json`. No logout — a logout revokes the token on the
   * server, and the account being left is one we want to come back to.
   */
  async switchTo(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }

    // The tokens in the store are the newest the current account has — the CLI
    // may have rotated them since we last looked, and rotation kills our copy.
    // Take them before overwriting, or the account being left is lost.
    const captured = await this.captureLiveAccount();
    if (!captured) {
      const live = await readLive().catch(() => null);
      if (isUsableAuth(live)) {
        const email = readIdentity(live).email ?? 'unknown';
        const answer = await vscode.window.showWarningMessage(
          `The active account (${email}) is not saved. Switching now loses access to it.`,
          { modal: true },
          'Save and switch',
          'Switch anyway',
        );
        if (!answer) {
          return { ok: false, message: 'Switch canceled.' };
        }
        if (answer === 'Save and switch') {
          const saved = await this.saveCurrent();
          if (!saved.ok) {
            return saved;
          }
        }
      }
    } else if (captured.id === id) {
      return { ok: true, message: `"${profile.label}" is already in use.` };
    }

    // Under the profile's lock, so a renewal of its stored copy (in this window
    // or another) cannot rotate the token between reading it and writing it out.
    const written = await withPrivateLock(this.lockDir, `profile-${id}`, async () => {
      const auth = await this.store.getAuth(id);
      if (!isUsableAuth(auth)) {
        return false;
      }
      this.selfWriteAt = Date.now();
      await writeLive(auth);
      this.selfWriteAt = Date.now();
      return true;
    });
    if (!written) {
      return {
        ok: false,
        message: `"${profile.label}" has no usable credentials. Use "Log in" to sign in to it again.`,
      };
    }

    this.mismatch = null;
    this.log.info(`Switched to ${profile.email ?? profile.label}.`);
    this.onChange();
    void this.afterSwitch(profile);
    return { ok: true, message: `Now using "${profile.label}".` };
  }

  /**
   * Claude Code picks the new account up by itself — the official extension
   * watches `.claude.json` and re-probes when the email there changes. What it
   * cannot do is move a conversation that is already running: that process
   * holds the old token in memory until it is closed.
   */
  private async afterSwitch(profile: Profile): Promise<void> {
    const auto = vscode.workspace
      .getConfiguration('claudeAccounts')
      .get<boolean>('autoReloadAfterSwitch', false);
    if (auto) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      `Claude Accounts: now using "${profile.label}". New conversations use it; conversations already open stay on the previous account until you close them or reload the window.`,
      'Reload window',
    );
    if (answer === 'Reload window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async rename(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const label = await vscode.window.showInputBox({
      prompt: 'New profile name',
      value: profile.label,
      validateInput: (value) => (value.trim() ? undefined : 'Enter a name.'),
    });
    if (!label) {
      return { ok: false, message: 'Canceled.' };
    }
    await this.store.rename(id, label.trim());
    this.onChange();
    return { ok: true, message: 'Profile renamed.' };
  }

  async remove(id: string): Promise<ActionResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: 'Profile not found.' };
    }
    const answer = await vscode.window.showWarningMessage(
      `Remove the profile "${profile.label}"? Its stored credentials go with it. If it is the account in use, Claude Code stays signed in to it.`,
      { modal: true },
      'Remove',
    );
    if (answer !== 'Remove') {
      return { ok: false, message: 'Canceled.' };
    }
    await this.store.remove(id);
    this.onChange();
    return { ok: true, message: `"${profile.label}" removed.` };
  }

  /**
   * Adds an account through an isolated `claude auth login`. The account in use
   * is never touched; the new one is offered as a switch once it lands.
   */
  async login(): Promise<ActionResult> {
    const outcome = await isolatedLogin(resolveClaudeCommand());
    if (outcome.kind === 'canceled') {
      return { ok: false, message: 'Login canceled.' };
    }
    if (outcome.kind === 'failed') {
      return { ok: false, message: outcome.message };
    }

    let auth = outcome.auth;
    if (!auth.oauthAccount?.accountUuid) {
      const owner = await this.lookUpOwner(auth.claudeAiOauth);
      auth = { ...auth, oauthAccount: owner ?? auth.oauthAccount };
    }
    const identity = readIdentity(auth);
    if (!identity.accountUuid) {
      return { ok: false, message: 'Signed in, but could not tell which account it was. Try again once online.' };
    }

    let profile = this.store.findByIdentity(identity);
    if (profile) {
      await this.store.updateAuth(profile.id, auth);
    } else {
      profile = await this.store.add(this.uniqueLabel(identity.email ?? identity.name ?? 'Claude account'), auth);
    }
    await this.store.undismiss(identity);
    this.cooldown.delete(profile.id);
    this.onChange();
    void this.refreshOne(profile.id);

    // Nothing signed in: there is nothing to protect, so just use it.
    const live = await readLive().catch(() => null);
    if (!isUsableAuth(live)) {
      return this.switchTo(profile.id);
    }
    const target = profile;
    void vscode.window
      .showInformationMessage(`Claude Accounts: "${target.label}" added.`, 'Use it now')
      .then((answer) => (answer ? this.switchTo(target.id) : undefined));
    return { ok: true, message: `"${target.label}" added.` };
  }

  // -------------------------------------------------------------------------
  // Usage

  /**
   * Refreshes one profile's usage. Marks it pending first and clears that in
   * `finally`, so a reading that throws still stops announcing itself.
   */
  async refreshOne(id: string, options: { scheduledEveryMs?: number } = {}): Promise<void> {
    const profile = this.store.get(id);
    if (!profile || this.pending.has(id)) {
      return;
    }
    if ((this.cooldown.get(id) ?? 0) > Date.now()) {
      return;
    }
    // Several windows may be polling the same profiles. A scheduled pass skips
    // what another window read recently; asking by hand always goes through.
    if (options.scheduledEveryMs && profile.lastUsage && !profile.lastUsage.error) {
      if (Date.now() - profile.lastUsage.fetchedAt < options.scheduledEveryMs * 0.8) {
        return;
      }
    }

    this.pending.add(id);
    this.onChange();
    try {
      let snapshot: UsageSnapshot;
      try {
        const live = await readLive();
        const active = isUsableAuth(live) && sameAccount(profile, readIdentity({ ...live, oauthAccount: this.knownOwner(live) }));
        const raw = active ? await this.usageForLive(id) : await this.usageForStored(id);
        snapshot = normalizeUsage(raw);
        this.cooldown.delete(id);
      } catch (error) {
        snapshot = this.failedSnapshot(id, error);
      }
      await this.store.setUsage(id, snapshot);
    } finally {
      this.pending.delete(id);
      this.onChange();
    }
  }

  private failedSnapshot(id: string, error: unknown): UsageSnapshot {
    const failure = describeFailure(error);
    this.log.warn(`Usage for ${this.store.get(id)?.email ?? id}: ${failure.errorDetail}`);
    if (error instanceof ApiError && error.isRateLimit) {
      this.cooldown.set(id, Date.now() + (error.retryAfter ? error.retryAfter * 1000 : RATE_LIMIT_COOLDOWN_MS));
    }
    const previous = this.store.get(id)?.lastUsage;
    // A dead credential means the numbers are no longer ours to show. Anything
    // else is a hiccup: keep the last reading, marked as old.
    const keep = failure.errorKind !== 'auth' && previous && previous.windows.length > 0;
    return {
      fetchedAt: keep ? previous.fetchedAt : Date.now(),
      windows: keep ? previous.windows : [],
      extraUsage: keep ? previous.extraUsage : undefined,
      stale: Boolean(keep),
      ...failure,
    };
  }

  /**
   * Usage for the account that is live. The store is the source of truth here,
   * not our copy: the CLI renews that token as the user works, and rotation
   * revokes whatever copy we hold. Renewing from our copy would sign the user's
   * Claude Code out.
   */
  private async usageForLive(id: string): Promise<unknown> {
    const live = await readLive();
    if (!isUsableAuth(live)) {
      throw new ApiError('Signed out.', 401);
    }
    let oauth = live.claudeAiOauth;
    if (isExpiring(oauth, EXPIRY_MARGIN_MS)) {
      oauth = await this.renewLive(id, oauth, false);
    }
    try {
      return await fetchUsageRaw(oauth.accessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      oauth = await this.renewLive(id, oauth, true);
      return fetchUsageRaw(oauth.accessToken);
    }
  }

  /**
   * Renews the live token the way the CLI does: under its storage lock, after
   * re-reading the store. If someone renewed while we waited, theirs is used.
   * The result goes back to the store first — it is the only valid copy — and
   * then into the profile.
   */
  private async renewLive(id: string, seen: ClaudeOauth, force: boolean): Promise<ClaudeOauth> {
    const location = resolveConfigLocation();
    const renewed = await withStorageLock(location.dir, async () => {
      const store = credentialStore(location);
      const current = await store.read();
      const oauth = current?.claudeAiOauth;
      if (!isUsableOauth(oauth)) {
        throw new ApiError('Signed out.', 401);
      }
      if (oauth.accessToken !== seen.accessToken || (!force && !isExpiring(oauth, EXPIRY_MARGIN_MS))) {
        return oauth;
      }
      const fresh = await refreshOauth(oauth);
      this.selfWriteAt = Date.now();
      await store.write({ ...current, claudeAiOauth: fresh });
      this.log.info(`Renewed the live token for ${this.store.get(id)?.email ?? id}.`);
      return fresh;
    });
    const auth = await this.store.getAuth(id);
    await this.store.updateAuth(id, { claudeAiOauth: renewed, oauthAccount: auth?.oauthAccount });
    return renewed;
  }

  /**
   * Usage for an account that is not live. Here this extension is the only
   * renewer, so it renews only when the token is actually running out.
   */
  private async usageForStored(id: string): Promise<unknown> {
    const auth = await this.store.getAuth(id);
    if (!isUsableAuth(auth)) {
      throw new ApiError('No stored credentials.', 401);
    }
    let oauth = auth.claudeAiOauth;
    if (isExpiring(oauth, EXPIRY_MARGIN_MS)) {
      oauth = await this.renewStored(id, oauth, false);
    }
    try {
      return await fetchUsageRaw(oauth.accessToken);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }
      oauth = await this.renewStored(id, oauth, true);
      return fetchUsageRaw(oauth.accessToken);
    }
  }

  /**
   * Renews a stored copy, one renewal per profile at a time across every
   * window: the lock is taken, the secret re-read (another window may have
   * renewed it already), and the result saved before anything else reads it.
   */
  private renewStored(id: string, seen: ClaudeOauth, force: boolean): Promise<ClaudeOauth> {
    return withPrivateLock(this.lockDir, `profile-${id}`, async () => {
      const auth = await this.store.getAuth(id);
      if (!isUsableAuth(auth)) {
        throw new ApiError('No stored credentials.', 401);
      }
      const oauth = auth.claudeAiOauth;
      if (oauth.accessToken !== seen.accessToken || (!force && !isExpiring(oauth, EXPIRY_MARGIN_MS))) {
        return oauth;
      }
      // It may have become the live account since the caller looked. Then the
      // store holds the same grant, and renewing our copy would revoke it.
      const profile = this.store.get(id);
      const live = await readLive().catch(() => null);
      if (profile && isUsableAuth(live) && sameAccount(profile, readIdentity(live))) {
        throw new ApiError('The account became active while renewing; will read it from the store next time.', null);
      }
      const fresh = await refreshOauth(oauth);
      await this.store.updateAuth(id, { ...auth, claudeAiOauth: fresh });
      this.log.info(`Renewed the stored token for ${profile?.email ?? id}.`);
      return fresh;
    });
  }

  /** Refreshes every profile, a couple at a time. */
  async refreshAll(options: { scheduledEveryMs?: number } = {}): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    this.onChange();
    try {
      // Reconcile with the store first: a refresh should notice an account that
      // appeared or changed while the watcher was not looking.
      await this.adoptLiveAuth();
      const ids = this.store.list().map((profile) => profile.id);
      for (let index = 0; index < ids.length; index += USAGE_CONCURRENCY) {
        const batch = ids.slice(index, index + USAGE_CONCURRENCY);
        await Promise.all(batch.map((id) => this.refreshOne(id, options)));
      }
    } finally {
      this.refreshing = false;
      this.onChange();
    }
  }

  // -------------------------------------------------------------------------
  // Keeping stored copies in step with the live account

  /**
   * The live files changed underneath us — a refresh by the CLI, a login or
   * logout in a terminal, a switch in another window. Redraw, adopt the new
   * tokens, and re-read usage if the account itself moved.
   */
  async adoptLiveAuth(): Promise<void> {
    if (Date.now() - this.selfWriteAt < SELF_WRITE_ECHO_MS) {
      return;
    }
    this.onChange();
    const captured = await this.captureLiveAccount().catch((error) => {
      this.log.warn(`Could not adopt the live account: ${(error as Error).message}`);
      return null;
    });
    if (!captured?.changed) {
      return;
    }
    this.onChange();
    const usage = this.store.get(captured.id)?.lastUsage;
    if (!usage || usage.error || Date.now() - usage.fetchedAt > ADOPT_MIN_AGE_MS) {
      await this.refreshOne(captured.id);
    }
  }

  /**
   * Copies the live account into its profile, creating the profile if this is
   * an account we have not seen (unless the user removed it on purpose).
   * Returns the profile and whether anything changed. Does network work only
   * when the token is new to us.
   */
  private async captureLiveAccount(): Promise<{ id: string; changed: boolean } | null> {
    const live = await readLive();
    if (!isUsableAuth(live)) {
      return null;
    }

    // Fast path: same token we already hold. At most the identity block moved.
    const claimed = this.store.findByIdentity(readIdentity({ ...live, oauthAccount: this.knownOwner(live) }));
    if (claimed) {
      const stored = await this.store.getAuth(claimed.id);
      if (stored && JSON.stringify(stored.claudeAiOauth) === JSON.stringify(live.claudeAiOauth)) {
        return { id: claimed.id, changed: false };
      }
    }

    const verified = await this.liveWithOwner(live);
    if (!verified) {
      return null;
    }
    const identity = readIdentity(verified);
    if (!identity.accountUuid) {
      return null;
    }
    const profile = this.store.findByIdentity(identity);
    if (!profile) {
      if (this.store.isDismissed(identity)) {
        return null; // Removed on purpose; the hint still offers to save it.
      }
      const created = await this.store.add(this.uniqueLabel(identity.email ?? identity.name ?? 'Claude account'), verified);
      this.log.info(`Saved ${identity.email ?? identity.accountUuid} as a new profile.`);
      return { id: created.id, changed: true };
    }
    const stored = await this.store.getAuth(profile.id);
    if (stored && JSON.stringify(stored.claudeAiOauth) === JSON.stringify(verified.claudeAiOauth)) {
      return { id: profile.id, changed: false };
    }
    await this.store.updateAuth(profile.id, verified);
    const accountMoved = stored?.claudeAiOauth.refreshToken !== verified.claudeAiOauth.refreshToken;
    return { id: profile.id, changed: accountMoved || !stored };
  }

  /**
   * The live account with its identity confirmed by the API. The identity in
   * `.claude.json` is written separately from the token, and they can disagree:
   * a conversation left open across a switch still renews the old account and
   * writes that token back into the store, under the new account's name. Filing
   * that token under the name would wreck both profiles, so the owner is asked
   * of the token itself.
   */
  private async liveWithOwner(live?: Partial<ClaudeAuth> | null): Promise<ClaudeAuth | null> {
    const current = live === undefined ? await readLive().catch(() => null) : live;
    if (!isUsableAuth(current)) {
      return null;
    }
    const owner = await this.lookUpOwner(current.claudeAiOauth);
    const claimed = readIdentity(current);
    if (!owner) {
      return current; // Offline or rate-limited: fall back to what the file says.
    }
    const actual = readIdentity({ oauthAccount: owner });
    if (claimed.accountUuid && !sameAccount(claimed, actual)) {
      this.mismatch =
        `Claude Code's token belongs to ${actual.email ?? 'another account'}, but it shows ${claimed.email ?? 'a different one'}. ` +
        'A conversation left open during a switch probably renewed the old account. Close it (or reload the window) and switch again.';
      this.log.warn(this.mismatch);
      return { claudeAiOauth: current.claudeAiOauth, oauthAccount: owner };
    }
    this.mismatch = null;
    // Same account: the CLI's block is the richer one, so keep it.
    return { claudeAiOauth: current.claudeAiOauth, oauthAccount: current.oauthAccount ?? owner };
  }

  /** Asks `/api/oauth/profile` who owns a token, remembering the answer. */
  private async lookUpOwner(oauth: ClaudeOauth): Promise<OauthAccount | null> {
    const known = this.owners.get(oauth.accessToken);
    if (known) {
      return known;
    }
    if (isExpiring(oauth, 0)) {
      return null; // An expired token cannot answer, and renewing it here is not ours to do.
    }
    try {
      const block = oauthAccountFromProfile(await fetchProfile(oauth.accessToken));
      if (block) {
        if (this.owners.size > 64) {
          this.owners.clear();
        }
        this.owners.set(oauth.accessToken, block);
      }
      return block;
    } catch (error) {
      this.log.warn(`Could not look up who owns a token: ${(error as Error).message}`);
      return null;
    }
  }

  /** Keeps auto-created labels distinct. */
  private uniqueLabel(base: string): string {
    const taken = new Set(this.store.list().map((profile) => profile.label));
    if (!taken.has(base)) {
      return base;
    }
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base} (${suffix})`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }

  get isRefreshing(): boolean {
    return this.refreshing;
  }

  get pendingIds(): string[] {
    return [...this.pending];
  }

  static isSilent(message: string): boolean {
    return SILENT_MESSAGES.has(message);
  }
}
