import { existsSync } from 'node:fs';
import path from 'node:path';
import { earlier } from './earlier.js';

// Where a saved folder lives. A new installation uses Tavi's folder. An installation that already has the folder
// under the earlier name keeps using it where it is: nothing is copied or moved, because other things are keyed by
// that exact place (a model connector remembers its per-folder choices by the folder's path, and a browser's saved
// sign-ins may be open in a running program).
export function savedFolder(base: string, name: string): string {
  const current = path.join(base, 'Tavi', name);
  const old = path.join(base, earlier.folder, name);
  return !existsSync(current) && existsSync(old) ? old : current;
}
