import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ActionResult, AccountsService } from './service';

export class AccountsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeAccounts.accountsView';

  private view?: vscode.WebviewView;
  /** Renders are coalesced: state is read from disk (or the Keychain) each time. */
  private renderQueued = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: AccountsService,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message) => void this.handle(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        // Second line of defence behind the file watcher: coming back to the
        // panel still picks up a login. Cheap when nothing changed.
        void this.service.adoptLiveAuth();
      }
    });
    this.render();
  }

  /** Pushes the current state into the webview. */
  render(): void {
    if (!this.view || this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      void this.push();
    }, 50);
  }

  private async push(): Promise<void> {
    if (!this.view) {
      return;
    }
    try {
      const state = await this.service.panelState();
      await this.view.webview.postMessage({
        type: 'state',
        ...state,
        warnThreshold: vscode.workspace
          .getConfiguration('claudeAccounts')
          .get<number>('warnThresholdPercent', 80),
        refreshing: this.service.isRefreshing,
        pending: this.service.pendingIds,
      });
    } catch (error) {
      this.log.error(`Could not render the panel: ${(error as Error).message}`);
    }
  }

  private async handle(message: { type?: string; id?: string }): Promise<void> {
    const id = message.id ?? '';
    try {
      switch (message.type) {
        case 'ready':
          this.render();
          return;
        case 'saveCurrent':
          return this.report(await this.service.saveCurrent());
        case 'login':
          return this.report(await this.service.login());
        case 'refreshAll':
          await this.service.refreshAll();
          return;
        case 'refreshOne':
          await this.service.refreshOne(id);
          return;
        case 'switch':
          return this.report(await this.service.switchTo(id));
        case 'rename':
          return this.report(await this.service.rename(id));
        case 'remove':
          return this.report(await this.service.remove(id));
        default:
          return;
      }
    } catch (error) {
      this.log.error(`${message.type} failed: ${(error as Error).stack ?? error}`);
      this.report({ ok: false, message: (error as Error).message });
    }
  }

  private report(result: ActionResult): void {
    if (result.ok) {
      vscode.window.setStatusBarMessage(`Claude Accounts: ${result.message}`, 5000);
    } else if (!AccountsService.isSilent(result.message)) {
      void vscode.window.showWarningMessage(`Claude Accounts: ${result.message}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const asset = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link href="${asset('panel.css')}" rel="stylesheet">
<title>Claude Accounts</title>
</head>
<body>
<div class="toolbar">
  <button class="save" data-action="saveCurrent">+ Save current account</button>
  <button data-action="login" title="Sign in to another account, without leaving this one">Log in</button>
  <button data-action="refreshAll" title="Check every account"><span>&#8635;</span></button>
</div>
<div id="warning" class="hint warn" hidden></div>
<div id="unsaved" class="hint" hidden></div>
<div id="accounts"></div>
<div id="empty" class="empty" hidden>
  No accounts saved yet.<br>Sign in to Claude Code, then use <b>Save current account</b> — or add one with <b>Log in</b>.
</div>
<footer id="home"></footer>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}
