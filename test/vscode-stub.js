// Minimal `vscode` module stub, to exercise the logic outside the editor.
const config = new Map(Object.entries({
  'claudeAccounts.configDir': '',
  'claudeAccounts.claudeCommand': '',
  'claudeCode.environmentVariables': [],
}));
module.exports = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key, fallback) => {
        const value = config.get(`${section}.${key}`);
        return value === undefined ? fallback : value;
      },
    }),
    workspaceFolders: undefined,
  },
  extensions: { getExtension: () => undefined },
  __config: config,
};
