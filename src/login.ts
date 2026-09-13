import * as vscode from 'vscode';
import {
  createTemporaryLocation,
  credentialStore,
  disposeTemporaryLocation,
  readOauthAccount,
} from './claude-home';
import { isUsableOauth } from './identity';
import { ClaudeAuth } from './types';

export type LoginOutcome = { kind: 'ok'; auth: ClaudeAuth } | { kind: 'canceled' } | { kind: 'failed'; message: string };

const POLL_MS = 1000;
/** How long to wait for `.claude.json` after the credential lands. */
const IDENTITY_GRACE_MS = 8000;
const DEADLINE_MS = 15 * 60_000;

/**
 * Signs in to an account without touching the one in use: `claude auth login`
 * runs against a throwaway CLAUDE_CONFIG_DIR, and what it writes there becomes
 * the profile. `auth login` does not revoke what it replaces, and here there is
 * nothing to replace anyway — the active account is never in the picture.
 *
 * A terminal, because the CLI may need to show a URL and read back a code
 * (a remote or headless session cannot open the browser for it).
 */
export async function isolatedLogin(command: string): Promise<LoginOutcome> {
  const location = await createTemporaryLocation();
  const terminal = vscode.window.createTerminal({
    name: 'Claude Accounts: login',
    shellPath: command,
    shellArgs: ['auth', 'login', '--claudeai'],
    env: { CLAUDE_CONFIG_DIR: location.dir },
    isTransient: true,
  });
  terminal.show();

  try {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Claude Accounts: finish the login in the browser (the terminal shows the link)…',
        cancellable: true,
      },
      (_progress, token) =>
        new Promise<LoginOutcome>((resolve) => {
          let settled = false;
          let credentialSeenAt = 0;
          let checking = false;

          const finish = (outcome: LoginOutcome): void => {
            if (settled) {
              return;
            }
            settled = true;
            clearInterval(timer);
            clearTimeout(deadline);
            closed.dispose();
            canceled.dispose();
            resolve(outcome);
          };

          const check = async (): Promise<void> => {
            if (settled || checking) {
              return;
            }
            checking = true;
            try {
              const exited = terminal.exitStatus !== undefined;
              const credentials = await credentialStore(location).read().catch(() => null);
              const oauth = credentials?.claudeAiOauth;
              if (isUsableOauth(oauth)) {
                credentialSeenAt ||= Date.now();
                const account = readOauthAccount(location);
                // The CLI writes the identity a moment after the token. Wait for
                // it, but not forever — the caller can fetch it from the API.
                if (account?.accountUuid || exited || Date.now() - credentialSeenAt > IDENTITY_GRACE_MS) {
                  finish({ kind: 'ok', auth: { claudeAiOauth: oauth, oauthAccount: account ?? undefined } });
                }
                return;
              }
              if (exited) {
                const code = terminal.exitStatus?.code;
                finish(
                  code === 0 || code === undefined
                    ? { kind: 'canceled' }
                    : { kind: 'failed', message: `The login exited with code ${code} — see the terminal.` },
                );
              }
            } finally {
              checking = false;
            }
          };

          const timer = setInterval(() => void check(), POLL_MS);
          const deadline = setTimeout(() => finish({ kind: 'failed', message: 'The login timed out.' }), DEADLINE_MS);
          const closed = vscode.window.onDidCloseTerminal((item) => {
            if (item === terminal) {
              void check().then(() => finish({ kind: 'canceled' }));
            }
          });
          const canceled = token.onCancellationRequested(() => finish({ kind: 'canceled' }));
        }),
    );
  } finally {
    terminal.dispose();
    await disposeTemporaryLocation(location);
  }
}
