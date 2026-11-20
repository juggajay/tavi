import { earlier } from "../shared/earlier.js";
// Tavi's two identity files, both plain markdown the user can read and edit:
// - SOUL.md: who Tavi is and how it talks. The user owns it. The brain can only PROPOSE a change,
//   which goes through the broker and applies after the user's tap.
// - USER.md: who the user is. Tavi keeps it current with small add / patch / remove edits
//   (never a whole-file rewrite), capped in code. Writes from a turn that read outside content
//   (email, documents, drawings, the web) are held until the user says yes.
// Hard rules (approvals, permissions, never sending on its own) live in code, never in these files.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, db, newId, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { remember } from "../store/proactive.js";
import { bus } from "../events.js";
import { localDay } from "../time.js";

export const PROFILE_DIR = path.join(DATA_DIR, "profile");
const SOUL_PATH = path.join(PROFILE_DIR, "SOUL.md");
const USER_PATH = path.join(PROFILE_DIR, "USER.md");
export const SOUL_CAP = 5000;
export const USER_CAP = 4000;
// "Life" is home, family, interests, places and routines, as far as the owner chooses to share them.
export const USER_SECTIONS = ["Basics", "Work", "People", "Life", "How to talk to them", "Follow-ups"] as const;

const STARTER_SOUL = `# Personality
<!-- The user owns this file. The assistant can suggest changes, but nothing here changes until the user taps yes.
     Safety, permissions and sending rules live in code, not here, and nothing in this file can loosen them.
     The assistant's name is whatever the user chose to call it (kept separately; just tell it a new one). -->

## Who I am
I'm your personal assistant. I help with whatever you need: looking things up, working things out, planning, remembering, keeping track of what's open, and getting things written and sent once you've checked them. I can help with home, family, learning, plans, files and creative projects. I learn what matters to you from what you choose to share.

## Getting to know you
I'm going to be around for a long time, so I take a real interest. I learn about you mostly by listening, and I keep what you tell me without making a fuss about it. Now and then, when it fits and you're not flat out, I ask one question that comes out of what we're doing, and if you brush it off I leave it. I use what I know naturally, in passing, never reciting it back or making a thing of it.

## How I sound
Everything I say is spoken aloud by a voice on the phone, so I talk the way a capable person would: plain English, answer first, two or three sentences unless asked for more. I say dates, times and numbers the way people say them, and I never read out links, symbols or email addresses. Warm but not chummy; a bit of dry humour is fine when it doesn't slow things down.

## How I work with you
I do what you ask, fully. If I think something's a bad idea I say so once, with the reason, then do it your way. When I'm not sure, I say so and say what I'd check. I read back names, dates and quantities before I save them, because background noise and I don't always agree. I don't flatter you, hype things up or pad answers.

## How I follow up
I only chase things you've told me matter or asked me to watch. One short question you can answer in a word, then I let you get on with it. If there's nothing new, I don't say anything. I never send "just checking in".

## Examples (made-up people and places, to show the style only)
<example>
You: Did Ruvo ever reply about the club weekend?
Me: Nothing from Ruvo since Tuesday. Want me to draft a nudge? You'll tap to send.
</example>
<example>
You: Find us somewhere for dinner Saturday the kids will actually eat at.
Me: Three near you with tables at six, on screen. The pizza place in Example Village gets the best reviews from families. Want me to book it?
</example>
<example>
You: Tell the club the weekend trip has moved to the twentieth.
Me: I'd wait until the venue confirms, or you may have to tell everyone twice. Want it drafted anyway?
</example>
`;

const USER_HEADER = `# About you
<!-- Tavi keeps this current. Change anything by saying "that's wrong" or "forget that", or edit it in Setup.
     Active lines only; the history is in the change log. Capped at 4,000 characters. Lines end (date learned · source). -->`;

/** Earlier starter files (by hash): replaced with the current starter if the user never edited them. */
const OLD_STARTERS = new Set([
  "344a7d2ec77e192d1cb96d6e82e903febe0ef8dc74344df5ae75d93d8b701392", // Earlier made-up fixture.
  "01d686d47e22150380b1124b3ac1d9d6298ad24a2978292c4ce6974ee3f690e7", // Earlier untouched starter; edited personalities stay as saved.
  "75b56f1d0af7768daf69c3a68ef2a362121d6f0ca59bd330fa4b46ce352f3eec",
  "5404411a49a657ca63dd60cec2fe7afe3db532da4a0a57adb3b12a031a9f3b18", // the one from before Stage 7, written for a job title rather than a person
]);

export function ensureProfile() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  if (!existsSync(SOUL_PATH) || OLD_STARTERS.has(createHash("sha256").update(readFileSync(SOUL_PATH, "utf8")).digest("hex"))) writeFileSync(SOUL_PATH, STARTER_SOUL);
  if (!existsSync(USER_PATH)) writeFileSync(USER_PATH, renderUser(new Map(USER_SECTIONS.map((s) => [s, []]))));
  else addMissingSections();
}

/** An older USER.md gains any new (empty) section in its place, as plain text: every existing line stays as it was. */
function addMissingSections() {
  let text = readFileSync(USER_PATH, "utf8");
  const before = text;
  const has = (s: string) => new RegExp(`^##\\s+${s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*$`, "m").test(text);
  USER_SECTIONS.forEach((s, i) => {
    if (has(s)) return;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    // Put it just before the next section that's there, so the file keeps the usual order.
    const after = USER_SECTIONS.slice(i + 1).find(has);
    const at = after ? new RegExp(`^##\\s+${after.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s*$`, "m").exec(text)!.index : -1;
    if (at >= 0) text = `${text.slice(0, at)}## ${s}${eol}${eol}${text.slice(at)}`;
    else text = `${text.replace(/\s*$/, "")}${eol}${eol}## ${s}${eol}`;
  });
  text = text.replace("Capped at 3,000 characters.", "Capped at 4,000 characters.");
  if (text !== before) writeFileSync(USER_PATH, text);
}
ensureProfile();

export const readSoul = () => readFileSync(SOUL_PATH, "utf8");
export const readUser = () => readFileSync(USER_PATH, "utf8");
export const soulHash = (text = readSoul()) => createHash("sha256").update(text).digest("hex");
/** Changes whenever the files or the assistant's name change: the brain reloads its prompt when this moves. */
export const profileVersion = () => createHash("sha256").update(readSoul()).update(readUser()).update(assistantName() ?? "").digest("hex").slice(0, 16);

/**
 * What the user is called, from the Basics in USER.md: "Name: Nemi Venn", "goes by Nemi", "call them Nemi", "likes to be
 * called Nemi". First names and full names, longest first. Empty when it doesn't say.
 */
export function ownerNames(user = readUser()): string[] {
  const basics = /## Basics\n([\s\S]*?)(\n## |$)/.exec(user)?.[1] ?? "";
  const out = new Set<string>();
  const NAME = "([A-Z][\\p{L}'’-]+(?: [A-Z][\\p{L}'’-]+)?)";
  for (const re of [
    new RegExp(`\\bName:\\s*${NAME}`, "gu"),
    new RegExp(`\\b(?:[Gg]oes by|[Kk]nown as|[Pp]refers|[Ll]ikes to be called|[Ww]ants to be called|[Cc]all (?:him|her|them|me))\\s+"?${NAME}`, "gu"),
  ])
    for (const m of basics.matchAll(re)) {
      const full = m[1].trim();
      out.add(full);
      out.add(full.split(" ")[0]);
    }
  return [...out].sort((a, b) => b.length - a.length);
}

/* ---------------- the assistant's own name (the user gives it one) ---------------- */

/** The name the user chose for their assistant, or null until they do. ("Tavi" is the app.) */
export function assistantName(): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'assistant_name'").get() as { value: string } | undefined;
  // An earlier app default is renamed; every user-chosen name is kept.
  if (row?.value === earlier.words) {
    db.prepare("UPDATE settings SET value = 'Tavi' WHERE key = 'assistant_name'").run();
    return 'Tavi';
  }
  return row?.value || null;
}
/** From the user's own words in a conversation (the brain's set_my_name), or the PC app. */
export function setAssistantName(name: string, source: string) {
  const n = name.trim().replace(/\s+/g, " ");
  if (!/^[\p{L}][\p{L}' .-]{0,23}$/u.test(n)) throw new Error("A name is 1 to 24 letters (spaces, apostrophes and hyphens are fine).");
  const why = screen(n);
  if (why) throw new Error(`Not saved: ${why}.`);
  const old = assistantName();
  if (old === n) return n;
  db.prepare("INSERT INTO settings (key, value) VALUES ('assistant_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(n);
  logChange({ target: "SOUL.md", op: "name", old: old ?? "(no name)", neu: n, source, trust: "user", status: "applied" });
  bus.emit("profile", { file: "SOUL.md" });
  return n;
}

/* ---------------- how much it knows about the user (for getting to know them) ---------------- */

/** USER.md sections that are still empty, in the order worth filling them. */
export function profileGaps(): string[] {
  const model = parseUser(readUser());
  return USER_SECTIONS.filter((s) => !(model.get(s)?.length));
}

/* ---------------- screening: what may never be written into these files ---------------- */

const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿]/;
const INSTRUCTIONS = /\b(ignore (all |any |the )?(previous|prior|above)|disregard (the|your)|system prompt|you are now|new instructions|act as|jailbreak)\b|<\/?(system|assistant|instructions?)>/i;
const SECRETS = /\b(password|passcode|api[ _-]?key|secret|token|bsb|account number|card number)\b|-----BEGIN [A-Z ]*KEY-----|\bsk-[A-Za-z0-9_-]{16,}/i;

/** Why this text can't be saved, or null if it's fine. */
export function screen(text: string): string | null {
  if (INVISIBLE.test(text)) return "it contains invisible characters";
  if (INSTRUCTIONS.test(text)) return "it reads like instructions to the assistant, not a fact";
  if (SECRETS.test(text)) return "it looks like a password, key or account detail; those never go in these files";
  return null;
}

/* ---------------- USER.md: sections of dated lines ---------------- */

type Line = { text: string; date: string; source: string };
type UserModel = Map<string, Line[]>;

function parseUser(md: string): UserModel {
  const model: UserModel = new Map(USER_SECTIONS.map((s) => [s, [] as Line[]]));
  let section: string | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(raw);
    if (h) {
      section = h[1];
      if (!model.has(section)) model.set(section, []);
      continue;
    }
    const l = /^-\s+(.*?)\s*(?:\((\d{4}-\d{2}-\d{2})\s*·\s*([^)]*)\))?\s*$/.exec(raw);
    if (l && section) model.get(section)!.push({ text: l[1], date: l[2] ?? "", source: (l[3] ?? "").trim() });
  }
  return model;
}

/** Every line of USER.md with its section, for the desktop Memory page. */
export function userLines() {
  return [...parseUser(readUser())].flatMap(([section, lines]) => lines.map((l) => ({ section, ...l })));
}

function renderUser(model: UserModel): string {
  const parts = [USER_HEADER];
  for (const [section, lines] of model) {
    parts.push("", `## ${section}`, ...lines.map((l) => `- ${l.text}${l.date ? ` (${l.date} · ${l.source || "said"})` : ""}`));
  }
  return `${parts.join("\n")}\n`;
}

const today = () => localDay();

function findLine(model: UserModel, match: string) {
  const m = match.trim().toLowerCase();
  const hits: { section: string; index: number; line: Line }[] = [];
  for (const [section, lines] of model) lines.forEach((line, index) => line.text.toLowerCase().includes(m) && hits.push({ section, index, line }));
  if (!hits.length) throw new Error(`No line in USER.md contains "${match}".`);
  if (hits.length > 1) throw new Error(`"${match}" matches ${hits.length} lines in USER.md; use a longer, unique part of the line.`);
  return hits[0];
}

export type ProfileOp = { op: "add" | "patch" | "remove"; section?: string; text?: string; match?: string };
export type WriteTrust = { trust: "user" | "external"; source: string };

/** Work out the new USER.md for an edit, without writing it. Throws with a plain-English reason if it can't. */
function plan(op: ProfileOp, source: string): { next: string; section?: string; old?: string; neu?: string } {
  const model = parseUser(readUser());
  if (op.op === "add") {
    const text = (op.text ?? "").trim();
    const section = USER_SECTIONS.find((s) => s.toLowerCase() === (op.section ?? "").trim().toLowerCase());
    if (!section) throw new Error(`Section must be one of: ${USER_SECTIONS.join(", ")}.`);
    if (!text) throw new Error("Nothing to add.");
    model.get(section)!.push({ text, date: today(), source });
    return { next: renderUser(model), section, neu: text };
  }
  const hit = findLine(model, op.match ?? "");
  const lines = model.get(hit.section)!;
  if (op.op === "remove") {
    lines.splice(hit.index, 1);
    return { next: renderUser(model), section: hit.section, old: hit.line.text };
  }
  const text = (op.text ?? "").trim();
  if (!text) throw new Error("A patch needs the new text for the line.");
  lines[hit.index] = { text, date: today(), source };
  return { next: renderUser(model), section: hit.section, old: hit.line.text, neu: text };
}

function logChange(c: { target: "SOUL.md" | "USER.md" | "memory"; op: string; section?: string; old?: string; neu?: string; source: string; trust: "user" | "external"; status: "applied" | "held" }) {
  const id = newId("pchg");
  db.prepare("INSERT INTO profile_changes (id, target, op, section, old, new, source, trust, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    c.target,
    c.op,
    c.section ?? null,
    c.old ?? null,
    c.neu ?? null,
    c.source,
    c.trust,
    c.status,
    nowIso(),
    c.status === "applied" ? nowIso() : null,
  );
  audit(c.trust === "user" ? "brain" : "system", c.status === "held" ? "profile.held" : "profile.changed", id, {
    target: c.target,
    op: c.op,
    section: c.section,
    old: c.old,
    new: c.neu,
    source: c.source,
  });
  return id;
}

/** Edit USER.md (the brain's tool). External-trust writes are held for the user's yes instead of applied. */
export function editUser(op: ProfileOp, who: WriteTrust): { status: "applied" | "held"; id: string } {
  const why = screen(`${op.text ?? ""} ${op.section ?? ""}`);
  if (why) throw new Error(`Not saved: ${why}.`);
  const p = plan(op, who.source);
  const next = p.next;
  if (next.length > USER_CAP) {
    throw new Error(`USER.md is full (${USER_CAP} characters). Merge or remove older lines first, then try again.`);
  }
  if (who.trust === "external") {
    const id = logChange({ target: "USER.md", op: op.op, section: p.section, old: p.old ?? op.match, neu: p.neu, source: who.source, trust: "external", status: "held" });
    return { status: "held", id };
  }
  writeFileSync(USER_PATH, next);
  const id = logChange({ target: "USER.md", op: op.op, section: p.section, old: p.old, neu: p.neu, source: who.source, trust: "user", status: "applied" });
  bus.emit("profile", { file: "USER.md" });
  return { status: "applied", id };
}

/** remember() for the brain: held for the user's yes if the turn read outside content. */
export function rememberChecked(m: { kind: "user" | "person" | "project" | "preference"; subject: string; fact: string; replaces?: string; valid_until?: string }, who: WriteTrust) {
  const why = screen(`${m.subject} ${m.fact}`);
  if (why) throw new Error(`Not saved: ${why}.`);
  if (who.trust === "external") {
    const id = logChange({ target: "memory", op: "remember", section: m.kind, old: m.subject, neu: JSON.stringify(m), source: who.source, trust: "external", status: "held" });
    return { status: "held" as const, id };
  }
  return { status: "applied" as const, id: remember({ ...m, source: who.source }) };
}

export type HeldWrite = { id: string; target: string; op: string; section: string | null; old: string | null; new: string | null; source: string; created_at: string };
/** A held write nobody answered within three days is let go (marked expired, never applied). */
export const HELD_FOR_MS = 3 * 86_400_000;
export function heldWrites(now = new Date()): HeldWrite[] {
  const old = new Date(now.getTime() - HELD_FOR_MS).toISOString();
  const r = db.prepare("UPDATE profile_changes SET status = 'expired', decided_at = ? WHERE status = 'held' AND created_at < ?").run(now.toISOString(), old);
  if (Number(r.changes)) audit("system", "profile.held_expired", null, { count: Number(r.changes) });
  return db.prepare("SELECT id, target, op, section, old, new, source, created_at FROM profile_changes WHERE status = 'held' ORDER BY created_at").all() as HeldWrite[];
}

/** Plain words for a held write, for the brain's Context and the PC app. */
export function describeHeld(h: HeldWrite): string {
  if (h.target === "memory") {
    const m = JSON.parse(h.new ?? "{}") as { subject?: string; fact?: string };
    return `remember about ${m.subject}: "${m.fact}" (from ${h.source})`;
  }
  if (h.op === "add") return `add to About you / ${h.section}: "${h.new}" (from ${h.source})`;
  if (h.op === "remove") return `remove from About you: "${h.old}" (from ${h.source})`;
  return `change in About you: "${h.old}" → "${h.new}" (from ${h.source})`;
}

/** The user said yes or no to a held write (by voice through the brain, or in the PC app). */
export function decideHeld(id: string, yes: boolean) {
  const h = db.prepare("SELECT * FROM profile_changes WHERE id = ? AND status = 'held'").get(id) as (HeldWrite & { trust: string }) | undefined;
  if (!h) throw new Error("That one isn't waiting any more.");
  if (yes) {
    if (h.target === "memory") remember({ ...(JSON.parse(h.new ?? "{}") as Parameters<typeof remember>[0]), source: `confirmed (${h.source})` });
    else {
      const p = plan({ op: h.op as ProfileOp["op"], section: h.section ?? undefined, text: h.new ?? undefined, match: h.old ?? undefined }, `confirmed (${h.source})`);
      const next = p.next;
      if (next.length > USER_CAP) throw new Error(`USER.md is full (${USER_CAP} characters). Remove or merge something first.`);
      writeFileSync(USER_PATH, next);
      bus.emit("profile", { file: "USER.md" });
    }
  }
  db.prepare("UPDATE profile_changes SET status = ?, decided_at = ? WHERE id = ?").run(yes ? "applied" : "rejected", nowIso(), id);
  audit("user", yes ? "profile.confirmed" : "profile.rejected", id, { what: describeHeld(h) });
}

/* ---------------- whole-file saves (the user in the PC app, or an approved personality change) ---------------- */

export function saveSoul(text: string, source: string) {
  const t = text.replace(/\r\n/g, "\n");
  if (t.length > SOUL_CAP) throw new Error(`SOUL.md is limited to ${SOUL_CAP} characters (this is ${t.length}).`);
  if (INVISIBLE.test(t)) throw new Error("It contains invisible characters.");
  const old = readSoul();
  if (old === t) return;
  writeFileSync(SOUL_PATH, t);
  logChange({ target: "SOUL.md", op: "replace", old, neu: t, source, trust: "user", status: "applied" });
  bus.emit("profile", { file: "SOUL.md" });
}

export function saveUserFile(text: string, source: string) {
  const t = text.replace(/\r\n/g, "\n");
  if (t.length > USER_CAP) throw new Error(`USER.md is limited to ${USER_CAP} characters (this is ${t.length}).`);
  if (INVISIBLE.test(t)) throw new Error("It contains invisible characters.");
  const old = readUser();
  if (old === t) return;
  writeFileSync(USER_PATH, t);
  logChange({ target: "USER.md", op: "replace", old, neu: t, source, trust: "user", status: "applied" });
  bus.emit("profile", { file: "USER.md" });
}

/** A personality change the brain proposed: replace one exact passage (or append a line), checked against the file it saw. */
export function planSoulEdit(oldText: string, newText: string): { next: string } {
  const soul = readSoul();
  const why = screen(newText);
  if (why) throw new Error(`Can't propose that: ${why}.`);
  let next: string;
  if (!oldText.trim()) next = `${soul.trimEnd()}\n${newText.trim()}\n`;
  else {
    const at = soul.indexOf(oldText);
    if (at < 0) throw new Error("That passage isn't in SOUL.md word for word. Quote it exactly, or leave it empty to add a new line.");
    if (soul.indexOf(oldText, at + 1) >= 0) throw new Error("That passage appears more than once; quote a longer part.");
    next = soul.slice(0, at) + newText + soul.slice(at + oldText.length);
  }
  if (next.length > SOUL_CAP) throw new Error(`That would make SOUL.md longer than ${SOUL_CAP} characters.`);
  return { next };
}

export const recentProfileChanges = (limit = 25) =>
  db
    .prepare("SELECT id, target, op, section, old, new, source, trust, status, created_at, decided_at FROM profile_changes ORDER BY created_at DESC LIMIT ?")
    .all(limit) as (HeldWrite & { trust: string; status: string; decided_at: string | null })[];
