// Keep the service worker's plain JavaScript copy in step with the shared compatibility helper.
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = new URL('../src/shared/earlier.ts', import.meta.url);
const target = new URL('../web/earlier.js', import.meta.url);
const generated = stripTypeScriptTypes(readFileSync(source, 'utf8'), { mode: 'transform' }).replaceAll('export ', '');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== generated) throw new Error('Refresh the worker helper with node scripts/earlier-worker.mjs.');
} else writeFileSync(target, generated);
console.log('The worker compatibility helper is up to date.');
