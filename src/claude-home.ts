import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isRecord } from './identity';
import { withConfigFileLock, withStorageLock } from './lock';
import { ClaudeAuth, CredentialsFile, OauthAccount } from './types';

/**
 * Where Claude Code keeps an account. `explicit` is whether a
 * CLAUDE_CONFIG_DIR is in play, which moves `.claude.json` inside the directory
 * and gives the macOS Keychain entry a suffix.
 */
export interface ConfigLocation {
  dir: string;
  explicit: boolean;
}

/**
 * Resolves the config directory the way the official extension does: our own
 * setting first, then CLAUDE_CONFIG_DIR from `claudeCode.environmentVariables`
 * (the official extension injects it into every `claude` it spawns), then the
 * environment, then `~/.claude`.
 */
export function resolveConfigLocation(): ConfigLocation {
  const configured = vscode.workspace
    .getConfiguration('claudeAccounts')
    .get<string>('configDir', '')
    .trim();
  if (configured) {
    return { dir: untilde(configured), explicit: true };
  }
  const variables = vscode.workspace
    .getConfiguration('claudeCode')
    .get<Array<{ name?: string; value?: string }>>('environmentVariables', []);
  const fromSetting = Array.isArray(variables)
    ? variables.find((item) => item?.name === 'CLAUDE_CONFIG_DIR')?.value?.trim()
    : undefined;
  if (fromSetting) {
    return { dir: untilde(fromSetting), explicit: true };
  }
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv) {
    return { dir: fromEnv, explicit: true };
  }
  return { dir: path.join(os.homedir(), '.claude'), explicit: false };
}

function untilde(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

export function credentialsPath(location: ConfigLocation): string {
  return path.join(location.dir, '.credentials.json');
}

/** `~/.claude.json`, or inside the directory when CLAUDE_CONFIG_DIR is set. */
export function globalConfigPath(location: ConfigLocation): string {
  return location.explicit
    ? path.join(location.dir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

/** Human-readable description of where the credential lives, for the footer. */
export function describeLocation(location: ConfigLocation): string {
  return process.platform === 'darwin'
    ? `Keychain "${keychainService(location)}" · ${globalConfigPath(location)}`
    : location.dir;
}

// ---------------------------------------------------------------------------
// .claude.json

/** Reads `.claude.json`. Returns `null` if it is missing or not valid JSON. */
export function readGlobalConfig(location: ConfigLocation): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(globalConfigPath(location), 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readOauthAccount(location: ConfigLocation): OauthAccount | null {
  const account = readGlobalConfig(location)?.oauthAccount;
  return isRecord(account) ? (account as OauthAccount) : null;
}

/**
 * Replaces `oauthAccount` in `.claude.json` and nothing else. The file holds
 * dozens of other keys, per-project history among them, so it is re-read under
 * the CLI's own lock and a file that does not parse is left alone rather than
 * replaced with something smaller.
 */
export async function writeOauthAccount(location: ConfigLocation, account: OauthAccount): Promise<void> {
  const file = globalConfigPath(location);
  await withConfigFileLock(file, async () => {
    let config: Record<string, unknown> = {};
    let mode = 0o600;
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        throw new Error(`${file} is not a JSON object`);
      }
      config = parsed;
      mode = (await fsp.stat(file)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Refusing to rewrite ${file}: ${(error as Error).message}`);
      }
    }
    config.oauthAccount = account;
    await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, mode);
  });
}

// ---------------------------------------------------------------------------
// Credential store: a file on Linux/Windows, the Keychain on macOS.

export interface CredentialStore {
  read(): Promise<CredentialsFile | null>;
  write(data: CredentialsFile): Promise<void>;
  remove(): Promise<void>;
}

export function credentialStore(location: ConfigLocation): CredentialStore {
  if (process.platform === 'darwin') {
    return keychainStore(location);
  }
  if (process.platform === 'win32' && usesWindowsCredentialManager(location)) {
    const refuse = async (): Promise<never> => {
      throw new Error(
        'Claude Code is keeping its credentials in the Windows Credential Manager, which Claude Accounts does not support yet.',
      );
    };
    return { read: refuse, write: refuse, remove: refuse };
  }
  return fileStore(location);
}

function fileStore(location: ConfigLocation): CredentialStore {
  const file = credentialsPath(location);
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
        return isRecord(parsed) ? (parsed as CredentialsFile) : null;
      } catch {
        return null;
      }
    },
    async write(data) {
      await fsp.mkdir(location.dir, { recursive: true });
      await writeFileAtomic(file, JSON.stringify(data), 0o600);
    },
    async remove() {
      // Overwrite before deleting: if the rm fails, what is left behind is an
      // empty object, not a live token.
      await fsp.writeFile(file, '{}', { mode: 0o600 }).catch(() => undefined);
      await fsp.rm(file, { force: true });
    },
  };
}

/** The Windows Credential Manager is behind a remote flag or an env override. */
function usesWindowsCredentialManager(location: ConfigLocation): boolean {
  if (process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN === '1') {
    return true;
  }
  const features = readGlobalConfig(location)?.cachedGrowthBookFeatures;
  return isRecord(features) && features.tengu_windows_credman === true;
}

/**
 * The Keychain item the CLI uses: `Claude Code-credentials`, with a hash of the
 * config directory appended when CLAUDE_CONFIG_DIR is set.
 */
export function keychainService(location: ConfigLocation): string {
  const suffix = location.explicit
    ? `-${crypto.createHash('sha256').update(location.dir.normalize('NFC')).digest('hex').slice(0, 8)}`
    : '';
  return `Claude Code-credentials${suffix}`;
}

function keychainAccount(): string {
  let user: string;
  try {
    user = process.env.USER || os.userInfo().username;
  } catch {
    return 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user';
}

function security(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('security', args, { timeout: 10_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** `security` exit status for "item not found". */
const KEYCHAIN_NOT_FOUND = 44;

function keychainStore(location: ConfigLocation): CredentialStore {
  const service = keychainService(location);
  const account = keychainAccount();
  return {
    async read() {
      const { code, stdout, stderr } = await security(['find-generic-password', '-a', account, '-w', '-s', service]);
      if (code === KEYCHAIN_NOT_FOUND) {
        return null;
      }
      if (code !== 0) {
        throw new Error(`Could not read the Keychain item "${service}": ${stderr.trim() || `exit ${code}`}`);
      }
      let text = stdout.trim();
      // `-w` prints the secret in hex when it is not plain text.
      if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
        const decoded = Buffer.from(text, 'hex').toString('utf8');
        if (decoded.startsWith('{')) {
          text = decoded;
        }
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? (parsed as CredentialsFile) : null;
      } catch {
        return null;
      }
    },
    async write(data) {
      const hex = Buffer.from(JSON.stringify(data), 'utf8').toString('hex');
      const { code, stderr } = await security(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
      if (code !== 0) {
        throw new Error(`Could not write the Keychain item "${service}": ${stderr.trim() || `exit ${code}`}`);
      }
    },
    async remove() {
      await security(['delete-generic-password', '-a', account, '-s', service]);
    },
  };
}

// ---------------------------------------------------------------------------
// The live account, as a unit.

/** Reads the signed-in account: credential from the store, identity from `.claude.json`. */
export async function readLive(location = resolveConfigLocation()): Promise<Partial<ClaudeAuth> | null> {
  const credentials = await credentialStore(location).read();
  if (!credentials?.claudeAiOauth) {
    return null;
  }
  return {
    claudeAiOauth: credentials.claudeAiOauth,
    oauthAccount: readOauthAccount(location) ?? undefined,
  };
}

/**
 * Makes `auth` the signed-in account. The credential goes first, under the
 * CLI's storage lock, keeping any other keys in the store; then the identity.
 * That order matters: the official extension reacts to the identity changing
 * by re-probing `claude auth status`, and the probe has to find the new token.
 */
export async function writeLive(auth: ClaudeAuth, location = resolveConfigLocation()): Promise<void> {
  await writeLiveCredential(auth.claudeAiOauth, location);
  if (auth.oauthAccount) {
    await writeOauthAccount(location, auth.oauthAccount);
  }
}

/** Replaces `claudeAiOauth` in the store, under the storage lock. */
export async function writeLiveCredential(
  oauth: ClaudeAuth['claudeAiOauth'],
  location = resolveConfigLocation(),
): Promise<void> {
  await withStorageLock(location.dir, async () => {
    const store = credentialStore(location);
    const current = (await store.read()) ?? {};
    await store.write({ ...current, claudeAiOauth: oauth });
  });
}

// ---------------------------------------------------------------------------
// Throwaway config directories, for the isolated login.

export async function createTemporaryLocation(): Promise<ConfigLocation> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-accounts-'));
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  return { dir, explicit: true };
}

/** Removes a throwaway directory and the credential the CLI left for it. */
export async function disposeTemporaryLocation(location: ConfigLocation): Promise<void> {
  await credentialStore(location)
    .remove()
    .catch(() => undefined);
  if (process.platform === 'darwin') {
    // The Keychain is the store there, but an older CLI may have used the file.
    await fileStore(location).remove().catch(() => undefined);
  }
  await fsp.rm(location.dir, { recursive: true, force: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------

/**
 * Temp file in the same directory, then a rename over the target — a reader
 * never sees a half-written file.
 */
export async function writeFileAtomic(target: string, content: string, mode: number): Promise<void> {
  const temp = `${target}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(temp, content, { mode });
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await fsp.chmod(target, mode).catch(() => undefined);
}
