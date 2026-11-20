import { TEST_DIR } from '../isolate.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
// @ts-expect-error The Windows app uses this shared plain script.
import configuration from '../../scripts/setup/config.cjs';

const root = path.join(TEST_DIR, 'app-run'), folder = path.join(root, 'saved');
mkdirSync(folder, { recursive: true }); mkdirSync(path.join(root, 'desktop'));
const source = readFileSync('desktop/main.js', 'utf8');
for (const mode of ['real', 'practice']) {
  writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ port: 4321, distro: 'tavi-test', mode, voice: false }));
  const calls: { program: string; args: string[] }[] = [];
  const api: { base?: string; start?: () => void; stop?: () => Promise<void>; folder?: string } = {};
  runInNewContext(source + '\ncaptured.base = BASE; captured.start = startEngine; captured.stop = stopEngine; captured.folder = runConfig.folder;', {
    require(name: string) {
      if (name === './earlier.cjs') return { dashed: ['leading', 'hand'].join('-') };
      if (name === 'electron') return { app: { requestSingleInstanceLock: () => true, on() {}, setAppUserModelId() {}, getPath() { return root; }, setPath() {}, whenReady: () => ({ then() {} }), isPackaged: true }, ipcMain: { handle() {} } };
      if (name === 'node:path') return path;
      if (name === 'node:fs') return { readFileSync, existsSync: () => false };
      if (name === './app-config.json') return { root, data: folder, url: 'http://127.0.0.1:9999', alongside: true };
      if (name.endsWith('config.cjs')) return configuration;
      if (name === 'node:child_process') return { spawn(program: string, args: string[]) {
        calls.push({ program, args }); return { unref() {}, once(event: string, done: () => void) { if (event === 'exit') done(); } };
      } };
      throw new Error('A test dependency was not supplied.');
    },
    process: { env: {}, argv: [] }, __dirname: root, URL, AbortSignal, captured: api,
  });
  assert.equal(api.base, 'http://127.0.0.1:4321'); assert.equal(api.folder, folder);
  api.start!(); assert.equal(path.basename(calls[0].args[0]), 'tavi-start-hidden.vbs');
  await api.stop!();
  assert.equal(path.basename(calls[1].args[0]), 'tavi.mjs'); assert.deepEqual(Array.from(calls[1].args.slice(1)), ['stop', '--data', folder]);
}
const build = readFileSync('scripts/tavi-desktop.mjs', 'utf8');
assert.doesNotMatch(build, /--builder|\.\.\//);
assert.match(build, /path.join\(desktop, 'node_modules'\)/);
const entry = readFileSync('scripts/tavi-install-autostart.ps1', 'utf8');
assert.match(entry, /'Tavi.vbs'/);
const pkg = JSON.parse(readFileSync('desktop/package.json', 'utf8'));
const lock = JSON.parse(readFileSync('desktop/package-lock.json', 'utf8'));
assert.deepEqual(pkg.devDependencies, lock.packages[''].devDependencies);
assert.equal(pkg.devDependencies.electron, '44.9.3'); assert.equal(pkg.devDependencies['electron-builder'], '26.17.0');
console.log('Desktop: both modes read the run file, use the chosen port and keeper, and build from local locked packages.');
