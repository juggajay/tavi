import { TEST_DIR } from '../isolate.js';
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { earlier, savedValue, copyEarlierCache } from '../../src/shared/earlier.js';
import { savedFolder } from '../../src/shared/savedFolder.js';
import { isAgentRequest, AGENT_HEADER } from '../../src/browser/sites.js';
import { brainHome, brainUrl, jobsDirs } from '../../src/brainlink/config.js';
import { startCommand } from '../../src/brainlink/launch.js';
import { updateSettings } from '../../src/store/settings.js';
import { devCheckDataDir } from '../../src/dev.js';
import { seedPractice } from '../../src/practice.js';
import { voiceCard, regenerateVoiceCard } from '../../src/profile/voiceCard.js';
import { db } from '../../src/store/db.js';
import { defaultReferenceDir } from '../../src/reference/dir.js';
import { assistantName } from '../../src/profile/profile.js';

const values = new Map<string, string>();
assert.match(voiceCard(), /Personality and tone/);
await regenerateVoiceCard();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
for (const suffix of ['client-id-phone', 'hq-theme', 'hq-bot', 'pane-width', 'firstrun-hidden', 'update-tried', 'update-reopen']) {
  values.set(earlier.prefix + suffix, 'Earlier saved value');
  assert.equal(savedValue(storage, 'tavi-' + suffix), 'Earlier saved value');
  assert.equal(values.get('tavi-' + suffix), 'Earlier saved value');
  values.set('tavi-' + suffix, 'Current saved value');
  assert.equal(savedValue(storage, 'tavi-' + suffix), 'Current saved value');
}
assert.equal(savedValue(storage, 'tavi-missing'), null);

const caches = new Map<string, Map<string, Response>>();
const cacheStorage = {
  keys: async () => [...caches.keys()],
  delete: async (key: string) => caches.delete(key),
  open: async (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const items = caches.get(name)!;
    return {
      keys: async () => [...items.keys()],
      match: async (key: string) => items.get(key)?.clone(),
      put: async (key: string, response: Response) => { items.set(key, response.clone()); },
    };
  },
} as unknown as CacheStorage;
for (const suffix of ['app-1', 'sheets-1', 'pins-1']) {
  caches.set(earlier.prefix + suffix, new Map([['/old', new Response('Old picture')], ['/shared', new Response('Old value')]]));
  caches.set('tavi-' + suffix, new Map([['/shared', new Response('Current picture')]]));
  const cache = await copyEarlierCache(cacheStorage, 'tavi-' + suffix);
  assert.equal(await (await cache.match('/old'))!.text(), 'Old picture');
  assert.equal(await (await cache.match('/shared'))!.text(), 'Current picture');
  assert.ok(!caches.has(earlier.prefix + suffix));
  assert.equal(await (await (await copyEarlierCache(cacheStorage, 'tavi-' + suffix)).match('/old'))!.text(), 'Old picture');
}

for (const name of ['brain', 'browser-profile', 'brain-dev', 'browser-dev']) {
  const base = path.join(TEST_DIR, name), old = path.join(base, earlier.folder, name), now = path.join(base, 'Tavi', name);
  // A new installation uses Tavi's folder.
  assert.equal(savedFolder(base, name), now);
  // A folder already saved under the earlier name is used where it is: nothing is copied or moved.
  mkdirSync(old, { recursive: true }); writeFileSync(path.join(old, 'saved.txt'), 'Earlier saved sign-in');
  assert.equal(savedFolder(base, name), old);
  assert.ok(!existsSync(now));
  assert.equal(readFileSync(path.join(old, 'saved.txt'), 'utf8'), 'Earlier saved sign-in');
  // Once Tavi's own folder exists it wins, and the earlier one is left alone.
  mkdirSync(now, { recursive: true });
  assert.equal(savedFolder(base, name), now);
  assert.ok(existsSync(path.join(old, 'saved.txt')));
}
assert.ok(isAgentRequest({ [AGENT_HEADER]: '1' }));
assert.ok(isAgentRequest({ [earlier.agentHeader]: '1' }));
assert.ok(!isAgentRequest({}));
assert.notEqual(AGENT_HEADER, earlier.agentHeader);
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('assistant_name', ?)").run(earlier.words);
assert.equal(assistantName(), 'Tavi');
db.prepare("UPDATE settings SET value = 'Pebble' WHERE key = 'assistant_name'").run();
assert.equal(assistantName(), 'Pebble');
const home = path.join(TEST_DIR, 'reference-home');
mkdirSync(path.join(home, earlier.referenceFolder), { recursive: true });
assert.equal(defaultReferenceDir(home), path.join(home, earlier.referenceFolder));
mkdirSync(path.join(home, 'Tavi Reference'));
assert.equal(defaultReferenceDir(home), path.join(home, 'Tavi Reference'));

// The packaged program keeps its own settings folder and never copies or redirects to another program's.
const program = readFileSync('desktop/main.js', 'utf8');
assert.doesNotMatch(program, /setPath\(\s*['"]userData['"]/);
assert.doesNotMatch(program, /cpSync/);

delete process.env.LH_BRAINLINK_URL;
assert.equal(brainHome(), ''); assert.equal(brainUrl(), null); assert.deepEqual(jobsDirs(), []);
process.env.LH_DEV_BRAINLINK_START = '1';
assert.match((startCommand() as { error: string }).error, /not set up/);
updateSettings({ 'brainlink.home': path.join(TEST_DIR, 'chosen-service') }, 'local');
assert.equal(brainHome(), path.join(TEST_DIR, 'chosen-service'));
assert.deepEqual(jobsDirs(), [path.join(brainHome(), 'out', 'jobs')]);

const protectedFolder = path.join(TEST_DIR, 'protected');
mkdirSync(protectedFolder);
process.env.TAVI_PROTECTED_DATA_DIRS = protectedFolder;
assert.throws(() => devCheckDataDir(path.join(protectedFolder, 'child'), TEST_DIR), /protected data folder/);
delete process.env.TAVI_PROTECTED_DATA_DIRS;
await seedPractice(TEST_DIR);
assert.ok(db.prepare("SELECT fact FROM memories WHERE subject='Ruvo Pell'").get());

// The standalone worker uses the same generated compatibility code as the apps.
const generated = stripTypeScriptTypes(readFileSync('src/shared/earlier.ts', 'utf8'), { mode: 'transform' } as never).replaceAll('export ', '');
assert.equal(readFileSync('web/earlier.js', 'utf8'), generated);
// Parse the retained page and exercise its actual hint with the worker's shared helper.
const html = readFileSync('web/index.html', 'utf8');
const inline = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
new AsyncFunction(inline);
assert.ok(html.indexOf('<script src="/earlier.js"></script>') >= 0);
assert.ok(html.indexOf('<script src="/earlier.js"></script>') < html.indexOf('<script type="module">'));
const start = inline.indexOf('function tuckAway()');
const tuck = inline.slice(start, inline.indexOf('\nfunction ', start + 1));
values.set(earlier.prefix + 'cards-hint', '2');
const pageContext = { localStorage: storage, cardsBtn: { classList: { remove() {}, add() {} }, offsetWidth: 0 }, hint: { textContent: '' }, setTimeout() {} };
runInNewContext(generated + '\n' + tuck + '\ntuckAway();', pageContext);
assert.equal(values.get('tavi-cards-hint'), '3');
values.set('tavi-cards-hint', '8');
runInNewContext(generated + '\n' + tuck + '\ntuckAway();', { ...pageContext });
assert.equal(values.get('tavi-cards-hint'), '9');
console.log('Earlier settings, cached pictures, sign-ins, browser refusal, service setup and practice data passed.');
