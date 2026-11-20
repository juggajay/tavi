// Node's own TypeScript reader, for the documented Windows account lookup failure.
// Use only with Node 24 and --experimental-transform-types.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'tsx') return next('node:module', context);
  if (specifier === 'tsx/esm/api') return { url: 'data:text/javascript,export function register() {}', shortCircuit: true };
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
  }
  return next(specifier, context);
} });
