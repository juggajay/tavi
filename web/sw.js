// Tavi service worker: shows push notifications and opens the app when one is tapped; for the v2 app it also
// keeps the app's own files so it opens without the network, and keeps sheet pictures it has already shown.
// Pins (Stage 13.2): the app itself keeps each pinned page's pictures and details in "tavi-pins-1"; they're answered
// from there first, so a pin opens at once and with no reception. It never keeps anything else the gateway sends
// (answers, settings, voice). The page at / is fetched fresh whenever there's a network, and the last copy is used
// when there isn't (it's the v2 app since the switch-over, and the installed app opens there).
importScripts("/earlier.js");
const APP = "tavi-app-1"; // the v2 app's files
const SHEETS = "tavi-sheets-1"; // sheet pages and tiles, newest 300
const SHEETS_MAX = 300;
const PINS = "tavi-pins-1"; // written by the app (ui/src/phone/pins.ts), only read here

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const name of [APP, SHEETS, PINS]) await copyEarlierCache(caches, name);
      for (const k of await caches.keys()) if (k !== APP && k !== SHEETS && k !== PINS) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  // hashed app files never change: cache first
  if (p.startsWith("/app/assets/") || p.startsWith("/app/icons/")) return e.respondWith(cacheFirst(APP, req));
  // the app's pages: the network when there is one, the last copy when there isn't
  if (p === "/" || p === "/v2" || p === "/desktop" || /^\/app\/[\w.-]+\.(html|webmanifest)$/.test(p)) return e.respondWith(networkFirst(APP, req));
  // sheet pictures: a pin's own copy, else cache first, keep the newest 300
  if (/^\/api\/sheets\/[\w-]+\/(page\.png|tile\/\d+\/\d+\/\d+\.png)$/.test(p)) return e.respondWith(pinned(req, () => cacheFirst(SHEETS, req, SHEETS_MAX)));
  // a pinned page's details, a book page's or shop drawing's pictures, a photo: from a pin's copy if there is one, else
  // the network
  if (/^\/api\/(sheets|reference|shopdrawings|files|drawings\/crop|browser\/shot)\//.test(p)) return e.respondWith(pinned(req, () => fetch(req)));
  // everything else (/classic, the rest of /api/*, /ws, /oauth/*) goes straight to the network, never cached
});

async function pinned(req, otherwise) {
  const hit = await (await caches.open(PINS)).match(req);
  return hit || otherwise();
}

async function cacheFirst(name, req, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    if (max) {
      const keys = await cache.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - max))) await cache.delete(k);
    }
  }
  return res;
}

// A page (the app itself): with a network, always the gateway's page as it is now, so the phone can't be held on an old
// build (13.4). The gateway sends pages as "no-cache", so the browser's own copy is checked with the gateway every time;
// the copy kept here is replaced on each load and only used when the network fails. A new sw.js is picked up the same
// way (also "no-cache"), takes over at once (skipWaiting, clients.claim), and the app asks for it before it reloads to
// update itself.
async function networkFirst(name, req) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: "Tavi", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || "Tavi", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: d.tag || undefined,
      data: { url: d.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) if ("focus" in w) return w.focus();
      return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/");
    })(),
  );
});
