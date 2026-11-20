// The assistant's saved browser profile, seen from Settings (Stage 15.2): the sites it holds cookies for, signing out of
// one site (that site's cookies and stored data only), and clearing everything. And signing in: the owner opens a site
// in the assistant's browser, in the desktop's pane, and types his own password into the page. The assistant isn't
// involved; nothing he types is seen, logged or kept by the app. Banks, payments, email and myGov can't be opened this way.
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { audit } from "../store/log.js";
import { BROWSER_PROFILE, addSite, browserBusy, listSites, markLoggedIn, markLoggedOut, releaseBrowser, siteDomain, takeBrowser, toOrigin } from "./sites.js";
import { liveHost, openBrowser } from "./host.js";
import { forgetAllLogins } from "./login.js";

const usesSaved = () => {
  const h = liveHost();
  return !!h && path.resolve(h.profile).toLowerCase() === path.resolve(BROWSER_PROFILE).toLowerCase();
};

/** Do something with the saved profile: the open browser's, if it's that one; else a quick hidden one. */
async function withProfile<T>(f: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  const h = liveHost();
  if (h && usesSaved()) {
    if (!h.ctx) throw new Error("The browser is just starting. Try again in a moment.");
    return f(h.ctx);
  }
  if (browserBusy()) throw new Error(`The browser is busy (${browserBusy()}). Try again when it's finished.`);
  takeBrowser("looking at its sign-ins");
  try {
    const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, { channel: "msedge", headless: true });
    try {
      return await f(ctx);
    } finally {
      await ctx.close().catch(() => undefined);
    }
  } finally {
    releaseBrowser("looking at its sign-ins");
  }
}

export type SignedIn = { domain: string; cookies: number; saved: boolean };

let cached: { at: number; sites: SignedIn[] } | null = null;
const forget = () => (cached = null);

/** Sites with cookies in the saved profile, by site ("shop.coles.com.au" counts as coles.com.au): saved sites first. */
export async function signedInSites(): Promise<SignedIn[]> {
  // read afresh from an open browser; otherwise a quick hidden one, remembered for half a minute (Settings redraws often)
  if (!usesSaved() && cached && Date.now() - cached.at < 30_000) return cached.sites;
  const cookies = await withProfile((ctx) => ctx.cookies());
  const saved = new Set(listSites().map((s) => siteDomain(new URL(s.origin).hostname)));
  const by = new Map<string, number>();
  for (const c of cookies) {
    const d = siteDomain(c.domain.replace(/^\./, ""));
    if (d) by.set(d, (by.get(d) ?? 0) + 1);
  }
  const sites = [...by].map(([domain, n]) => ({ domain, cookies: n, saved: saved.has(domain) })).sort((a, b) => Number(b.saved) - Number(a.saved) || a.domain.localeCompare(b.domain));
  cached = { at: Date.now(), sites };
  return sites;
}

/** Sign out of one site: its cookies (every subdomain) and the data it stored. Every other site is left alone. */
export async function signOutSite(domain: string) {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(d) || !d.includes(".")) throw new Error("That isn't a site.");
  const site = siteDomain(d);
  forget();
  const n = await withProfile(async (ctx) => {
    const hit = [...new Set((await ctx.cookies()).map((c) => c.domain).filter((c) => siteDomain(c.replace(/^\./, "")) === site))];
    for (const c of hit) await ctx.clearCookies({ domain: c });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const cdp = await ctx.newCDPSession(page);
    const hosts = new Set([site, `www.${site}`, ...hit.map((c) => c.replace(/^\./, ""))]);
    for (const h of hosts) for (const scheme of ["https", "http"]) await cdp.send("Storage.clearDataForOrigin", { origin: `${scheme}://${h}`, storageTypes: "all" }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    return hit.length;
  });
  for (const s of listSites()) if (siteDomain(new URL(s.origin).hostname) === site) markLoggedOut(s.origin);
  audit("user", "browser.signed_out", null, { site, cookie_domains: n });
  return { site };
}

/** Clear everything: the whole saved profile goes; every site is signed out. */
export function clearEverything() {
  if (usesSaved()) throw new Error("The browser is open. Stop it first.");
  forget();
  forgetAllLogins();
}

/**
 * "Open the saved shop site and let me log in": the site opens in the assistant's browser, in the desktop's pane, with him
 * driving from the start. When he presses Done it closes, and the site is kept as one of his saved sites (signed in).
 */
export async function openSignIn(site: string) {
  const origin = toOrigin(site); // refuses banks, payments, email, myGov, and anything local
  if (!listSites().some((s) => s.origin === origin)) addSite(origin);
  const domain = new URL(origin).hostname.replace(/^www\./, "");
  takeBrowser(`signing in to ${domain}`);
  try {
    const host = await openBrowser({ profile: BROWSER_PROFILE, throwaway: false, mode: "owner", job_id: null, summary: `Signing in to ${domain}`, url: origin });
    host.whenClosed(() => {
      forget();
      const own = siteDomain(new URL(origin).hostname);
      markLoggedIn(origin, host.sites().filter((d) => d !== own));
      releaseBrowser(`signing in to ${domain}`);
      audit("user", "browser.signin_closed", null, { origin });
    });
    await host.takeOver();
    return { origin, domain };
  } catch (err) {
    releaseBrowser(`signing in to ${domain}`);
    throw err;
  }
}
