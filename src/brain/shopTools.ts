// Shop drawings (Stage 12.5): drawn from a 3D model the assistant made, as a numbered set with revisions. What a drawing
// needs and the model lacks (who it's for, the job, materials) comes from what he's said, or one question; it says what
// it drew and assumed; it looks at the sheets before calling them done (look_at_drawing, Stage 21.2); never fills
// "checked"; never claims a certification. The functions are also used by the fake brain and the tests.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { DEV } from "../dev.js";
import { createItem, getItem, publishItem, touchItem } from "../store/items.js";
import { type Drawing, allDrawings, drawingByNumber, getDrawing, getRevision, revisionsOf, setRevisionItem } from "../store/shopdrawings.js";
import { companyDetails, fileNameFor, makeRevision, payloadFor, readLogo, setTestDetails, sheetPicture } from "../drawings/shop.js";
import { updateSettings } from "../store/settings.js";
import { screenOf } from "./showTools.js";
import { testSafe, type TurnCtx, type TurnInfo } from "./turn.js";
import type { Item, ModelPayload, ShopDrawingStatus } from "../shared/protocol.js";
import { clientById } from "../gateway/clients.js";
import { buildModel } from "../shared/model3d/build.js";
import { analyseParts, labelOf } from "../shared/drawing/parts.js";
import { findAllJoints } from "../shared/drawing/joints.js";
import { type ExtraView, jointBetween } from "../shared/drawing/details.js";
import { makeSet } from "../shared/drawing/sheets.js";
import { AddedError, addedText, type Added, type FeatureRef } from "../shared/drawing/added.js";
import type { Side } from "../shared/drawing/dims.js";
import { randomUUID } from "node:crypto";
import { drawingAccess, fileAccess, itemAccess, mayUseDrawing } from "../hq/ownership.js";
import { db } from "../store/db.js";
import type { DocRow } from "../files/library.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const err = (message: string) => json({ error: message });
type DrawingItem = Extract<Item, { kind: "shopdrawing" }>;

/** The item for a revision: its own if it still exists, else made again from what's kept. */
function itemFor(turn: TurnInfo, d: Drawing, rev: string, open = true, openAt?: number): DrawingItem {
  const r = getRevision(d.id, rev)!;
  const kept = r.item_id ? getItem(r.item_id) : null;
  if (kept && kept.kind === "shopdrawing" && !openAt) {
    const it = (turn.persist ? touchItem(kept.id) : kept) as DrawingItem;
    turn.items.push(it.id);
    publishItem(it, turn, open);
    return it;
  }
  // (opened at a sheet: the one a view he just asked for went on, 19.3)
  const it = createItem(turn, { kind: "shopdrawing", title: `${d.title}`, source: `Shop drawing ${d.number} ${rev} · ${r.sheets.length} sheets`, payload: payloadFor(d, r, openAt) }) as DrawingItem;
  setRevisionItem(d.id, rev, it.id, turn.persist);
  publishItem(it, turn, open);
  return it;
}

/** The drawing they mean: its number, or the one on their screen, or the one drawn from the model on their screen. */
function drawingFor(turn: TurnInfo, number?: string, look = false): Drawing | { error: string } {
  const checked = (d: Drawing | null | undefined) => {
    if (!d) return { error: "That drawing isn't kept any more." };
    const refusal = drawingAccess(turn, d, look);
    return refusal ? { error: refusal } : d;
  };
  if (number) {
    const d = drawingByNumber(number) ?? findDrawings(number)[0];
    return d ? checked(d) : { error: `There's no drawing "${number}". show_shop_drawing with no words lists them.` };
  }
  const on = screenOf(turn).itemId;
  const it = on ? getItem(on) : null;
  if (it?.kind === "shopdrawing") return checked(getDrawing(it.payload.drawing_id));
  if (it?.kind === "model") {
    const d = allDrawings().find((x) => x.model_item === it.id);
    if (d) return checked(d);
  }
  return { error: "There's no drawing on their screen; say which (its number, or words from its title or job)." };
}

/** Drawings matching words in their number, title, project, client or job, best first. */
export function findDrawings(words: string): Drawing[] {
  const ws = words.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1 && !["the", "drawing", "drawings", "shop", "for", "pull", "up", "show", "me"].includes(w));
  if (!ws.length) return allDrawings();
  const score = (d: Drawing) => ws.reduce((t, w) => t + (d.number.toLowerCase().includes(w) ? 4 : 0) + (d.title.toLowerCase().includes(w) ? 3 : 0) + (d.project.toLowerCase().includes(w) ? 3 : 0) + (d.client.toLowerCase().includes(w) ? 2 : 0), 0);
  return allDrawings()
    .map((d) => ({ d, s: score(d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.d);
}

export type MakeArgs = { model?: string; drawing?: string; title?: string; project?: string; client?: string; finish?: string; materials?: Record<string, string>; asked?: boolean; notes?: string[]; change?: string };

/** The model's materials that don't say what they really are (species, grade, treatment): "hardwood", "pine", "ply"... */
const GENERIC = ["hardwood", "pine", "oak", "walnut", "ply", "mdf", "steel", "concrete"];

/** Make a shop drawing from a model (or the next revision of one). Returns what's missing, once, if it can't yet. */
export async function makeShopDrawing(turn: TurnInfo, a: MakeArgs) {
  // the model: the one named, or on screen, or the one the drawing on screen was drawn from
  let modelId = a.model;
  const on = screenOf(turn).itemId;
  const onItem = on ? getItem(on) : null;
  if (!modelId && onItem?.kind === "model") modelId = onItem.id;
  let prev: Drawing | null = null;
  if (a.drawing) {
    const d = drawingFor(turn, a.drawing);
    if ("error" in d) return { error: d.error };
    prev = d;
  } else if (!a.model && onItem?.kind === "shopdrawing") prev = getDrawing(onItem.payload.drawing_id); // drawn again from its own model
  if (!modelId && prev) modelId = prev.model_item ?? undefined;
  const model = modelId ? getItem(modelId) : null;
  if (!model || model.kind !== "model") return { error: "Make the 3D model first (joint_model or show_model), or say which model; a shop drawing is drawn from one." };
  const refusal = itemAccess(turn, model);
  if (refusal) return { error: refusal };
  if (!prev) prev = allDrawings().find((d) => d.model_item === model.id && mayUseDrawing(turn, d)) ?? null;
  if (prev) { const refusal = drawingAccess(turn, prev); if (refusal) return { error: refusal }; }
  // what a drawing needs that the model doesn't say: asked for once, together
  const project = (a.project ?? prev?.project ?? "").trim(),
    client = (a.client ?? prev?.client ?? "").trim();
  const needs: string[] = [];
  if (!client) needs.push("who it's for (the client)");
  if (!project) needs.push("the job or project name");
  const plain = [...new Set(model.payload.parts.filter((p) => p.material === "plain").map((p) => p.name))];
  if (plain.length) needs.push(`the material for: ${plain.join(", ")} (then remake the model with it)`);
  const last = prev ? revisionsOf(prev.id).at(-1) : null;
  // the real material (species, grade, treatment) and the finish: asked for once with the rest; not known, it says TBC
  const materials = a.materials && Object.keys(a.materials).length ? a.materials : last?.input.materials;
  const finish = a.finish ?? last?.input.finish;
  if (!a.asked && !prev) {
    const kinds = [...new Set(model.payload.parts.map((p) => p.material).filter((m) => GENERIC.includes(m)))];
    if (!materials && kinds.length) needs.push(`what it's made of, as they'd order it (species or grade and treatment, e.g. "Tas oak, DAR", "MGP10 H3 pine", "18 HMR melamine, white"; the model only says ${kinds.join(", ")})`);
    if (!finish) needs.push(`the finish (e.g. "2 coats clear satin"), if they know it`);
  }
  if (needs.length)
    return {
      needs,
      say: "Not given yet. Use what they've already told you or what's plain from the conversation (\"just for me, at home\" is the client and the job; the timber they named is the material); ask only what you genuinely can't tell, in one question. Then call make_shop_drawing again with them and asked: true; what nobody knows goes on the drawing as TBC.",
    };
  const made = await makeRevision({
    model: model.payload,
    modelItem: model.id,
    title: (a.title ?? prev?.title ?? model.title).slice(0, 80),
    project,
    client,
    finish,
    ...(materials ? { materials } : {}),
    notes: a.notes ?? last?.input.notes,
    ...(last?.input.views?.length ? { views: last.input.views } : {}),
    text: a.change,
    drawing: prev ?? undefined,
    persist: turn.persist,
  });
  const it = itemFor(turn, made.drawing, made.rev.rev);
  const views = made.set.sheets.flatMap((s) => s.meta.views);
  const ga = views.find((v) => v.kind === "ga");
  const sections = views.filter((v) => v.kind === "section").map((v) => v.id);
  const assumed = [
    ...(made.rev.input.finish ? [] : ["finish not given (shown as TBC)"]),
    ...(made.rev.input.materials ? [] : ["materials not given (TBC in the schedule)"]),
    "fixings not shown unless they're parts of the model",
    ...(model.payload.note ? [`the model's note: ${model.payload.note}`] : []),
  ];
  return {
    shown: it.id,
    number: made.drawing.number,
    revision: made.rev.rev,
    status: made.drawing.status,
    sheets: made.set.sheets.map((s) => s.meta.title.replace(/^.* – /, "")),
    drew: `${made.set.sheets.length} sheets: a general arrangement${ga ? ` at 1:${ga.scale}` : ""}, ${made.set.marks.length} part views${sections.length ? `, ${sections.length === 1 ? "a section" : `${sections.length} sections`} through the joints (${sections.join(", ")})` : ""}, the parts schedule`,
    assumed,
    files: { pdf: fileNameFor(made.drawing, made.rev.rev, "pdf"), dxf: fileNameFor(made.drawing, made.rev.rev, "dxf"), parts: made.files.parts.length, folder: "models/shop-drawings in the folder the app manages" },
    say: "It's on their screen. Look at the sheets (look_at_drawing) before you call it done, and fix what you can. Then say in a sentence or two what you drew and what you assumed. Never say it's checked, certified or structurally adequate; 'checked' stays empty until they say they've checked it.",
  };
}

/** Show a drawing (a revision of it), or the list of drawings by job when it isn't clear which. */
export function showShopDrawing(turn: TurnInfo, a: { query?: string; rev?: string }) {
  const exact = a.query ? drawingByNumber(a.query) : null;
  if (exact) { const refusal = drawingAccess(turn, exact); if (refusal) return { error: refusal }; }
  const found = (exact ? [exact] : a.query ? findDrawings(a.query) : []).filter((d) => mayUseDrawing(turn, d));
  if (found.length === 1) {
    const d = found[0];
    const refusal = drawingAccess(turn, d);
    if (refusal) return { error: refusal };
    const revs = revisionsOf(d.id);
    const rev = a.rev ? revs.find((r) => r.rev.toUpperCase() === a.rev!.toUpperCase()) : revs.at(-1);
    if (!rev) return { error: `${d.number} has no revision ${a.rev}; it has ${revs.map((r) => r.rev).join(", ")}.` };
    const kept = rev.item_id ? getItem(rev.item_id) : null;
    if (kept) { const refusal = itemAccess(turn, kept); if (refusal) return { error: refusal }; }
    const it = itemFor(turn, d, rev.rev);
    return { shown: it.id, number: d.number, revision: rev.rev, latest: revs.at(-1)!.rev, revisions: revs.map((r) => `${r.rev} ${r.date} ${r.text}`), status: rev.status };
  }
  // the list, by job, with each drawing's revisions; a row opens its newest
  const all = (a.query && found.length ? found : allDrawings()).filter((d) => mayUseDrawing(turn, d)).slice(0, 60);
  if (!all.length) return { error: "No shop drawings yet." };
  const byJob = [...new Set(all.map((d) => d.job))];
  const rows = byJob.flatMap((job) =>
    all
      .filter((d) => d.job === job)
      .map((d) => {
        const revs = revisionsOf(d.id);
        const latest = revs.at(-1)!;
        const kept = latest.item_id ? getItem(latest.item_id) : null;
        const target = { type: "item" as const, item_id: (kept ?? itemFor(turn, d, latest.rev, false)).id };
        return { id: d.id, cells: [`${d.number} ${latest.rev}`, d.title, `${d.project} · ${d.status.toLowerCase()} · ${revs.map((r) => r.rev).join(", ")}`], target };
      }),
  );
  const list = createItem(turn, { kind: "list", title: "Shop drawings", source: `${all.length} drawings`, payload: { heading: "Shop drawings", sub: `By job, newest revision first · ${all.length} drawings`, rows } });
  publishItem(list, turn);
  return { shown_list: list.id, drawings: all.map((d) => `${d.number} ${d.rev} ${d.title} (${d.project}, ${d.status.toLowerCase()})`) };
}

/** Mark a drawing for approval or construction (or back to preliminary): its next revision, issued that way. */
export async function setDrawingStatus(turn: TurnInfo, a: { drawing?: string; status: ShopDrawingStatus; note?: string }) {
  const d = drawingFor(turn, a.drawing);
  if ("error" in d) return { error: d.error };
  if (d.status === a.status) return { error: `${d.number} is already ${a.status.toLowerCase()} (revision ${d.rev}).` };
  const last = revisionsOf(d.id).at(-1)!;
  const made = await makeRevision({
    model: last.model,
    modelItem: d.model_item,
    title: last.input.title,
    project: d.project,
    client: d.client,
    finish: last.input.finish,
    ...(last.input.materials ? { materials: last.input.materials } : {}),
    notes: last.input.notes,
    ...(last.input.views?.length ? { views: last.input.views } : {}),
    status: a.status,
    text: a.note,
    drawing: d,
    persist: turn.persist,
  });
  const it = itemFor(turn, made.drawing, made.rev.rev);
  return { shown: it.id, number: made.drawing.number, revision: made.rev.rev, status: a.status, was: `${d.rev} ${d.status.toLowerCase()}` };
}

/** The files for a revision: where they are, and how the owner gets them (the share button on his phone). */
export function exportShopDrawing(turn: TurnInfo, a: { drawing?: string; rev?: string; as?: "pdf" | "dxf" | "parts" }) {
  const d = drawingFor(turn, a.drawing);
  if ("error" in d) return { error: d.error };
  const r = a.rev ? getRevision(d.id, a.rev.toUpperCase()) : revisionsOf(d.id).at(-1);
  if (!r) return { error: `${d.number} has no revision ${a.rev}.` };
  const kept = r.item_id ? getItem(r.item_id) : null;
  if (kept) { const refusal = itemAccess(turn, kept); if (refusal) return { error: refusal }; }
  const it = itemFor(turn, d, r.rev);
  const as = a.as ?? "pdf";
  return {
    shown: it.id,
    file: as === "pdf" ? fileNameFor(d, r.rev, "pdf") : as === "dxf" ? fileNameFor(d, r.rev, "dxf") : `${d.number} ${r.rev} parts (one DXF per part)`,
    path: as === "pdf" ? r.pdf : as === "dxf" ? r.dxf : r.parts_dir,
    say: "The drawing is on their screen with a Share button: tapping it hands the file to their phone's share sheet (Mail, Messages, Files, AirDrop). Sending anywhere happens only on their tap. Say that in a sentence.",
  };
}

/**
 * The title block's details, set by talking ("put Example Club on the drawings", "add our phone number", "take the
 * company name off", "my initials are NV"): each given value is set, null clears it. Kept for later drawings; a drawing
 * already made picks them up on its next revision. A test turn keeps them for that run only.
 */
export function setDrawingDetails(turn: TurnInfo, a: { company?: string | null; line?: string | null; logo?: string | null; drawn_by?: string | null }) {
  if (turn.bot && a.logo) {
    const file = db.prepare("SELECT * FROM docs WHERE path = ?").get(a.logo) as DocRow | undefined;
    if (!file) return { error: "Use a logo file from the owner's file list." };
    const refusal = fileAccess(turn, file);
    if (refusal) return { error: refusal };
  }
  const patch: Record<string, string> = {};
  if (a.company !== undefined) patch["drawings.company"] = (a.company ?? "").trim().slice(0, 80);
  if (a.line !== undefined) patch["drawings.company_line"] = (a.line ?? "").trim().slice(0, 80);
  if (a.drawn_by !== undefined) patch["drawings.drawn_by"] = (a.drawn_by ?? "").replace(/[^A-Za-z.]/g, "").toUpperCase().slice(0, 6);
  if (a.logo !== undefined) {
    const p = (a.logo ?? "").trim();
    if (p && !readLogo(p)) return { error: `"${p}" isn't a PNG or JPEG file I can read. Ask for the logo's file (or bring it across), then try again.` };
    patch["drawings.logo"] = p;
  }
  if (!Object.keys(patch).length) return { error: "Nothing to change: give company, line, logo or drawn_by (null clears one)." };
  if (turn.persist) updateSettings(patch, "brain");
  else setTestDetails(patch as Parameters<typeof setTestDetails>[0]);
  const now = companyDetails(!turn.persist);
  return {
    title_block: { company: now.name || "(none: the project leads the title block)", line: now.line || "(none)", logo: now.logoPath ? "yes" : "none", drawn_by: now.drawn },
    applies: "New drawings from now on. A drawing already made keeps what it had until its next revision (reissue or a status change).",
    say: "Say in a sentence what's on the title block now, and that drawings already made pick it up on their next revision.",
  };
}


/* ---------------- views he asks for (Stage 19.3) ---------------- */

const singular = (w: string) => w.replace(/(?<=[a-z]{3})(es|s)$/, "");
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an", "that", "this", "those", "these", "one", "piece", "part", "bit"].includes(w))
    .map(singular);

/**
 * The parts he means, from his words ("that shelf", "the rail", "left stile"), against the model's part names and their
 * labels on the drawing. One kind of part: its names. Two or three kinds: ask which (a "rail" on a door could be the top
 * rail or the bottom rail). None: say what the parts are.
 */
export function resolveParts(model: ModelPayload, words: string): { names: string[]; label: string } | { ask: string[] } | { none: string[] } {
  const ws = wordsOf(words);
  const parts = model.parts.map((p) => ({ name: p.name, label: labelOf(p.name) }));
  const labels = [...new Set(parts.map((p) => p.label))];
  if (!ws.length) return { none: labels };
  const has = (s: string) => {
    const pw = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).map(singular);
    return ws.every((w) => pw.includes(w));
  };
  // a whole name ("left stile") first, then a label ("stile"), then any part whose name has the words
  const exact = parts.filter((p) => has(p.name) && wordsOf(p.name).length === ws.length);
  const hits = exact.length ? exact : parts.filter((p) => has(p.name) || has(p.label));
  const kinds = [...new Set(hits.map((p) => p.label))];
  if (!kinds.length) return { none: labels };
  if (kinds.length > 1 && !exact.length) return { ask: kinds.map((k) => k.toLowerCase()) };
  const names = exact.length ? exact.map((p) => p.name) : hits.map((p) => p.name);
  return { names: [...new Set(names)], label: kinds[0] };
}

export type ViewArgs = {
  drawing?: string;
  kind: "section" | "detail" | "bigger" | "3d";
  part?: string;
  way?: "across" | "along";
  parts?: string[];
  detail?: string;
  from?: "above" | "below" | "front" | "back" | "left" | "right";
  apart?: boolean;
};

/** The joint types of a model, and which detail letter each has: worked out the same way the drawing does. */
function jointsOf(model: ModelPayload) {
  const built = buildModel(model);
  const { parts, marks } = analyseParts(model, built);
  return { built, parts, marks, joints: findAllJoints(model, built, parts, marks) };
}

/** The sheet of the drawing on their screen they're looking at (from 1), if it's this drawing. */
function sheetOnScreen(turn: TurnInfo, d: Drawing): number | null {
  const { clientId, itemId } = screenOf(turn);
  const it = itemId ? getItem(itemId) : null;
  if (it?.kind !== "shopdrawing" || it.payload.drawing_id !== d.id) return null;
  const c = clientId ? clientById(clientId) : undefined;
  return (c?.screen?.page_index ?? 0) + 1;
}

/**
 * A detail he asked for himself that "bigger" means: by its letter ("make detail E bigger"), or, with no letter or parts,
 * ("that") the newest view he asked for when it's a detail on the sheet on his screen ("make that detail bigger" just
 * after it).
 */
function askedDetail(a: ViewArgs, turn: TurnInfo, d: Drawing, last: ReturnType<typeof revisionsOf>[number], views: ExtraView[]): ExtraView | undefined {
  const asked = last.sheets.flatMap((s) => s.asked ?? []);
  let id: string | undefined;
  if (a.detail && /^[a-z]$/i.test(a.detail.trim())) id = asked.find((x) => x.label === `Detail ${a.detail!.trim().toUpperCase()}`)?.id;
  else if (!a.parts?.length) {
    const sheet = sheetOnScreen(turn, d);
    const here = sheet ? (last.sheets[sheet - 1]?.asked ?? []) : [];
    const newest = views.at(-1);
    if (newest && here.some((x) => x.id === newest.id)) id = newest.id;
  }
  return views.find((v) => v.id === id && v.kind === "detail");
}

/**
 * Add a view he asked for (19.3.1): a section, a detail of where two parts meet (seen from a side), a standard detail
 * drawn bigger, or a 3D view. Remembered with the drawing; makes the next revision with a plain note ("Section D-D
 * added") and puts up the sheet it's on. If it can't tell which part or joint he means, it says which to ask about.
 */
export async function addDrawingView(turn: TurnInfo, a: ViewArgs) {
  const d = drawingFor(turn, a.drawing);
  if ("error" in d) return { error: d.error };
  const last = revisionsOf(d.id).at(-1)!;
  const model = last.model;
  const views = [...(last.input.views ?? [])];
  const id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const one = (words: string | undefined, what: string) => {
    const r = resolveParts(model, words ?? "");
    if ("ask" in r) return { ask: `Which ${what}: ${r.ask.length === 2 ? r.ask.join(" or ") : `${r.ask.slice(0, -1).join(", ")} or ${r.ask.at(-1)}`}?`, candidates: r.ask };
    if ("none" in r) return { error: `There's no ${words ?? "part"} in this drawing. The parts are: ${r.none.map((x) => x.toLowerCase()).join(", ")}.` };
    return r;
  };
  let view: ExtraView;
  if (a.kind === "section" || a.kind === "3d") {
    const names: string[] = [];
    for (const w of a.kind === "section" ? (a.part ? [a.part] : []) : (a.parts ?? [])) {
      const r = one(w, "part");
      if ("ask" in r || "error" in r) return { ...r, say: "ask" in r ? "Ask which they mean, naming these; don't guess." : undefined };
      names.push(...(a.kind === "section" ? r.names.slice(0, 1) : r.names));
    }
    view = { id, kind: a.kind, ...(names.length ? { parts: names } : {}), ...(a.kind === "section" ? { way: a.way ?? "across" } : { apart: a.apart ?? false }) };
  } else if (a.kind === "bigger" && askedDetail(a, turn, d, last, views)) {
    // a detail he asked for himself, drawn larger: seen from the same side
    const src = askedDetail(a, turn, d, last, views)!;
    view = { id, kind: "bigger", ...(src.parts ? { parts: src.parts } : {}), from: src.from ?? "above" };
  } else {
    // a joint: by its letter, the one on their screen, or the two parts that meet
    const J = jointsOf(model);
    let pair: [string, string] | null = null;
    const typeNames = (t: (typeof J.joints.types)[number]) => [model.parts[t.insts[0].host].name, model.parts[t.insts[0].guests[0]].name] as [string, string];
    if (a.detail && /^[a-z]$/i.test(a.detail.trim())) {
      const t = J.joints.types.find((x) => x.letter === a.detail!.trim().toUpperCase());
      if (!t) return { error: `There's no detail ${a.detail.toUpperCase()} on ${d.number}. Its details are ${J.joints.types.flatMap((x) => (x.letter ? [x.letter] : [])).join(", ")}.` };
      pair = typeNames(t);
    } else if (a.detail || (!a.parts?.length && a.kind === "bigger")) {
      // "that detail": the ones on the sheet on their screen
      const sheet = sheetOnScreen(turn, d);
      const on = sheet ? (last.sheets[sheet - 1]?.details ?? []) : [];
      const types = J.joints.types.filter((t) => t.letter && on.includes(t.letter));
      if (types.length === 1) pair = typeNames(types[0]);
      else
        return {
          ask: `Which detail: ${(types.length ? types : J.joints.types.filter((t) => t.letter)).map((t) => `${t.letter} (${t.title.toLowerCase()})`).join(", ")}?`,
          candidates: (types.length ? types : J.joints.types.filter((t) => t.letter)).map((t) => t.letter),
          say: "Ask which detail they mean, naming these; don't guess.",
        };
    } else {
      const ws = a.parts ?? [];
      if (ws.length < 2) return { error: "Say the two parts that meet (\"the back\" and \"the side\"), or the detail's letter." };
      const r1 = one(ws[0], "part"),
        r2 = one(ws[1], "part");
      for (const r of [r1, r2]) if ("ask" in r || "error" in r) return { ...r, say: "ask" in r ? "Ask which they mean, naming these; don't guess." : undefined };
      const n1 = (r1 as { names: string[] }).names,
        n2 = (r2 as { names: string[] }).names;
      const idx = (ns: string[]) => model.parts.flatMap((p, i) => (ns.includes(p.name) ? [i] : []));
      const jb = jointBetween(J.joints, idx(n1), idx(n2));
      if (!jb) return { error: `The ${ws[0]} and the ${ws[1]} don't meet anywhere in this drawing.` };
      pair = [model.parts[jb.inst.host].name, model.parts[jb.inst.guests[0]].name];
    }
    view = { id, kind: a.kind, parts: pair, ...(a.kind === "detail" ? { from: a.from ?? "above" } : {}) };
  }
  views.push(view);
  let label = "";
  const made = await makeRevision({
    model,
    modelItem: d.model_item,
    title: last.input.title,
    project: d.project,
    client: d.client,
    finish: last.input.finish,
    ...(last.input.materials ? { materials: last.input.materials } : {}),
    notes: last.input.notes,
    views,
    text: (set) => {
      label = set.extras.find((x) => x.id === id)?.label ?? "View";
      return /drawn larger$/.test(label) ? label : `${label} added`;
    },
    drawing: d,
    persist: turn.persist,
  });
  const x = made.set.extras.find((e) => e.id === id);
  if (!x || !x.sheet) return { error: "That view couldn't be drawn from this model." };
  const it = itemFor(turn, made.drawing, made.rev.rev, true, x.sheet);
  return {
    shown: it.id,
    number: made.drawing.number,
    revision: made.rev.rev,
    added: x.label,
    sheet: x.sheet,
    of: made.set.sheets.length,
    note: made.rev.text,
    say: "It's up on that sheet. Say in one sentence what was added and which sheet it's on.",
  };
}

/** Take a view he asked for off (19.3.1): by its name ("section D", "detail F", "the 3D view") or the last one added. */
export async function removeDrawingView(turn: TurnInfo, a: { drawing?: string; view: string }) {
  const d = drawingFor(turn, a.drawing);
  if ("error" in d) return { error: d.error };
  const last = revisionsOf(d.id).at(-1)!;
  const views = [...(last.input.views ?? [])];
  if (!views.length) return { error: `${d.number} has no added views; its standard sheets stay.` };
  // what each is called on the drawing now
  const set = makeSet({ model: last.model, title: last.input.title, number: d.number, revision: last.rev, status: last.status, revisions: [{ rev: last.rev, date: last.date, text: last.text, by: "LH" }], project: d.project, client: d.client, drawn: "LH", date: last.date, views });
  const labels = views.map((v) => set.extras.find((x) => x.id === v.id)?.label ?? "");
  const w = a.view.trim().toLowerCase();
  let at = /\b(last|latest|that one|the one you just added)\b/.test(w) ? views.length - 1 : labels.findIndex((l) => l && (l.toLowerCase() === w || new RegExp(`\\b${w.replace(/[^a-z0-9 ]/g, "").replace(/^(section|detail|3d view) /, "")}\\b`).test(l.toLowerCase())));
  if (at < 0 && /\b3d\b/.test(w)) at = labels.findIndex((l) => /^3D view/.test(l));
  if (at < 0) return { error: `There's no added view "${a.view}" on ${d.number}. The added views are: ${labels.filter(Boolean).join(", ")}.` };
  const label = labels[at];
  views.splice(at, 1);
  const made = await makeRevision({
    model: last.model,
    modelItem: d.model_item,
    title: last.input.title,
    project: d.project,
    client: d.client,
    finish: last.input.finish,
    ...(last.input.materials ? { materials: last.input.materials } : {}),
    notes: last.input.notes,
    views,
    text: /drawn larger$/.test(label) ? label.replace(/drawn larger$/, "back to its size") : `${label} taken off`,
    drawing: d,
    persist: turn.persist,
  });
  const it = itemFor(turn, made.drawing, made.rev.rev);
  return { shown: it.id, number: made.drawing.number, revision: made.rev.rev, removed: label, note: made.rev.text, say: "Say in one sentence what was taken off." };
}

const STATUS = ["PRELIMINARY", "FOR APPROVAL", "FOR CONSTRUCTION"] as const;

type AddedArgs = { drawing?: string; sheet: number; view: string };
export type DimensionArgs = AddedArgs & { from: FeatureRef; to: FeatureRef; label?: string; side?: Side };
export type NoteArgs = AddedArgs & { at: FeatureRef; text: string };

/** Keep the earlier issues and show the changed sheet, using the same ownership check as added views. */
async function changeAdded(turn: TurnInfo, a: { drawing?: string; sheet: number }, change: (additions: Added[]) => { additions: Added[]; id: string; text: string }) {
  const d = drawingFor(turn, a.drawing);
  if ("error" in d) return { error: d.error };
  const last = revisionsOf(d.id).at(-1)!;
  if (!Number.isInteger(a.sheet) || !last.sheets[a.sheet - 1]) return { error: `${d.number} has ${last.sheets.length} sheets; choose one from 1.` };
  try {
    const changed = change([...(last.input.additions ?? [])]);
    const made = await makeRevision({ model: last.model, modelItem: d.model_item, title: last.input.title, project: d.project, client: d.client, finish: last.input.finish, materials: last.input.materials, notes: last.input.notes, views: last.input.views, additions: changed.additions, text: changed.text, drawing: d, persist: turn.persist });
    const it = itemFor(turn, made.drawing, made.rev.rev, true, a.sheet);
    return { shown: it.id, number: d.number, revision: made.rev.rev, sheet: a.sheet, id: changed.id, note: changed.text };
  } catch (e) {
    if (e instanceof AddedError) return { error: e.message, ...(e.choices ? { choices: e.choices } : {}) };
    throw e;
  }
}

export const addDimension = (turn: TurnInfo, a: DimensionArgs) => changeAdded(turn, a, (additions) => {
  const id = `a${randomUUID().replaceAll("-", "")}`;
  return { additions: [...additions, { id, kind: "dimension", sheet: a.sheet, view: a.view, from: a.from, to: a.to, label: a.label, side: a.side }], id, text: `Size added on sheet ${a.sheet}` };
});

export const addNote = (turn: TurnInfo, a: NoteArgs) => changeAdded(turn, a, (additions) => {
  const id = `a${randomUUID().replaceAll("-", "")}`;
  return { additions: [...additions, { id, kind: "note", sheet: a.sheet, view: a.view, at: a.at, text: a.text }], id, text: `Note added on sheet ${a.sheet}` };
});

export const removeAdded = (turn: TurnInfo, a: { drawing?: string; sheet: number; id: string }) => changeAdded(turn, a, (additions) => {
  const found = additions.find((x) => x.sheet === a.sheet && x.id === a.id);
  if (!found) throw new AddedError(`There is no addition ${a.id} on sheet ${a.sheet}. Use look_at_drawing to see its additions and their ids.`);
  return { additions: additions.filter((x) => x !== found), id: found.id, text: `${found.kind === "note" ? "Note" : "Size"} removed, sheet ${a.sheet}` };
});

const featureRef = z.object({ part: z.number().int().positive(), feature: z.string().regex(/^(left|right|top|bottom|centre|hole:[1-9]\d*|cut:[1-9]\d*|corner:(tl|tr|bl|br))$/) });
const addedWhere = { drawing: z.string().optional(), sheet: z.number().int().min(1).max(40), view: z.string().min(1).max(40) };

export const shopTools = (ctx: TurnCtx) =>
  testSafe(
    ctx,
    [
      tool("add_dimension", "Add one dimension to a drawing view. Name the part marks and their features, never page positions or a measurement. The number is measured from the model; label adds words after it. Hole and cut numbers start at one, counted separately. Use look_at_drawing for view names. If a mark repeats in the assembly, use its part view or a section showing one copy.",
        { ...addedWhere, from: featureRef, to: featureRef, label: z.string().max(40).optional(), side: z.enum(["above", "below", "left", "right"]).optional() },
        async (a) => json(await addDimension(ctx.turn, a))),
      tool("add_note", "Add a leader note pointing to a part feature in a drawing view. One line, up to 80 characters. The change makes a new revision and is refused if it cannot fit clearly.",
        { ...addedWhere, at: featureRef, text: z.string().trim().min(1).max(80) },
        async (a) => json(await addNote(ctx.turn, a))),
      tool("remove_added", "Remove one added dimension or note from a sheet by its id from look_at_drawing. Makes a new revision and keeps earlier issues.",
        { drawing: z.string().optional(), sheet: z.number().int().min(1).max(40), id: z.string().min(1).max(60) },
        async (a) => json(await removeAdded(ctx.turn, a))),
      tool(
        "make_shop_drawing",
        "Draw up shop drawings from a 3D model you've made (joint_model or show_model): a numbered A3 set (a general " +
          "arrangement, each part, sections through the joints, the parts schedule), as PDF and DXF. model: the model's item " +
          "id (default: the one on their screen). It needs who it's for, the job and what it's made of: give what you know " +
          "from the conversation; if it says what's missing, ask only what you can't tell, in one question. To reissue after changing the model: change the model (replaces), then call this again with " +
          "drawing: its number and change: one line saying what changed ('Top 50 wider'); that makes the next revision and " +
          "keeps the earlier one. Look at the sheets (look_at_drawing) before you say it's done.",
        {
          model: z.string().optional(),
          drawing: z.string().optional().describe("The number of a drawing this is the next revision of"),
          title: z.string().max(80).optional().describe("e.g. 'Household cabinet'"),
          project: z.string().max(80).optional().describe("The job, e.g. 'Household project'"),
          client: z.string().max(80).optional(),
          finish: z.string().max(80).optional().describe("As they said it, e.g. '2 coats clear satin' (else TBC)"),
          materials: z
            .record(z.string().max(40), z.string().max(48))
            .optional()
            .describe('What it\'s made of as they\'d order it, e.g. {"all": "Tas oak, DAR"} or {"carcass": "18 HMR melamine, white", "back": "6 MDF"}: keyed by a part\'s name, a kind from the model (hardwood, pine, ply, mdf, steel) or "all"'),
          asked: z.boolean().optional().describe("true once you've used what they said (or asked): draw with that, TBC for the rest"),
          notes: z.array(z.string().max(160)).max(5).optional().describe("Extra notes for the drawing, e.g. a span table a size came from"),
          change: z.string().max(60).optional().describe("What changed, for the revision table"),
        },
        async (a) => {
          const r = await makeShopDrawing(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
      tool(
        "show_shop_drawing",
        "Put a shop drawing on their screen: by its number or words from its title, job or client ('the Household cabinet'); rev for " +
          "an earlier revision. With no words, or when several match, it shows the list of drawings by job with their revisions.",
        { query: z.string().optional(), rev: z.string().optional() },
        async (a) => {
          const r = showShopDrawing(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
      tool(
        "look_at_drawing",
        "See shop drawing sheets the way they'll print (A3), as pictures made here, so you can check what you drew before you " +
          "call it done: every part sized, the joints shown and readable, nothing missing, overlapping or crowded. drawing: its " +
          "number (default: the one on their screen, or the one you made this turn); sheets: which ones, from 1 (default the " +
          "first four); box: with one sheet, [x0, y0, x1, y1] as fractions of the sheet to look closer at part of it.",
        {
          drawing: z.string().optional(),
          sheets: z.array(z.number().int().min(1).max(40)).min(1).max(6).optional(),
          box: z.array(z.number().min(0).max(1)).length(4).optional(),
        },
        async (a) => {
          const made = [...ctx.turn.items].reverse().map((id) => getItem(id)).find((it) => it?.kind === "shopdrawing");
          let d: Drawing | { error: string } = a.drawing ? drawingFor(ctx.turn, a.drawing, true) : made?.kind === "shopdrawing" ? (getDrawing(made.payload.drawing_id) ?? { error: "That drawing isn't kept any more." }) : drawingFor(ctx.turn, undefined, true);
          if ("error" in d) return err(d.error);
          d = d as Drawing;
          const refusal = drawingAccess(ctx.turn, d, true);
          if (refusal) return err(refusal);
          const rev = revisionsOf(d.id).at(-1)!;
          const want = (a.sheets ?? Array.from({ length: Math.min(4, rev.sheets.length) }, (_, i) => i + 1)).filter((n) => n <= rev.sheets.length);
          if (!want.length) return err(`${d.number} ${rev.rev} has ${rev.sheets.length} sheets.`);
          const box = a.box && want.length === 1 && a.box[2] > a.box[0] && a.box[3] > a.box[1] ? (a.box as [number, number, number, number]) : undefined;
          const pics: { n: number; png: Buffer }[] = [];
          for (const n of want) {
            const png = await sheetPicture(d.id, rev.rev, n, box ? 1600 : 2048, box);
            if (png) pics.push({ n, png });
          }
          if (!pics.length) return err("The sheets couldn't be drawn just now.");
          const titles = pics.map((p) => `sheet ${p.n} of ${rev.sheets.length}: ${rev.sheets[p.n - 1]?.title ?? ""}. Views: ${rev.sheets[p.n - 1]?.views?.map((v) => `${v.id} ${v.title}`).join(", ") ?? "reissue this drawing to list its view names"}. Additions: ${addedText(rev.input.additions ?? [], p.n)}`.trim());
          return {
            content: [
              { type: "text" as const, text: `${d.number} revision ${rev.rev}, ${titles.join("; ")}${box ? ` (closer: ${box.join(", ")})` : ""}. Look for what a maker would need and can't find.` },
              ...pics.map((p) => ({ type: "image" as const, data: p.png.toString("base64"), mimeType: "image/png" })),
            ],
          };
        },
      ),
      tool(
        "set_drawing_status",
        "Mark a shop drawing PRELIMINARY, FOR APPROVAL or FOR CONSTRUCTION, when they ask. It makes the next revision (the first " +
          "issue for approval is revision A) with the status on every sheet, and keeps the earlier ones. No drawing: the one on " +
          "their screen.",
        { drawing: z.string().optional(), status: z.enum(STATUS), note: z.string().max(60).optional().describe("For the revision table; default 'Issued for approval' etc.") },
        async (a) => {
          const r = await setDrawingStatus(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
      tool(
        "set_drawing_details",
        "Set what goes in the shop drawings' title block, when they tell you: company (the business name), line (one line " +
          "under it, e.g. a phone number or licence), logo (a PNG or JPEG file's path) and drawn_by (initials). null clears " +
          "one ('take the company name off'). Nothing is needed: with no company the project leads the title block. It's " +
          "kept for later drawings; one already made picks it up on its next revision.",
        { company: z.string().max(80).nullable().optional(), line: z.string().max(80).nullable().optional(), logo: z.string().max(500).nullable().optional(), drawn_by: z.string().max(6).nullable().optional() },
        async (a) => {
          const r = setDrawingDetails(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
      tool(
        "add_drawing_view",
        "Add a view to a shop drawing when they ask to see how something is made or for more detail, rather than describing " +
          "it: kind 'section' (part: the part to cut through, e.g. 'that shelf'; no part: through the middle of the whole " +
          "piece; way: across (default) or along), 'detail' (parts: the two parts that meet, e.g. ['back', 'side']; from: the " +
          "side it's seen from, e.g. 'above'), 'bigger' (detail: its letter, or 'that' for the one on their screen; or parts) " +
          "or '3d' (parts: which, none for the whole piece; apart: true to pull it apart). It's kept with the drawing for " +
          "every reissue, makes the next revision with a note ('Section D-D added') and puts that sheet up. If it says ask, " +
          "ask which they mean, naming the candidates; don't guess. Then say in one sentence what was added and on which sheet.",
        {
          drawing: z.string().optional().describe("The drawing's number; default the one on their screen"),
          kind: z.enum(["section", "detail", "bigger", "3d"]),
          part: z.string().max(60).optional(),
          way: z.enum(["across", "along"]).optional(),
          parts: z.array(z.string().max(60)).max(4).optional(),
          detail: z.string().max(20).optional(),
          from: z.enum(["above", "below", "front", "back", "left", "right"]).optional(),
          apart: z.boolean().optional(),
        },
        async (a) => {
          const r = await addDrawingView(ctx.turn, a);
          return "error" in r && r.error ? err(r.error) : json(r);
        },
      ),
      tool(
        "remove_drawing_view",
        "Take a view they asked for off a shop drawing: view is its name on the drawing ('section D', 'detail F', 'the 3D " +
          "view') or 'last' for the one added last. Makes the next revision with a note. The standard sheets always stay.",
        { drawing: z.string().optional(), view: z.string().max(40) },
        async (a) => {
          const r = await removeDrawingView(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
      tool(
        "export_shop_drawing",
        "Get a shop drawing's file for them: as 'pdf' (the set), 'dxf' (the drawing at 1:1 for CAD) or 'parts' (one DXF outline " +
          "per part for a CNC shop). It puts the drawing on their screen; its Share button sends the file from their phone, on " +
          "their tap only. You don't send it.",
        { drawing: z.string().optional(), rev: z.string().optional(), as: z.enum(["pdf", "dxf", "parts"]).optional() },
        async (a) => {
          const r = exportShopDrawing(ctx.turn, a);
          return "error" in r ? err(r.error!) : json(r);
        },
      ),
    ],
    // Showing only reads. Making and issuing write files: on a test turn only in dev (the dev data folder), and never the database.
    // Setting the details on a test turn keeps them for that run only, never the settings.
    ["show_shop_drawing", "look_at_drawing", "set_drawing_details", ...(DEV ? ["make_shop_drawing", "set_drawing_status", "export_shop_drawing", "add_drawing_view", "remove_drawing_view"] : [])],
  );

export const makeShopServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "shop", version: "0.1.0", alwaysLoad: true, tools: shopTools(ctx) });
