// Local test helper for Windows sandboxes where tsx cannot read the Windows user record.
// Use with Node's --experimental-transform-types flag. No package files are changed.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url).href;
// Child checks sometimes move into a throwaway folder. Keep this helper's address absolute.
if (process.env.NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(
  /--import\s+\.\/src\/hq\/screens\/test-loader\.mjs/g,
  `--import ${import.meta.url}`,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'tsx') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root)) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (target.href.startsWith(root) && existsSync(fileURLToPath(target))) return nextResolve(target.href, context);
    }
    return nextResolve(specifier, context);
  },
});
