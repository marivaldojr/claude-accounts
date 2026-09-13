# Changelog

Notable changes to Claude Accounts. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-09-13

### Changed

- The Marketplace page shows a screenshot of the panel. The extension itself
  is the same as 0.1.0.

## [0.1.0] — 2026-09-12

### Added

- Sidebar panel with every saved account's usage: the 5-hour session, the
  week, and the per-model weekly windows, read from `/api/oauth/usage`.
- Switching writes the credential (under the CLI's storage lock) and the
  `oauthAccount` identity (under the `.claude.json` lock). Claude Code picks it
  up without a reload.
- Isolated login: `claude auth login` against a throwaway `CLAUDE_CONFIG_DIR`,
  leaving the active account alone.
- Token handling that survives refresh-token rotation: the store is the source
  of truth for the live account, and renewals of inactive accounts are
  serialized across windows.
- Detection of a live token whose owner does not match `.claude.json`.
- File store on Linux/WSL/Windows; Keychain on macOS.
