// Which build of the apps is which (Stage 13.4). A build is named by the hashed files its page loads (/app/assets/…,
// each named from a hash of its contents by the bundler), so any change to the built code or styles changes it. The
// gateway works it out from the built page on disk and sends it in hello; the app works out its own from the page it
// was loaded with. Different: a newer build has gone live since the app was opened.

/** The hashed files a built page loads, sorted, without repeats. */
export function assetsIn(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+)"/g)].map((m) => m[1]))].sort();
}

/** A short name for a build: FNV-1a over its files' names. "" when it loads none (the dev server's page). */
export function buildIdOf(assets: string[]): string {
  if (!assets.length) return "";
  let h = 0x811c9dc5;
  const s = assets.join("\n");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
