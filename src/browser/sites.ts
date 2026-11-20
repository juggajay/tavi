import { earlier } from "../shared/earlier.js";
import { savedFolder } from "../shared/savedFolder.js";
// Tavi's own browser. Two modes:
// - "your accounts": sites the user listed in Setup, in a saved profile where THEY logged in themselves
//   (Tavi never sees or types a password). The job can only go to those sites.
// - "fresh": any public site, in a throwaway profile with no logins.
// Either way: never this PC's own pages, local networks, or claude.ai (where it could change its own access).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { db } from "../store/db.js";
import { audit } from "../store/log.js";
import { PRIVATE_HOST } from "../brain/guards.js";

/** Where the assistant's own browser profile is: outside the repo and outside data/ (it holds the user's site logins). */
export const profileDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.LH_BROWSER_DIR
    ? path.resolve(env.LH_BROWSER_DIR) // dev and tests: never the live logins
    : savedFolder(env.LOCALAPPDATA ?? homedir(), "browser-profile");
export const BROWSER_PROFILE = profileDir();
mkdirSync(BROWSER_PROFILE, { recursive: true });

/** A real browser's own profile (the owner's Chrome, Edge, Brave, Firefox): the assistant's browser never opens one. */
export function ownersBrowserProfile(dir: string): boolean {
  const p = path.resolve(dir).toLowerCase().replace(/\//g, "\\");
  return /\\(google\\chrome[^\\]*|microsoft\\edge[^\\]*|bravesoftware\\brave-browser[^\\]*|chromium|mozilla\\firefox)\\/.test(`${p}\\`) || /\\user data(\\|$)/.test(p);
}

/** Sent with every request from Tavi's browser; the gateway refuses anything carrying it. */
export const AGENT_HEADER = "x-tavi-agent";
// Earlier paired browsers must still be refused at every owner-only route.
export const isAgentRequest = (headers: Record<string, unknown>) => !!(headers[AGENT_HEADER] || headers[earlier.agentHeader]);

/**
 * logged_in_at: when the user last logged in through Setup. last_used_at: when a job last used it.
 * extra_domains: other domains that got cookies during the login (single sign-on), cleared with the site.
 */
export type Site = { origin: string; label: string; added_at: string; logged_in_at?: string | null; last_used_at?: string | null; extra_domains?: string[] };

/** Logins are forgotten after this long unused, and this long after logging in regardless. */
export const IDLE_DAYS = 30;
export const MAX_DAYS = 90;

/**
 * Sites Tavi's browser may never hold a login for: banks, payments, crypto, super and shares, email and
 * the big account providers, and myGov / ATO. Those stay with the user.
 */
const NEVER = [
  "commbank.com.au", "netbank.com.au", "westpac.com.au", "anz.com", "anz.com.au", "nab.com.au", "bankwest.com.au", "stgeorge.com.au",
  "bankofmelbourne.com.au", "banksa.com.au", "ing.com.au", "ubank.com.au", "macquarie.com.au", "suncorp.com.au", "suncorpbank.com.au",
  "bendigobank.com.au", "boq.com.au", "hsbc.com.au", "citibank.com.au", "amp.com.au", "greatsouthernbank.com.au", "mebank.com.au",
  "beyondbank.com.au", "heritage.com.au", "newcastlepermanent.com.au", "peoplesfirst.com.au", "americanexpress.com", "paypal.com",
  "wise.com", "revolut.com", "afterpay.com", "zip.co", "humm.com.au", "stripe.com", "coinbase.com", "binance.com", "swyftx.com",
  "coinspot.com.au", "independentreserve.com", "commsec.com.au", "selfwealth.com.au", "stake.com.au", "superhero.com.au",
  "australiansuper.com", "hostplus.com.au", "rest.com.au", "aware.com.au", "unisuper.com.au", "cbussuper.com.au", "hesta.com.au",
  "google.com", "gmail.com", "outlook.com", "live.com", "hotmail.com", "microsoft.com", "microsoftonline.com", "office.com",
  "yahoo.com", "icloud.com", "apple.com", "proton.me", "protonmail.com", "fastmail.com",
  "my.gov.au", "ato.gov.au", "servicesaustralia.gov.au", "centrelink.gov.au", "medicare.gov.au",
];
const neverAllowed = (host: string) => NEVER.some((d) => host === d || host.endsWith(`.${d}`));

/** "shop.example.com" → "example.com": the part a site's cookies can be shared across. */
export function siteDomain(host: string) {
  const parts = host.toLowerCase().replace(/^\.+/, "").split(".");
  const twoLevel = /^(com|net|org|gov|edu|asn|id|co|ac)$/.test(parts[parts.length - 2] ?? "") && (parts[parts.length - 1] ?? "").length === 2;
  return parts.slice(twoLevel ? -3 : -2).join(".");
}
const KEY = "browser_sites";

export function listSites(): Site[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as Site[]) : [];
  } catch {
    return [];
  }
}
const save = (sites: Site[]) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(sites));

/** "example.com" or "https://www.example.com/shop" → "https://www.example.com". */
export function toOrigin(input: string): string {
  const raw = input.trim();
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (u.protocol !== "https:") throw new Error("Only https sites can be saved.");
  const why = blockedHost(u.hostname);
  if (why) throw new Error(why);
  if (neverAllowed(u.hostname.toLowerCase())) {
    throw new Error("Banking, payment, super, email and myGov sites can't be added. Logins for those stay with you, not Tavi.");
  }
  return u.origin;
}

function update(origin: string, f: Partial<Site>) {
  save(listSites().map((s) => (s.origin === origin ? { ...s, ...f } : s)));
}
/** The user finished logging in (the login window closed). */
export function markLoggedIn(origin: string, extraDomains: string[]) {
  const cur = listSites().find((s) => s.origin === origin);
  if (!cur) return;
  update(origin, { logged_in_at: new Date().toISOString(), extra_domains: [...new Set([...(cur.extra_domains ?? []), ...extraDomains])] });
}
/** A job is about to use these sites. */
export function markUsed(origins: string[]) {
  const now = new Date().toISOString();
  save(listSites().map((s) => (origins.includes(s.origin) ? { ...s, last_used_at: now } : s)));
}
export const markLoggedOut = (origin: string) => update(origin, { logged_in_at: null });

/** Saved sites whose login should be forgotten now: unused for IDLE_DAYS, or logged in more than MAX_DAYS ago. */
export function staleLogins(now = Date.now()): Site[] {
  return listSites().filter((s) => {
    if (!s.logged_in_at) return false;
    const loggedIn = new Date(s.logged_in_at).getTime();
    const lastTouch = Math.max(loggedIn, s.last_used_at ? new Date(s.last_used_at).getTime() : 0);
    return now - lastTouch > IDLE_DAYS * 86_400_000 || now - loggedIn > MAX_DAYS * 86_400_000;
  });
}

/** Only the user, from the PC app. */
export function addSite(input: string, label?: string) {
  const origin = toOrigin(input);
  const sites = listSites().filter((s) => s.origin !== origin);
  sites.push({ origin, label: (label || new URL(origin).hostname.replace(/^www\./, "")).slice(0, 40), added_at: new Date().toISOString() });
  save(sites);
  audit("user", "browser.site_added", null, { origin });
  return origin;
}
export function removeSite(origin: string) {
  save(listSites().filter((s) => s.origin !== origin));
  audit("user", "browser.site_removed", null, { origin });
}

/** Hosts the browser must never open, whatever the task says. */
export function blockedHost(host: string): string | null {
  const h = host.toLowerCase();
  if (PRIVATE_HOST.test(h) || h.endsWith(".ts.net") || h.endsWith(".local") || h === "[::1]") return "Local and private network addresses are off-limits.";
  if (/(^|\.)(claude\.ai|anthropic\.com|claude\.com)$/.test(h)) return "Claude's own sites are off-limits to the browser.";
  return null;
}

/** For tests only: one extra origin allowed in this process (e.g. a local test shop). Never set by the gateway. */
export const testOrigin = () => process.env.BROWSER_TEST_ORIGIN || null;

/** Why the browser may not go to this URL in this job, or null. */
export function navigationBlock(raw: string, allowed: string[] | null): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That isn't a valid web address.";
  }
  if (testOrigin() && u.origin === testOrigin()) return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only normal web pages.";
  const why = blockedHost(u.hostname);
  if (why) return why;
  if (allowed && !allowed.includes(u.origin)) return `This job can only use ${allowed.map((o) => new URL(o).hostname).join(", ")}.`;
  return null;
}

/* One browser at a time: the saved profile can't be opened twice (a job and the user's login window). */
let holder: string | null = null;
export const browserBusy = () => holder;
export function takeBrowser(who: string) {
  if (holder) throw new Error(`The browser is busy (${holder}).`);
  holder = who;
}
export const releaseBrowser = (who: string) => {
  if (holder === who) holder = null;
};
