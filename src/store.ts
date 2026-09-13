import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { identityKey, readIdentity, sameAccount } from './identity';
import { ClaudeAuth, Identity, Profile, UsageSnapshot } from './types';

const PROFILES_KEY = 'claudeAccounts.profiles';
const DISMISSED_KEY = 'claudeAccounts.dismissed';
const SECRET_PREFIX = 'claudeAccounts.auth.';

/**
 * Profile metadata goes in `globalState`; the credential only in SecretStorage.
 * Keeping the two apart is what avoids dumping tokens into `state.vscdb` in the
 * clear.
 */
export class ProfileStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Profile[] {
    return [...this.raw()].sort((a, b) => a.order - b.order);
  }

  get(id: string): Profile | undefined {
    return this.raw().find((profile) => profile.id === id);
  }

  private raw(): Profile[] {
    return this.context.globalState.get<Profile[]>(PROFILES_KEY, []);
  }

  private async save(profiles: Profile[]): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, profiles);
  }

  private secretKey(id: string): string {
    return SECRET_PREFIX + id;
  }

  async getAuth(id: string): Promise<ClaudeAuth | null> {
    const raw = await this.context.secrets.get(this.secretKey(id));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as ClaudeAuth;
    } catch {
      return null;
    }
  }

  private async setAuth(id: string, auth: ClaudeAuth): Promise<void> {
    await this.context.secrets.store(this.secretKey(id), JSON.stringify(auth));
  }

  /** Creates a profile from a credential and its identity block. */
  async add(label: string, auth: ClaudeAuth): Promise<Profile> {
    const profiles = this.raw();
    const profile: Profile = {
      id: crypto.randomUUID(),
      label,
      order: profiles.reduce((max, item) => Math.max(max, item.order), -1) + 1,
      addedAt: Date.now(),
    };
    applyIdentity(profile, readIdentity(auth));
    // Secret first: a profile without its credential is a card that cannot work.
    await this.setAuth(profile.id, auth);
    profiles.push(profile);
    await this.save(profiles);
    return profile;
  }

  findByIdentity(identity: Identity): Profile | undefined {
    return this.raw().find((profile) => sameAccount(profile, identity));
  }

  async rename(id: string, label: string): Promise<void> {
    await this.patch(id, (profile) => {
      profile.label = label;
    });
  }

  async remove(id: string): Promise<void> {
    const profile = this.get(id);
    await this.save(this.raw().filter((item) => item.id !== id));
    await this.context.secrets.delete(this.secretKey(id));
    // Removing the account that is live would otherwise be undone by the next
    // reconcile, which auto-saves accounts it does not recognise.
    const key = profile && identityKey(profile);
    if (key) {
      await this.dismiss(key);
    }
  }

  /**
   * Accounts the user deleted on purpose. Auto-save skips these, so a removal
   * sticks; saving one explicitly is what takes it off the list.
   */
  private get dismissed(): string[] {
    return this.context.globalState.get<string[]>(DISMISSED_KEY, []);
  }

  isDismissed(identity: Identity): boolean {
    const key = identityKey(identity);
    return Boolean(key && this.dismissed.includes(key));
  }

  private async dismiss(key: string): Promise<void> {
    if (!this.dismissed.includes(key)) {
      await this.context.globalState.update(DISMISSED_KEY, [...this.dismissed, key]);
    }
  }

  async undismiss(identity: Identity): Promise<void> {
    const key = identityKey(identity);
    if (key && this.dismissed.includes(key)) {
      await this.context.globalState.update(
        DISMISSED_KEY,
        this.dismissed.filter((item) => item !== key),
      );
    }
  }

  async setUsage(id: string, usage: UsageSnapshot): Promise<void> {
    await this.patch(id, (profile) => {
      profile.lastUsage = usage;
    });
  }

  /**
   * Rewrites the secret with a newer credential and realigns the metadata.
   * Without this the stored refresh token ages out, or is rotated away.
   */
  async updateAuth(id: string, auth: ClaudeAuth): Promise<void> {
    const previous = await this.getAuth(id);
    // Keep a known identity block when the new copy arrived without one.
    const merged: ClaudeAuth = { ...auth, oauthAccount: auth.oauthAccount ?? previous?.oauthAccount };
    await this.setAuth(id, merged);
    await this.patch(id, (profile) => applyIdentity(profile, readIdentity(merged)));
  }

  async reorder(orderedIds: string[]): Promise<void> {
    const profiles = this.raw();
    orderedIds.forEach((id, index) => {
      const profile = profiles.find((item) => item.id === id);
      if (profile) {
        profile.order = index;
      }
    });
    await this.save(profiles);
  }

  private async patch(id: string, mutate: (profile: Profile) => void): Promise<void> {
    const profiles = this.raw();
    const profile = profiles.find((item) => item.id === id);
    if (!profile) {
      return;
    }
    mutate(profile);
    await this.save(profiles);
  }
}

function applyIdentity(profile: Profile, identity: Identity): void {
  profile.accountUuid = identity.accountUuid ?? profile.accountUuid;
  profile.organizationUuid = identity.organizationUuid ?? profile.organizationUuid;
  profile.email = identity.email ?? profile.email;
  profile.name = identity.name ?? profile.name;
  profile.organizationName = identity.organizationName ?? profile.organizationName;
  profile.planType = identity.planType ?? profile.planType;
}
