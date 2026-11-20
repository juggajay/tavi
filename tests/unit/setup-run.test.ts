import { TEST_DIR } from '../isolate.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error The settings are shared with plain JavaScript programs.
import configuration from '../../scripts/setup/config.cjs';
// @ts-expect-error The keeper is a plain script.
import { settings } from '../../scripts/tavi-supervise.mjs';
// @ts-expect-error The earlier command remains a plain script.
import { alongside } from '../../scripts/tavi-alongside.mjs';

const root = path.join(TEST_DIR, 'run-settings'), folder = path.join(root, 'data-v3');
mkdirSync(folder, { recursive: true }); mkdirSync(path.join(root, 'desktop'));
const empty = (file: string) => { throw Object.assign(new Error(file), { code: 'ENOENT' }); };
const fresh = configuration.loadRun({}, root, empty);
for (const text of ['OPENAI_API_KEY=made-up', 'OPENAI_API_KEY="made-up"', "export OPENAI_API_KEY='made-up'", 'OPENAI_API_KEY=made-up # a note']) assert.equal(configuration.voiceKey(text), 'made-up');
assert.equal(configuration.voiceKey('PORT=1234'), '');
assert.deepEqual(fresh.run, { port: 3077, distro: 'tavi-bots', mode: 'real', voice: false });
assert.equal(fresh.folder, path.join(root, 'data'));
const real = settings({}, root, empty);
assert.equal(real.env.LH_DEV, '0'); assert.equal(real.env.LH_V3_DISTRO, 'tavi-bots'); assert.equal(real.env.LH_NO_VOICE, '1');
const practice = { port: 3100, distro: 'lh-bots', mode: 'practice', voice: true, voiceFile: 'voice.env' };
writeFileSync(path.join(folder, 'run.json'), JSON.stringify(practice));
writeFileSync(path.join(root, 'desktop/app-config.json'), JSON.stringify({ data: folder }));
const read: string[] = [];
const reader = (file: string) => {
  read.push(file);
  if (file === path.join(folder, 'voice.env')) return Buffer.from('OPENAI_API_KEY=made-up-voice-key\nPORT=1\nLH_DEV=0\n');
  return readFileSync(file);
};
const configured = configuration.loadRun({}, root, reader);
assert.equal(read.some(file => file.endsWith('voice.env')), false, 'Reading the run file never opens a key file.');
assert.equal(configured.port, 3100); assert.equal(configured.run.mode, 'practice');
const run = settings({ PORT: '9999', LH_DEV: '0', LH_DEV_PUSH: '1', LH_DEV_KEEPER: '1', LH_DEV_BROWSER: '1', LH_DEV_SCHEDULER: '1' }, root, reader);
assert.equal(run.env.PORT, '3100'); assert.equal(run.env.LH_DEV, '1'); assert.equal(run.env.LH_V3_DISTRO, 'lh-bots');
assert.equal(run.env.LH_NO_VOICE, '0'); assert.equal(run.env.OPENAI_API_KEY, 'made-up-voice-key');
for (const name of ['PUSH', 'KEEPER', 'BROWSER', 'SCHEDULER']) assert.equal(run.env[`LH_DEV_${name}`], undefined);
assert.equal(run.env.LH_DATA_DIR, folder); assert.equal(run.env.LH_V3_DATA, folder);
assert.equal(run.env.DOTENV_CONFIG_PATH, path.join(folder, 'no-env-file'));
writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ ...practice, voice: false }));
const compatibility = alongside({}, root);
assert.equal(compatibility.port, 3100); assert.equal(compatibility.folder, folder); assert.equal(compatibility.env.LH_DEV, '1');
writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ ...practice, mode: 'real', voice: false }));
assert.equal(alongside({}, root).env.LH_DEV, '0', 'The old entry point also obeys the run file.');
assert.equal(settings({}, root, reader).env.LH_NO_VOICE, '1');
for (const patch of [{ port: 3091 }, { port: 3090 }, { port: 0 }, { port: 1.5 }, { distro: '../other' }, { distro: 'not a name' }, { mode: 'other' }, { voice: 'yes' }]) {
  writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ ...practice, ...patch }));
  assert.throws(() => configuration.loadRun({}, root), /run.json/);
}
writeFileSync(path.join(folder, 'run.json'), '{'); assert.throws(() => configuration.loadRun({}, root), /Repair/);
for (const damaged of ['null', 'false', '[]', JSON.stringify({ ...practice, unexpected: true })]) {
  writeFileSync(path.join(folder, 'run.json'), damaged); assert.throws(() => configuration.loadRun({}, root), /run.json/);
}
assert.throws(() => settings({ LH_DATA_DIR: folder, LH_V3_DATA: path.join(root, 'different') }, root, empty), /same data folder/);

// All changed source and guide files are checked for fixed personal paths and names.
const project = path.resolve('.');
const files = ['scripts/tavi.mjs', 'scripts/v3-dev.mjs', 'src/dev.ts', existsSync('public/INSTALL.md') ? 'public/INSTALL.md' : 'INSTALL.md', existsSync('public/docs/UPDATING.md') ? 'public/docs/UPDATING.md' : 'docs/UPDATING.md',
  ...readdirSync('scripts').filter(name => /^tavi-.*\.(mjs|ps1|vbs)$/.test(name)).map(name => 'scripts/' + name),
  ...readdirSync('scripts/setup').filter(name => /\.(cjs|mjs)$/.test(name)).map(name => 'scripts/setup/' + name),
  ...readdirSync('desktop').filter(name => /\.(js|html|json)$/.test(name)).map(name => 'desktop/' + name),
  ...readdirSync('tests/unit').filter(name => /^(setup-|tavi-).*\.test\.ts$/.test(name)).map(name => 'tests/unit/' + name)];
for (const file of files) {
  const text = readFileSync(path.join(project, file), 'utf8');
  assert.doesNotMatch(text, /[A-Z]:[\\/](?:Users|users)[\\/][a-z0-9_-]+[\\/]/i, file);
  assert.doesNotMatch(text, /\.\.\/[a-z-]*harness(?:\/|["'])|["']harness["']|\.ts\.net/i, file);
}
console.log('Run settings: fresh real mode, practice compatibility, voice choices, all entry paths and portable source passed.');
