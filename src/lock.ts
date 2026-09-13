import * as fsp from 'fs/promises';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';

/** Same retry schedule the CLI uses for its secure-storage lock. */
const RETRIES = { retries: 10, minTimeout: 100, maxTimeout: 1000 };

/**
 * proper-lockfile refuses a lock this process already holds instead of
 * waiting for it, so calls on the same path are chained in-process first.
 */
const chains = new Map<string, Promise<unknown>>();

async function withLock<T>(lockTarget: string, options: lockfile.LockOptions, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(lockTarget) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await fsp.mkdir(path.dirname(lockTarget), { recursive: true });
    const release = await lockfile.lock(lockTarget, { retries: RETRIES, ...options });
    try {
      return await run();
    } finally {
      await release().catch(() => undefined);
    }
  });
  chains.set(lockTarget, current);
  try {
    return await current;
  } finally {
    if (chains.get(lockTarget) === current) {
      chains.delete(lockTarget);
    }
  }
}

/**
 * The lock Claude Code takes around every write to its credential store:
 * `<configDir>/.storage-write`, which proper-lockfile turns into the directory
 * `.storage-write.lock`. Holding it is what keeps a CLI refresh from landing in
 * the middle of a switch.
 */
export function withStorageLock<T>(configDir: string, run: () => Promise<T>): Promise<T> {
  return withLock(path.join(configDir, '.storage-write'), { realpath: false, stale: 15_000 }, run);
}

/**
 * The lock Claude Code takes around its read-modify-write of `.claude.json`:
 * `<file>.lock`. The CLI re-reads the file under it before applying a change,
 * so a write made under the same lock is not undone by the next one.
 */
export function withConfigFileLock<T>(file: string, run: () => Promise<T>): Promise<T> {
  return withLock(file, { realpath: false, lockfilePath: `${file}.lock` }, run);
}

/**
 * A lock of our own, for things only other windows of this extension race on
 * — refreshing one profile's stored token, for instance.
 */
export function withPrivateLock<T>(lockDir: string, name: string, run: () => Promise<T>): Promise<T> {
  return withLock(path.join(lockDir, name), { realpath: false, stale: 30_000 }, run);
}
