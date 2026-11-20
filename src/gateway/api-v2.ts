// PC-only routes for the desktop app (/api/v2/*): the conversation thread, Activity, and Memory. The gateway calls
// handleV2() after its own PC-only check; everything that changes something also needs the same-origin check.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { itemsForJob } from "../store/items.js";
import { activeMemories, forget, getCommitment, getRoutine, listCommitments, listRoutines, remember, setRoutineStatus, updateCommitment, updateRoutine, type Routine } from "../store/proactive.js";
import { decideHeld, describeHeld, editUser, heldWrites, readSoul, saveSoul, userLines } from "../profile/profile.js";
import { answerOffer, pendingOffers } from "../memory/keeper.js";
import { pendingApprovals } from "../broker/broker.js";
import { canStop, cancelJob } from "../brain/tasks.js";
import { formatLocal, parseLocal, partsIn } from "../time.js";
import { describeControls } from "../proactive/followups.js";
import type { Schedule } from "../proactive/schedule.js";
import { bus } from "../events.js";
import type { Item } from "../shared/protocol.js";
import { addFolder, ensureManagedFolder, folderFiles, folderProblem, folderSummaries, getDoc, getFolder, kindOf, MODELS_DIR, readOneFile, registerMadeFile, removeFolder, scanFolder, setFolder } from "../files/library.js";
import { getItem } from "../store/items.js";
import { deliverPicture, deliverSaved, saveWaiting } from "./modelLink.js";
import { DRAWINGS_DIR, processQueue, scanForNew } from "../drawings/library.js";
import { scanShelf, shelfSummary } from "../reference/library.js";
import { listShortcuts, pairShortcut, unpairShortcut } from "./shortcut.js";
import { pictureKind } from "./picture-kind.js";
import { fileFor, isGroup, itemForEntry, listEverything, previewOf, setLabel, type GroupId, type Sort } from "../files/everything.js";
import { browserState, liveHost } from "../browser/host.js";
import { clearEverything, openSignIn, signedInSites, signOutSite } from "../browser/profile.js";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** name.pdf, or name (2).pdf if that's taken: an attachment never replaces a file. */
function uniqueName(dir: string, name: string) {
  const ext = path.extname(name),
    base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const p = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    if (!existsSync(p)) return p;
  }
}

type H = {
  send: (res: ServerResponse, status: number, body: unknown) => void;
  readBody: (req: IncomingMessage) => Promise<string>;
  sameOrigin: (req: IncomingMessage) => boolean;
};
const json = async <T>(req: IncomingMessage, h: H): Promise<T> => JSON.parse((await h.readBody(req)) || "{}") as T;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);

/* ---------------- photos and sketches from the phone (Stage 8.4, 8.5) ---------------- */

export { pictureKind };

export const NOT_A_PICTURE = "That isn't a photo. I can take JPEG, PNG, HEIC or WebP pictures.";

/**
 * POST /api/v2/upload?as=photo|sketch (the phone may use this one; the gateway has already checked the origin). Only a
 * picture is kept: saved into photos/<day>/ or sketches/<day>/ in the folder the app manages, named by the time
 * (photo-1432-07.jpg), read straight away, and answered with its file id. A sketch may name the photo it was drawn
 * over (over=doc_…); that photo is never changed. 50 MB at most.
 */
export async function handlePictureUpload(req: IncomingMessage, res: ServerResponse, url: URL, h: Pick<H, "send">, as: "photo" | "sketch") {
  const overId = url.searchParams.get("over");
  let over: string | undefined;
  if (as === "sketch" && overId) {
    const d = /^doc_[a-f0-9]{16}$/.test(overId) ? getDoc(overId) : undefined;
    if (!d || d.type !== "image") return h.send(res, 400, { error: "That sketch names a photo I don't have." });
    over = d.id;
  }
  const at = new Date();
  const p = partsIn(at);
  const dir = path.join(DRAWINGS_DIR, as === "photo" ? "photos" : "sketches", p.ymd);
  mkdirSync(dir, { recursive: true });
  const stem = `${as}-${String(p.h).padStart(2, "0")}${String(p.mi).padStart(2, "0")}-${String(at.getUTCSeconds()).padStart(2, "0")}`;
  const tmp = path.join(dir, `.${stem}.${process.pid}.${Date.now()}.part`);
  let size = 0;
  const head: Buffer[] = [];
  const out = createWriteStream(tmp);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 50 * 1024 * 1024) throw new Error("That's over 50 MB.");
      if (Buffer.concat(head).length < 16) head.push(chunk as Buffer);
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    }
    await new Promise<void>((r, j) => out.end((e?: Error) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    return h.send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  const ext = pictureKind(Buffer.concat(head));
  if (!ext) {
    await rm(tmp, { force: true });
    return h.send(res, 400, { error: NOT_A_PICTURE });
  }
  const target = uniqueName(dir, `${stem}.${ext}`);
  await rename(tmp, target);
  const doc = await readOneFile(target, { by: "owner", kind: as, ...(over ? { over } : {}) });
  audit("user", as === "photo" ? "photo.sent" : "sketch.sent", doc.id, { name: doc.name, size, over });
  bus.emit("picture", { kind: as, file: doc.id, over });
  return h.send(res, 200, { file: doc.id, name: doc.name });
}

/* ---------------- 3D models (Stage 9.3): pictures for the assistant, and files the app made ---------------- */

/** The whole request body, up to max bytes (a 400 with a reason past that). */
async function readAll(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error(`That's over ${Math.round(max / 1024 / 1024)} MB.`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
/** glTF binary: "glTF", version 2, and the length it declares is the length it is. */
const isGlb = (b: Buffer) => b.length >= 20 && b.subarray(0, 4).toString("latin1") === "glTF" && b.readUInt32LE(4) === 2 && b.readUInt32LE(8) === b.length;
/** STL: binary (an 80-byte header, a count, 50 bytes a triangle, exactly) or text ("solid" ... "facet" ... "endsolid"). */
function isStl(b: Buffer) {
  if (b.length >= 84 && 84 + 50 * b.readUInt32LE(80) === b.length) return true;
  const head = b.subarray(0, 512).toString("latin1").trimStart();
  return head.startsWith("solid") && /facet\s+normal/.test(head) && /endsolid/.test(b.subarray(Math.max(0, b.length - 512)).toString("latin1"));
}
export const NOT_A_MODEL_FILE = "That isn't a model file. I keep PNG pictures, GLB and STL files of a model here.";

/**
 * A title as a file name: plain letters only (the file reader can't open a name with "×" or "°" in it), "x" for "×",
 * at most 60 characters.
 */
export const fileNameOf = (title: string) =>
  title
    .replace(/×/g, "x")
    .replace(/°/g, " deg")
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, "") || "Model";

/**
 * POST /api/v2/upload?as=model&item=itm_…&format=png|glb|stl[&req=…] (phone or PC; the origin is checked first). The app
 * made a picture or a 3D file of a model on its screen: kept under models/<day>/ in the folder the app manages, named
 * from the model's title, and answered with its file id. Anything that isn't that kind of file is a 400.
 */
export async function handleModelUpload(req: IncomingMessage, res: ServerResponse, url: URL, h: Pick<H, "send">) {
  const item = getItem(url.searchParams.get("item") ?? "");
  if (!item || item.kind !== "model") return h.send(res, 400, { error: "That isn't a model I showed." });
  const format = url.searchParams.get("format");
  if (format !== "png" && format !== "glb" && format !== "stl") return h.send(res, 400, { error: NOT_A_MODEL_FILE });
  let body: Buffer;
  try {
    body = await readAll(req, 50 * 1024 * 1024);
  } catch (e) {
    return h.send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  if (!(format === "png" ? isPng(body) : format === "glb" ? isGlb(body) : isStl(body))) return h.send(res, 400, { error: NOT_A_MODEL_FILE });
  const p = partsIn(new Date());
  const dir = path.join(MODELS_DIR, p.ymd);
  mkdirSync(dir, { recursive: true });
  const target = uniqueName(dir, `${fileNameOf(item.title)}.${format}`);
  const tmp = `${target}.${process.pid}.part`;
  await writeFile(tmp, body);
  await rename(tmp, target);
  const doc = format === "png" ? await readOneFile(target, { by: "assistant", kind: "model-picture", item: item.id }) : await registerMadeFile(target, { item: item.id, title: item.title });
  audit("user", "model.saved", doc.id, { name: doc.name, size: body.length, item: item.id });
  const out = { file: doc.id, name: doc.name, path: target };
  const r = url.searchParams.get("req");
  if (r && saveWaiting(r, item.id)) deliverSaved(r, out);
  return h.send(res, 200, out);
}

/** POST /api/v2/model/<item>/pictures?req=…&n=…&view=… (phone or PC): one picture the assistant asked to see. */
export async function handleModelPicture(req: IncomingMessage, res: ServerResponse, url: URL, itemId: string, h: Pick<H, "send">) {
  const item = getItem(itemId);
  if (!item || item.kind !== "model") return h.send(res, 404, { error: "not found" });
  let body: Buffer;
  try {
    body = await readAll(req, 12 * 1024 * 1024);
  } catch (e) {
    return h.send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
  if (!isPng(body)) return h.send(res, 400, { error: "That isn't a picture." });
  const ok = deliverPicture(url.searchParams.get("req") ?? "", itemId, Number(url.searchParams.get("n")), url.searchParams.get("view") ?? "", body);
  return h.send(res, ok ? 200 : 410, ok ? { ok: true } : { error: "Nobody's waiting for that picture any more." });
}

/* ---------------- conversation ---------------- */

type LineRow = { id: number; ts: string; role: string; channel: string; text: string; job_id: string | null };

/** "Looked at 2 sheets, Searched your email": a short line from the tools a turn used. */
export function traceSummary(tools: { name: string }[]): string {
  if (!tools.length) return "";
  const base = (n: string) => n.replace(/^mcp__\w+?__/, "");
  const count = (re: RegExp) => tools.filter((t) => re.test(base(t.name)) || re.test(t.name)).length;
  const parts: string[] = [];
  const sheets = count(/^(read_sheet|view_drawing|show_drawing|find_on_sheet|point_at)$/);
  if (sheets) parts.push(`Looked at ${sheets} ${sheets === 1 ? "sheet" : "sheets"}`);
  else if (count(/^(search_drawings|list_sheets|list_drawing_sets|schedule_rows)$/)) parts.push("Searched the drawings");
  if (count(/^(find_in_reference|read_reference|show_reference)$/)) parts.push("Looked it up in the books");
  if (count(/^(calculate|roof_geometry|set_out|stairs|stair_calc|roof_calc|setout_calc|quantity_calc)$/)) parts.push("Worked it out");
  if (count(/^(joint_model|show_model)$/)) parts.push("Built a 3D model");
  if (count(/^(make_shop_drawing|set_drawing_status)$/)) parts.push("Drew it up");
  if (count(/^(search_email|read_email)$|Gmail/)) parts.push("Checked your email");
  if (count(/Calendar|check_calendars/)) parts.push("Checked your calendar");
  if (count(/^Web(Search|Fetch)$/)) parts.push("Looked on the web");
  if (count(/^(recall|search_history|todays_activity)$/)) parts.push("Checked my notes");
  if (count(/^(remember|update_profile|add_commitment|create_routine|update_commitment)$/)) parts.push("Made a note");
  if (count(/^(draft_email|request_action)$/)) parts.push("Drafted it for your OK");
  if (count(/^browser_task$/)) parts.push("Started a website job");
  if (!parts.length) return `Did ${tools.length} ${tools.length === 1 ? "thing" : "things"}`;
  return parts.slice(0, 2).join(", ");
}

function jobSummary(jobId: string | null) {
  if (!jobId) return null;
  const r = db.prepare("SELECT summary FROM jobs WHERE id = ?").get(jobId) as { summary: string | null } | undefined;
  if (!r?.summary) return null;
  try {
    const s = JSON.parse(r.summary) as { tools?: { name: string; label: string; ms: number }[]; ms: number; model: string; closer?: boolean };
    if (!s.tools) return null;
    const summary = [s.closer ? "Took a closer look" : "", s.tools.length ? traceSummary(s.tools) : ""].filter(Boolean).join(". ");
    // which model answered (Stage 10.4), where the turn's steps are already shown
    const by = /opus/i.test(s.model) ? "Opus" : /sonnet/i.test(s.model) ? "Sonnet" : /haiku/i.test(s.model) ? "Haiku" : "";
    return summary ? { summary: by ? `${summary} (${by})` : summary, steps: s.tools.map((t) => ({ label: t.label, ms: t.ms })), ms: s.ms, model: s.model } : null;
  } catch {
    return null;
  }
}

function lineView(r: LineRow) {
  const assistant = r.role === "assistant";
  const items: Item[] = assistant && r.job_id ? itemsForJob(r.job_id) : [];
  return {
    id: r.id,
    role: r.role,
    channel: r.channel,
    text: r.text,
    at: r.ts,
    job_id: r.job_id,
    started_by: r.channel === "proactive" ? "assistant" : "you",
    items,
    trace: assistant ? jobSummary(r.job_id) : null,
  };
}

export function conversationPage(before: number | null, limit: number) {
  const rows = db
    .prepare(`SELECT id, ts, role, channel, text, job_id FROM conversation_log WHERE channel != 'test' AND role IN ('user','assistant','guest') ${before ? "AND id < ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(before ? [before, limit] : [limit])) as LineRow[];
  return rows.map(lineView);
}

function searchLines(q: string) {
  const terms = q
    .split(/\s+/)
    .map((w) => w.replace(/[^\w'-]/g, ""))
    .filter((w) => w.length > 1)
    .map((w) => `"${w}"`);
  if (!terms.length) return [];
  return (
    db
      .prepare(
        `SELECT c.id, c.ts, c.role, c.channel, c.text, c.job_id FROM conversation_fts f JOIN conversation_log c ON c.id = f.rowid
         WHERE conversation_fts MATCH ? AND c.channel != 'test' AND c.role IN ('user','assistant','guest') ORDER BY c.id DESC LIMIT 50`,
      )
      .all(terms.join(" AND ")) as LineRow[]
  ).map(lineView);
}

/* ---------------- activity ---------------- */

type Entry = { id: string; kind: string; title: string; detail: string; at: string | null; state: string; actions: string[]; item_id?: string; trace?: ReturnType<typeof jobSummary> };

const said = (jobId: string) => (db.prepare("SELECT text FROM conversation_log WHERE job_id = ? AND role = 'user' ORDER BY id LIMIT 1").get(jobId) as { text: string } | undefined)?.text;
function jobTitle(j: { id: string; kind: string; source: string | null; request: string }) {
  const s = said(j.id);
  if (s) return s;
  if (j.kind === "routine") return j.source ? `Routine: ${j.source}` : "A routine";
  if (j.kind === "task") return j.source ?? "A job in the background";
  if (j.kind === "browser") return j.request || "A job on the web";
  const first = j.request.split("\n").find((l) => l.trim() && !/^Context:|^Now:/.test(l)) ?? j.request;
  return first.replace(/^Routine: /, "").slice(0, 140);
}

function draftItemId(approvalId: string) {
  return (db.prepare("SELECT id FROM items WHERE kind = 'draft' AND json_extract(payload_json, '$.approval_id') = ?").get(approvalId) as { id: string } | undefined)?.id;
}

export function activity() {
  type JobRow = { id: string; kind: string; source: string | null; request: string; status: string; result: string | null; error: string | null; progress: string | null; created_at: string; updated_at: string };
  // Doing now: what's running, and background jobs waiting their turn. Anything that can be stopped gets a Stop button.
  const running = db.prepare("SELECT id, kind, source, request, status, result, error, progress, created_at, updated_at FROM jobs WHERE status = 'running' OR (status = 'queued' AND kind IN ('task','browser')) ORDER BY created_at").all() as JobRow[];
  const now: Entry[] = running.map((j) => {
    const queued = j.status === "queued";
    return { id: j.id, kind: j.kind, title: jobTitle(j), detail: queued ? "Waiting its turn" : (j.progress ?? "Working on it"), at: j.created_at, state: queued ? "queued" : "running", actions: queued || canStop(j.id) ? ["stop"] : [] };
  });

  const waiting: Entry[] = [
    ...pendingApprovals().map((a) => ({
      id: a.id,
      kind: "approval",
      title: a.kind === "email" ? `Email to ${a.to.join(", ")}: ${a.subject}` : a.subject,
      detail: `Using ${a.account} · until ${formatLocal(a.expires_at, { hour: "numeric", minute: "2-digit" })}`,
      at: a.expires_at,
      state: "waiting",
      actions: a.kind === "email" ? ["review", "send", "not_now"] : ["review", "send", "not_now"],
      item_id: draftItemId(a.id),
    })),
    ...heldWrites().map((h) => ({ id: h.id, kind: "held", title: describeHeld(h), detail: "Held because it came from something I read, not from you", at: h.created_at, state: "waiting", actions: ["yes", "no"] })),
    ...pendingOffers().map((o) => ({ id: o.id, kind: "offer", title: `Track this? ${o.title}`, detail: o.evidence ? `You said: "${o.evidence.slice(0, 120)}"` : "", at: o.created_at, state: "waiting", actions: ["yes", "no"] })),
  ];

  const routines = (listRoutines(true) as (Routine & { when: string })[]).filter((r) => r.status !== "deleted");
  const scheduled = {
    routines: routines.map((r) => ({ id: r.id, kind: "routine", title: r.title, detail: r.when, at: r.next_run_at, state: r.status === "active" ? "on" : "off", actions: ["toggle", "change"], schedule: JSON.parse(r.schedule_json) as Schedule })),
    followups: (listCommitments("open", 50) as { id: string; title: string; due_at: string | null; next_check_at: string | null; owner: string }[]).map((c) => ({
      id: c.id,
      kind: "followup",
      title: c.owner.toLowerCase() === "user" ? c.title : `${c.title} (${c.owner})`,
      detail: c.due_at ? `Due ${fmt(c.due_at)}` : "",
      at: c.next_check_at ?? c.due_at,
      state: "open",
      actions: ["change", "done", "cancel"],
    })),
    controls: describeControls(),
  };

  const done = db.prepare("SELECT id, kind, source, request, status, result, error, progress, created_at, updated_at FROM jobs WHERE status IN ('done','failed','cancelled','interrupted') AND (result IS NULL OR json_extract(result, '$.fast') IS NULL) ORDER BY updated_at DESC LIMIT 30").all() as JobRow[];
  const finished: Entry[] = done.map((j) => ({
    id: j.id,
    kind: j.kind,
    title: jobTitle(j),
    detail: j.status === "done" ? doneLine(j.result) : j.status === "failed" ? `Didn't finish: ${j.error ?? ""}`.slice(0, 160) : j.status === "cancelled" ? "Stopped" : "Cut off by a restart",
    at: j.updated_at,
    state: j.status,
    actions: [],
    trace: jobSummary(j.id),
  }));
  return { now, waiting, scheduled, finished };
}
const fmt = (iso: string) => formatLocal(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
function doneLine(result: string | null) {
  try {
    const r = JSON.parse(result ?? "{}") as { spoken?: string };
    return (r.spoken ?? "").slice(0, 160);
  } catch {
    return "";
  }
}

/* ---------------- memory ---------------- */

export const GROUPS = ["About you", "Work", "People", "Home and personal", "How I should behave"] as const;
type Group = (typeof GROUPS)[number];
type MemEntry = { id: string; text: string; group: Group; source: "you" | "learned"; at: string | null; editable: boolean };

const SECTION_GROUP: Record<string, Group> = { Basics: "About you", Work: "Work", People: "People", "How to talk to them": "How I should behave", "Follow-ups": "Work" };
const KIND_GROUP: Record<string, Group> = { user: "About you", preference: "About you", project: "Work", person: "People" };
const HOME = "Home and personal";
const RULES = "## Your rules";

function soulRules() {
  return readSoul()
    .split(/\r?\n/)
    .map((l, i) => ({ line: l, i }))
    .filter(({ line }) => /^-\s+\S/.test(line))
    .map(({ line }) => line.replace(/^-\s+/, "").trim());
}

export function memory(): Record<Group, MemEntry[]> {
  const out = Object.fromEntries(GROUPS.map((g) => [g, [] as MemEntry[]])) as Record<Group, MemEntry[]>;
  for (const l of userLines()) {
    const g = SECTION_GROUP[l.section] ?? "About you";
    out[g].push({ id: `user:${sha(l.section)}:${sha(l.text)}`, text: l.text, group: g, source: /said|you/i.test(l.source) || !l.source ? "you" : "learned", at: l.date || null, editable: true });
  }
  for (const m of activeMemories(300) as { id: string; kind: string; subject: string; fact: string; created_at: string }[]) {
    const g = m.subject === HOME ? HOME : (KIND_GROUP[m.kind] ?? "About you");
    const src = (db.prepare("SELECT source FROM memories WHERE id = ?").get(m.id) as { source: string | null } | undefined)?.source ?? "";
    out[g].push({ id: m.id, text: m.fact, group: g, source: /you|said|fixture|PC/i.test(src) ? "you" : "learned", at: m.created_at, editable: true });
  }
  for (const r of soulRules()) out["How I should behave"].push({ id: `soul:${sha(r)}`, text: r, group: "How I should behave", source: "you", at: null, editable: true });
  const controls = describeControls();
  if (controls) out["How I should behave"].push({ id: "controls", text: `Follow-ups: ${controls}`, group: "How I should behave", source: "you", at: null, editable: false });
  return out;
}

const who = { trust: "user" as const, source: "you (PC)" };
/** Removed in the last 30 seconds, so Undo can put them back. */
const removed = new Map<string, { at: number; restore: () => void }>();

function findUserLine(id: string) {
  const [, s, t] = id.split(":");
  return userLines().find((l) => sha(l.section) === s && sha(l.text) === t);
}
function setSoulRule(oldText: string | null, newText: string | null) {
  const lines = readSoul().split(/\r?\n/);
  if (oldText !== null) {
    const i = lines.findIndex((l) => /^-\s+/.test(l) && l.replace(/^-\s+/, "").trim() === oldText);
    if (i < 0) throw new Error("That rule has changed; reload.");
    if (newText === null) lines.splice(i, 1);
    else lines[i] = `- ${newText}`;
  } else if (newText !== null) {
    let h = lines.findIndex((l) => l.trim() === RULES);
    if (h < 0) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push("", RULES);
      h = lines.length - 1;
    }
    let end = h + 1;
    while (end < lines.length && /^-\s+/.test(lines[end])) end++;
    lines.splice(end, 0, `- ${newText}`);
  }
  saveSoul(lines.join("\n").replace(/\n*$/, "\n"), "you (PC)");
}

function addMemory(group: Group, text: string) {
  if (group === "How I should behave") return setSoulRule(null, text);
  const kind = group === "Work" ? "project" : group === "People" ? "person" : "user";
  const subject = group === HOME ? HOME : group === "People" ? (text.split(/[\s:,]/)[0] ?? "someone") : group === "Work" ? "Work" : "the user";
  remember({ kind, subject, fact: text, source: "you (PC)" });
}

function editMemory(id: string, text: string) {
  if (id.startsWith("user:")) {
    const l = findUserLine(id);
    if (!l) throw new Error("That line has changed; reload.");
    return void editUser({ op: "patch", section: l.section, match: l.text, text }, who);
  }
  if (id.startsWith("soul:")) {
    const r = soulRules().find((x) => `soul:${sha(x)}` === id);
    if (!r) throw new Error("That rule has changed; reload.");
    return setSoulRule(r, text);
  }
  const m = db.prepare("SELECT kind, subject FROM memories WHERE id = ? AND status = 'active'").get(id) as { kind: "user" | "person" | "project" | "preference"; subject: string } | undefined;
  if (!m) throw new Error("That one has changed; reload.");
  remember({ kind: m.kind, subject: m.subject, fact: text, replaces: id, source: "you (PC)" });
}

function removeMemory(id: string) {
  if (id.startsWith("user:")) {
    const l = findUserLine(id);
    if (!l) throw new Error("That line has changed; reload.");
    editUser({ op: "remove", section: l.section, match: l.text }, who);
    removed.set(id, { at: Date.now(), restore: () => void editUser({ op: "add", section: l.section, text: l.text }, who) });
    return;
  }
  if (id.startsWith("soul:")) {
    const r = soulRules().find((x) => `soul:${sha(x)}` === id);
    if (!r) throw new Error("That rule has changed; reload.");
    setSoulRule(r, null);
    removed.set(id, { at: Date.now(), restore: () => setSoulRule(null, r) });
    return;
  }
  forget(id);
  removed.set(id, {
    at: Date.now(),
    restore: () => {
      db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ? AND status = 'forgotten'").run(nowIso(), id);
      audit("user", "memory.restored", id);
    },
  });
}

function restoreMemory(id: string) {
  const r = removed.get(id);
  if (!r || Date.now() - r.at > 30_000) throw new Error("Too late to undo that one.");
  removed.delete(id);
  r.restore();
}

/* ---------------- routes ---------------- */

export async function handleV2(req: IncomingMessage, res: ServerResponse, url: URL, h: H): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/v2/")) return false;
  const changes = req.method !== "GET";
  if (changes && !h.sameOrigin(req)) return h.send(res, 403, { error: "origin not allowed" }), true;
  try {
    if (req.method === "GET" && p === "/api/v2/conversation") {
      const before = Number(url.searchParams.get("before")) || null;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      return h.send(res, 200, { lines: conversationPage(before, limit) }), true;
    }
    if (req.method === "GET" && p === "/api/v2/conversation/search") return h.send(res, 200, { lines: searchLines(url.searchParams.get("q") ?? "") }), true;
    if (req.method === "GET" && p === "/api/v2/activity") return h.send(res, 200, activity()), true;
    const stop = /^\/api\/v2\/jobs\/([\w-]+)\/cancel$/.exec(p);
    if (stop && req.method === "POST") return h.send(res, cancelJob(stop[1], "user") ? 200 : 409, { ok: true }), true;

    const routine = /^\/api\/v2\/routines\/([\w-]+)$/.exec(p);
    if (routine && req.method === "POST") {
      const r = getRoutine(routine[1]);
      if (!r) return h.send(res, 404, { error: "not found" }), true;
      const b = await json<{ enabled?: boolean; time?: string }>(req, h);
      if (b.enabled !== undefined) setRoutineStatus(r.id, b.enabled ? "active" : "paused");
      if (b.time) {
        const s = JSON.parse(r.schedule_json) as Schedule;
        if (s.kind === "once") return h.send(res, 400, { error: "A one-off routine has a date, not a time." }), true;
        updateRoutine(r.id, { schedule: { ...s, time: b.time } as Schedule });
      }
      bus.emit("activity");
      return h.send(res, 200, { ok: true }), true;
    }
    const cmt = /^\/api\/v2\/commitments\/([\w-]+)$/.exec(p);
    if (cmt && req.method === "POST") {
      if (!getCommitment(cmt[1])) return h.send(res, 404, { error: "not found" }), true;
      const b = await json<{ due?: string; done?: boolean; cancel?: boolean }>(req, h);
      if (b.done) updateCommitment(cmt[1], { status: "done", note: "from the PC app" });
      else if (b.cancel) updateCommitment(cmt[1], { status: "dropped", note: "from the PC app" });
      else if (b.due) updateCommitment(cmt[1], { due_at: parseLocal(b.due).toISOString(), next_check_at: parseLocal(b.due).toISOString() });
      bus.emit("activity");
      return h.send(res, 200, { ok: true }), true;
    }
    const offer = /^\/api\/v2\/offers\/([\w-]+)$/.exec(p);
    if (offer && req.method === "POST") {
      answerOffer(offer[1], (await json<{ accept?: boolean }>(req, h)).accept === true);
      bus.emit("activity");
      return h.send(res, 200, { ok: true }), true;
    }

    /* a file attached in the desktop's message box: saved into the drawings folder's inbox (the one place it owns) */
    if (req.method === "POST" && p === "/api/v2/upload") {
      const as = url.searchParams.get("as");
      if (as === "photo" || as === "sketch") return await handlePictureUpload(req, res, url, h, as), true;
      if (as === "model") return await handleModelUpload(req, res, url, h), true;
      const raw = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
      const name = path.basename(raw).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").trim().slice(0, 120);
      if (!name || name.startsWith(".") || !kindOf(name) || kindOf(name) === "old") return h.send(res, 400, { error: "I can read PDF, Word, Excel, text, email and photo files." }), true;
      const dir = path.join(DRAWINGS_DIR, "inbox");
      mkdirSync(dir, { recursive: true });
      const target = uniqueName(dir, name);
      const tmp = `${target}.${process.pid}.part`;
      let size = 0;
      const out = createWriteStream(tmp);
      try {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > 50 * 1024 * 1024) throw new Error("That's over 50 MB. Put it in one of the folders I read instead.");
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
        }
        await new Promise<void>((r, j) => out.end((e?: Error) => (e ? j(e) : r())));
        await rename(tmp, target);
      } catch (e) {
        out.destroy();
        await rm(tmp, { force: true });
        throw e;
      }
      audit("user", "file.attached", null, { name: path.basename(target), size });
      // A photo attached here is read at once, so it's in the "photos they sent" Context line like one from the phone.
      if (kindOf(name) === "image") {
        const doc = await readOneFile(target, { by: "owner", kind: "photo" }).catch(() => null);
        if (doc) bus.emit("picture", { kind: "photo", file: doc.id });
        return h.send(res, 200, { name: path.basename(target), job: "Unsorted", file: doc?.id }), true;
      }
      void scanForNew().then(() => processQueue());
      void scanFolder(ensureManagedFolder());
      return h.send(res, 200, { name: path.basename(target), job: "Unsorted" }), true;
    }
    /* folders it may read (Stage 4) */
    if (req.method === "GET" && p === "/api/v2/folders") return h.send(res, 200, { folders: folderSummaries() }), true;
    if (req.method === "POST" && p === "/api/v2/folders") {
      const b = await json<{ path?: string; label?: string; check?: boolean }>(req, h);
      if (b.check) return h.send(res, 200, { problem: folderProblem(String(b.path ?? "")).problem }), true;
      return h.send(res, 200, { folder: addFolder(String(b.path ?? ""), b.label) }), true;
    }
    const fld = /^\/api\/v2\/folders\/(fld_[\w]{1,20})(\/rescan|\/files)?$/.exec(p);
    if (fld) {
      if (!getFolder(fld[1])) return h.send(res, 404, { error: "not found" }), true;
      if (req.method === "GET" && fld[2] === "/files") return h.send(res, 200, { files: folderFiles(fld[1], Number(url.searchParams.get("offset")) || 0, Math.min(500, Number(url.searchParams.get("limit")) || 200)) }), true;
      if (req.method === "POST" && fld[2] === "/rescan") return void scanFolder(fld[1]), h.send(res, 200, { ok: true }), true;
      if (req.method === "PATCH" && !fld[2]) return h.send(res, 200, { folder: setFolder(fld[1], await json(req, h)) }), true;
      if (req.method === "DELETE" && !fld[2]) return removeFolder(fld[1]), h.send(res, 200, { ok: true }), true;
    }
    /* everything it holds, for the file viewer (Stage 15.1): only ever read; a preview is never kept */
    if (req.method === "GET" && p === "/api/v2/everything") {
      const s = url.searchParams;
      const sort = s.get("sort");
      const dir = s.get("dir");
      return (
        h.send(res, 200, listEverything({
          group: isGroup(s.get("group")) ? (s.get("group") as GroupId) : null,
          job: s.get("job") || null,
          q: (s.get("q") ?? "").slice(0, 200) || null,
          sort: sort && ["name", "kind", "job", "date", "size", "best"].includes(sort) ? (sort as Sort) : undefined,
          dir: dir === "asc" || dir === "desc" ? dir : undefined,
          offset: Number(s.get("offset")) || 0,
          limit: Number(s.get("limit")) || 100,
        })),
        true
      );
    }
    const ev = /^\/api\/v2\/everything\/(doc_[a-f0-9]{16}|dwg_[a-f0-9]{64}|sd_[a-f0-9]{8}|itm_\w{1,40}|ref_[a-f0-9]{12})(\/item|\/label|\/file)?$/.exec(p);
    if (ev) {
      const id = ev[1];
      const n = Math.max(0, Number(url.searchParams.get("n")) || 0);
      const rev = /^[A-Z0-9]{1,4}$/.test(url.searchParams.get("rev") ?? "") ? url.searchParams.get("rev")! : undefined;
      if (req.method === "GET" && !ev[2]) {
        const pv = await previewOf(id, { n, rev });
        return h.send(res, pv ? 200 : 404, pv ?? { error: "not found" }), true;
      }
      if (req.method === "GET" && ev[2] === "/file") {
        const f = fileFor(id);
        if (!f || !existsSync(f.path)) return h.send(res, 404, { error: "That file isn't there any more." }), true;
        // always a download, never opened in the app's own window
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
        createReadStream(f.path).pipe(res);
        return true;
      }
      if (req.method === "POST" && ev[2] === "/item") {
        const b = await json<{ n?: number; rev?: string }>(req, h);
        const it = await itemForEntry(id, { n: Math.max(0, Number(b.n) || 0), rev: typeof b.rev === "string" && /^[A-Z0-9]{1,4}$/.test(b.rev) ? b.rev : undefined });
        return h.send(res, it ? 200 : 404, it ? { item: it } : { error: "not found" }), true;
      }
      if (req.method === "POST" && ev[2] === "/label") {
        const b = await json<{ label?: string }>(req, h);
        const e = setLabel(id, String(b.label ?? ""));
        bus.emit("files", {});
        return h.send(res, 200, { entry: e }), true;
      }
    }
    /* the assistant's browser (Stage 15.2): watch it, take it over, hand it back, stop it; sign in; its sign-ins */
    if (p.startsWith("/api/v2/browser")) {
      const host = liveHost();
      if (req.method === "GET" && p === "/api/v2/browser") return h.send(res, 200, { view: browserState() }), true;
      if (req.method === "POST" && p === "/api/v2/browser/stop") {
        if (!host) return h.send(res, 200, { ok: true, view: browserState() }), true;
        const id = host.view.job_id;
        if (id && !cancelJob(id, "user")) await host.close(); // the job's stop closes it; anything else closes here
        if (!id) await host.close();
        return h.send(res, 200, { ok: true, view: browserState() }), true;
      }
      if (req.method === "POST" && p === "/api/v2/browser/takeover") {
        if (!host) return h.send(res, 409, { error: "The browser isn't open." }), true;
        await host.takeOver();
        return h.send(res, 200, { view: browserState() }), true;
      }
      if (req.method === "POST" && p === "/api/v2/browser/handback") {
        host?.handBack();
        return h.send(res, 200, { view: browserState() }), true;
      }
      if (req.method === "POST" && p === "/api/v2/browser/signin") {
        const r = await openSignIn(String((await json<{ site?: string }>(req, h)).site ?? ""));
        return h.send(res, 200, { ...r, view: browserState() }), true;
      }
      if (req.method === "GET" && p === "/api/v2/browser/sites") return h.send(res, 200, { sites: await signedInSites() }), true;
      if (req.method === "POST" && p === "/api/v2/browser/signout") return h.send(res, 200, { ...(await signOutSite(String((await json<{ domain?: string }>(req, h)).domain ?? ""))), sites: await signedInSites() }), true;
      if (req.method === "POST" && p === "/api/v2/browser/clear") return clearEverything(), h.send(res, 200, { ok: true }), true;
    }
    /* Siri Shortcut keys (Stage 14.3): made here, shown once, taken away here */
    if (req.method === "GET" && p === "/api/v2/shortcuts") return h.send(res, 200, { shortcuts: listShortcuts() }), true;
    if (req.method === "POST" && p === "/api/v2/shortcuts") {
      const r = pairShortcut(String((await json<{ name?: string }>(req, h)).name ?? ""));
      return h.send(res, 200, { name: r.name, key: r.key, shortcuts: listShortcuts() }), true;
    }
    const sc = /^\/api\/v2\/shortcuts\/([\w %-]{1,40})$/.exec(p);
    if (sc && req.method === "DELETE") return h.send(res, unpairShortcut(decodeURIComponent(sc[1])) ? 200 : 404, { shortcuts: listShortcuts() }), true;
    /* the reference books shelf (Stage 8): only ever read */
    if (req.method === "GET" && p === "/api/v2/reference") return h.send(res, 200, shelfSummary()), true;
    if (req.method === "POST" && p === "/api/v2/reference/rescan") return void scanShelf({ retryFailed: true }), h.send(res, 200, { ok: true }), true;
    if (req.method === "GET" && p === "/api/v2/memory") return h.send(res, 200, { groups: memory() }), true;
    const held = /^\/api\/v2\/memory\/held\/([\w-]+)$/.exec(p);
    if (held && req.method === "POST") {
      decideHeld(held[1], (await json<{ accept?: boolean }>(req, h)).accept === true);
      bus.emit("activity");
      bus.emit("memory");
      return h.send(res, 200, { ok: true }), true;
    }
    if (p === "/api/v2/memory" && req.method === "POST") {
      const b = await json<{ group?: string; text?: string }>(req, h);
      const text = String(b.text ?? "").trim().slice(0, 500);
      if (!text || !GROUPS.includes(b.group as Group)) return h.send(res, 400, { error: "Say which group, and what to remember." }), true;
      addMemory(b.group as Group, text);
      bus.emit("memory");
      return h.send(res, 200, { groups: memory() }), true;
    }
    const mem = /^\/api\/v2\/memory\/([\w:%-]+?)(\/restore)?$/.exec(p); // ids may contain ":" (sent as %3A)
    if (mem && mem[1] !== "held") {
      const id = decodeURIComponent(mem[1]);
      if (req.method === "PATCH") {
        const text = String((await json<{ text?: string }>(req, h)).text ?? "").trim().slice(0, 500);
        if (!text) return h.send(res, 400, { error: "Nothing to save." }), true;
        editMemory(id, text);
      } else if (req.method === "DELETE") removeMemory(id);
      else if (req.method === "POST" && mem[2]) restoreMemory(id);
      else return false;
      bus.emit("memory");
      return h.send(res, 200, { groups: memory() }), true;
    }
  } catch (err) {
    return h.send(res, 400, { error: err instanceof Error ? err.message : String(err) }), true;
  }
  return false;
}
