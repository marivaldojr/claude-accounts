import * as fs from 'fs';
import * as path from 'path';
import { ConfigLocation, credentialsPath, globalConfigPath, resolveConfigLocation } from './claude-home';

/** A login rewrites the files more than once; settle before reading them. */
const DEBOUNCE_MS = 600;

/** Stat interval for the backstop watcher. Cheap enough to leave running. */
const POLL_MS = 4000;

/**
 * Watches the two files that make up the signed-in account — `.credentials.json`
 * (the token; the CLI rewrites it on every refresh) and `.claude.json` (the
 * identity; a login elsewhere changes it). They live in different directories
 * unless CLAUDE_CONFIG_DIR is set.
 *
 * Uses Node's watchers rather than `vscode.workspace.createFileSystemWatcher`:
 * the VS Code one does not deliver for a path outside the workspace under a
 * remote extension host (WSL, SSH), which is a setup this has to work in.
 *
 * The watch is on the *directory*, because both files are written atomically —
 * a temp file and a rename — which swaps the inode under a file-bound watch.
 * `watchFile` polls by path, so it survives that too and stands in where
 * inotify is unavailable.
 *
 * On macOS the credential is in the Keychain and cannot be watched; the
 * identity file still is, which covers account changes, and token rotation is
 * picked up on the next poll.
 */
export function watchLiveAuth(
  onChange: () => void,
  location: ConfigLocation = resolveConfigLocation(),
): { dispose: () => void } {
  const files = [globalConfigPath(location)];
  if (process.platform !== 'darwin') {
    files.push(credentialsPath(location));
  }

  let settle: NodeJS.Timeout | undefined;
  const trigger = (): void => {
    if (settle) {
      clearTimeout(settle);
    }
    settle = setTimeout(onChange, DEBOUNCE_MS);
  };

  const byDirectory = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = path.dirname(file);
    const names = byDirectory.get(dir) ?? new Set<string>();
    names.add(path.basename(file));
    byDirectory.set(dir, names);
  }

  const watchers: fs.FSWatcher[] = [];
  for (const [dir, names] of byDirectory) {
    try {
      const watcher = fs.watch(dir, (_event, changed) => {
        // `changed` is null on some platforms; treat that as "something moved".
        if (!changed || names.has(changed.toString())) {
          trigger();
        }
      });
      // An unreadable directory raises on the watcher, not on the call.
      watcher.on('error', () => undefined);
      watchers.push(watcher);
    } catch {
      // No such directory yet — the poller covers it.
    }
  }

  const onStat = (current: fs.Stats, previous: fs.Stats): void => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
      trigger();
    }
  };
  for (const file of files) {
    fs.watchFile(file, { interval: POLL_MS }, onStat);
  }

  return {
    dispose: () => {
      if (settle) {
        clearTimeout(settle);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
      for (const file of files) {
        fs.unwatchFile(file, onStat);
      }
    },
  };
}
