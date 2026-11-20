import { existsSync } from 'node:fs';
import path from 'node:path';
// Earlier saved names are assembled here so existing installations keep their settings.
export { default as earlier } from '../desktop/earlier.cjs';
import earlier from '../desktop/earlier.cjs';
// The same rule as src/shared/savedFolder.ts: an existing folder under the earlier name is used where it is.
export function savedFolder(base, name) {
  const current = path.join(base, 'Tavi', name);
  const old = path.join(base, earlier.folder, name);
  return !existsSync(current) && existsSync(old) ? old : current;
}
