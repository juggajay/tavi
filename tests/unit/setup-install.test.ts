import { TEST_DIR } from '../isolate.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, cpSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
// @ts-expect-error The installer is plain JavaScript.
import { install, readState, dataPath } from '../../scripts/setup/install.mjs';
// @ts-expect-error The checks are plain JavaScript.
import { GiB, checkFacts, printChecks } from '../../scripts/setup/checks.mjs';
// @ts-expect-error The transfer is plain JavaScript.
import { transferScript, boxFiles, engineScript } from '../../scripts/setup/box.mjs';
// @ts-expect-error The Windows commands are plain JavaScript.
import { system, execute } from '../../scripts/setup/system.mjs';
// @ts-expect-error The entry point is plain JavaScript.
import { main } from '../../scripts/tavi.mjs';

let number = 0;
function fixture() {
  const root = path.join(TEST_DIR, `install-${number++}`), folder = path.join(root, 'saved');
  for (const name of ['box/screen', 'scripts/setup', 'src/guard', 'ui', 'desktop']) mkdirSync(path.join(root, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'ui/package.json', 'ui/package-lock.json', 'desktop/package.json', 'desktop/package-lock.json']) writeFileSync(path.join(root, name), '{}');
  writeFileSync(path.join(root, 'src/guard/runner.ts'), 'The test safety switch supports names.');
  writeFileSync(path.join(root, 'box/setup.sh'), '#!/bin/bash\necho "A made-up step"\n');
  writeFileSync(path.join(root, 'box/screen/test.py'), 'print("A made-up check")\n');
  writeFileSync(path.join(root, 'scripts/setup/hermes-installer.sh'), '#!/bin/bash\necho "The reviewed public installer"\n');
  const config = { folder, port: 4321, host: '127.0.0.1', voiceFile: path.join(folder, 'voice.env'),
    run: { port: 4321, distro: 'tavi-test', mode: 'real', voice: false } };
  const facts = { platform: 'win32', build: 26100, nodeMajor: 24, linuxFeature: true, vmFeature: true,
    virtualization: true, wslMajor: 2, kernel: true, diskFree: 20 * GiB, memoryFree: 4 * GiB, memoryTotal: 16 * GiB,
    ports: { 4321: true, 3090: true, 3091: true }, spaces: [] as { name: string; version: number; id: string }[], guardSupportsName: true };
  const calls: string[] = [], scripts: string[] = [], output: string[] = [];
  let failure = '';
  const call = (name: string) => { calls.push(name); if (name === failure) throw new Error('FAIL  a made-up check'); };
  const ops = {
    inspect: async () => { call('inspect'); return facts; }, stop: async () => { call('stop'); },
    npm: async (dir: string, args: string[]) => { call(`npm ${dir} ${args.join(' ')}`); }, python: async () => { call('python'); },
    createSpace: async () => { call('create'); facts.spaces.push({ name: 'tavi-test', version: 2, id: 'test-id' }); },
    adoptSpace: async () => { call('adopt'); },
    linux: async (script: string) => { scripts.push(script); call(script.includes('TAVI_FILES') ? 'transfer' : script.includes('install-hermes.sh /') ? 'engine' : script.includes('screen/apps.sh') ? 'screens' : script.includes('runuser -u bot-probe') ? 'checks' : 'base'); return 'ok    a made-up check'; },
    terminateSpace: async () => { call('terminate'); }, permissions: async () => { call('permissions'); },
    desktop: async () => { call('desktop'); }, autostart: async () => { call('autostart'); }, start: async () => { call('start'); },
    waitLive: async () => { call('live'); return { rows: [{ ok: true, line: 'The app and engines answer.' }] }; },
    phone: async () => { call('phone'); },
  };
  return { root, folder, config, facts, calls, scripts, output, ops, print: (line: string) => output.push(line), fail: (name: string) => { failure = name; } };
}
const ready = fixture();
const passing = checkFacts(ready.facts, ready.config, { done: {} });
assert.ok(printChecks(passing, ready.print));
assert.ok(passing.every((row: { line: string; fix: string }) => row.line.length && row.fix.length));
const failures = [
  ['windows', { platform: 'linux' }], ['windows', { build: 18000 }], ['node', { nodeMajor: 22 }],
  ['features', { linuxFeature: false }], ['features', { vmFeature: false }], ['virtual', { virtualization: false }],
  ['wsl', { wslMajor: 1 }], ['wsl', { kernel: false }], ['disk', { diskFree: GiB }],
  ['memory', { memoryFree: GiB }], ['memory', { memoryTotal: 4 * GiB }], ['port-4321', { ports: { ...ready.facts.ports, 4321: false } }],
  ['port-3090', { ports: { ...ready.facts.ports, 3090: false } }], ['port-3091', { ports: { ...ready.facts.ports, 3091: false } }],
  ['space', { spaces: [{ name: 'tavi-test', version: 2, id: 'someone-else' }] }], ['guard-name', { guardSupportsName: false }],
] as const;
for (const [id, patch] of failures) {
  const rows = checkFacts({ ...ready.facts, ...patch }, ready.config, { done: {} });
  assert.equal(rows.find((row: { id: string }) => row.id === id).ok, false);
  const lines: string[] = []; assert.equal(printChecks(rows, (line: string) => lines.push(line)), false);
  assert.ok(lines.some(line => line.startsWith('STOP:') && line.includes('Do this:')));
}
const check = fixture();
assert.equal(await install(check.root, check.config, { check: true }, check.ops, check.print), 0);
assert.deepEqual(check.calls, ['inspect']); assert.equal(existsSync(check.folder), false);
const bad = fixture(); bad.facts.guardSupportsName = false;
await assert.rejects(install(bad.root, bad.config, {}, bad.ops, bad.print), /before changing anything/);
assert.equal(existsSync(bad.folder), false);
const missing = fixture();
await assert.rejects(install(missing.root, missing.config, {}, missing.ops, missing.print), /reviewed|obtain and read/);
assert.equal(existsSync(missing.folder), false);
const options = { engineInstaller: 'scripts/setup/hermes-installer.sh' };
for (const failed of ['npm  ci --no-audit --no-fund', 'npm ui ci --no-audit --no-fund', 'npm desktop ci --no-audit --no-fund', 'npm ui run build', 'npm  run check', 'python', 'create', 'transfer', 'base', 'engine', 'screens', 'checks', 'permissions', 'desktop', 'autostart', 'start', 'live', '']) {
  const f = fixture(); f.fail(failed);
  if (failed) {
    await assert.rejects(install(f.root, f.config, options, f.ops, f.print), /Stopped at:/);
    assert.equal(f.calls.at(-1), failed);
    assert.equal(existsSync(path.join(f.folder, 'setup.lock')), false);
    const saved = readState(f.folder), completed = Object.keys(saved.done);
    f.calls.length = 0; f.fail('');
    assert.equal(await install(f.root, f.config, options, f.ops, f.print), 0);
    if (completed.includes('packages-root')) assert.equal(f.calls.includes('npm  ci --no-audit --no-fund'), false);
    if (completed.includes('packages-ui')) assert.equal(f.calls.includes('npm ui ci --no-audit --no-fund'), false);
    if (completed.includes('packages-desktop')) assert.equal(f.calls.includes('npm desktop ci --no-audit --no-fund'), false);
    if (completed.includes('build')) assert.equal(f.calls.includes('npm ui run build'), false);
    if (completed.includes('engine')) assert.equal(f.calls.includes('engine'), false);
  } else {
    assert.equal(await install(f.root, f.config, options, f.ops, f.print), 0);
    assert.deepEqual(f.calls, ['inspect', 'stop', 'npm  ci --no-audit --no-fund', 'npm ui ci --no-audit --no-fund', 'npm desktop ci --no-audit --no-fund',
      'npm ui run build', 'npm  run check', 'python', 'create', 'inspect', 'terminate', 'transfer', 'base', 'terminate', 'engine', 'screens', 'terminate', 'checks', 'permissions', 'desktop', 'autostart', 'start', 'live', 'phone']);
    assert.equal(JSON.parse(readFileSync(path.join(f.folder, 'run.json'), 'utf8')).mode, 'real');
    f.calls.length = 0;
    await install(f.root, f.config, {}, f.ops, f.print);
    assert.deepEqual(f.calls, ['inspect', 'stop', 'terminate', 'terminate', 'checks', 'autostart', 'start', 'live', 'phone']);
    writeFileSync(path.join(f.root, 'box/setup.sh'), '#!/bin/bash\necho "Updated"\n');
    f.calls.length = 0; await install(f.root, f.config, {}, f.ops, f.print);
    assert.ok(f.calls.includes('transfer') && f.calls.includes('base') && f.calls.includes('screens'));
    assert.equal(f.calls.includes('engine'), false);
  }
}
const adopt = fixture(); adopt.facts.spaces.push({ name: 'tavi-test', version: 2, id: 'old-id' }, { name: 'another-space', version: 2, id: 'other-id' });
await install(adopt.root, adopt.config, { ...options, adopt: true }, adopt.ops, adopt.print);
assert.ok(adopt.calls.includes('adopt')); assert.equal(adopt.calls.includes('create'), false);
assert.equal(readState(adopt.folder).spaceId, 'old-id');
const interrupted = fixture();
mkdirSync(interrupted.folder);
writeFileSync(path.join(interrupted.folder, 'setup-state.json'), JSON.stringify({ done: {}, distro: 'tavi-test', creating: true }));
interrupted.facts.spaces.push({ name: 'tavi-test', version: 2, id: 'created-id' });
Object.assign(interrupted.facts, { pendingSpaceId: 'created-id' });
await install(interrupted.root, interrupted.config, options, interrupted.ops, interrupted.print);
assert.equal(interrupted.calls.includes('create'), false);
assert.equal(interrupted.calls.includes('adopt'), false);
assert.equal(readState(interrupted.folder).spaceId, 'created-id');
assert.equal(readState(interrupted.folder).creating, undefined);
const payload = transferScript(boxFiles(adopt.root));
assert.match(payload, /base64/); assert.doesNotMatch(payload, /\/mnt\/[a-z]|[A-Z]:\\|another-space/);
const encoded = payload.match(/b64decode\('([^']+)'\)/)![1];
const transferred = JSON.parse(Buffer.from(encoded, 'base64').toString());
assert.equal(Buffer.from(transferred.find((row: { name: string }) => row.name === 'setup.sh').data, 'base64').toString(), readFileSync(path.join(adopt.root, 'box/setup.sh'), 'utf8'));
assert.doesNotMatch(engineScript(Buffer.from('a public installer')), /password|auth add|API_KEY/);
const updateCalls = adopt.calls;
updateCalls.length = 0;
const updateOps = { ...adopt.ops, cleanCode: async () => { updateCalls.push('clean'); }, pull: async () => {
  updateCalls.push('pull'); writeFileSync(path.join(adopt.root, 'src/changed.ts'), 'export const changed = true;');
} };
assert.equal(await main(['update'], { root: adopt.root, source: { TAVI_DATA_DIR: adopt.folder }, ops: updateOps, print: adopt.print }), 0);
assert.deepEqual(updateCalls.slice(0, 4), ['clean', 'stop', 'pull', 'inspect']);
assert.ok(updateCalls.includes('npm ui run build') && updateCalls.includes('npm  run check'));
assert.ok(updateCalls.indexOf('stop') < updateCalls.indexOf('base') || !updateCalls.includes('base'));
assert.throws(() => dataPath(adopt.root, adopt.root), /separate data folder/);
assert.throws(() => dataPath(adopt.root, path.join(adopt.root, 'src')), /separate data folder/);

const windowsCalls: { program: string; args: string[]; input?: string }[] = [];
const native = system(adopt.root, adopt.config, adopt.print, { platform: 'win32', freePort: async () => true,
  execute: async (program: string, args: string[], settings: { input?: string }) => {
    windowsCalls.push({ program, args, input: settings.input });
    if (program === 'powershell.exe') return JSON.stringify({ build: 26100, diskFree: 20 * GiB, virtualization: true, linuxFeature: true, vmFeature: true, spaces: [] });
    if (args[0] === '--version') return 'WSL version: 2.6.1\nKernel version: 6.6.1';
    return '';
  } });
const facts = await native.inspect({}); assert.equal(facts.wslMajor, 2); assert.equal(facts.kernel, true);
assert.equal(windowsCalls.some(row => row.args.includes('-d')), false, 'Looking starts no Linux space.');
await native.createSpace(); await native.linux(payload); await native.terminateSpace(); await native.unregister();
for (const row of windowsCalls.filter(row => row.program === 'wsl.exe' && !['--version', '--list'].includes(row.args[0]))) {
  assert.ok(row.args.includes('tavi-test')); assert.equal(row.args.includes('another-space'), false);
  assert.doesNotMatch(row.args.join(' '), /\/mnt\/[a-z]/);
  if (row.args.includes('bash')) { assert.ok(row.args.includes('-s')); assert.equal(row.input, payload); }
}
const linked = path.join(adopt.root, 'linked');
try { symlinkSync(path.join(adopt.root, 'src'), linked, 'junction'); assert.throws(() => dataPath(adopt.root, path.join(linked, 'saved')), /file links/); }
finally { rmSync(linked, { force: true }); }
const identity = 'a'.repeat(36);
assert.equal(await execute(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(identity)})`]), identity);
await assert.rejects(execute(process.execPath, ['-e', "console.error('A fake private value: short-private-value'); process.exit(2)"],
  { env: { ...process.env, TEST_API_KEY: 'short-private-value' } }), (error: Error) => error.message.includes('[hidden]') && !error.message.includes('short-private-value'));
const bare = path.join(TEST_DIR, 'no-packages');
mkdirSync(path.join(bare, 'scripts'), { recursive: true });
for (const name of ['tavi.mjs', 'tavi-supervise.mjs', 'v3-dev.mjs']) cpSync(path.join('scripts', name), path.join(bare, 'scripts', name));
cpSync('scripts/setup', path.join(bare, 'scripts/setup'), { recursive: true });
assert.equal(existsSync(path.join(bare, 'node_modules')), false);
assert.equal(await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(bare, 'scripts/tavi.mjs')).href)}); console.log('Setup loads without packages.');`]), 'Setup loads without packages.');
console.log('Setup: checks, order, interruption, repeat runs, adoption, pipe transfer and chosen-space commands passed.');
