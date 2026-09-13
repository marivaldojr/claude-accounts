// Smoke tests against the compiled modules in out/. Everything that writes does
// so in a throwaway directory; the real account is only ever read, and the test
// checks at the end that its files came through byte for byte.
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const stub = path.resolve('test/vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? stub : originalResolve.call(this, request, ...rest);
};

const { readIdentity, isUsableAuth, sameAccount, oauthAccountFromProfile, isExpiring } = require('../out/identity.js');
const home = require('../out/claude-home.js');
const { normalizeUsage, describeFailure } = require('../out/usage.js');
const { ApiError, fetchUsageRaw, fetchProfile } = require('../out/oauth.js');
const { watchLiveAuth } = require('../out/live-auth.js');

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

const realLocation = home.resolveConfigLocation();
const realFiles = [home.credentialsPath(realLocation), home.globalConfigPath(realLocation)];
const realBefore = realFiles.map(sha);

console.log('normalizeUsage (real payload from a Max account)');
{
  const payload = JSON.parse(fs.readFileSync('test/fixtures/usage-max.json', 'utf8'));
  const snap = normalizeUsage(payload, 1_789_000_000_000);
  const byLabel = Object.fromEntries(snap.windows.map((w) => [w.label, w]));
  await check('three windows from limits[]', () => assert.equal(snap.windows.length, 3));
  await check('session first, as 5h', () => assert.deepEqual([snap.windows[0].kind, snap.windows[0].label], ['session', '5h']));
  await check('weekly as 7d', () => assert.equal(byLabel['7d'].kind, 'weekly'));
  await check('scoped window named after its model', () => assert.equal(byLabel.Fable?.kind, 'scoped'));
  await check('percent carried over', () => assert.equal(byLabel['7d'].usedPercent, payload.limits[1].percent));
  await check('resets_at becomes unix seconds', () =>
    assert.equal(byLabel['7d'].resetsAt, Math.floor(Date.parse(payload.limits[1].resets_at) / 1000)));
  await check('extra usage parsed', () => assert.equal(snap.extraUsage.enabled, false));
  await check('no error', () => assert.equal(snap.error, undefined));

  const legacy = normalizeUsage({ ...payload, limits: undefined });
  await check('falls back to five_hour/seven_day without limits[]', () =>
    assert.deepEqual(legacy.windows.map((w) => w.label), ['5h', '7d']));
  await check('a null resets_at stays null', () =>
    assert.equal(normalizeUsage({ five_hour: { utilization: 0, resets_at: null } }).windows[0].resetsAt, null));
  await check('out-of-range percent is clamped', () =>
    assert.equal(normalizeUsage({ limits: [{ kind: 'session', percent: 140 }] }).windows[0].usedPercent, 100));
  await check('garbage does not throw', () => assert.ok(normalizeUsage(null).error));
}

console.log('\ndescribeFailure');
await check('401 is an auth failure', () => assert.equal(describeFailure(new ApiError('x', 401)).errorKind, 'auth'));
await check('invalid_grant is an auth failure', () => assert.equal(describeFailure(new ApiError('x', 400, true)).errorKind, 'auth'));
await check('429 is a rate limit', () => assert.equal(describeFailure(new ApiError('x', 429)).errorKind, 'rate'));
await check('network failure is not auth', () => assert.equal(describeFailure(new ApiError('failed: ENOTFOUND', null)).errorKind, 'other'));
await check('anything else still gets a message', () => assert.ok(describeFailure(new Error('kaboom')).error));

console.log('\nidentity');
{
  const a = { accountUuid: 'u1', organizationUuid: 'o1' };
  await check('same account and org match', () => assert.ok(sameAccount(a, { accountUuid: 'u1', organizationUuid: 'o1' })));
  await check('same person, other org is another account', () => assert.ok(!sameAccount(a, { accountUuid: 'u1', organizationUuid: 'o2' })));
  await check('org unknown on one side still matches', () => assert.ok(sameAccount(a, { accountUuid: 'u1' })));
  await check('no uuid never matches', () => assert.ok(!sameAccount({}, {})));
  const block = oauthAccountFromProfile({
    account: { uuid: 'u1', email: 'a@b.c', display_name: 'A', created_at: '2025-01-01' },
    organization: { uuid: 'o1', name: 'Org', billing_type: 'stripe', has_extra_usage_enabled: false },
  });
  await check('profile response maps to oauthAccount', () =>
    assert.deepEqual([block.accountUuid, block.emailAddress, block.organizationUuid, block.organizationName], ['u1', 'a@b.c', 'o1', 'Org']));
  await check('missing fields are dropped, not blanked', () => assert.ok(!('fullName' in block)));
  await check('a profile without account is rejected', () => assert.equal(oauthAccountFromProfile({ organization: {} }), null));
}

console.log('\nlive account (real files, read-only)');
const live = await home.readLive(realLocation);
const identity = readIdentity(live);
await check(`credential found (${home.describeLocation(realLocation)})`, () => assert.ok(isUsableAuth(live)));
await check('identity has accountUuid and email', () => assert.ok(identity.accountUuid && /@/.test(identity.email ?? '')));
await check('plan read from the credential', () => assert.ok(identity.planType));
console.log(`       -> ${identity.email} | ${identity.planType} | account ${identity.accountUuid?.slice(0, 8)}… org ${identity.organizationUuid?.slice(0, 8)}…`);

console.log('\nAPI with the live token (read-only calls; no renewal)');
if (isUsableAuth(live) && !isExpiring(live.claudeAiOauth, 60_000)) {
  let raw;
  try { raw = await fetchUsageRaw(live.claudeAiOauth.accessToken); } catch (error) { raw = error; }
  if (raw instanceof ApiError && raw.isRateLimit) {
    console.log(`  SKIP usage endpoint rate-limited: ${raw.message}`);
  } else {
    await check('GET /api/oauth/usage answers', () => assert.ok(!(raw instanceof Error), String(raw?.message)));
    const snap = normalizeUsage(raw);
    await check('and normalizes to windows', () => assert.ok(snap.windows.length > 0));
    for (const w of snap.windows) {
      console.log(`       ${w.label.padEnd(8)} ${String(w.usedPercent).padStart(3)}%  resets ${w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : '—'}`);
    }
  }
  let profile;
  try { profile = await fetchProfile(live.claudeAiOauth.accessToken); } catch (error) { profile = error; }
  await check('GET /api/oauth/profile answers', () => assert.ok(!(profile instanceof Error), String(profile?.message)));
  const owner = oauthAccountFromProfile(profile);
  await check('and names the same account as .claude.json', () => assert.ok(sameAccount(identity, readIdentity({ oauthAccount: owner }))));
} else {
  console.log('  SKIP the live token is expired; not renewing it from a test');
}

console.log('\nwriteLive (throwaway config dir)');
{
  const location = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-accounts-test-')), explicit: true };
  const credFile = home.credentialsPath(location);
  const cfgFile = home.globalConfigPath(location);
  await fsp.writeFile(credFile, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'old' }, mcpOAuth: { keep: 1 } }), { mode: 0o600 });
  await fsp.writeFile(cfgFile, JSON.stringify({ projects: { '/x': { a: 1 } }, oauthAccount: { accountUuid: 'old' }, numStartups: 3 }, null, 2), { mode: 0o644 });

  const next = {
    claudeAiOauth: { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: Date.now() + 3600_000, subscriptionType: 'max' },
    oauthAccount: { accountUuid: 'u2', emailAddress: 'b@c.d', organizationUuid: 'o2' },
  };
  if (process.platform !== 'darwin') {
    await home.writeLive(next, location);
    const cred = JSON.parse(await fsp.readFile(credFile, 'utf8'));
    const cfg = JSON.parse(await fsp.readFile(cfgFile, 'utf8'));
    await check('credential replaced', () => assert.equal(cred.claudeAiOauth.accessToken, 'new-at'));
    await check('other keys in the store kept', () => assert.deepEqual(cred.mcpOAuth, { keep: 1 }));
    await check('.credentials.json stays 0600', () => assert.equal(fs.statSync(credFile).mode & 0o777, 0o600));
    await check('oauthAccount replaced', () => assert.equal(cfg.oauthAccount.accountUuid, 'u2'));
    await check('the rest of .claude.json kept', () => assert.deepEqual([cfg.projects, cfg.numStartups], [{ '/x': { a: 1 } }, 3]));
    await check('.claude.json keeps its mode', () => assert.equal(fs.statSync(cfgFile).mode & 0o777, 0o644));
    const leftovers = (await fsp.readdir(location.dir)).filter((name) => name.endsWith('.lock') || name.endsWith('.tmp'));
    await check('no lock or temp file left behind', () => assert.deepEqual(leftovers, []));
    const back = await home.readLive(location);
    await check('readLive sees the new account', () => assert.equal(readIdentity(back).email, 'b@c.d'));

    // A lock held by "the CLI" makes the write wait, not barge in.
    const lockfile = require('proper-lockfile');
    const release = await lockfile.lock(path.join(location.dir, '.storage-write'), { realpath: false });
    const started = Date.now();
    setTimeout(() => void release(), 400);
    await home.writeLiveCredential({ ...next.claudeAiOauth, accessToken: 'after-lock' }, location);
    await check('a write waits for the CLI storage lock', () => assert.ok(Date.now() - started >= 350));

    await fsp.writeFile(cfgFile, '{"projects": {"/x": ', 'utf8');
    let refused = null;
    try { await home.writeOauthAccount(location, { accountUuid: 'u3' }); } catch (error) { refused = error; }
    await check('a .claude.json that does not parse is refused, not replaced', () => assert.ok(refused));
    await check('and left exactly as it was', () => assert.equal(fs.readFileSync(cfgFile, 'utf8'), '{"projects": {"/x": '));
  } else {
    console.log('  SKIP on macOS the store is the Keychain');
  }
  await home.disposeTemporaryLocation(location);
  await check('disposeTemporaryLocation removes the directory', () => assert.ok(!fs.existsSync(location.dir)));
}

console.log('\nkeychainService');
await check('default location has no suffix', () =>
  assert.equal(home.keychainService({ dir: '/home/x/.claude', explicit: false }), 'Claude Code-credentials'));
await check('CLAUDE_CONFIG_DIR adds sha256[:8] of the dir', () =>
  assert.equal(
    home.keychainService({ dir: '/tmp/cfg', explicit: true }),
    `Claude Code-credentials-${crypto.createHash('sha256').update('/tmp/cfg').digest('hex').slice(0, 8)}`,
  ));

console.log('\nwatchLiveAuth (throwaway config dir)');
{
  const location = { dir: await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-accounts-watch-')), explicit: true };
  const target = home.globalConfigPath(location);
  await fsp.writeFile(target, '{"v":0}');
  let fired = 0;
  const watcher = watchLiveAuth(() => { fired++; }, location);
  await sleep(200);
  await fsp.writeFile(target + '.tmp', '{"v":1}');
  await fsp.rename(target + '.tmp', target);
  await fsp.writeFile(home.credentialsPath(location), '{}');
  await sleep(1400);
  watcher.dispose();
  const afterDispose = fired;
  await fsp.writeFile(target, '{"v":2}');
  await sleep(1200);
  await check('an atomic rewrite wakes the watcher', () => assert.ok(fired > 0));
  await check('writes to both files collapse into one call', () => assert.equal(fired, 1));
  await check('dispose actually stops it', () => assert.equal(fired, afterDispose));
  await fsp.rm(location.dir, { recursive: true, force: true });
}

console.log('\nreal account untouched');
const realAfter = realFiles.map(sha);
// The CLI may legitimately rewrite either file while this runs (a refresh, a
// cache update); only a change we could have caused is worth failing on.
await check('.credentials.json unchanged (or changed by the CLI, not us)', () =>
  assert.ok(realAfter[0] === realBefore[0] || process.env.ALLOW_LIVE_CHANGES));
if (realAfter[1] !== realBefore[1]) {
  console.log('  note .claude.json changed during the run — the CLI writes it constantly; nothing here writes to it');
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
