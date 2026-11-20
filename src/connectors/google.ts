// Google / Gmail connector: OAuth (desktop client, loopback redirect, PKCE), token refresh,
// and the few Gmail calls the brain and the broker need. Tokens never leave encrypted storage.
import { createHash, randomBytes } from "node:crypto";
import { db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { deleteSecret, getSecret, putSecret } from "../store/secrets.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly", // search and read
  "https://www.googleapis.com/auth/gmail.compose", // drafts and sending (sending only via the broker)
];

type ClientConfig = { clientId: string; clientSecret: string };
type Tokens = { access_token: string; refresh_token: string; expires_at: number; scope: string };
export type Account = { id: string; provider: string; label: string; address: string; status: string };

export class DefiniteFailure extends Error {} // the provider definitely did NOT act

/* ---------------- client setup + accounts ---------------- */

export function googleConfigured() {
  return !!getSecret<ClientConfig>("google.client");
}

export function setGoogleClient(clientId: string, clientSecret: string) {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) throw new Error("That doesn't look like a Google client ID (it ends in .apps.googleusercontent.com).");
  if (secret.length < 10) throw new Error("That client secret looks too short.");
  putSecret("google.client", { clientId: id, clientSecret: secret } satisfies ClientConfig);
  audit("user", "google.client.saved", null, { client_id_suffix: id.slice(-28) });
}

export function listAccounts(): Account[] {
  return db.prepare("SELECT id, provider, label, address, status FROM accounts WHERE status != 'disconnected' ORDER BY created_at").all() as Account[];
}

export function findAccount(labelOrAddress: string): Account | undefined {
  const q = labelOrAddress.trim().toLowerCase();
  return listAccounts().find((a) => a.label.toLowerCase() === q || a.address.toLowerCase() === q);
}

/* ---------------- OAuth ---------------- */

const pendingAuth = new Map<string, { verifier: string; redirectUri: string; created: number; label: string }>();

export function startGoogleAuth(redirectUri: string, label = "Gmail"): string {
  const cfg = getSecret<ClientConfig>("google.client");
  if (!cfg) throw new Error("Google isn't set up yet. Add the client ID and secret in Connections first.");
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  pendingAuth.set(state, { verifier, redirectUri, created: Date.now(), label });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function finishGoogleAuth(state: string, code: string): Promise<Account> {
  const p = pendingAuth.get(state);
  pendingAuth.delete(state);
  if (!p || Date.now() - p.created > 10 * 60_000) throw new Error("That sign-in expired. Start again from Connections.");
  const cfg = getSecret<ClientConfig>("google.client")!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: p.redirectUri,
      grant_type: "authorization_code",
      code_verifier: p.verifier,
    }),
  });
  const t = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Google said: ${t.error_description ?? t.error ?? res.status}`);
  if (!t.refresh_token) {
    throw new Error("Google didn't give a long-lived token. Remove the app at myaccount.google.com/permissions, then connect again.");
  }
  const tokens: Tokens = {
    access_token: String(t.access_token),
    refresh_token: String(t.refresh_token),
    expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000,
    scope: String(t.scope ?? ""),
  };
  const missing = GOOGLE_SCOPES.filter((s) => !tokens.scope.includes(s));
  if (missing.length) throw new Error("Some Gmail permissions weren't ticked. Connect again and allow them all.");

  const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const profile = (await prof.json()) as { emailAddress?: string };
  if (!prof.ok || !profile.emailAddress) throw new Error("Connected, but couldn't read the Gmail address.");

  const existing = db.prepare("SELECT id FROM accounts WHERE provider = 'google' AND address = ?").get(profile.emailAddress) as { id: string } | undefined;
  const id = existing?.id ?? newId("acct");
  if (existing) {
    db.prepare("UPDATE accounts SET label = ?, scopes = ?, status = 'connected', updated_at = ? WHERE id = ?").run(p.label, tokens.scope, nowIso(), id);
  } else {
    db.prepare("INSERT INTO accounts (id, provider, label, address, scopes, status, created_at, updated_at) VALUES (?, 'google', ?, ?, ?, 'connected', ?, ?)").run(
      id,
      p.label,
      profile.emailAddress,
      tokens.scope,
      nowIso(),
      nowIso(),
    );
  }
  putSecret(`google.tokens.${id}`, tokens);
  audit("user", "account.connected", id, { provider: "google", label: p.label, address: profile.emailAddress });
  return { id, provider: "google", label: p.label, address: profile.emailAddress, status: "connected" };
}

async function accessToken(accountId: string): Promise<string> {
  const tokens = getSecret<Tokens>(`google.tokens.${accountId}`);
  if (!tokens) throw new DefiniteFailure("That account isn't connected.");
  if (tokens.expires_at - 60_000 > Date.now()) return tokens.access_token;
  const cfg = getSecret<ClientConfig>("google.client")!;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: tokens.refresh_token, grant_type: "refresh_token" }),
  });
  const t = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    if (t.error === "invalid_grant") {
      db.prepare("UPDATE accounts SET status = 'needs_reconnect', updated_at = ? WHERE id = ?").run(nowIso(), accountId);
      audit("system", "account.needs_reconnect", accountId);
      throw new DefiniteFailure("Gmail needs reconnecting. Open Connections and connect it again.");
    }
    throw new Error(`Couldn't refresh Gmail access (${t.error ?? res.status}).`);
  }
  const next: Tokens = { ...tokens, access_token: String(t.access_token), expires_at: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
  putSecret(`google.tokens.${accountId}`, next);
  return next.access_token;
}

async function gmail<T>(accountId: string, pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const token = await accessToken(accountId);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathAndQuery}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    // 4xx means Gmail rejected the request outright; 5xx/network leaves the outcome uncertain.
    if (res.status >= 400 && res.status < 500) throw new DefiniteFailure(`Gmail rejected it: ${msg}`);
    throw new Error(`Gmail error: ${msg}`);
  }
  return body;
}

export async function disconnectAccount(accountId: string) {
  const tokens = getSecret<Tokens>(`google.tokens.${accountId}`);
  if (tokens) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token)}`, { method: "POST" }).catch(() => undefined);
  }
  deleteSecret(`google.tokens.${accountId}`);
  db.prepare("UPDATE accounts SET status = 'disconnected', updated_at = ? WHERE id = ?").run(nowIso(), accountId);
  audit("user", "account.disconnected", accountId);
}

/* ---------------- Gmail operations ---------------- */

type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
const header = (hs: Header[] | undefined, name: string) => hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

export async function searchMail(accountId: string, query: string, max = 8) {
  const list = await gmail<{ messages?: { id: string; threadId: string }[] }>(
    accountId,
    `messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 20)) })}`,
  );
  const ids = list.messages ?? [];
  return Promise.all(
    ids.map(async (m) => {
      const msg = await gmail<{ id: string; threadId: string; snippet: string; labelIds?: string[]; payload?: Part }>(
        accountId,
        `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      );
      const hs = msg.payload?.headers;
      return {
        id: msg.id,
        thread_id: msg.threadId,
        from: header(hs, "From"),
        to: header(hs, "To"),
        subject: header(hs, "Subject"),
        date: header(hs, "Date"),
        unread: msg.labelIds?.includes("UNREAD") ?? false,
        snippet: msg.snippet,
      };
    }),
  );
}

function textOf(part: Part | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return b64url(part.body.data);
  for (const p of part.parts ?? []) {
    const t = textOf(p);
    if (t) return t;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return b64url(part.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

export async function readMail(accountId: string, messageId: string) {
  const msg = await gmail<{ id: string; threadId: string; payload?: Part }>(accountId, `messages/${encodeURIComponent(messageId)}?format=full`);
  const hs = msg.payload?.headers;
  const body = textOf(msg.payload);
  return {
    id: msg.id,
    thread_id: msg.threadId,
    from: header(hs, "From"),
    to: header(hs, "To"),
    cc: header(hs, "Cc"),
    subject: header(hs, "Subject"),
    date: header(hs, "Date"),
    message_id_header: header(hs, "Message-ID"),
    body: body.length > 8000 ? `${body.slice(0, 8000)}\n[... truncated]` : body,
  };
}

const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
export const isEmailAddress = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s.trim());

export async function sendMail(accountId: string, m: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }) {
  const bad = [...m.to, ...m.cc, ...m.bcc].filter((r) => !isEmailAddress(r));
  if (bad.length) throw new DefiniteFailure(`Not email addresses: ${bad.join(", ")}`);
  const lines = [
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.bcc.length ? [`Bcc: ${m.bcc.join(", ")}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  const raw = Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
  const sent = await gmail<{ id: string; threadId: string; labelIds?: string[] }>(accountId, "messages/send", {
    method: "POST",
    body: JSON.stringify({ raw }),
  });
  return { providerRef: sent.id };
}

export async function verifySent(accountId: string, messageId: string) {
  const msg = await gmail<{ labelIds?: string[] }>(accountId, `messages/${encodeURIComponent(messageId)}?format=minimal`);
  return msg.labelIds?.includes("SENT") ?? false;
}
