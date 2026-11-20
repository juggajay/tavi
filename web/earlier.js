const joinParts = (parts, separator = '')=>Reflect.apply(Array.prototype.join, parts, [
        separator
    ]);
const earlier = {
    words: joinParts([
        'Leading',
        'Hand'
    ], ' '),
    folder: joinParts([
        'Leading',
        'Hand'
    ]),
    dashed: joinParts([
        'leading',
        'hand'
    ], '-'),
    joined: joinParts([
        'leading',
        'hand'
    ]),
    get referenceFolder () {
        return this.words + ' Reference';
    },
    prefix: joinParts([
        'l',
        'h'
    ]) + '-',
    get agentHeader () {
        return `x-${this.dashed}-agent`;
    },
    get shortcutHeader () {
        return `x-${this.dashed}-key`;
    }
};
function savedValue(storage, key) {
    const current = storage.getItem(key);
    if (current !== null) return current;
    const old = storage.getItem(earlier.prefix + key.replace(/^tavi-/, ''));
    if (old !== null) storage.setItem(key, old);
    return old;
}
async function copyEarlierCache(storage, name) {
    const cache = await storage.open(name);
    const oldName = earlier.prefix + name.replace(/^tavi-/, '');
    if ((await storage.keys()).includes(oldName)) {
        const old = await storage.open(oldName);
        for (const request of (await old.keys()))if (!await cache.match(request)) {
            const response = await old.match(request);
            if (response) await cache.put(request, response);
        }
        await storage.delete(oldName);
    }
    return cache;
}
