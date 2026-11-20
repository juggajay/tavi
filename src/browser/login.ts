// The user logs in to their sites themselves, in Tavi's browser on the PC (Setup → Websites → Log in).
// What's kept is only the site's own "stay signed in" cookie, in this browser's profile (outside the repo, encrypted by
// Edge with a key tied to the user's Windows account). Tavi never sees, types or stores a password, and the
// browser is told not to save passwords, addresses or cards either.
// Logins are forgotten when the site is removed, after IDLE_DAYS unused, or MAX_DAYS after logging in.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { audit } from "../store/log.js";
import { BROWSER_PROFILE, listSites, markLoggedIn, markLoggedOut, releaseBrowser, siteDomain, staleLogins, takeBrowser, toOrigin } from "./sites.js";

const LOGIN = "the login window is open on the PC";

/** Turn off the browser's own password, address and card saving in this profile. */
function noSavedSecrets() {
  const file = path.join(BROWSER_PROFILE, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    if (existsSync(file)) prefs = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* rewrite below */
  }
  prefs.credentials_enable_service = false;
  prefs.profile = { ...((prefs.profile as Record<string, unknown>) ?? {}), password_manager_enabled: false };
  prefs.autofill = { ...((prefs.autofill as Record<string, unknown>) ?? {}), profile_enabled: false, credit_card_enabled: false, enabled: false };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
}

const cookieDomains = async (ctx: BrowserContext) => new Set((await ctx.cookies()).map((c) => c.domain.replace(/^\./, "").toLowerCase()));

export async function openLoginWindow(site: string) {
  const origin = toOrigin(site);
  takeBrowser(LOGIN);
  try {
    noSavedSecrets();
    const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, {
      channel: "msedge",
      headless: false,
      viewport: null,
      locale: "en-AU",
      args: ["--disable-features=PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication"],
    });
    // Note which other domains pick up cookies during the login (single sign-on), so Remove can clear those too.
    const before = await cookieDomains(ctx);
    let seen = new Set(before);
    const poll = setInterval(() => void cookieDomains(ctx).then((d) => (seen = d)).catch(() => undefined), 5000);
    ctx.on("close", () => {
      clearInterval(poll);
      const own = siteDomain(new URL(origin).hostname);
      const extra = [...seen].filter((d) => !before.has(d) && !d.endsWith(own));
      markLoggedIn(origin, extra);
      releaseBrowser(LOGIN);
      audit("user", "browser.login_closed", null, { origin, extra_domains: extra });
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(origin);
    audit("user", "browser.login_opened", null, { origin });
  } catch (err) {
    releaseBrowser(LOGIN);
    throw err;
  }
}

/**
 * Log Tavi's browser out of one site: every cookie for the site's whole domain (so shop.example.com.au also
 * clears example.com.au), its single-sign-on domains (unless another saved site shares them), and the site's stored
 * data (local storage, IndexedDB, caches, service workers).
 */
export async function forgetLogin(origin: string) {
  const site = listSites().find((s) => s.origin === origin);
  const domain = siteDomain(new URL(origin).hostname);
  const othersUse = new Set(listSites().filter((s) => s.origin !== origin).flatMap((s) => [siteDomain(new URL(s.origin).hostname), ...(s.extra_domains ?? [])]));
  const domains = [domain, ...(site?.extra_domains ?? []).filter((d) => !othersUse.has(d))];
  takeBrowser("forgetting a login");
  try {
    const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE, { channel: "msedge", headless: true });
    try {
      const all = await ctx.cookies();
      const hit = [...new Set(all.map((c) => c.domain).filter((d) => domains.some((x) => d.replace(/^\./, "").toLowerCase().endsWith(x))))];
      for (const d of hit) await ctx.clearCookies({ domain: d });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      const origins = new Set([origin, `https://${domain}`, `https://www.${domain}`, ...domains.map((d) => `https://${d}`)]);
      for (const o of origins) await cdp.send("Storage.clearDataForOrigin", { origin: o, storageTypes: "all" }).catch(() => undefined);
      markLoggedOut(origin);
      audit("user", "browser.login_forgotten", null, { origin, cookie_domains: hit.length, origins: [...origins] });
    } finally {
      await ctx.close();
    }
  } finally {
    releaseBrowser("forgetting a login");
  }
}

/** Log out of everything: delete the whole browser profile. The next login starts from scratch. */
export function forgetAllLogins() {
  takeBrowser("forgetting all logins");
  try {
    rmSync(BROWSER_PROFILE, { recursive: true, force: true });
    mkdirSync(BROWSER_PROFILE, { recursive: true });
    for (const s of listSites()) markLoggedOut(s.origin);
    audit("user", "browser.logins_cleared", null, {});
  } finally {
    releaseBrowser("forgetting all logins");
  }
}

/** Forget logins that sat unused too long (run a few times a day). Skips quietly if the browser is busy. */
export async function expireLogins() {
  for (const s of staleLogins()) {
    try {
      await forgetLogin(s.origin);
      audit("system", "browser.login_expired", null, { origin: s.origin, logged_in_at: s.logged_in_at, last_used_at: s.last_used_at });
    } catch {
      return; // busy: try again next time
    }
  }
}
