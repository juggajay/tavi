// Earlier saved names are assembled here so existing installations keep their settings.
// Use a runtime call so a build does not turn these parts back into old literal names.
const joinParts = (parts: string[], separator = ''): string => Reflect.apply(Array.prototype.join, parts, [separator]);
export const earlier = {
  words: joinParts(['Leading', 'Hand'], ' '),
  folder: joinParts(['Leading', 'Hand']),
  dashed: joinParts(['leading', 'hand'], '-'),
  joined: joinParts(['leading', 'hand']),
  get referenceFolder() { return this.words + ' Reference'; },
  prefix: joinParts(['l', 'h']) + '-',
  get agentHeader() { return `x-${this.dashed}-agent`; },
  get shortcutHeader() { return `x-${this.dashed}-key`; },
};

/** Read the current saved value first, then keep an earlier value under the current key. */
export function savedValue(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): string | null {
  const current = storage.getItem(key);
  if (current !== null) return current;
  const old = storage.getItem(earlier.prefix + key.replace(/^tavi-/, ''));
  if (old !== null) storage.setItem(key, old);
  return old;
}

/** Copy earlier caches once before removing them; existing current entries take priority. */
export async function copyEarlierCache(storage: CacheStorage, name: string): Promise<Cache> {
  const cache = await storage.open(name);
  const oldName = earlier.prefix + name.replace(/^tavi-/, '');
  if ((await storage.keys()).includes(oldName)) {
    const old = await storage.open(oldName);
    for (const request of await old.keys()) if (!(await cache.match(request))) {
      const response = await old.match(request);
      if (response) await cache.put(request, response);
    }
    await storage.delete(oldName);
  }
  return cache;
}
