import { TEST_DIR } from '../isolate.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error The command is plain JavaScript.
import { main, argumentsFor } from '../../scripts/tavi.mjs';

const root = path.join(TEST_DIR, 'commands'), folder = path.join(root, 'saved');
mkdirSync(folder, { recursive: true }); mkdirSync(path.join(root, 'desktop'));
writeFileSync(path.join(folder, 'run.json'), JSON.stringify({ port: 4321, distro: 'tavi-test', mode: 'real', voice: false }));
writeFileSync(path.join(folder, 'setup-state.json'), JSON.stringify({ done: {}, spaceId: 'ours', distro: 'tavi-test' }));
const output: string[] = [], calls: string[] = [];
let running = false, owned = true;
const rows = (ok: boolean) => ['app', 'guard', 'engine'].map(id => ({ id, ok, line: `${id} answers.`, fix: 'Read the log.' }));
const live = () => ({ rows: rows(running), health: running ? { ok: true } : undefined,
  hq: running ? { guard: 'up', safety: { level: 'open' }, bots: [{ id: 'mira', name: 'Mira', engine: 'hermes', primary: { provider: 'anthropic' } }] } : undefined,
  engines: { mira: { status: 'ready' } } });
const ops = {
  live: async () => live(), waitLive: async () => live(),
  start: async () => { calls.push('start'); running = true; }, stop: async () => { calls.push('stop'); running = false; },
  logs: async () => { calls.push('logs'); }, autostart: async (remove: boolean) => { calls.push(`entry ${remove}`); },
  removeDesktop: async () => { calls.push('remove desktop'); }, unregister: async () => { calls.push('remove space'); }, removeData: async () => { calls.push('remove data'); },
  cleanCode: async () => { calls.push('clean'); }, pull: async () => { calls.push('pull'); throw new Error('A made-up pull failed.'); },
  inspect: async () => ({ platform: 'win32', build: 26100, nodeMajor: 24, linuxFeature: true, vmFeature: true,
    virtualization: true, wslMajor: 2, kernel: true, diskFree: 30 * 1024 ** 3, memoryFree: 4 * 1024 ** 3, memoryTotal: 16 * 1024 ** 3,
    ports: { 4321: true, 3090: true, 3091: true }, guardSupportsName: true,
    spaces: [{ name: 'tavi-test', version: 2, id: owned ? 'ours' : 'another-installation' }] }),
};
const command = (words: string[]) => main([...words, '--data', folder], { root, source: {}, ops, print: (line: string) => output.push(line) });
assert.equal(await command(['status']), 0); assert.match(output.join('\n'), /stopped.*real/); assert.ok(output.some(line => line.includes('tavi-test')));
assert.equal(await command(['start']), 0); assert.deepEqual(calls.splice(0), ['start']);
assert.equal(await command(['start']), 0); assert.deepEqual(calls.splice(0), []);
assert.equal(await command(['status']), 0); assert.match(output.join('\n'), /Mira: hermes; anthropic; ready/);
assert.equal(await command(['doctor']), 0);
assert.equal(await command(['logs']), 0); assert.deepEqual(calls.splice(0), ['logs']);
assert.equal(await command(['restart']), 0); assert.deepEqual(calls.splice(0), ['stop', 'start']);
assert.equal(await command(['stop']), 0); assert.deepEqual(calls.splice(0), ['stop']);
assert.equal(await command(['doctor']), 1);
assert.equal(await command(['setup', '--check']), 0); assert.equal(calls.length, 0);
assert.equal(await command(['update']), 1); assert.deepEqual(calls.splice(0), ['clean', 'stop', 'pull']);
assert.equal(await command(['uninstall']), 0); assert.deepEqual(calls.splice(0), ['stop', 'entry true', 'remove desktop']);
assert.ok(existsSync(path.join(folder, 'run.json')));
assert.match(output.join('\n'), /permanently.*uninstall erase/);
owned = false;
assert.equal(await command(['uninstall', 'erase']), 1); assert.equal(calls.length, 0);
owned = true;
assert.equal(await command(['uninstall', 'erase']), 0); assert.deepEqual(calls.splice(0), ['stop', 'entry true', 'remove desktop', 'remove space', 'remove data']);
assert.ok(output.find(line => line.startsWith('ERASE:'))?.includes('subscription sign-ins'));
for (const args of [['wrong'], ['setup', '--port'], ['start', '--mode', 'practice'], ['uninstall', '--yes'], ['stop', 'erase'], ['setup', '--mode', 'real', '--mode', 'practice']]) assert.throws(() => argumentsFor(args));
assert.equal(await command(['setup', '--port', '3091']), 1);
assert.equal(await command(['setup', '--mode', 'unknown']), 1);
console.log('Commands: every word, check-only, live failures, update failure and explicit removal passed.');
