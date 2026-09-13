import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const OFFICIAL_EXTENSION = 'anthropic.claude-code';

/**
 * The Claude CLI to log in with: the configured one, else the binary bundled
 * with the official extension (so nothing has to be on PATH), else `claude`.
 */
export function resolveClaudeCommand(): string {
  const configured = vscode.workspace
    .getConfiguration('claudeAccounts')
    .get<string>('claudeCommand', '')
    .trim();
  if (configured) {
    return configured;
  }
  const extension = vscode.extensions.getExtension(OFFICIAL_EXTENSION);
  if (extension) {
    const binary = path.join(
      extension.extensionPath,
      'resources',
      'native-binary',
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    );
    if (fs.existsSync(binary)) {
      return binary;
    }
  }
  return 'claude';
}
