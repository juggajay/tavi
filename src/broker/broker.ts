// The action broker: the ONLY code path that can send, book or change anything outside the PC.
// The brain can draft; only a user tap on an exact, unexpired, single-use grant makes the broker act.
import { createHash, randomBytes } from "node:crypto";
import { db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { DEV } from "../dev.js";
import { DefiniteFailure, findAccount, sendMail, verifySent } from "../connectors/google.js";
import { ConnectorRefused, permissionsFor, runConnectorCall, serverOf, stableJson } from "../connectors/claudeai.js";
import { planSoulEdit, saveSoul, soulHash } from "../profile/profile.js";

const APPROVAL_TTL_MS = 15 * 60_000;

/** One exact call to a Claude-account connector (send, create an event, share a file...). */
export type ConnectorGrant = { operation: "connector.call"; version: 1; connector: string; tool: string; input: unknown; summary: string };
/** A browser job is ready to press its final button (place order, pay, book, send...) and is waiting for the user. */
export type BrowserGrant = {
  operation: "browser.submit";
  version: 1;
  job_id: string;
  summary: string;
  details: { label: string; value: string }[];
  total: string | null;
  final_button: string;
  image: string | null;
};
/** Running browser jobs waiting on a go-ahead: approval id → how to tell them the answer. */
const waiting = new Map<string, (answer: "approve" | "reject") => void>();
/** One change to SOUL.md the brain proposed, bound to the exact file it was based on. */
export type SoulGrant = { operation: "soul.edit"; version: 1; base_hash: string; next_hash: string; old_text: string; new_text: string; summary: string };

export type EmailGrant = {
  operation: "email.send";
  version: 1;
  draft_id: string;
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body_sha256: string;
  attachments_sha256: string[];
};

export type ApprovalView = {
  id: string;
  nonce: string;
  operation: string;
  kind: "email" | "action";
  account: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** For actions: the exact input, as label/value rows. */
  rows?: { label: string; value: string }[];
  /** For browser go-aheads: a screenshot of the review page. */
  image?: string;
  expires_at: string;
};

export type ActionStatus = "pending" | "executing" | "accepted" | "verified" | "failed" | "unknown";
export type Outcome = { approvalId: string; status: ActionStatus | "rejected" | "expired" | "refused"; message: string; providerRef?: string };

/** approval: a new one (replaces: the earlier approval it supersedes, after an edit). expired: timed out unanswered. */
export type BrokerEvent =
  | { type: "approval"; approval: ApprovalView; replaces?: string }
  | { type: "outcome"; outcome: Outcome }
  | { type: "expired"; approvalId: string };
type Listener = (e: BrokerEvent) => void;
const listeners = new Set<Listener>();
export const onBrokerEvent = (fn: Listener) => (listeners.add(fn), () => listeners.delete(fn));
const emit: Listener = (e) => listeners.forEach((fn) => fn(e));

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const canonical = (o: unknown) => JSON.stringify(o, Object.keys(o as object).sort());

type DraftRow = { id: string; account: string; to_json: string; cc_json: string; bcc_json: string; subject: string; body: string };

function grantFromDraft(d: DraftRow): EmailGrant {
  return {
    operation: "email.send",
    version: 1,
    draft_id: d.id,
    account: d.account,
    to: JSON.parse(d.to_json),
    cc: JSON.parse(d.cc_json),
    bcc: JSON.parse(d.bcc_json),
    subject: d.subject,
    body_sha256: sha256(d.body),
    attachments_sha256: [],
  };
}

function loadDraft(id: string) {
  return db.prepare("SELECT id, account, to_json, cc_json, bcc_json, subject, body FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
}

/* ---------------- drafts + approval requests (called by the brain's tools) ---------------- */

export function saveDraft(d: { account: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; jobId?: string }) {
  const id = newId("draft");
  db.prepare("INSERT INTO drafts (id, account, to_json, cc_json, bcc_json, subject, body, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    d.account,
    JSON.stringify(d.to),
    JSON.stringify(d.cc ?? []),
    JSON.stringify(d.bcc ?? []),
    d.subject,
    d.body,
    d.jobId ?? null,
    nowIso(),
  );
  audit("brain", "draft.saved", id, { account: d.account, to: d.to, subject: d.subject });
  return id;
}

export function requestEmailApproval(draftId: string, jobId?: string, opts: { replaces?: string } = {}): ApprovalView {
  const draft = loadDraft(draftId);
  if (!draft) throw new Error(`no draft ${draftId}`);
  const grant = grantFromDraft(draft);
  const id = newId("appr");
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO approvals (id, nonce, operation, draft_id, account, grant_json, grant_hash, status, expires_at, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
  ).run(id, nonce, grant.operation, draftId, grant.account, canonical(grant), sha256(canonical(grant)), expires, jobId ?? null, nowIso());
  audit("broker", "approval.requested", id, { draft_id: draftId, account: grant.account, to: grant.to, subject: grant.subject, replaces: opts.replaces });
  const view = toView(id)!;
  emit({ type: "approval", approval: view, replaces: opts.replaces });
  return view;
}

/**
 * Change an email's subject or words before it goes. The approval is bound to the exact text, so the old one is closed
 * ("revised") and a new draft and approval take its place; recipients and account stay the same. Needs the nonce the
 * owner's screen holds, like decide().
 */
export function reviseEmailApproval(id: string, nonce: string, change: { subject?: string; body?: string }): ApprovalView {
  const a = db.prepare("SELECT id, nonce, operation, draft_id, status, expires_at, job_id FROM approvals WHERE id = ?").get(id) as
    | { id: string; nonce: string; operation: string; draft_id: string | null; status: string; expires_at: string; job_id: string | null }
    | undefined;
  if (!a || a.nonce !== nonce) throw new Error("That approval isn't valid.");
  if (a.operation !== "email.send" || !a.draft_id) throw new Error("Only emails can be edited.");
  if (a.status !== "pending" || a.expires_at <= nowIso()) throw new Error("That one has already been handled.");
  const d = loadDraft(a.draft_id);
  if (!d) throw new Error("The draft is gone.");
  return replaceEmail(a.id, a.job_id ?? undefined, d, { subject: change.subject ?? d.subject, body: change.body ?? d.body });
}

/** The brain's draft_email with replaces: the owner asked for a change by voice ("make it shorter"). */
export function replaceEmailApproval(id: string, next: { account: string; to: string[]; cc?: string[]; subject: string; body: string }, jobId?: string): ApprovalView {
  const a = db.prepare("SELECT id, operation, draft_id, status, expires_at FROM approvals WHERE id = ?").get(id) as
    | { id: string; operation: string; draft_id: string | null; status: string; expires_at: string }
    | undefined;
  if (!a || a.operation !== "email.send" || a.status !== "pending" || a.expires_at <= nowIso()) throw new Error("That draft isn't waiting any more; make a new one.");
  const draftId = saveDraft({ ...next, jobId });
  closeAsRevised(a.id);
  return requestEmailApproval(draftId, jobId, { replaces: a.id });
}

function replaceEmail(oldId: string, jobId: string | undefined, d: DraftRow, change: { subject: string; body: string }) {
  const draftId = saveDraft({ account: d.account, to: JSON.parse(d.to_json), cc: JSON.parse(d.cc_json), bcc: JSON.parse(d.bcc_json), subject: change.subject, body: change.body, jobId });
  closeAsRevised(oldId);
  return requestEmailApproval(draftId, jobId, { replaces: oldId });
}

function closeAsRevised(id: string) {
  db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
  audit("user", "approval.revised", id);
}

/** Close approvals whose time ran out, and say so (the apps take the buttons away). Returns their ids. */
export function expireDue(now = nowIso()): string[] {
  const due = db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at <= ? AND operation != 'browser.submit'").all(now) as { id: string }[];
  for (const { id } of due) {
    const r = db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
    if (Number(r.changes) !== 1) continue;
    audit("broker", "approval.expired", id);
    emit({ type: "expired", approvalId: id });
  }
  return due.map((d) => d.id);
}

/** A stopped job's approvals are closed, so nothing it asked for can go out after the owner stopped it. */
export function rejectForJob(jobId: string): string[] {
  const ids = (db.prepare("SELECT id FROM approvals WHERE job_id = ? AND status = 'pending'").all(jobId) as { id: string }[]).map((r) => r.id);
  for (const id of ids) {
    const r = db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
    if (Number(r.changes) !== 1) continue;
    audit("broker", "approval.cancelled", id, { job_id: jobId });
    emit({ type: "outcome", outcome: { approvalId: id, status: "rejected", message: "Not sent: you stopped the job that asked for it." } });
  }
  return ids;
}

/** Called by the brain's request_action tool: the user sees the exact call and taps Approve or Not now. */
export function requestConnectorApproval(r: { connector: string; tool: string; input: unknown; summary: string; jobId?: string }): ApprovalView {
  const grant: ConnectorGrant = { operation: "connector.call", version: 1, connector: r.connector, tool: r.tool, input: r.input, summary: r.summary };
  const id = newId("appr");
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO approvals (id, nonce, operation, draft_id, account, grant_json, grant_hash, status, expires_at, job_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?)",
  ).run(id, nonce, grant.operation, r.connector, stableJson(grant), sha256(stableJson(grant)), expires, r.jobId ?? null, nowIso());
  audit("broker", "approval.requested", id, { operation: grant.operation, tool: r.tool, summary: r.summary });
  const view = toView(id)!;
  emit({ type: "approval", approval: view });
  return view;
}

/** Called by the brain's propose_personality_change: the user sees the exact before/after and taps. */
export function requestSoulApproval(r: { oldText: string; newText: string; summary: string }): ApprovalView {
  const { next } = planSoulEdit(r.oldText, r.newText);
  const grant: SoulGrant = { operation: "soul.edit", version: 1, base_hash: soulHash(), next_hash: soulHash(next), old_text: r.oldText, new_text: r.newText, summary: r.summary };
  const id = newId("appr");
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO approvals (id, nonce, operation, draft_id, account, grant_json, grant_hash, status, expires_at, job_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, NULL, ?)",
  ).run(id, nonce, grant.operation, "Tavi's personality", stableJson(grant), sha256(stableJson(grant)), expires, nowIso());
  audit("broker", "approval.requested", id, { operation: grant.operation, summary: r.summary });
  const view = toView(id)!;
  emit({ type: "approval", approval: view });
  return view;
}

/** Apply an approved personality change, only if SOUL.md is still exactly what the user was shown. */
function executeSoulEdit(a: { id: string; grant_json: string; grant_hash: string }): Outcome {
  const approvalId = a.id;
  const refuse = (reason: string, message: string) => {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason });
    return { approvalId, status: "refused" as const, message };
  };
  if (sha256(a.grant_json) !== a.grant_hash) return refuse("grant changed after it was shown", "That changed after you saw it, so I didn't apply it.");
  const g = JSON.parse(a.grant_json) as SoulGrant;
  if (soulHash() !== g.base_hash) return refuse("SOUL.md changed since the proposal", "My personality file changed since I asked, so I didn't apply that. Ask me again.");
  const { next } = planSoulEdit(g.old_text, g.new_text);
  if (soulHash(next) !== g.next_hash) return refuse("result differs from what was shown", "That wouldn't come out as shown, so I didn't apply it.");
  const consumed = db.prepare("UPDATE approvals SET status = 'used', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), a.id);
  if (Number(consumed.changes) !== 1) return { approvalId, status: "refused", message: "That one has already been handled." };
  audit("user", "approval.approved", a.id);
  saveSoul(next, "you approved on the phone");
  return { approvalId, status: "verified", message: `Done: ${g.summary}.` };
}

/**
 * A browser job asks for the go-ahead on its final button. Resolves with the user's answer, or "expired".
 * The job's own guard only lets that button through after "approve".
 */
export function requestBrowserGoAhead(g: Omit<BrowserGrant, "operation" | "version">): { view: ApprovalView; answer: Promise<"approve" | "reject" | "expired"> } {
  const grant: BrowserGrant = { operation: "browser.submit", version: 1, ...g };
  const id = newId("appr");
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO approvals (id, nonce, operation, draft_id, account, grant_json, grant_hash, status, expires_at, job_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?)",
  ).run(id, nonce, grant.operation, "Tavi's browser", stableJson(grant), sha256(stableJson(grant)), expires, g.job_id, nowIso());
  audit("broker", "approval.requested", id, { operation: grant.operation, summary: g.summary, total: g.total, button: g.final_button });
  const answer = new Promise<"approve" | "reject" | "expired">((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), id);
      emit({ type: "expired", approvalId: id });
      resolve("expired");
    }, APPROVAL_TTL_MS);
    waiting.set(id, (a) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(a);
    });
  });
  const view = toView(id)!;
  emit({ type: "approval", approval: view });
  return { view, answer };
}

function decideBrowser(a: { id: string; grant_json: string; grant_hash: string }, decision: "approve" | "reject"): Outcome {
  const approvalId = a.id;
  const tell = waiting.get(a.id);
  if (sha256(a.grant_json) !== a.grant_hash || !tell) {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason: tell ? "grant changed" : "job no longer running" });
    return { approvalId, status: "refused", message: "That job isn't running any more, so nothing was done." };
  }
  const consumed = db
    .prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(decision === "approve" ? "used" : "rejected", nowIso(), a.id);
  if (Number(consumed.changes) !== 1) return { approvalId, status: "refused", message: "That one has already been handled." };
  audit("user", decision === "approve" ? "approval.approved" : "approval.rejected", a.id);
  tell(decision);
  return decision === "approve"
    ? { approvalId, status: "accepted", message: "Go-ahead given. I'll finish it and tell you when it's done." }
    : { approvalId, status: "rejected", message: "No worries, I've stopped before that step." };
}

/* ---------------- operations other parts register (Stage 16: The Brain) ---------------- */

/**
 * A kind of write another part of the app owns (Stage 16: starting a job in The Brain). It goes through the same
 * approvals as everything else: the owner sees exactly what's in the grant and taps; only then does run() happen, once.
 * view: what the approval shows. run: what the tap does (it returns the outcome). declined: what a "Not now" says.
 */
export type RegisteredOperation = {
  account: string;
  view: (grant: Record<string, unknown>) => { subject: string; rows: { label: string; value: string }[] };
  run: (grant: Record<string, unknown>, approvalId: string) => Promise<{ status: "accepted" | "verified" | "failed" | "unknown" | "refused"; message: string; ref?: string }>;
  declined: string;
};
const operations = new Map<string, RegisteredOperation>();
export function registerOperation(operation: string, op: RegisteredOperation) {
  if (["email.send", "connector.call", "browser.submit", "soul.edit"].includes(operation)) throw new Error(`${operation} is the broker's own`);
  operations.set(operation, op);
}

/** Ask the owner to approve a registered operation with this exact grant. */
export function requestOperationApproval(operation: string, grant: Record<string, unknown>, opts: { jobId?: string } = {}): ApprovalView {
  const op = operations.get(operation);
  if (!op) throw new Error(`no operation ${operation}`);
  const full = { ...grant, operation, version: 1 };
  const id = newId("appr");
  const nonce = randomBytes(16).toString("hex");
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  db.prepare(
    "INSERT INTO approvals (id, nonce, operation, draft_id, account, grant_json, grant_hash, status, expires_at, job_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?)",
  ).run(id, nonce, operation, op.account, stableJson(full), sha256(stableJson(full)), expires, opts.jobId ?? null, nowIso());
  audit("broker", "approval.requested", id, { operation, summary: op.view(full).subject });
  const view = toView(id)!;
  emit({ type: "approval", approval: view });
  return view;
}

/** Run an approved registered operation: exactly the stored grant, once. */
async function executeRegistered(a: { id: string; operation: string; grant_json: string; grant_hash: string }, op: RegisteredOperation): Promise<Outcome> {
  const approvalId = a.id;
  if (sha256(a.grant_json) !== a.grant_hash) {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason: "grant changed after it was shown" });
    return { approvalId, status: "refused", message: "That changed after you saw it, so I didn't do it." };
  }
  const consumed = db.prepare("UPDATE approvals SET status = 'used', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), a.id);
  if (Number(consumed.changes) !== 1) return { approvalId, status: "refused", message: "That one has already been handled." };
  audit("user", "approval.approved", a.id);
  const actionId = newId("act");
  db.prepare("INSERT INTO actions (id, approval_id, operation, status, created_at, updated_at) VALUES (?, ?, ?, 'executing', ?, ?)").run(actionId, a.id, a.operation, nowIso(), nowIso());
  audit("broker", "action.executing", actionId, { approval: a.id, operation: a.operation });
  try {
    const r = await op.run(JSON.parse(a.grant_json) as Record<string, unknown>, a.id);
    const status: ActionStatus = r.status === "refused" ? "failed" : r.status;
    setAction(actionId, status, { provider_ref: r.ref, ...(status === "failed" ? { error: r.message } : {}) });
    audit("broker", `action.${status}`, actionId, { operation: a.operation, ref: r.ref, message: r.message.slice(0, 300) });
    return { approvalId, status: r.status, message: r.message, ...(r.ref ? { providerRef: r.ref } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setAction(actionId, "unknown", { error: msg });
    audit("broker", "action.unknown", actionId, { operation: a.operation, error: msg });
    return { approvalId, status: "unknown", message: "I'm not sure that went through, so I won't try it again by myself." };
  }
}

/** Show an action's input to a person: one row per field, nested values flattened. */
function inputRows(input: unknown, prefix = ""): { label: string; value: string }[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ label: prefix || "Input", value: fmt(input) }];
  return Object.entries(input as Record<string, unknown>).flatMap(([k, v]) => {
    const label = prefix ? `${prefix} ${k}` : k;
    return v && typeof v === "object" && !Array.isArray(v) ? inputRows(v, label) : [{ label: label.replace(/_/g, " "), value: fmt(v) }];
  });
}
const fmt = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : typeof v === "string" ? v : JSON.stringify(v));

function toView(approvalId: string): ApprovalView | undefined {
  const a = db.prepare("SELECT id, nonce, operation, draft_id, account, grant_json, expires_at FROM approvals WHERE id = ?").get(approvalId) as
    | { id: string; nonce: string; operation: string; draft_id: string | null; account: string; grant_json: string; expires_at: string }
    | undefined;
  if (!a) return undefined;
  if (a.operation === "connector.call") {
    const g = JSON.parse(a.grant_json) as ConnectorGrant;
    const rows = inputRows(g.input);
    return { id: a.id, nonce: a.nonce, operation: a.operation, kind: "action", account: a.account, to: [], cc: [], subject: g.summary, body: "", rows, expires_at: a.expires_at };
  }
  if (a.operation === "browser.submit") {
    const g = JSON.parse(a.grant_json) as BrowserGrant;
    const rows = [...g.details, ...(g.total ? [{ label: "Total", value: g.total }] : []), { label: "Then presses", value: g.final_button }];
    return { id: a.id, nonce: a.nonce, operation: a.operation, kind: "action", account: a.account, to: [], cc: [], subject: g.summary, body: "", rows, image: g.image ?? undefined, expires_at: a.expires_at };
  }
  if (a.operation === "soul.edit") {
    const g = JSON.parse(a.grant_json) as SoulGrant;
    const rows = g.old_text.trim() ? [{ label: "Instead of", value: g.old_text }, { label: "It will say", value: g.new_text }] : [{ label: "Adds", value: g.new_text }];
    return { id: a.id, nonce: a.nonce, operation: a.operation, kind: "action", account: a.account, to: [], cc: [], subject: g.summary, body: "", rows, expires_at: a.expires_at };
  }
  const registered = operations.get(a.operation);
  if (registered) {
    const v = registered.view(JSON.parse(a.grant_json) as Record<string, unknown>);
    return { id: a.id, nonce: a.nonce, operation: a.operation, kind: "action", account: a.account, to: [], cc: [], subject: v.subject, body: "", rows: v.rows, expires_at: a.expires_at };
  }
  const d = a.draft_id ? loadDraft(a.draft_id) : undefined;
  if (!d) return undefined;
  return { id: a.id, nonce: a.nonce, operation: a.operation, kind: "email", account: a.account, to: JSON.parse(d.to_json), cc: JSON.parse(d.cc_json), subject: d.subject, body: d.body, expires_at: a.expires_at };
}

export function pendingApprovals(): ApprovalView[] {
  const rows = db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at").all(nowIso()) as { id: string }[];
  return rows.map((r) => toView(r.id)).filter((v): v is ApprovalView => !!v);
}

/* ---------------- the user's decision (only reachable from the app, never from the brain) ---------------- */

const executors: Record<string, (grant: EmailGrant, draft: DraftRow, actionId: string) => Promise<{ providerRef: string }>> = {
  // Real account (Gmail) if connected under that label; otherwise the local demo outbox.
  "email.send": async (grant, draft, actionId) => {
    const real = DEV ? undefined : findAccount(grant.account); // dev: always the local outbox, never a real send
    if (real) {
      if (real.status !== "connected") throw new DefiniteFailure(`${real.label} needs reconnecting in Setup on your PC.`);
      const { providerRef } = await sendMail(real.id, { to: grant.to, cc: grant.cc, bcc: grant.bcc, subject: grant.subject, body: draft.body });
      return { providerRef: `gmail:${real.id}:${providerRef}` };
    }
    const ref = newId("demo_msg");
    db.prepare("INSERT INTO demo_outbox (id, action_id, account, to_json, cc_json, bcc_json, subject, body, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      ref,
      actionId,
      grant.account,
      JSON.stringify(grant.to),
      JSON.stringify(grant.cc),
      JSON.stringify(grant.bcc),
      grant.subject,
      draft.body,
      nowIso(),
    );
    return { providerRef: ref };
  },
};
const verifiers: Record<string, (providerRef: string) => Promise<boolean>> = {
  "email.send": async (ref) => {
    if (ref.startsWith("gmail:")) {
      const [, accountId, messageId] = ref.split(":");
      return verifySent(accountId, messageId);
    }
    return !!db.prepare("SELECT 1 FROM demo_outbox WHERE id = ?").get(ref);
  },
};

function setAction(id: string, status: ActionStatus, fields: { provider_ref?: string; error?: string } = {}) {
  db.prepare("UPDATE actions SET status = ?, provider_ref = COALESCE(?, provider_ref), error = COALESCE(?, error), updated_at = ? WHERE id = ?").run(
    status,
    fields.provider_ref ?? null,
    fields.error ?? null,
    nowIso(),
    id,
  );
}

/**
 * The owner's answer to an approval. ONLY the owner's tap reaches this with "approve": the gateway calls it for a
 * decide message from the app, and nothing else may (not the brain, not the voice fast path, not a background job).
 * tests/unit/draft-items.test.ts checks that no other code calls it.
 */
export async function decide(approvalId: string, nonce: string, decision: "approve" | "reject"): Promise<Outcome> {
  const a = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
    | { id: string; nonce: string; operation: string; draft_id: string; grant_hash: string; grant_json: string; status: string; expires_at: string }
    | undefined;
  const done = (o: Outcome) => (emit({ type: "outcome", outcome: o }), o);

  if (!a || a.nonce !== nonce) {
    audit("broker", "approval.refused", approvalId, { reason: "unknown approval or wrong nonce" });
    return done({ approvalId, status: "refused", message: "That approval isn't valid." });
  }
  if (a.status !== "pending") return done({ approvalId, status: "refused", message: "That one has already been handled." });
  if (a.expires_at <= nowIso()) {
    db.prepare("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.expired", a.id);
    return done({ approvalId, status: "expired", message: "That approval expired. Ask me to prepare it again." });
  }
  // A waiting browser job must hear the answer either way.
  if (a.operation === "browser.submit") return done(decideBrowser(a, decision));
  const registered = operations.get(a.operation);
  if (decision === "reject") {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("user", "approval.rejected", a.id);
    const message = registered
      ? registered.declined
      : a.operation === "connector.call" ? "No worries, I haven't done it." : a.operation === "soul.edit" ? "No worries, I'll keep things as they are." : "No worries, I've left it as a draft.";
    return done({ approvalId, status: "rejected", message });
  }
  if (a.operation === "connector.call") return done(await executeConnectorCall(a));
  if (a.operation === "soul.edit") return done(executeSoulEdit(a));
  if (registered) return done(await executeRegistered(a, registered));
  if (a.operation !== "email.send") return done({ approvalId, status: "refused", message: "I don't know how to do that one any more, so I didn't." });

  // The draft must be byte-for-byte what was approved.
  const draft = loadDraft(a.draft_id);
  if (!draft || sha256(canonical(grantFromDraft(draft))) !== a.grant_hash) {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason: "draft changed after it was shown" });
    return done({ approvalId, status: "refused", message: "The draft changed after you saw it, so I didn't send it." });
  }

  // Single use: consume the grant before acting.
  const consumed = db.prepare("UPDATE approvals SET status = 'used', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), a.id);
  if (Number(consumed.changes) !== 1) return done({ approvalId, status: "refused", message: "That one has already been handled." });
  audit("user", "approval.approved", a.id);

  const grant = JSON.parse(a.grant_json) as EmailGrant;
  const actionId = newId("act");
  db.prepare("INSERT INTO actions (id, approval_id, operation, status, created_at, updated_at) VALUES (?, ?, ?, 'executing', ?, ?)").run(
    actionId,
    a.id,
    a.operation,
    nowIso(),
    nowIso(),
  );
  audit("broker", "action.executing", actionId, { approval: a.id, operation: a.operation });

  let providerRef: string;
  try {
    ({ providerRef } = await executors[a.operation](grant, draft, actionId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof DefiniteFailure) {
      // The provider refused before acting: definitely not sent, safe to fix and try again.
      setAction(actionId, "failed", { error: msg });
      audit("broker", "action.failed", actionId, { error: msg });
      return done({ approvalId, status: "failed", message: `It didn't send: ${msg}` });
    }
    // We can't tell whether the provider acted. Never retry blindly.
    setAction(actionId, "unknown", { error: msg });
    audit("broker", "action.unknown", actionId, { error: msg });
    return done({ approvalId, status: "unknown", message: "I'm not sure that went through, so I won't resend it. Check your sent items." });
  }
  setAction(actionId, "accepted", { provider_ref: providerRef });
  audit("broker", "action.accepted", actionId, { provider_ref: providerRef });

  const verified = await verifiers[a.operation](providerRef).catch(() => false);
  setAction(actionId, verified ? "verified" : "accepted");
  audit("broker", verified ? "action.verified" : "action.unverified", actionId, { provider_ref: providerRef });
  const who = grant.to.join(", ");
  const demo = providerRef.startsWith("demo_") ? " (demo outbox, not a real email)" : "";
  return done({
    approvalId,
    status: verified ? "verified" : "accepted",
    providerRef,
    message: verified ? `Sent to ${who} from ${grant.account}${demo}.` : `Handed to ${grant.account} for ${who}, but I couldn't confirm it yet.`,
  });
}

/** Run one approved connector call: exactly the stored tool and input, once. */
async function executeConnectorCall(a: { id: string; operation: string; grant_json: string; grant_hash: string }): Promise<Outcome> {
  const approvalId = a.id;
  if (sha256(a.grant_json) !== a.grant_hash) {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason: "grant changed after it was shown" });
    return { approvalId, status: "refused", message: "That changed after you saw it, so I didn't do it." };
  }
  const g = JSON.parse(a.grant_json) as ConnectorGrant;
  // Permissions can change between asking and tapping: write access must still be on now.
  const server = serverOf(g.tool);
  if (!server || !permissionsFor(server).write) {
    db.prepare("UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?").run(nowIso(), a.id);
    audit("broker", "approval.refused", a.id, { reason: "write access to the connector is off" });
    return { approvalId, status: "refused", message: `Write access to ${g.connector} is off in Setup, so I didn't do it.` };
  }
  const consumed = db.prepare("UPDATE approvals SET status = 'used', decided_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), a.id);
  if (Number(consumed.changes) !== 1) return { approvalId, status: "refused", message: "That one has already been handled." };
  audit("user", "approval.approved", a.id);

  const actionId = newId("act");
  db.prepare("INSERT INTO actions (id, approval_id, operation, status, created_at, updated_at) VALUES (?, ?, ?, 'executing', ?, ?)").run(
    actionId,
    a.id,
    a.operation,
    nowIso(),
    nowIso(),
  );
  audit("broker", "action.executing", actionId, { approval: a.id, tool: g.tool });
  try {
    const { result } = DEV ? { result: "dev: not sent" } : await runConnectorCall(g.tool, g.input); // dev: never touches the real account
    // The connector's own answer is the evidence; there's no separate read-back for an arbitrary tool.
    setAction(actionId, "accepted", { provider_ref: result.slice(0, 500) });
    audit("broker", "action.accepted", actionId, { tool: g.tool, result: result.slice(0, 300) });
    return { approvalId, status: "accepted", providerRef: result.slice(0, 200), message: `Done: ${g.summary}.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof ConnectorRefused) {
      setAction(actionId, "failed", { error: msg });
      audit("broker", "action.failed", actionId, { tool: g.tool, error: msg });
      return { approvalId, status: "failed", message: `That didn't go through: ${msg}` };
    }
    setAction(actionId, "unknown", { error: msg });
    audit("broker", "action.unknown", actionId, { tool: g.tool, error: msg });
    return { approvalId, status: "unknown", message: `I'm not sure that went through (${g.connector}), so I won't try again. Worth checking.` };
  }
}

/** On boot: an action still "executing" may or may not have happened. Mark it unknown; never retry. */
export function recoverActions(): string[] {
  const rows = db.prepare("SELECT id FROM actions WHERE status IN ('executing','pending')").all() as { id: string }[];
  for (const r of rows) {
    setAction(r.id, "unknown", { error: "process restarted mid-action" });
    audit("system", "action.unknown", r.id, { reason: "process restarted mid-action" });
  }
  return rows.map((r) => r.id);
}
