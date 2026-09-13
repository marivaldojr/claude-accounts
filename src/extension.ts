import * as path from 'path';
import * as vscode from 'vscode';
import { watchLiveAuth } from './live-auth';
import { setUserAgent } from './oauth';
import { AccountsPanel } from './panel';
import { ActionResult, AccountsService } from './service';
import { ProfileStore } from './store';
import { Profile } from './types';

/**
 * Floor for the poll interval. The usage endpoint is rate-limited hard, and
 * every open window polls on its own.
 */
const MIN_POLL_SECONDS = 180;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Accounts', { log: true });
  context.subscriptions.push(log);

  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  setUserAgent(version);

  const store = new ProfileStore(context);
  let panel: AccountsPanel | undefined;
  const service = new AccountsService(
    store,
    path.join(context.globalStorageUri.fsPath, 'locks'),
    log,
    () => panel?.render(),
  );
  panel = new AccountsPanel(context.extensionUri, service, log);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsPanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /** Asks the user for a profile when a command is run from the palette. */
  const pickProfile = async (placeHolder: string): Promise<Profile | undefined> => {
    const profiles = store.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage(
        'Claude Accounts: no profiles saved. Use "Save current account" or "Log in".',
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.label,
        description: profile.email,
        detail: [profile.planType, profile.organizationName].filter(Boolean).join(' · ') || undefined,
        profile,
      })),
      { placeHolder },
    );
    return picked?.profile;
  };

  const notify = (result: ActionResult): void => {
    if (result.ok) {
      void vscode.window.showInformationMessage(`Claude Accounts: ${result.message}`);
    } else if (!AccountsService.isSilent(result.message)) {
      void vscode.window.showWarningMessage(`Claude Accounts: ${result.message}`);
    }
  };

  const guarded =
    (run: () => Promise<ActionResult | void>) =>
    async (): Promise<void> => {
      try {
        const result = await run();
        if (result) {
          notify(result);
        }
      } catch (error) {
        log.error(String((error as Error).stack ?? error));
        notify({ ok: false, message: (error as Error).message });
      }
    };

  const withPick = (placeHolder: string, run: (profile: Profile) => Promise<ActionResult>) =>
    guarded(async () => {
      const profile = await pickProfile(placeHolder);
      return profile ? run(profile) : undefined;
    });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAccounts.saveCurrent', guarded(() => service.saveCurrent())),
    vscode.commands.registerCommand('claudeAccounts.login', guarded(() => service.login())),
    vscode.commands.registerCommand('claudeAccounts.refresh', guarded(() => service.refreshAll())),
    vscode.commands.registerCommand(
      'claudeAccounts.switch',
      withPick('Switch to which account?', (profile) => service.switchTo(profile.id)),
    ),
    vscode.commands.registerCommand(
      'claudeAccounts.rename',
      withPick('Rename which profile?', (profile) => service.rename(profile.id)),
    ),
    vscode.commands.registerCommand(
      'claudeAccounts.remove',
      withPick('Remove which profile?', (profile) => service.remove(profile.id)),
    ),
    vscode.commands.registerCommand('claudeAccounts.openPanel', async () => {
      await vscode.commands.executeCommand('claudeAccounts.accountsView.focus');
    }),
    vscode.commands.registerCommand('claudeAccounts.showLog', () => log.show()),
  );

  // A refresh by the CLI, a login in a terminal, a switch in another window:
  // all of them rewrite the live files without telling us.
  const adopt = (): void => void service.adoptLiveAuth();
  let watcher = watchLiveAuth(adopt);
  const rewatch = (): void => {
    watcher.dispose();
    watcher = watchLiveAuth(adopt);
  };

  // Usage polling, rescheduled when the setting changes.
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    if (timer) {
      clearInterval(timer);
    }
    const configured = vscode.workspace
      .getConfiguration('claudeAccounts')
      .get<number>('pollIntervalSeconds', 300);
    const everyMs = Math.max(MIN_POLL_SECONDS, configured) * 1000;
    timer = setInterval(() => void service.refreshAll({ scheduledEveryMs: everyMs }), everyMs);
  };
  schedule();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeAccounts.pollIntervalSeconds')) {
        schedule();
      }
      if (
        event.affectsConfiguration('claudeAccounts.configDir') ||
        event.affectsConfiguration('claudeCode.environmentVariables')
      ) {
        rewatch();
        adopt();
      }
      if (event.affectsConfiguration('claudeAccounts')) {
        panel?.render();
      }
    }),
    {
      dispose: () => {
        if (timer) {
          clearInterval(timer);
        }
        watcher.dispose();
      },
    },
  );

  void service.refreshAll();
}

export function deactivate(): void {
  // No global state outside the context: VS Code disposes the subscriptions.
}
