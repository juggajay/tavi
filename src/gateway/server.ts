import { earlier } from "../shared/earlier.js";
import { isAgentRequest } from "../browser/sites.js";
// Gateway for the voice spike: serves the avatar app, creates gpt-live-1 voice sessions,
// turns voice delegations into brain requests, and pushes subtitles/cards to the app.
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createLiveSession, PHOTO_VOICE_LINE, Sideband, SITDOWN_OVER_LINE, SITDOWN_VOICE_LINE, SKETCH_VOICE_LINE, type LiveEvent } from "./live.js";
import { VoiceCall, type Answer, type HandOver } from "./voiceCall.js";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { brainInfo, mindRecord, readThisTurn, RECENT, refreshConnectors, resetConversation, think, warmUp, type BrainResult } from "../brain/brain.js";
import { connectorStates, setPermission } from "../connectors/claudeai.js";
import { describeControls } from "../proactive/followups.js";
import { assistantName, decideHeld, describeHeld, heldWrites, ownerNames, readSoul, readUser, recentProfileChanges, saveSoul, saveUserFile, setAssistantName, SOUL_CAP, USER_CAP } from "../profile/profile.js";
import { namesLine, voiceCard } from "../profile/voiceCard.js";
import { pendingOffers, recentConversation, runKeeper, scheduleKeeper } from "../memory/keeper.js";
import { openerFor } from "../memory/opener.js";
import { addSite, AGENT_HEADER, browserBusy, listSites, removeSite } from "../browser/sites.js";
import { liveHost, watchBrowser, type InputEvent } from "../browser/host.js";
import { browserQueue, SHOTS_DIR } from "../browser/worker.js";
import { expireLogins, forgetAllLogins, forgetLogin, openLoginWindow } from "../browser/login.js";
import { DATA_DIR, db, nowIso } from "../store/db.js";
import { DEV, devAllows } from "../dev.js";
import { DIST, appFile, serveApp, pageHeaders, entryPage } from "./static.js";
import { tryFastPath } from "./fastpath.js";
import { bareGreeting } from "./greeting.js";
import { getDoc, startFileWatcher } from "../files/library.js";
import { startReferenceShelf } from "../reference/library.js";
import { bookPage, refInfo, refPageImage, refTile, warmRef } from "../reference/pages.js";
import { fileImage } from "../brain/fileTools.js";
import { ownerPageTurn, savePage } from "../brain/pageTools.js";
import { fileMeta } from "../hq/ownership.js";
import { docPart } from "../files/library.js";
import { handleModelPicture, handleModelUpload, handlePictureUpload, handleV2 } from "./api-v2.js";
import { handleShortcut, saveAttachment, shortcutRequest, type ShortcutTurn } from "./shortcut.js";
import { handleShopRoute } from "../drawings/shop.js";
import { describeScreen } from "./surface.js";
import { uiBuild } from "./build.js";
import { addClient, clientById, clients, toAll, toClient, toEach, toKind } from "./clients.js";
import { createItem, findItems, getItem, publishItem, recentItems, shownToday, touchItem, updateItem } from "../store/items.js";
import { addPin, expirePins, getPin, listPins, setPinPlace, unpin, unpinItem } from "../store/pins.js";
import { newTurn, type TurnInfo } from "../brain/turn.js";
import { cropSheet, describeSheet, findSheet, locate } from "../drawings/library.js";
import { PAGE_WIDTHS, pageImage, sheetById, sheetInfo, startCacheJanitor, tile, warm } from "../drawings/tiles.js";
import type { Box, DraftPayload, Item } from "../shared/protocol.js";
import { getSettings, SettingsError, uiSettings, updateSettings, type Settings } from "../store/settings.js";
import type { ClientKind, Origin, ScreenState } from "../shared/protocol.js";
import { beginTurn, rowsShown, cardShown, endTurn, noticeCard, recentCards, reopenCard, shownThisTurn } from "../store/cards.js";
import { disconnectAccount, finishGoogleAuth, googleConfigured, listAccounts, setGoogleClient, startGoogleAuth } from "../connectors/google.js";
import { buildContext } from "../brain/context.js";
import { SPOKEN_AFTER_HANDOVER } from "../brain/rules.js";
import { adequacyClaim, RESAY, withoutClaimSentences } from "../brain/claims.js";
import { limitIn, limitSentence } from "../brain/limit.js";
import { SpokenPieces } from "../brain/spoken.js";
import { sitdownOn } from "../memory/sitdown.js";
import { onScheduler, startScheduler } from "../proactive/scheduler.js";
import { addChannel, deliverDue, listWaiting, markSeen, queueNotification, setBundlePush } from "../proactive/notify.js";
import { pushDeviceCount, pushToAll, saveSubscription, setPushSubject, vapidPublicKey } from "../proactive/push.js";
import { runRoutine } from "../proactive/scheduler.js";
import { bus } from "../events.js";
import { cropPath, DRAWINGS_DIR, listProjects, listSheets, startDrawingWatcher } from "../drawings/library.js";
import { activeMemories, allSettings, forget, getRoutine, listCommitments, listRoutines, notificationRules, setRoutineStatus, setSetting, updateCommitment, getSetting } from "../store/proactive.js";

const execFileP = promisify(execFile);
import { audit, logConversation } from "../store/log.js";
import { createJob, failJob, finishJob, recoverJobs, startJob } from "../store/jobs.js";
import { cancelJob, onStop, requeueInterruptedTasks, turnFinished } from "../brain/tasks.js";
import { decide, onBrokerEvent, pendingApprovals, recoverActions, expireDue, reviseEmailApproval, type ApprovalView } from "../broker/broker.js";
import { helperUpgrade } from "../remote/hub.js";
import { recoverCutOff, startBrainWatch } from "../brainlink/boot.js";
import { createRoundTable, TABLE_VOICE_LINE } from "./roundTable.js";
import { clipFor, fakeVoices, RATE, realtimeVoices } from "../guest/voice.js";
import { guestConfig } from "../guest/guest.js";
import { voiceSaidNote } from "./promises.js";
import type { Hq } from "../hq/hq.js";

let hq: Hq | undefined;
if (process.env.LH_V3 === "1") {
  try { hq = await (await import("../hq/hq.js")).startHq(); }
  catch { console.warn("The bot team could not start. The safety switch is still available."); }
}
let callBot: string | undefined;
/** The bot whose voice the live call was opened with. Its own answers are spoken by the call's voice itself. */
let callVoiceBot: string | undefined;

/* ---------- boot: anything left mid-flight by a previous run is marked, never silently re-run ---------- */
const interruptedJobs = recoverJobs();
const unknownActions = recoverActions();
// Background tasks cut off early are tried once more; older ones become an offer to start again.
for (const t of requeueInterruptedTasks().givenUp)
  queueNotification({ title: t.title, spoken: `I got cut off part-way through "${t.title}". Want me to start again?`, priority: "normal", source: `task:${t.id}` });
audit("system", "boot", null, { interrupted_jobs: interruptedJobs.length, unknown_actions: unknownActions.length });
const bootNotice = unknownActions.length
  ? "Heads up: I restarted in the middle of sending something, so I'm not sure it went. I won't resend it. Check your sent items."
  : interruptedJobs.length
    ? "I restarted while I was working on something. Ask me again if you still need it."
    : "";

const PORT = Number(process.env.PORT ?? 3077);
const HOST = process.env.HOST ?? "127.0.0.1";
const VOICE = process.env.LIVE_VOICE || "marin";
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web");
const openaiKey = () => (process.env.LH_NO_VOICE === "1" ? "" : (process.env.OPENAI_API_KEY ?? "").trim()); // dev runs without voice unless asked

/* ---------- app clients: v1 (the original phone page) and v2 (phone and desktop apps), see clients.ts ---------- */
/** The client that started the current voice session (POST /api/session client_id); voice turns are tagged with it. */
let voiceOwner: string | null = null;
const voiceOrigin = (): Origin => {
  const c = voiceOwner ? clientById(voiceOwner) : undefined;
  return c && c.v === 2 ? { client: c.kind, id: c.id } : { kind: "voice" };
};

/* ---------- conversation state for one voice session (the call itself: voiceCall.ts) ---------- */
const live = {
  sideband: undefined as Sideband | undefined,
  recent: [] as string[], // short rolling context: "User: …" / "Assistant: …"
};

function remember(line: string) {
  live.recent.push(line);
  if (live.recent.length > 8) live.recent.shift();
}

const call = new VoiceCall({
  ...(process.env.LH_V3 === "1" ? {
    bot: () => callBot,
    // (The usual "still looking" lines during a long wait are back on: the call's own voice speaks again.)
    deliver: async (text: string, ref: string | null, signal: AbortSignal) => {
      let workBot = ref ? (await import("../brain/tasks.js")).jobBot(ref) : null;
      if (ref?.startsWith("routine:")) {
        const routine = getRoutine(ref.slice("routine:".length));
        workBot = routine ? (await import("../hq/proactive.js")).withRoutineBot(routine).bot ?? null : null;
      }
      if (ref?.startsWith("commitment:")) workBot = hq?.members().find((b) => b.lead)?.id ?? null;
      const bot = hq?.pick("", workBot ?? callBot).bot;
      // The owner's first real calls on the team (18 and 19 November): every answer went to the phone as a separately made
      // recording, the call's own voice stayed silent, and the phone never played the recordings outside a room. He saw
      // the words and heard nothing; each answer then waited up to a minute for the one before to "finish". The bot the
      // call was opened with speaks through the call's own voice, as the assistant always has: it starts sooner, he can
      // talk over it, and it says it is still looking. A recording is only for another bot's words in that bot's voice.
      if (!bot || bot.id === callVoiceBot) return false;
      return "sayBot" in table ? table.sayBot(bot, text, voiceOwner, signal) : false;
    },
  } : {}),
  answer: (t) => answerHandOver(t),
  cancel: (jobId) => void cancelJob(jobId, "user"),
  remember,
  sitdown: sitdownOn,
  // Stage 18: at a round table (and for the words that start one) the gateway acts on his words itself, hand-over or not
  table: () => table.on,
  startsTable: (text) => !table.on && table.wants(text),
  guest: () => guestConfig().name,
  echo: (text, heard) => table.echo(text, heard),
});

function onLiveEvent(e: LiveEvent) {
  if (e.type === "session.input_transcript.delta") hq?.seen();
  call.onEvent(e);
  switch (e.type) {
    case "session.closed":
      console.log("[live] session closed", JSON.stringify(e).slice(0, 300));
      toAll({ type: "live", state: "closed" });
      endLive(e.usage, String(e.reason ?? "closed"));
      break;
    case "error":
      console.warn("[live] error", JSON.stringify(e).slice(0, 400));
      break;
  }
}

/* ---------- approvals: the broker talks to the app; outcomes are fed back to the brain and the voice ---------- */
/* Approvals as draft items (v2): the item is what the apps draw; the approval message (with the nonce) is what makes
   Send work. The original phone page gets the approval message exactly as before. */
const activeTurns = new Map<string, TurnInfo>(); // job id -> the turn in progress, so a draft opens where it was asked

function draftItemFor(approvalId: string): Item | null {
  const r = db.prepare("SELECT id FROM items WHERE kind = 'draft' AND json_extract(payload_json, '$.approval_id') = ?").get(approvalId) as { id: string } | undefined;
  return r ? getItem(r.id) : null;
}

function draftPayload(v: ApprovalView, status: DraftPayload["status"] = "pending"): DraftPayload {
  return {
    approval_id: v.id,
    operation: v.operation,
    account: v.account,
    to: v.to,
    cc: v.cc,
    subject: v.subject,
    body: v.body,
    summary: v.kind === "email" ? `Email to ${v.to.join(", ")}` : v.subject,
    details: v.rows ?? [],
    ...(v.image ? { image: v.image } : {}),
    editable: v.kind === "email",
    status,
  };
}

/** The draft item for a pending approval, made quietly if there isn't one (e.g. it was requested before a restart). */
function ensureDraftItem(v: ApprovalView): Item {
  return draftItemFor(v.id) ?? createItem(null, { kind: "draft", title: v.kind === "email" ? (v.subject || `Email to ${v.to.join(", ")}`) : v.subject, source: v.account, origin: "approval", payload: draftPayload(v) });
}

function settleDraft(approvalId: string, status: DraftPayload["status"], message?: string) {
  const it = draftItemFor(approvalId);
  if (!it) return null;
  updateItem(it.id, { payload: { status, ...(message ? { outcome_message: message } : {}) } });
  return it;
}

onBrokerEvent((e) => {
  if (e.type === "approval") {
    const v = e.approval;
    const title = v.kind === "email" ? (v.subject || `Email to ${v.to.join(", ")}`) : v.subject;
    let item = e.replaces ? draftItemFor(e.replaces) : null;
    if (item) {
      item = updateItem(item.id, { title, payload: draftPayload(v) as unknown as Record<string, unknown> });
      toEach((c) => (c.v === 2 ? { type: "approval_gone", id: e.replaces, item_id: item!.id, reason: "revised" } : null));
    } else {
      const jobId = (db.prepare("SELECT job_id FROM approvals WHERE id = ?").get(v.id) as { job_id: string | null } | undefined)?.job_id ?? null;
      const turn = (jobId && activeTurns.get(jobId)) || newTurn({ job_id: jobId });
      item = createItem(turn, { kind: "draft", title, source: v.account, origin: "approval", payload: draftPayload(v) });
      publishItem(item, turn, true, false);
    }
    toAll({ type: "approval", approval: { ...v, item_id: item?.id } }, { type: "approval", approval: v });
    return;
  }
  if (e.type === "expired") {
    const it = settleDraft(e.approvalId, "expired", "That one timed out. Ask me again and I'll redo it.");
    toEach((c) => (c.v === 2 ? { type: "approval_gone", id: e.approvalId, item_id: it?.id ?? null, reason: "expired" } : null));
    return;
  }
  toAll(e);
  if (e.type === "outcome") {
    const o = e.outcome;
    const op = (db.prepare("SELECT operation FROM approvals WHERE id = ?").get(o.approvalId) as { operation: string } | undefined)?.operation;
    const status: DraftPayload["status"] | null =
      o.status === "accepted" || o.status === "verified" ? (op === "email.send" ? "sent" : "done")
      : o.status === "rejected" ? "declined"
      : o.status === "expired" ? "expired"
      : o.status === "failed" || o.status === "unknown" ? "failed"
      : null; // refused: a wrong nonce or a second tap; the draft stays as it was
    if (status) settleDraft(o.approvalId, status, o.message);
    const note = `System: the user ${e.outcome.status === "rejected" ? "declined" : "acted on"} approval ${e.outcome.approvalId}. Result: ${e.outcome.message}`;
    remember(note);
    logConversation("system", "system", e.outcome.message);
    live.sideband?.send({ type: "session.instructions.append", delegation_id: null, content: `Status update for this conversation: ${e.outcome.message}` });
  }
});

/* ---------- brain queue: one request at a time for the spike ---------- */
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

/** test: a message from a test script; logged as such so the memory keeper and history never treat it as the user. */
// "Show me the door schedule", "where's that?", "pull up the plan"
const WANTS_TO_SEE = /\b(show (me|us)|let me see|let['’]s see|have a look|where(?:['’]s| is| are)|pull (it |that |them )?up|bring (it|that|them) up|put (it|that) (up|on))\b/i;
const SHOW_IT =
  "(Tavi, not the user) They asked to see it, but nothing is on their screen yet. Put it on screen: show_drawing at the " +
  "spot that proves your answer (one per sheet if it spans sheets), or show_list / show_table for rows. Then give your answer again in full.";

type Ask = {
  request: string;
  said: string;
  source: "voice" | "typed";
  test?: boolean;
  origin: Origin;
  requestId?: string;
  jobId?: string;
  bot?: string;
  /** The spoken answer so far, while it's being written (voice turns, Stage 10.5). */
  onSpoken?: (soFar: string) => void;
  /** Some of the answer has already been said (so a second pass mustn't change what's logged). */
  streamed?: () => boolean;
  /** The brain's own line of what it's doing now (its progress tool, not a tool's label): for the call's one filler. */
  onNote?: (line: string) => void;
};

/** v2 clients get the turn's ids and origin on every brain event; v1 clients get the event exactly as before. */
function brainEvent(a: Ask & { jobId: string }, v1: Record<string, unknown>, v2only: Record<string, unknown> = {}) {
  toAll({ ...v1, ...v2only, job_id: a.jobId, request_id: a.requestId, origin: a.origin }, v1);
}

/** What to tell the owner when the brain fails: a usage limit plainly, anything else as a snag. */
export function sayError(message: string) {
  // his plan's usage limit (Stage 21): what it is, when it resets if known, and that drafts and the screen still work
  const lim = limitIn(message);
  if (lim) return limitSentence(lim);
  if (/rate.?limit|quota|429|overloaded|credit balance/i.test(message)) return "I've hit my limit for now. Try again in a bit.";
  if (/brain is busy/i.test(message)) return "I'm still on the last one. Give me a sec.";
  return "Sorry, I hit a snag on that one. Try again?";
}

async function askBrain(ask: Ask): Promise<BrainResult | undefined> {
  const { request, said, source, test = false } = ask;
  const a = { ...ask, jobId: ask.jobId ?? createJob("ask", source, request) }; // queued until its turn comes
  const run = async () => {
    const jobId = a.jobId;
    startJob(jobId);
    brainEvent(a, { type: "brain", phase: "thinking", label: "Working on it", source });
    beginTurn(!test);
    const turn = newTurn({ job_id: jobId, origin: a.origin, persist: !test });
    activeTurns.set(jobId, turn);
    const steps: { tool: string; label: string; at: number }[] = [];
    const t0 = Date.now();
    const ac = new AbortController(); // "Stop" on the desktop, or "stop that"
    const unregister = onStop(jobId, () => ac.abort());
    try {
      const onProgress = (label: string, tool?: string) => {
        if (tool) steps.push({ tool, label, at: Date.now() });
        else if (label !== "Thinking") ask.onNote?.(label); // its own words (the progress tool), not a step label
        db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(label, jobId);
        // (own: its own words of what it's doing, Stage 21.3, as against a tool's step label)
        brainEvent(a, { type: "brain", phase: "thinking", label, source }, !tool && label !== "Thinking" ? { own: true } : {});
      };
      const voice = source === "voice";
      let res: BrainResult;
      if (process.env.LH_V3 === "1") {
        if (!hq) throw new Error("The bot team is not available.");
        const result = await hq.answer(said, { bot: a.bot ?? (voice ? callBot : undefined), via: voice ? "voice" : "client" in a.origin && a.origin.id.startsWith("shortcut:") ? "siri" : "typed",
          origin: a.origin, test, request, signal: ac.signal, onProgress, onSpoken: ask.onSpoken });
        res = { spoken: result.spoken, ms: Date.now() - t0 };
      } else res = await think(request, { onProgress, said, test, turn, voice, onSpoken: ask.onSpoken, signal: ac.signal, recent: (skip) => recentConversation(16, 6, skip, jobId) });
      // where the conversation's record stood at this answer: a piece of work started in this turn begins from here (21.3)
      turnFinished(jobId, mindRecord());
      // Asked to see a drawing and answered without one: one more go, so the drawing lands on the same card.
      if (process.env.LH_V3 !== "1" && WANTS_TO_SEE.test(said) && !turn.items.length && !shownThisTurn() && readThisTurn().includes("the drawings")) {
        const first = res;
        res = await think(SHOW_IT, { onProgress, test, turn, voice, said, signal: ac.signal }).catch(() => first);
        if (res !== first) Object.assign(res, { ms: first.ms + res.ms, costUsd: (first.costUsd ?? 0) + (res.costUsd ?? 0) });
        // The first answer was already being said: that's the answer (the second pass only put the drawing up).
        if (res !== first && ask.streamed?.()) res.spoken = first.spoken;
        audit("brain", "show_nudge", jobId, { shown: turn.items.length });
      }
      // A wall in code (Stage 21.2): no claim of structural adequacy reaches him. Asked for again once without it.
      if (process.env.LH_V3 !== "1" && !ask.streamed?.()) res = await withoutClaims(res, (p) => think(p, { onProgress, test, turn, voice, said, signal: ac.signal }), jobId);
      // v2 apps show items, not cards: a card with nothing else shown becomes a note (v1 still gets the card below).
      if (res.card && !turn.items.length) {
        try {
          publishItem(createItem(turn, { kind: "note", title: res.card.title, source: res.card.source, payload: { rows: res.card.rows } }), turn, true, false);
        } catch (err) {
          console.warn("[items] card not shown as a note:", err instanceof Error ? err.message : err);
        }
      }
      res.card = endTurn(res.card) ?? undefined; // the drawing it showed and its summary are one card
      finishJob(jobId, { spoken: res.spoken, card: res.card ?? null, ms: res.ms });
      const tools = steps.map((s, i) => ({ name: s.tool, label: s.label, ms: (steps[i + 1]?.at ?? Date.now()) - s.at }));
      db.prepare("UPDATE jobs SET summary = ? WHERE id = ?").run(JSON.stringify({ tools, ms: Date.now() - t0, model: process.env.LH_FAKE_BRAIN === "1" ? "fake" : (res.model ?? brainInfo.model) }), jobId);
      audit("brain", "answered", jobId, { ms: res.ms });
      logConversation("assistant", test ? "test" : source, res.spoken, jobId);
      if (!test) scheduleKeeper(); // once it goes quiet, keep what mattered
      console.log(`[brain] ${res.ms} ms${res.costUsd ? `, ~$${res.costUsd.toFixed(4)}` : ""}: ${res.spoken}`);
      activeTurns.delete(jobId);
      brainEvent(a, { type: "brain", phase: "done", spoken: res.spoken, card: res.card ?? null, source });
      return res;
    } catch (err) {
      activeTurns.delete(jobId);
      endTurn(null);
      turnFinished(jobId, null);
      if (ac.signal.aborted) {
        // Stopped on purpose: cancelJob has already marked the job. Nothing to report but that.
        brainEvent(a, { type: "brain", phase: "done", spoken: "Stopped.", card: null, source });
        return undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      failJob(jobId, message);
      audit("brain", "failed", jobId, { message });
      console.error("[brain] failed:", message);
      // the plan's limit: said in the thread too, so the PC's conversation shows it as well as the phone (Stage 21)
      if (limitIn(message)) logConversation("assistant", test ? "test" : source, sayError(message), jobId);
      brainEvent(a, { type: "brain", phase: "error", message, source }, { say: sayError(message) });
      return undefined;
    } finally {
      unregister();
    }
  };
  return process.env.LH_V3 === "1" ? run() : enqueue(run);
}

/**
 * A wall in code (Stage 21.2): an answer that says or implies something is structurally adequate, strong enough or
 * certified is asked for again once without the claim. If the second still claims it, the claiming sentences come out
 * and the plain line goes in. Logged either way (claim_resaid).
 */
async function withoutClaims(res: BrainResult, again: (prompt: string) => Promise<BrainResult>, jobId: string | null): Promise<BrainResult> {
  const claim = adequacyClaim(res.spoken);
  if (!claim) return res;
  const redo = await again(RESAY(claim)).catch(() => null);
  const fixed = !!redo && !adequacyClaim(redo.spoken);
  audit("brain", "claim_resaid", jobId, { claim: claim.slice(0, 200), fixed });
  if (fixed) return { ...redo!, ms: res.ms + redo!.ms, costUsd: (res.costUsd ?? 0) + (redo!.costUsd ?? 0) };
  return { ...res, spoken: withoutClaimSentences(res.spoken) };
}

/* ---------- the round table (Stage 17): a second assistant, the guest, brought in when the owner asks ---------- */
/** One of the assistant's turns at the round table: the brain, in the same queue as every other request. Its words. */
function tableThink(a: { request: string; said: string; test: boolean; voice: boolean; origin: Origin | null; clientId: string | null; outside: boolean; signal: AbortSignal; task: string; tableId: string }) {
  return enqueue(async () => {
    if (a.signal.aborted) return null;
    const turn = newTurn({ job_id: null, origin: a.origin, persist: !a.test });
    beginTurn(!a.test);
    try {
      const opts = { said: a.said, test: a.test, turn, voice: a.voice, signal: a.signal, outside: a.outside ? "the round table's guest" : undefined };
      const res = await withoutClaims(await think(a.request, { ...opts, recent: (skip) => recentConversation(16, 6, skip) }), (p) => think(p, opts), null);
      if (res.card && !turn.items.length) publishItem(createItem(turn, { kind: "note", title: res.card.title, source: res.card.source, payload: { rows: res.card.rows } }), turn, true, false);
      audit("brain", "table_turn", a.tableId, { task: a.task, ms: res.ms, model: res.model ?? null });
      return res.spoken;
    } catch (err) {
      if (!a.signal.aborted) audit("brain", "table_failed", a.tableId, { task: a.task, message: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      endTurn(null);
    }
  });
}
const table = createRoundTable({
  ...(process.env.LH_V3 === "1" ? { rooms: {
    members: () => hq?.members() ?? [],
    askRoom: async (ids: string[], ask: import("../hq/turns/index.js").Ask, signal?: AbortSignal) => {
      if (!hq) throw new Error("The bot team is not available.");
      const answers = [];
      for (const bot of ids) answers.push({ bot, result: await hq.room(bot, ask, signal) });
      return answers;
    },
    stop: (id: string) => hq?.turns.stop(id),
  } } : {}),
  think: tableThink,
  context: (said, clientId) => buildContext(said, clientId ? describeScreen(clientId) : undefined),
  toApps: (m) => toEach((c) => (c.v === 2 ? m : null)),
  // (the call's own link: the same socket as live.sideband on a real call, and a scripted one in the tests)
  callOn: () => call.live,
  instruct: (content) => void call.send({ type: "session.instructions.append", delegation_id: null, content }),
  note: (title, text, o) => {
    const turn = newTurn({ origin: o.origin, persist: !o.test });
    // a short note, or (everything sent to the guest can be long) a page of text, as a file it read is shown
    const item = text.length <= 4000
      ? createItem(turn, { kind: "note", title, source: o.source, payload: { rows: [], text } })
      : createItem(turn, { kind: "doc", title, source: o.source, payload: { file_id: "round-table", name: title, part_label: o.source, text: text.slice(0, 200_000), more: false } });
    publishItem(item, turn, true, false);
  },
  notify: (title, spoken) => {
    queueNotification({ title, spoken, priority: "normal", source: "table" });
    void deliverDue(new Date());
  },
  // by voice (17.3): the lines are made into speech here and said by the app on the call, Pebble in the call's voice
  toClient: (id, m) => toClient(id, m),
  voices: () => (DEV && process.env.LH_FAKE_TTS === "1" ? fakeVoices() : openaiKey() ? realtimeVoices(openaiKey) : DEV ? fakeVoices() : null),
  pebbleVoice: () => VOICE,
  muteCall: (muted) => muteCallVoice(muted),
  timeline: () => call.timeline,
});

/** While a round table is on (Stage 18.1) the device mutes the call's own voice: the table's lines are played by the
 * app, so he never hears the call's voice say anything there. What it does say meanwhile is recorded as unheard. */
function muteCallVoice(muted: boolean) {
  call.muted = muted && call.live;
  toEach((c) => (c.v === 2 ? { type: "call_voice", muted } : null));
}

/* ---------- Siri and the Action Button (Stage 14.3): a Shortcut's message is the owner's own turn ---------- */
const shortcutTurns: ShortcutTurn = {
  run: (m) => {
    const said = m.text || (m.shared ? "(shared something from another app)" : "(sent a file)");
    const jobId = createJob("ask", "siri", said);
    logConversation("user", m.test ? "test" : "siri", said, jobId);
    if (!m.test) remember(`User (by Siri): ${said}`);
    // its own origin: what it shows is kept and sent to the apps, but pops up on no screen
    const origin: Origin = { client: "phone", id: `shortcut:${m.device}` };
    const request = shortcutRequest(m, buildContext(said), RECENT);
    db.prepare("UPDATE jobs SET request = ? WHERE id = ?").run(request, jobId);
    const done = askBrain({ request, said, source: "typed", test: m.test, origin, jobId }).then((r) => {
      if (r && !m.test) remember(`Assistant (backend result): ${r.spoken}`);
      return r ? { spoken: r.spoken } : undefined;
    });
    return { jobId, done };
  },
  push: (title, body, opts) => pushToAll(title, body, opts),
  save: saveAttachment, // the apps' own upload paths: a photo into photos/<day>/, a PDF into the drawings inbox
  waitSeconds: () => getSettings()["shortcut.wait_s"],
};

/** A hand-over from the voice (voiceCall.ts has already logged the words and made the job): screen commands at once,
 * everything else to the brain. The answer goes back to the voice from voiceCall.ts. */
async function answerHandOver({ delegationId, utterance, jobId, corrects, speak, note, by, voiceSaid, heard }: HandOver): Promise<Answer> {
  hq?.seen();
  const switched = !table.on && hq?.switchCall(utterance);
  if (switched) {
    callBot = switched.id;
    hq?.callChanged(switched.id);
    audit("voice", "call.bot", delegationId, { bot: switched.id, voice: switched.voice, at_ms: call.timeline });
    if (/^\s*let me talk to\b/i.test(utterance)) return { spoken: `${switched.name} here.`, fast: true };
    utterance = utterance.trimStart().slice(switched.name.length).replace(/^[\s,:]+/, "");
  }
  // Screen commands ("zoom out", "next one", "clear") are done at once, without the brain.
  const owner = voiceOrigin();
  const ownerId = "client" in owner ? owner.id : null;
  const fast = ownerId && utterance ? await tryFastPath(utterance, ownerId, owner, callBot) : null;
  if (fast) {
    toAll({ type: "heard", text: utterance, job_id: null }, { type: "heard", text: utterance });
    toAll({ type: "brain", phase: "done", spoken: fast.spoken, source: "voice", job_id: null, origin: owner, fast: true }, null);
    logConversation("assistant", "voice", fast.spoken);
    audit("voice", "fast_path", delegationId, { utterance, did: fast.did });
    return { spoken: fast.spoken, fast: true };
  }
  // A bare hello on a team call is answered at once (greeting.ts): the voice hands every line over, and a whole bot's
  // turn for "hello" kept the owner waiting about ten seconds at the start of a call.
  const hello = process.env.LH_V3 === "1" && !by && !corrects && !table.on ? bareGreeting(utterance, hq?.members().find((b) => b.id === callBot)?.name) : null;
  if (hello) {
    toAll({ type: "heard", text: utterance, job_id: null }, { type: "heard", text: utterance });
    toAll({ type: "brain", phase: "done", spoken: hello, source: "voice", job_id: null, origin: owner, fast: true }, null);
    logConversation("assistant", "voice", hello);
    finishJob(jobId, { spoken: hello });
    audit("voice", "fast_path", delegationId, { utterance, did: "greeting" });
    return { spoken: hello, fast: true };
  }
  // The round table (Stage 17): on, or these words bring the guest in. It says its own lines; the voice is closed quietly.
  if (utterance && table.wants(utterance)) return table.handOver(utterance, { origin: owner, clientId: ownerId, jobId, heard });
  const request = [
    `Context:\n${buildContext(utterance, ownerId ? describeScreen(ownerId) : undefined)}`,
    `Recent conversation:\n${RECENT}`,
    SPOKEN_AFTER_HANDOVER,
    ...(corrects ? [`Just before this they asked "${corrects}". That hasn't been answered, and won't be on its own: this may correct it or add to it. Answer them as one.`] : []),
    // Stage 18.2: the voice answered by itself and didn't hand it over; the gateway did
    ...(by && voiceSaid ? [voiceSaidNote(voiceSaid)] : []),
    `The user said (by voice, transcribed, may contain errors): "${utterance || "(transcript missing)"}"`,
  ].join("\n\n");
  db.prepare("UPDATE jobs SET request = ? WHERE id = ?").run(request, jobId);
  toAll({ type: "heard", text: utterance, job_id: jobId }, { type: "heard", text: utterance });
  // The answer a sentence at a time while it's written (Stage 10.5), only with LH_VOICE_STREAM=1: each whole sentence,
  // cleaned and without a leading "okay", goes to the voice as soon as it's there. Off by default (10.5b): in dev it
  // saved 0.1 to 0.7 s, and the voice dropped most of the last sentence of 2 answers in 29 sent in parts (0 in 33 sent
  // whole).
  const pieces = speak && process.env.LH_V3 !== "1" && process.env.LH_VOICE_STREAM === "1" ? new SpokenPieces({ question: utterance, names: ownerNames(), emit: speak, voice: true }) : null;
  const res = await askBrain({
    request,
    said: utterance,
    source: "voice",
    origin: voiceOrigin(),
    jobId,
    onNote: note,
    ...(pieces ? { onSpoken: (soFar: string) => pieces.update(soFar), streamed: () => pieces.pieces.length > 0 } : {}),
  });
  pieces?.close();
  if (res) return { spoken: res.spoken };
  // the plan's limit: the voice says what it is in one sentence, not "Sorry, I couldn't get that done" (Stage 21)
  const failed = (db.prepare("SELECT error FROM jobs WHERE id = ?").get(jobId) as { error: string | null } | undefined)?.error;
  return limitIn(failed) ? { spoken: sayError(failed!) } : null;
}

function endLive(usage?: unknown, reason?: string) {
  call.end(usage, reason);
  live.sideband?.close();
  live.sideband = undefined;
}

/* ---------- setup app helpers ---------- */
const STARTED_AT = new Date().toISOString();

/** True only for requests made on this PC (not proxied in from the phone via Tailscale Serve). */
function isLocal(req: IncomingMessage) {
  const host = (req.headers.host ?? "").split(":")[0];
  const proxied = !!(req.headers["x-forwarded-for"] || req.headers["tailscale-user-login"] || req.headers["x-forwarded-host"]);
  return (host === "localhost" || host === "127.0.0.1") && !proxied && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}

let phoneUrl: string | null | undefined;
async function getPhoneUrl() {
  if (phoneUrl !== undefined) return phoneUrl;
  try {
    const { stdout } = await execFileP("C:\\Program Files\\Tailscale\\tailscale.exe", ["status", "--json"], { windowsHide: true, timeout: 5000 });
    const dns = String(JSON.parse(stdout)?.Self?.DNSName ?? "").replace(/\.$/, "");
    phoneUrl = dns ? `https://${dns}` : null;
  } catch {
    phoneUrl = null;
  }
  return phoneUrl;
}

async function setupStatus() {
  // An existing sign-in entry still counts until the owner installs the current one.
  const startupFolder = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const startup = ["Tavi.vbs", earlier.folder + ".vbs"].map(name => path.join(startupFolder, name)).find(existsSync) || path.join(startupFolder, "Tavi.vbs");
  return {
    startedAt: STARTED_AT,
    phoneUrl: await getPhoneUrl(),
    voice: { ready: !!openaiKey(), name: VOICE, model: "gpt-live-1", live: !!live.sideband },
    brain: {
      model: brainInfo.model,
      // Before the first question the SDK hasn't reported its auth yet; with no API key set it uses the subscription login.
      subscription: brainInfo.apiKeySource === "none" || (brainInfo.apiKeySource === "unknown" && !process.env.ANTHROPIC_API_KEY),
      apiKeySource: brainInfo.apiKeySource === "unknown" && !process.env.ANTHROPIC_API_KEY ? "none" : brainInfo.apiKeySource,
    },
    autostart: existsSync(startup),
    google: { configured: googleConfigured() },
    accounts: listAccounts(),
    claude: connectorStates(),
    pendingApprovals: pendingApprovals().length,
  };
}

/** Nothing said yet, by either side (test lines don't count): the very first run. */
const neverSpoken = () => !db.prepare("SELECT 1 FROM conversation_log WHERE role IN ('user','assistant') AND channel != 'test' LIMIT 1").get();

/**
 * First run on the desktop (6.5): the assistant says hello once, and three quiet steps show until each is done:
 * open it on the phone, connect an account, add a folder.
 */
function sayHelloOnce() {
  if (!neverSpoken() || getSetting("intro_said")) return;
  setSetting("intro_said", nowIso());
  const name = assistantName();
  logConversation("assistant", "proactive", `Hi, I'm ${name ?? "Tavi"}, your personal assistant. Ask me anything, get me to keep track of things, or have me look at your drawings and files. What should I call you?`);
}
async function firstRun() {
  sayHelloOnce();
  const s = connectorStates();
  const linked = db.prepare("SELECT 1 FROM folders WHERE kind = 'linked' LIMIT 1").get();
  return {
    phone: { done: pushDeviceCount() > 0 || !!getSetting("phone_seen"), url: await getPhoneUrl() },
    account: { done: s.connectors.some((c) => c.status === "connected") || listAccounts().length > 0 },
    folder: { done: !!linked },
  };
}

function recentActivity(limit: number) {
  return db.prepare("SELECT ts, actor, event, ref, detail FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}

/* ---------- HTTP ---------- */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** One of the original pages (phone at /classic, Setup), with its security headers. */
async function sendPage(res: ServerResponse, file: string, host: string | undefined) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...pageHeaders(host, true) });
  res.end(await readFile(file, "utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    // Tavi's own browser must never use this gateway (its Setup page could change its own access).
    if (isAgentRequest(req.headers)) {
      audit("system", "browser.gateway_refused", null, { path: url.pathname });
      return send(res, 403, { error: "not from Tavi's browser" });
    }
    // Nothing that changes state may be asked for by another website open in the same browser. Routes below may
    // check again; this is the one place that covers them all (including /api/session/close).
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
    if (process.env.LH_V3 === "1") {
      if (url.pathname.startsWith("/api/hq/") && !sameOrigin(req)) return send(res, 403, { error: "This page cannot use the bot team." });
      if (req.method !== "GET" && req.method !== "HEAD") hq?.seen();
      if (await (await import("../hq/proactive.js")).routineRoute(req, res, url, isLocal(req))) return;
      if (url.pathname === "/api/hq/rooms/ask" && req.method === "POST" && "askBots" in table) {
        try {
          const b = JSON.parse(await readBody(req));
          if (!b || !Array.isArray(b.bots) || b.bots.some((id: unknown) => typeof id !== "string") || typeof b.text !== "string" || !b.text.trim()) return send(res, 400, { error: "Choose the bots and write their question." });
          return send(res, 200, await table.askBots(b.bots, b.text, { origin: call.live ? voiceOrigin() : null, clientId: call.live ? voiceOwner : null, test: false, mode: call.live ? "voice" : "typed" }));
        } catch (error) { return send(res, 400, { error: error instanceof SyntaxError ? "Choose the bots and write their question." : error instanceof Error ? error.message : "The room could not open." }); }
      }
      if (await (await import("../hq/api.js")).handleHq(req, res, url, hq, { isLocal, sameOrigin }, hq ? { baseUrl: hq.guard.baseUrl } : {})) return;
      if (DEV && url.pathname.startsWith("/api/hq-trial/") && await (await import("../hq/dev.js")).handleTrial(req, res, url, { isLocal, sameOrigin }, hq)) return;
    }
    // The phone app (v2) is the front door; the original phone page stays at /classic until it's retired (Stage 6).
    // If the new app hasn't been built, the original page keeps working at / as before.
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html") && existsSync(path.join(DIST, "phone.html"))) {
      return serveApp(res, path.join(DIST, "phone.html"), req.headers.host);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/classic")) {
      return sendPage(res, path.join(WEB_DIR, "index.html"), req.headers.host);
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest" && existsSync(path.join(DIST, "manifest.v2.webmanifest"))) {
      return serveApp(res, path.join(DIST, "manifest.v2.webmanifest"));
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(302, { Location: "/icons/icon-192.png" });
      return res.end();
    }
    /* ---------- installable app: manifest, service worker, icons ---------- */
    const STATIC: Record<string, [string, string]> = {
      "/sw.js": ["sw.js", "application/javascript; charset=utf-8"],
      "/earlier.js": ["earlier.js", "application/javascript; charset=utf-8"],
      "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json"],
      "/setup.webmanifest": ["setup.webmanifest", "application/manifest+json"],
      "/icons/icon-192.png": ["icons/icon-192.png", "image/png"],
      "/icons/icon-512.png": ["icons/icon-512.png", "image/png"],
      "/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png"],
      "/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png"],
    };
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { "Content-Type": type, "Cache-Control": file === "sw.js" ? "no-cache" : "public, max-age=86400" });
      return res.end(await readFile(path.join(WEB_DIR, file)));
    }
    /* ---------- v2 apps (built from ui/ into web/dist): phone at /v2, desktop at /desktop (PC only) ---------- */
    if (req.method === "GET" && url.pathname === "/v2") return serveApp(res, path.join(DIST, "phone.html"), req.headers.host);
    const entry = entryPage(url.pathname);
    if (req.method === "GET" && entry?.local) {
      if (!isLocal(req)) return send(res, 404, { error: "The desktop app is only available on the PC." });
      return serveApp(res, entry.file, req.headers.host);
    }
    if (req.method === "GET" && url.pathname.startsWith("/app/")) return serveApp(res, appFile(url.pathname), req.headers.host);
    /* ---------- whole sheets for the zoomable viewer (v2): page images and tiles, by sheet id only ---------- */
    const sheetPath = /^\/api\/sheets\/([\w-]{1,64})(?:\/page\.png|\/tile\/(\d{1,2})\/(\d{1,3})\/(\d{1,3})\.png)?$/.exec(url.pathname);
    if (req.method === "GET" && sheetPath) {
      const sheet = sheetById(sheetPath[1]);
      if (!sheet) return send(res, 404, { error: "not found" });
      if (url.pathname.endsWith("/page.png") || sheetPath[2] !== undefined) {
        let file: Promise<string> | null;
        if (sheetPath[2] !== undefined) file = tile(sheet, Number(sheetPath[2]), Number(sheetPath[3]), Number(sheetPath[4]));
        else {
          const w = Number(url.searchParams.get("w") ?? 1024);
          file = (PAGE_WIDTHS as readonly number[]).includes(w) ? pageImage(sheet, w as (typeof PAGE_WIDTHS)[number]) : null;
        }
        if (!file) return send(res, 404, { error: "not found" });
        const png = await readFile(await file);
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" });
        return res.end(png);
      }
      return send(res, 200, sheetInfo(sheet));
    }
    /* ---------- shop drawings (Stage 12.6): their sheets for the viewer and their files, by id only, like sheets ---------- */
    if (url.pathname.startsWith("/api/shopdrawings/") && (await handleShopRoute(req, res, url, send))) return;
    /* ---------- reference book pages for the viewer (Stage 8.2): by book id and page only, like sheets ---------- */
    const refPath = /^\/api\/reference\/(ref_[a-f0-9]{12})\/(\d{1,5})(?:\/page\.png|\/tile\/(\d{1,2})\/(\d{1,3})\/(\d{1,3})\.png)?$/.exec(url.pathname);
    if (req.method === "GET" && refPath) {
      const pg = Number(refPath[2]);
      const book = bookPage(refPath[1], pg);
      if (!book) return send(res, 404, { error: "not found" });
      if (url.pathname.endsWith(".png")) {
        let file: Promise<string | null>;
        if (refPath[3] !== undefined) file = refTile(book, pg, Number(refPath[3]), Number(refPath[4]), Number(refPath[5]));
        else {
          const w = Number(url.searchParams.get("w") ?? 1024);
          file = w === 1024 || w === 2048 ? refPageImage(book, pg, w) : Promise.resolve(null);
        }
        const f = await file;
        if (!f) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" });
        return res.end(await readFile(f));
      }
      return send(res, 200, await refInfo(book, pg));
    }
    /* ---------- files it has read (Stage 4): by id only, never a path from the URL ---------- */
    const fileRoute = /^\/api\/files\/(doc_[a-f0-9]{16})\/(?:image-(1024|2048)\.jpg|part\/(\d{1,4}))$/.exec(url.pathname);
    if (req.method === "GET" && fileRoute) {
      const d = getDoc(fileRoute[1]);
      if (!d) return send(res, 404, { error: "not found" });
      if (fileRoute[2]) {
        if (d.type !== "image") return send(res, 404, { error: "not found" });
        const jpg = await readFile(await fileImage(d, Number(fileRoute[2]) as 1024 | 2048));
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
        return res.end(jpg);
      }
      const p = docPart(d.id, Number(fileRoute[3]));
      return p ? send(res, 200, { name: d.name, label: p.label, text: p.text, grid: p.grid_json ? JSON.parse(p.grid_json) : null, more: Number(fileRoute[3]) + 1 < d.parts }) : send(res, 404, { error: "not found" });
    }
    /* ---------- items (v2): what the assistant has shown; only ever things it already put on screen ---------- */
    const pageSavePath = /^\/api\/items\/(itm_[\w]{1,40})\/page-file$/.exec(url.pathname);
    if (pageSavePath && req.method === "GET") {
      const file = getDoc(url.searchParams.get("file") ?? "");
      const meta = file ? fileMeta(file) : {};
      if (!file || file.type !== "made" || meta.kind !== "page" || meta.item !== pageSavePath[1] || !existsSync(file.path)) return send(res, 404, { error: "That saved page isn't kept any more." });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      return res.end(await readFile(file.path));
    }
    if (pageSavePath && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      const item = getItem(pageSavePath[1]);
      if (item?.kind !== "page") return send(res, 404, { error: "That page isn't kept any more." });
      const result = await savePage(ownerPageTurn(item), item.id);
      return send(res, "error" in result ? 400 : 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/items") {
      const scope = url.searchParams.get("scope") ?? "recent";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
      const q = url.searchParams.get("q");
      const items = q ? findItems(q, limit) : scope === "today" ? shownToday() : recentItems(limit);
      return send(res, 200, { items });
    }
    // A list row that points at a place on a sheet: open it as a sheet item of its own (kept, so "zoom out",
    // "keep that handy" and "shown today" work on it), ringed at the row's label.
    const rowPath = /^\/api\/items\/(itm_[\w]{1,40})\/rows\/([\w-]{1,80})\/open$/.exec(url.pathname);
    if (rowPath && req.method === "POST") {
      if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      const list = getItem(rowPath[1]);
      const entry = list?.kind === "page" ? list.payload.blocks.flatMap(b => b.type === "collection" ? b.entries : []).find(e => e.id === rowPath[2]) : undefined;
      const row = list?.kind === "list" ? list.payload.rows.find((r) => r.id === rowPath[2]) : entry?.place && entry.place.type !== "web" ? { target: entry.place } : undefined;
      if (!row?.target) return send(res, 404, { error: "not found" });
      if (row.target.type === "item") {
        const it = getItem(row.target.item_id);
        return it ? send(res, 200, { item: touchItem(it.id) }) : send(res, 404, { error: "not found" });
      }
      const s = sheetById(row.target.sheet_id);
      if (!s) return send(res, 404, { error: "not found" });
      const marks = row.target.label ? (await locate(s, row.target.label, 3)).map((h) => ({ box: h.box as Box, label: row.target!.type === "sheet" ? row.target!.label : undefined })) : [];
      const item = createItem(list?.kind === "page" ? ownerPageTurn(list) : null, {
        kind: "sheet",
        title: `${row.target.label || s.sheet_no || "Sheet"}${list!.title ? `, ${list!.title}` : ""}`,
        source: describeSheet(s),
        payload: { sheet_id: s.id, sheet_no: s.sheet_no, title: s.title, revision: s.revision, status: s.status, project: s.project, aspect: s.width_pt / s.height_pt, marks, view: row.target.box },
      });
      void warm(s.id, row.target.box);
      return send(res, 200, { item });
    }
    const itemPath = /^\/api\/items\/(itm_[\w]{1,40})(\/pin)?$/.exec(url.pathname);
    if (itemPath && req.method === "GET" && !itemPath[2]) {
      const it = getItem(itemPath[1]);
      return it ? send(res, 200, { item: it }) : send(res, 404, { error: "not found" });
    }
    if (itemPath && req.method === "POST" && itemPath[2]) {
      // The original pin route: { on } pins that one item on its own (13.2), or unpins whatever pin holds it.
      if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      const body = JSON.parse((await readBody(req)) || "{}") as { on?: unknown };
      if (!getItem(itemPath[1])) return send(res, 404, { error: "not found" });
      if (body.on === false) unpinItem(itemPath[1]);
      else {
        const r = addPin({ item_ids: [itemPath[1]] });
        if ("full" in r) return send(res, 409, { full: true, pins: r.pins });
      }
      return send(res, 200, { item: getItem(itemPath[1]) });
    }
    /* ---------- pins (13.2): up to five things kept on the phone's home screen; only ever his own doing ---------- */
    if (url.pathname === "/api/pins" && req.method === "GET") return send(res, 200, { pins: listPins() });
    if (url.pathname === "/api/pins" && req.method === "POST") {
      let b: Record<string, unknown>;
      try {
        b = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "expected a JSON object" });
      }
      const ids = Array.isArray(b.item_ids) ? b.item_ids.filter((x): x is string => typeof x === "string" && /^itm_\w{1,40}$/.test(x)) : [];
      if (!ids.length) return send(res, 400, { error: "item_ids: the pages to pin" });
      const r = addPin({
        item_ids: ids,
        idx: Number.isInteger(b.idx) ? (b.idx as number) : 0,
        view: b.view as never,
        camera: b.camera as never,
        sheet: b.sheet as never, // a set of shop drawings: the sheet it's on (checked in pins.ts)
        for_today: b.for_today === true,
        replace: typeof b.replace === "string" ? b.replace : undefined,
      });
      if ("error" in r) return send(res, 404, { error: r.error });
      if ("full" in r) return send(res, 409, { full: true, pins: r.pins });
      return send(res, 200, { pin: r.pin, already: r.already });
    }
    const pinPath = /^\/api\/pins\/(pin_\w{1,40})(\/place)?$/.exec(url.pathname);
    if (pinPath && req.method === "POST" && pinPath[2]) {
      let b: Record<string, unknown>;
      try {
        b = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "expected a JSON object" });
      }
      const pin = setPinPlace(pinPath[1], { idx: Number.isInteger(b.idx) ? (b.idx as number) : undefined, view: b.view as never, camera: b.camera as never, sheet: b.sheet as never });
      return pin ? send(res, 200, { pin }) : send(res, 404, { error: "not found" });
    }
    if (pinPath && req.method === "GET" && !pinPath[2]) {
      const pin = getPin(pinPath[1]);
      return pin ? send(res, 200, { pin }) : send(res, 404, { error: "not found" });
    }
    if (pinPath && req.method === "DELETE" && !pinPath[2]) return unpin(pinPath[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
    /* ---------- phone push: the app registers itself; the policy in notify.ts decides when to buzz ---------- */
    /* ---------- drawing crops (shown on the phone after "show me") ---------- */
    const crop = /^\/api\/drawings\/crop\/(crop_[a-f0-9]{16})\.png$/.exec(url.pathname);
    if (req.method === "GET" && crop) {
      const file = cropPath(crop[1]);
      if (!file) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
      return res.end(await readFile(file));
    }
    /* ---------- browser go-ahead screenshots (shown on the phone with the approval) ---------- */
    const shot = /^\/api\/browser\/shot\/(shot_[a-f0-9]{16}\.png)$/.exec(url.pathname);
    if (req.method === "GET" && shot) {
      const file = path.join(SHOTS_DIR, shot[1]);
      if (!existsSync(file)) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
      return res.end(await readFile(file));
    }
    /* ---------- everything put on the phone, newest first (the Cards button) ---------- */
    if (req.method === "GET" && url.pathname === "/api/cards") return send(res, 200, { cards: recentCards(80) });
    if (req.method === "GET" && url.pathname === "/api/push/key") return send(res, 200, { key: vapidPublicKey() });
    if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
      if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      try {
        saveSubscription(JSON.parse(await readBody(req)));
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      // build: which build of each app is live (13.4), so an app that's been sent something it can't show can check
      return send(res, 200, { ok: true, ...(process.env.LH_V3 === "1" ? { name: "Tavi" } : {}), voiceReady: !!openaiKey(), voice: VOICE, dev: DEV, build: { phone: uiBuild("phone"), desktop: uiBuild("desktop"), hq: uiBuild("hq") } });
    }
    /* ---------- dev only: make a notice arrive now (UI tests and trying the screens) ---------- */
    if (DEV && req.method === "POST" && url.pathname === "/api/dev/notify") {
      const b = JSON.parse((await readBody(req)) || "{}") as { title?: string; spoken?: string };
      queueNotification({ title: String(b.title ?? "Test notice"), spoken: String(b.spoken ?? "Finished checking prices. Want to see them?"), priority: "urgent", source: "dev" });
      await deliverDue(new Date());
      return send(res, 200, { ok: true });
    }
    /* ---------- dev only: start both brains afresh (timing checks: each round a fresh conversation) ---------- */
    if (DEV && req.method === "POST" && url.pathname === "/api/dev/reset-brain") {
      if (process.env.LH_V3 === "1") { for (const bot of hq?.members() ?? []) hq?.fresh(bot.id); return send(res, 200, { ok: true }); }
      resetConversation();
      warmUp();
      return send(res, 200, { ok: true });
    }
    /* ---------- settings: the phone (through Tailscale) sees and changes only ui.*; the PC everything ---------- */
    if (url.pathname === "/api/settings") {
      const local = isLocal(req);
      const visible = (all: Settings) => (local ? all : uiSettings(all));
      if (req.method === "GET") return send(res, 200, { values: visible(getSettings()) });
      if (req.method === "PUT") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        let patch: unknown;
        try {
          patch = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: "expected a JSON object" });
        }
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) return send(res, 400, { error: "expected a JSON object" });
        try {
          return send(res, 200, { values: visible(updateSettings(patch as Record<string, unknown>, local ? "local" : "remote")) });
        } catch (err) {
          if (!(err instanceof SettingsError)) throw err;
          return send(res, /only be changed on the PC/.test(err.message) ? 403 : 400, { error: err.message });
        }
      }
      return send(res, 405, { error: "GET or PUT" });
    }
    /* ---------- the round table (Stage 17): what's on it; everything sent to the guest (the PC's "What does Tim know?") ---------- */
    if (req.method === "GET" && url.pathname === "/api/table") return send(res, 200, table.state());
    // a line's speech (17.3), by its line id only: raw 24 kHz 16-bit mono, streamed while it's still being made
    const clipPath = /^\/api\/table\/audio\/(tl_[a-z0-9]{1,30})$/.exec(url.pathname);
    if (req.method === "GET" && clipPath) {
      const c = clipFor(clipPath[1]);
      if (!c) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Sample-Rate": String(RATE), "X-Content-Type-Options": "nosniff" });
      let i = 0;
      const flush = () => {
        while (i < c.chunks.length) res.write(c.chunks[i++]);
        if (c.done) {
          c.listeners.delete(flush);
          res.end();
        }
      };
      c.listeners.add(flush);
      res.on("close", () => c.listeners.delete(flush));
      return flush();
    }
    if (req.method === "GET" && url.pathname === "/api/table/sent") {
      if (!isLocal(req)) return send(res, 404, { error: "Only available on the PC." });
      const id = table.lastTableId();
      return send(res, 200, { id, sent: table.sentAt(id) });
    }
    // Siri and the Action Button (Stage 14.3): reached from the phone like the app; its own key in a header.
    if (req.method === "POST" && url.pathname === "/api/shortcut") return await handleShortcut(req, res, url, shortcutTurns);
    if (req.method === "POST" && url.pathname === "/api/session") {
      if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      if (!openaiKey()) return send(res, 503, { error: "No OpenAI key yet. Add OPENAI_API_KEY to .env and restart." });
      const { sdp, client_id, bot, mic_ms, ice_ms } = JSON.parse(await readBody(req));
      if (typeof sdp !== "string" || !sdp.startsWith("v=")) return send(res, 400, { error: "missing SDP offer" });
      voiceOwner = typeof client_id === "string" && /^[\w-]{1,64}$/.test(client_id) ? client_id : null;
      callBot = hq?.pick("", typeof bot === "string" ? bot : undefined).bot.id;
      endLive();
      callVoiceBot = callBot;
      const asked = Date.now();
      const session = await createLiveSession(openaiKey(), sdp, hq?.pick("", callBot).bot.voice ?? VOICE);
      console.log(`[live] session ${session.id} created`);
      // How long the call took to set up, for when a start feels slow: the microphone and the device's own network
      // check (timed on the device), then the voice service making the session.
      const took = (v: unknown) => (typeof v === "number" && v >= 0 && v < 120_000 ? Math.round(v) : null);
      const setup = { mic_ms: took(mic_ms), ice_ms: took(ice_ms), session_ms: Date.now() - asked };
      const sb = new Sideband(openaiKey(), session.id, onLiveEvent, (why) => {
        console.warn(`[live] ${why}`);
        if (live.sideband === sb) toAll({ type: "live", state: "degraded", message: "Lost the link to the voice service." });
      });
      live.sideband = sb;
      call.attach(sb, session.id);
      audit("voice", "call.setup", session.id, setup);
      if (callBot) hq?.callChanged(callBot);
      if (table.on) muteCallVoice(true); // a round table already on: the call's voice is muted from the start (18.1)
      sb.attach().then(
        () => {
          console.log("[live] sideband attached");
          // a round table already on (started by typing): the voice hands everything over while it lasts (Stage 17)
          if (table.on) sb.send({ type: "session.instructions.append", delegation_id: null, content: TABLE_VOICE_LINE(table.state().names) });
        },
        (err) => {
          console.error("[live] sideband attach failed:", err.message);
          toAll({ type: "live", state: "degraded", message: "Voice connected, but I can't hear its requests. Restart the session." });
        },
      );
      return send(res, 201, { session: { id: session.id }, transport: { type: "webrtc", sdp: session.answerSdp } });
    }
    if (req.method === "POST" && url.pathname === "/api/session/close") {
      endLive(undefined, "hung up");
      return send(res, 200, { ok: true });
    }

    /* ---------- desktop app APIs (PC only) ---------- */
    // Photos and sketches (Stage 8.4, 8.5) come from the phone, so this one upload is not PC-only. The origin check
    // above already applies; it only ever keeps a picture, in the app's own folder.
    if (req.method === "POST" && url.pathname === "/api/v2/upload" && !isLocal(req)) {
      const as = url.searchParams.get("as");
      if (as === "photo" || as === "sketch") return void (await handlePictureUpload(req, res, url, { send }, as));
      // a picture or 3D file of a model on the phone's screen (Stage 9.3): only ever that, into the app's own folder
      if (as === "model") return void (await handleModelUpload(req, res, url, { send }));
    }
    // pictures of a model the assistant asked to look at (Stage 9.3), from whichever app has it on screen
    const modelPics = /^\/api\/v2\/model\/(itm_[\w]{1,40})\/pictures$/.exec(url.pathname);
    if (modelPics && req.method === "POST") return void (await handleModelPicture(req, res, url, modelPics[1], { send }));
    if (url.pathname.startsWith("/api/v2/")) {
      if (!isLocal(req)) return send(res, 404, { error: "Only available on the PC." });
      if (req.method === "GET" && url.pathname === "/api/v2/firstrun") return send(res, 200, await firstRun());
      if (req.method === "GET" && url.pathname === "/api/v2/conversation") sayHelloOnce(); // so the thread opens on it
      if (await handleV2(req, res, url, { send, readBody, sameOrigin })) return;
      return send(res, 404, { error: "not found" });
    }
    /* ---------- PC-only setup app: never reachable through the phone (Tailscale) address ---------- */
    if (url.pathname === "/setup" || url.pathname.startsWith("/api/setup/") || url.pathname.startsWith("/oauth/")) {
      if (!isLocal(req)) return send(res, 404, { error: "Setup is only available on the PC." });
      if (req.method === "GET" && url.pathname === "/setup") {
        return sendPage(res, path.join(WEB_DIR, "setup.html"), req.headers.host);
      }
      if (req.method === "GET" && url.pathname === "/api/setup/status") return send(res, 200, await setupStatus());
      if (req.method === "GET" && url.pathname === "/api/setup/activity") return send(res, 200, { events: recentActivity(80) });
      if (req.method === "POST" && url.pathname === "/api/setup/google-client") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        const { clientId, clientSecret } = JSON.parse(await readBody(req));
        try {
          setGoogleClient(String(clientId ?? ""), String(clientSecret ?? ""));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return send(res, 200, { ok: true });
      }
      // Personality page: SOUL.md, USER.md, held writes, change log. Only the PC (a person), never the brain.
      if (req.method === "GET" && url.pathname === "/api/setup/profile") {
        return send(res, 200, {
          soul: readSoul(),
          user: readUser(),
          voiceCard: voiceCard(),
          name: assistantName(),
          caps: { soul: SOUL_CAP, user: USER_CAP },
          held: heldWrites().map((h) => ({ ...h, text: describeHeld(h) })),
          changes: recentProfileChanges(30),
        });
      }
      if (req.method === "POST" && /^\/api\/setup\/profile\/(soul|user|held|name)$/.test(url.pathname)) {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        const body = JSON.parse(await readBody(req));
        try {
          if (url.pathname.endsWith("/soul")) saveSoul(String(body.text ?? ""), "you (PC)");
          else if (url.pathname.endsWith("/user")) saveUserFile(String(body.text ?? ""), "you (PC)");
          else if (url.pathname.endsWith("/name")) setAssistantName(String(body.name ?? ""), "you (PC)");
          else decideHeld(String(body.id), !!body.yes);
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return send(res, 200, { ok: true });
      }
      // The desktop app's "Restart Tavi": exit cleanly and let the supervisor start a fresh gateway.
      if (req.method === "POST" && url.pathname === "/api/setup/restart") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        audit("user", "gateway.restart", null, {});
        send(res, 200, { restarting: true });
        setTimeout(() => process.exit(0), 300);
        return;
      }
      // Websites Tavi's browser may use with the user's logins. Only the user, from the PC.
      if (req.method === "GET" && url.pathname === "/api/setup/browser") {
        return send(res, 200, { sites: listSites(), busy: browserBusy(), jobs: browserQueue() });
      }
      if (req.method === "POST" && /^\/api\/setup\/browser\/(add|remove|login|forget-all)$/.test(url.pathname)) {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        const body = JSON.parse(await readBody(req));
        try {
          if (url.pathname.endsWith("/add")) addSite(String(body.site ?? ""), body.label ? String(body.label) : undefined);
          else if (url.pathname.endsWith("/remove")) {
            // Removing a site also logs Tavi's browser out of it, so no login is left behind.
            await forgetLogin(String(body.origin ?? ""));
            removeSite(String(body.origin ?? ""));
          } else if (url.pathname.endsWith("/forget-all")) forgetAllLogins();
          else await openLoginWindow(String(body.origin ?? ""));
        } catch (err) {
          return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return send(res, 200, { sites: listSites(), busy: browserBusy() });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/connectors/check") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        await refreshConnectors(true);
        return send(res, 200, connectorStates());
      }
      // Read / Write per connector. Only here, from the PC app: the brain has no way to change its own permissions.
      if (req.method === "POST" && url.pathname === "/api/setup/connectors/permission") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        const { server, read, write } = JSON.parse(await readBody(req));
        if (!connectorStates().connectors.some((c) => c.server === server)) return send(res, 400, { error: "unknown connector" });
        setPermission(String(server), { read: !!read, write: !!write });
        await refreshConnectors(false);
        return send(res, 200, connectorStates());
      }
      if (req.method === "POST" && url.pathname === "/api/setup/disconnect") {
        if (!sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
        const { id } = JSON.parse(await readBody(req));
        await disconnectAccount(String(id));
        toAll({ type: "accounts" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/oauth/google/start") {
        const label = (url.searchParams.get("label") || "Gmail").slice(0, 30);
        try {
          res.writeHead(302, { Location: startGoogleAuth(`http://127.0.0.1:${PORT}/oauth/google/callback`, label) });
        } catch (err) {
          res.writeHead(302, { Location: `/setup?error=${encodeURIComponent(err instanceof Error ? err.message : String(err))}#connections` });
        }
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
        const err = url.searchParams.get("error");
        let to = "/setup?connected=gmail#connections";
        if (err) to = `/setup?error=${encodeURIComponent(err === "access_denied" ? "You cancelled the Google sign-in." : `Google said: ${err}`)}#connections`;
        else {
          try {
            await finishGoogleAuth(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
            toAll({ type: "accounts" });
          } catch (e) {
            to = `/setup?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}#connections`;
          }
        }
        // Setup is opened at localhost; Google returns to 127.0.0.1. Send the browser back to the same origin it started on.
        res.writeHead(302, { Location: `http://localhost:${PORT}${to}` });
        return res.end();
      }
      /* ----- Proactive page ----- */
      if (req.method === "GET" && url.pathname === "/api/setup/proactive") {
        return send(res, 200, {
          routines: process.env.LH_V3 === "1" ? listRoutines().map((await import("../hq/proactive.js")).withRoutineBot) : listRoutines(),
          commitments: listCommitments("open", 50),
          memories: activeMemories(60),
          offers: pendingOffers(),
          days: db.prepare("SELECT day, group_concat(note, ' ') notes FROM day_notes GROUP BY day ORDER BY day DESC LIMIT 7").all(),
          settings: allSettings(),
          rules: notificationRules(),
          followups: describeControls(),
          pushDevices: pushDeviceCount(),
        });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/setup/") && !sameOrigin(req)) return send(res, 403, { error: "origin not allowed" });
      if (req.method === "POST" && url.pathname === "/api/setup/routine") {
        const { id, action } = JSON.parse(await readBody(req));
        const r = getRoutine(String(id));
        if (!r) return send(res, 404, { error: "No such routine" });
        if (action === "run") void runRoutine(r);
        else if (action === "pause" || action === "resume" || action === "delete") setRoutineStatus(r.id, action === "resume" ? "active" : action === "pause" ? "paused" : "deleted");
        else return send(res, 400, { error: "unknown action" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/commitment") {
        const { id, action } = JSON.parse(await readBody(req));
        if (action !== "done" && action !== "drop") return send(res, 400, { error: "unknown action" });
        updateCommitment(String(id), { status: action === "done" ? "done" : "dropped", note: "from the PC app" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/forget") {
        const { id } = JSON.parse(await readBody(req));
        forget(String(id));
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/rules") {
        const b = JSON.parse(await readBody(req)) as { quiet_start?: string; quiet_end?: string; max_interruptions?: string };
        const time = (v?: string) => (v === undefined || v === "" || /^\d{1,2}:\d{2}$/.test(v) ? v : null);
        if (time(b.quiet_start) === null || time(b.quiet_end) === null) return send(res, 400, { error: "Times must look like 19:00" });
        if (Boolean(b.quiet_start) !== Boolean(b.quiet_end)) return send(res, 400, { error: "Set both a start and an end, or leave both empty." });
        setSetting("quiet_start", b.quiet_start ?? "");
        setSetting("quiet_end", b.quiet_end ?? "");
        setSetting("max_interruptions", String(Math.max(0, Number(b.max_interruptions) || 0)));
        return send(res, 200, { ok: true, rules: notificationRules() });
      }
      if (req.method === "GET" && url.pathname === "/api/setup/drawings") {
        return send(res, 200, {
          dir: DRAWINGS_DIR,
          projects: listProjects(),
          sheets: listSheets({ includeSuperseded: true }).map((x) => ({
            project: x.project, sheet_no: x.sheet_no, title: x.title, revision: x.revision, status: x.status,
            discipline: x.discipline, read_path: x.read_path, source: x.source, confidence: x.confidence, file: x.name, page: x.page,
          })),
        });
      }
      if (req.method === "POST" && url.pathname === "/api/setup/push-test") {
        queueNotification({ title: "Test from Tavi", spoken: "This is a test notification. If you can see this on your phone, alerts are working.", priority: "urgent", source: "setup.test" });
        return send(res, 200, { ok: true, devices: pushDeviceCount() });
      }
      return send(res, 404, { error: "not found" });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[http]", message);
    send(res, 500, { error: message });
  }
});

/** The nearest v1 card for a v2 item, for the original phone page (it can't show items). Null: nothing to show. */
async function legacyCard(item: Item, background: boolean) {
  try {
    if (item.kind === "sheet") {
      const s = findSheet(item.payload.sheet_id);
      if (!s) return null;
      const crop = await cropSheet(s, item.payload.view, 1800);
      return cardShown({ title: item.title, image: `/api/drawings/crop/${crop.id}.png`, source: item.source, background });
    }
    if (item.kind === "image") return cardShown({ title: item.title, image: item.payload.src, source: item.source, background });
    const flat = (cells: string[], columns?: string[]) => ({ label: cells[0] ?? "", value: cells.slice(1).map((c, i) => (columns?.[i + 1] ? `${columns[i + 1]}: ${c}` : c)).join(" · ") });
    if (item.kind === "list") return rowsShown({ title: item.title, source: item.source, rows: item.payload.rows.slice(0, 12).map((r) => flat(r.cells, item.payload.columns)) });
    if (item.kind === "table") return rowsShown({ title: item.title, source: item.source, rows: item.payload.rows.slice(0, 12).map((r) => flat(r, item.payload.columns)) });
    if (item.kind === "note") return rowsShown({ title: item.title, source: item.source, rows: item.payload.text ? [...item.payload.rows, { label: "", value: item.payload.text }] : item.payload.rows });
    return null; // drafts reach v1 as approvals already; legacy and doc items have no v1 form
  } catch (err) {
    console.warn("[items] no v1 card:", err instanceof Error ? err.message : err);
    return null;
  }
}

/* ---------- WebSocket to the app: typed input in, subtitles/cards out ---------- */
const wss = new WebSocketServer({ noServer: true });
/**
 * The live view (Stage 15.2): the browser's state as JSON, each picture as binary ([2-byte header length][header JSON]
 * [JPEG]); from the desktop, only his mouse and keys while he has taken it over, handed straight to the page by
 * host.input. Nothing from this socket is logged, kept or passed on.
 */
const browserWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
function liveView(ws: WebSocket) {
  const off = watchBrowser((m) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // this socket's own message (PROTOCOL.md, "WebSocket /browser"), not one of /ws's
    const view = { type: "view", view: "view" in m ? m.view : null };
    if ("view" in m) return ws.send(JSON.stringify(view));
    if (ws.bufferedAmount > 2 * 1024 * 1024) return; // a slow screen skips pictures rather than falling behind
    const head = Buffer.from(JSON.stringify({ w: m.frame.w, h: m.frame.h, dw: m.frame.dw, dh: m.frame.dh, at: m.frame.at }));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(head.length);
    ws.send(Buffer.concat([len, head, m.frame.jpeg]));
  });
  ws.on("message", (raw) => {
    let msg: { type?: string; e?: InputEvent };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    hq?.seen();
    if (msg.type === "input" && msg.e && typeof msg.e === "object") void liveHost()?.input(msg.e);
  });
  ws.on("close", off);
  ws.on("error", off);
}
server.on("upgrade", (req, socket, head) => {
  if (process.env.LH_V3 === "1" && new URL(req.url ?? "/", "http://local").pathname.startsWith("/api/hq/bots/")) {
    void import("../hq/api.js").then(m => { if (!m.handleScreenUpgrade(req, socket, head, hq, { isLocal, sameOrigin })) socket.destroy(); }).catch(() => socket.destroy());
    return;
  }
  if (helperUpgrade(req, socket, head)) return; // another computer's helper (Stage 11): remote/hub.ts
  // the live view of the assistant's browser (Stage 15.2): the desktop on this PC only
  if (new URL(req.url ?? "/", "http://local").pathname === "/browser") {
    if (!isLocal(req) || !sameOrigin(req) || isAgentRequest(req.headers)) return socket.destroy();
    return void browserWss.handleUpgrade(req, socket, head, (ws) => liveView(ws));
  }
  if (new URL(req.url ?? "/", "http://local").pathname !== "/ws" || !sameOrigin(req) || isAgentRequest(req.headers)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
/** The opening line (memory/opener.ts) after a quiet spell, as hello.say: shown under Pebble, never spoken. */
const opening = (): { say?: string } => {
  const say = openerFor();
  return say ? { say } : {};
};
/** What a client gets on connect: hello, approvals waiting for an OK, notices it hasn't seen. */
const settingsFor = (kind: string, all: Settings = getSettings()) => (kind === "desktop" ? all : uiSettings(all));

function greet(ws: WebSocket, v: 1 | 2, kind = "legacy") {
  const hello = { type: "hello", voiceReady: !!openaiKey(), notice: bootNotice || null, name: assistantName() };
  ws.send(JSON.stringify(v === 2 ? { ...hello, v: 2, settings: settingsFor(kind), dev: DEV, first_run: neverSpoken(), ...opening(), build: uiBuild(kind === "desktop" ? "desktop" : "phone") } : hello));
  for (const approval of pendingApprovals()) {
    if (v === 1) {
      ws.send(JSON.stringify({ type: "approval", approval }));
      continue;
    }
    const item = ensureDraftItem(approval);
    ws.send(JSON.stringify({ type: "item", item, open: false }));
    ws.send(JSON.stringify({ type: "approval", approval: { ...approval, item_id: item.id } }));
  }
  const waiting = listWaiting().map((n) => ({ ...n, card: noticeCard(n) }));
  if (waiting.length) ws.send(JSON.stringify({ type: "notices", items: waiting }));
  if (v === 2) ws.send(JSON.stringify({ type: "pins", pins: listPins() })); // the home screen's row (13.2)
  if (v === 2 && table.on) ws.send(JSON.stringify({ type: "table", ...table.state() })); // a round table that's on (17)
}
const vec3 = (a: unknown): a is [number, number, number] => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === "number" && Number.isFinite(n));
const cameraOf = (c: unknown) => (c && typeof c === "object" && vec3((c as { pos?: unknown }).pos) && vec3((c as { target?: unknown }).target) ? (c as ScreenState["camera"]) : null);

wss.on("connection", (ws) => {
  const me = addClient(ws);
  // A v2 app says hello first. The original phone page never does: after a short wait it's greeted as before.
  let greeted = false;
  const v1Greeting = setTimeout(() => {
    greeted = true;
    greet(ws, 1);
  }, 300);
  ws.on("message", async (raw) => {
    let msg: { type?: string; text?: string; id?: string; nonce?: string; decision?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    hq?.seen();
    if (msg.type === "hello") {
      const kind = msg.client === "phone" || msg.client === "desktop" ? (msg.client as ClientKind) : null;
      if (msg.v !== 2 || !kind || typeof msg.id !== "string" || !/^[\w-]{1,64}$/.test(msg.id)) return;
      // The Tavi apps say hello twice: the shared socket code first, then again with hq: true to ask for the team's
      // live updates. The second one used to be dropped here as a repeat, so nothing reached the screen until a reload
      // (the owner's first message to Pebble). A repeat hello may still ask for team updates; it changes nothing else.
      if (me.v === 2) { if (msg.hq === true) hq?.attach(ws); return; }
      Object.assign(me, { v: 2, kind, id: msg.id });
      if (msg.hq === true) hq?.attach(ws);
      if (kind === "phone" && !getSetting("phone_seen")) setSetting("phone_seen", nowIso()); // a first-run step done
      if (!greeted) {
        clearTimeout(v1Greeting);
        greeted = true;
        greet(ws, 2, kind);
      } else {
        ws.send(JSON.stringify({ type: "hello", v: 2, voiceReady: !!openaiKey(), notice: null, name: assistantName(), settings: settingsFor(kind), dev: DEV, first_run: neverSpoken(), ...opening(), build: uiBuild(kind) }));
      }
      return;
    }
    if (msg.type === "seen" && Array.isArray((msg as { ids?: unknown }).ids)) {
      markSeen(((msg as { ids: unknown[] }).ids).filter((x): x is string => typeof x === "string").slice(0, 50));
      return;
    }
    if (msg.type === "decide" && typeof msg.id === "string" && typeof msg.nonce === "string" && (msg.decision === "approve" || msg.decision === "reject")) {
      void decide(msg.id, msg.nonce, msg.decision);
      return;
    }
    if (msg.type === "screen" && me.v === 2) {
      const item_id = typeof msg.item_id === "string" ? msg.item_id.slice(0, 64) : null;
      const model = msg.model as ScreenState["model"] | undefined;
      me.screen = {
        item_id,
        view: msg.view as ScreenState["view"],
        stack_depth: Number(msg.stack_depth) || 0,
        page_index: Number(msg.page_index) || 0,
        page_count: Number(msg.page_count) || 0,
        ...(msg.pad === true ? { pad: true } : {}),
        ...(model && typeof model === "object" ? { model: { apart: model.apart === true, sizes: model.sizes === true } } : {}),
        // the pages beside it and a model's camera (13.2), only in the shapes the apps send
        ...(Array.isArray(msg.set) ? { set: (msg.set as unknown[]).filter((x): x is string => typeof x === "string" && /^itm_\w{1,40}$/.test(x)).slice(0, 20) } : {}),
        ...(cameraOf(msg.camera) ? { camera: cameraOf(msg.camera)! } : {}),
      };
      return;
    }
    if (msg.type === "cancel") {
      if (typeof msg.job_id === "string") cancelJob(msg.job_id, "user");
      return;
    }
    // The round table (Stage 17): a line it asked this app to say has been said, the owner cut in, or End was tapped.
    if (me.v === 2 && typeof msg.type === "string" && /^table_(played|cut|end)$/.test(msg.type)) {
      table.client({ ...msg, client_id: me.id });
      return;
    }
    if (msg.type === "revise" && me.v === 2 && typeof msg.id === "string" && typeof msg.nonce === "string") {
      const change = { subject: typeof msg.subject === "string" ? msg.subject.slice(0, 500) : undefined, body: typeof msg.body === "string" ? msg.body.slice(0, 50_000) : undefined };
      try {
        reviseEmailApproval(msg.id, msg.nonce, change);
      } catch (err) {
        ws.send(JSON.stringify({ type: "outcome", outcome: { approvalId: msg.id, status: "refused", message: err instanceof Error ? err.message : String(err) } }));
      }
      return;
    }
    if (msg.type === "typed" && typeof msg.text === "string" && msg.text.trim()) {
      const text = msg.text.trim().slice(0, 2000);
      const test = (msg as { test?: unknown }).test === true;
      const requestId = typeof msg.request_id === "string" ? msg.request_id.slice(0, 64) : undefined;
      const typedJob = createJob("ask", "typed", text);
      logConversation("user", test ? "test" : "typed", text, typedJob);
      if (!test) remember(`User (typed): ${text}`); // the voice's short-term context never sees test lines
      const origin: Origin = { client: me.kind, id: me.id };
      if (me.v === 2 && !test) {
        const fast = await tryFastPath(text, me.id, origin, process.env.LH_V3 === "1" ? hq?.pick(text, typeof msg.bot === "string" ? msg.bot : undefined).bot.id : undefined);
        if (fast) {
          toAll({ type: "brain", phase: "done", spoken: fast.spoken, source: "typed", job_id: null, request_id: requestId, origin, fast: true }, null);
          logConversation("assistant", "typed", fast.spoken, typedJob);
          db.prepare("UPDATE jobs SET status = 'done', result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ spoken: fast.spoken, fast: fast.did }), new Date().toISOString(), typedJob);
          audit("user", "fast_path", null, { text, did: fast.did });
          return;
        }
      }
      // The round table (Stage 17): on, or these words bring the guest in (the v2 apps only: they can show it).
      if (me.v === 2 && table.wants(text)) {
        // (dev only, voice_test: the screens' checks stand in for a call, so the lines are said as on a real one)
        table.typed(text, { origin, clientId: me.id, test, jobId: typedJob, asVoice: DEV && (msg as { voice_test?: unknown }).voice_test === true });
        return;
      }
      // Photos sent with these words (Stage 8.4): only ids of pictures it holds; anything else is ignored.
      const sentWith = (Array.isArray(msg.files) ? (msg.files as unknown[]) : [])
        .filter((f): f is string => typeof f === "string" && /^doc_[a-f0-9]{16}$/.test(f))
        .slice(0, 4)
        .map((f) => getDoc(f))
        .filter((d) => d?.type === "image");
      // ... and a sketch from the pad (Stage 8.5) is named as theirs: a hand sketch, not to scale.
      const isSketch = (d: (typeof sentWith)[number]) => !!d?.meta_json && /"kind":"sketch"/.test(d.meta_json);
      const photos = sentWith.filter((d) => !isSketch(d)).map((d) => d!.id);
      const sketches = sentWith.filter(isSketch).map((d) => d!.id);
      const parts = [
        ...(photos.length ? [`${photos.length === 1 ? "photo" : "photos"} ${photos.join(", ")}`] : []),
        ...(sketches.length ? [`their own sketch ${sketches.join(", ")}, drawn by hand (not to scale)`] : []),
      ];
      const withPhotos = parts.length ? `\n\nSent with this message: ${parts.join("; ")} (look with view_file).` : "";
      const request = `Context:\n${buildContext(text, me.v === 2 ? describeScreen(me.id) : undefined)}\n\nRecent conversation:\n${RECENT}${withPhotos}\n\nThe user typed: "${text}"`;
      db.prepare("UPDATE jobs SET request = ? WHERE id = ?").run(request, typedJob);
      void askBrain({ request, said: text, source: "typed", test, origin, requestId, jobId: typedJob, bot: typeof msg.bot === "string" ? msg.bot : undefined }).then((res) => {
        if (res && !test) remember(`Assistant (backend result): ${res.spoken}`);
      });
    }
  });
  ws.on("close", () => {
    clearTimeout(v1Greeting);
    clients.delete(ws);
  });
});

const pagePictures = await import("../pages/made.js");
pagePictures.closePendingPictures();
server.once("close", () => { pagePictures.madePictures.stop(); pagePictures.stopMadePictures(); if (hq) void import("../hq/hq.js").then((m) => m.stopHq()); });
if (process.env.LH_V3 === "1") for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  void (async () => {
    pagePictures.madePictures.stop(); pagePictures.stopMadePictures();
    await pagePictures.madePictures.drain();
    await (await import("../hq/hq.js")).stopHq();
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  })();
});
server.listen(PORT, HOST, () => {
  if (process.env.LH_V3 === "1" && DEV) {
    let saving = false;
    const savePractice = async () => {
      if (saving) return; saving = true;
      try {
        const subscriptions = await hq?.subscriptions() ?? [];
        const file = path.join(DATA_DIR, "logs", "tavi-practice-status.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file + ".new", JSON.stringify({ at: new Date().toISOString(), data: path.resolve(DATA_DIR),
          subscriptions: Object.fromEntries(subscriptions.map(s => [s.provider, s.signedIn === true])) }));
        await rename(file + ".new", file);
      } catch { console.warn("The practice sign-in check could not be saved. Check both subscriptions before switching."); }
      finally { saving = false; }
    };
    void savePractice(); const timer = setInterval(() => void savePractice(), 5000); timer.unref();
    server.once("close", () => clearInterval(timer));
  }
  console.log(`${process.env.LH_V3 === "1" ? "Tavi" : "Tavi"} gateway on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(
    openaiKey()
      ? `Voice ready (gpt-live-1, voice "${VOICE}")`
      : process.env.LH_NO_VOICE === "1"
        ? "Voice is off for this run (npm run dev -- --voice turns it on). Typing works."
        : "Voice not ready: add OPENAI_API_KEY to .env. Typing works now.",
  );
  if (process.env.LH_V3 !== "1") warmUp();
  // Proactive side: deliver notices to the open app (and, once set up, as phone push), then start the heartbeat.
  void getPhoneUrl().then(setPushSubject);
  addChannel(async (notice, { push }) => {
    const { source: _from, ...shown } = notice; // (where it came from is the gateway's business, not the apps')
    toAll({ type: "notice", notice: { ...shown, card: noticeCard(notice) } });
    if (push) await pushToAll(notice.title, notice.spoken, { urgent: notice.priority === "urgent", tag: notice.id });
    // A piece of work is done (Stage 21.3): on a call, said out loud when he isn't mid-sentence (the brain's words, once).
    const work = /^task:(.+)$/.exec(notice.source ?? "")?.[1];
    if (call.live && !table.on && (work || process.env.LH_V3 === "1")) void call.announce(notice.spoken, work ?? notice.source ?? notice.id).then((said) => said && markSeen([notice.id]));
    else if (live.sideband) live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: `New update for the user (mention it when there's a natural pause): ${notice.spoken}` });
  });
  setBundlePush(async (title, body) => void (await pushToAll(title, body, { tag: "followups" })));
  onScheduler((e) => toAll(e));
  bus.on("show", (s) => toAll({ type: "show", card: cardShown(s) }));
  bus.on("reopen", (id: string) => {
    const card = reopenCard(id);
    if (card) toAll({ type: "show", card });
  });
  bus.on("drawings", (e) => toAll({ type: "drawings", ...e }));
  bus.on("background", (e) => toAll({ type: "background", ...e }));
  // v2 items: open on the screen of whoever asked; listed (not popped up) everywhere else. The original phone page
  // gets the nearest v1 card instead.
  bus.on("item", ({ item, open, turn, v1, replaces }) => {
    if (item.kind === "sheet") void warm(item.payload.sheet_id, item.payload.view);
    if (item.kind === "reference") void warmRef(item.payload.book_id, item.payload.page);
    const owner = turn?.origin && "client" in turn.origin ? turn.origin.id : null;
    toEach((c) => (c.v === 2 ? { type: "item", item, open: open && c.id === owner, ...(replaces ? { replaces } : {}) } : null));
    if (v1 !== false && [...clients.values()].some((c) => c.v === 1)) void legacyCard(item, turn?.background ?? false).then((card) => card && toAll({ type: "show", card }, { type: "show", card }));
  });
  bus.on("item_update", (u) => toEach((c) => (c.v === 2 ? { type: "item_update", ...u } : null)));
  bus.on("pins", (pins) => toEach((c) => (c.v === 2 ? { type: "pins", pins } : null)));
  bus.on("surface", ({ client_id, cmd }) => toClient(client_id, { type: "surface", ...cmd }));
  // The desktop's thread updates as lines are written; Activity and Memory refetch, at most once a second.
  bus.on("line", (l) => toKind("desktop", { type: "line", ...l }));
  let actTimer: ReturnType<typeof setTimeout> | null = null;
  const activityChanged = () => (actTimer ??= setTimeout(() => ((actTimer = null), toKind("desktop", { type: "activity" })), 1000));
  for (const e of ["activity", "line", "item", "settings"] as const) bus.on(e, activityChanged);
  onBrokerEvent(activityChanged);
  onScheduler(activityChanged);
  bus.on("memory", () => toKind("desktop", { type: "memory" }));
  // the assistant's browser (15.2): the desktop shows what it's doing and opens the view when it asks for him
  bus.on("browser", (view) => toKind("desktop", { type: "browser", view }));
  let filesTimer: ReturnType<typeof setTimeout> | null = null;
  bus.on("files", () => (filesTimer ??= setTimeout(() => ((filesTimer = null), toKind("desktop", { type: "files" })), 1000)));
  bus.on("profile", () => toKind("desktop", { type: "memory" }));
  bus.on("settings", (all) => {
    toKind("desktop", { type: "settings", values: all });
    toKind("phone", { type: "settings", values: uiSettings(all as Settings) });
  });
  // A new name reaches the phone at once, and the voice mid-call (its instructions otherwise refresh on the next call).
  let knownName = assistantName();
  bus.on("profile", () => {
    const name = assistantName();
    if (name === knownName) return;
    knownName = name;
    toAll({ type: "name", name });
    if (name && live.sideband) live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: `The user just named you: your name is now ${name}.` });
  });
  // USER.md changed: the names the voice listens for are rebuilt, and a call in progress gets the new list.
  let knownNames = namesLine();
  bus.on("profile", ({ file }) => {
    if (file !== "USER.md") return;
    const names = namesLine();
    if (names === knownNames) return;
    knownNames = names;
    if (names && live.sideband) live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: `Updated list. ${names}` });
  });
  // The sit-down started or ended mid-call: the voice hands every answer to the brain while it's on, then goes back to normal.
  bus.on("sitdown", ({ status, was }) => {
    if (!live.sideband) return;
    if (status === "in_progress") live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: SITDOWN_VOICE_LINE });
    else if (was === "in_progress") live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: SITDOWN_OVER_LINE });
  });
  // A photo or sketch arrived mid-call (Stage 8.4, 8.5): the voice never looks at it or comments on it itself.
  bus.on("picture", ({ kind }) => {
    if (!live.sideband) return;
    live.sideband.send({ type: "session.instructions.append", delegation_id: null, content: kind === "sketch" ? SKETCH_VOICE_LINE : PHOTO_VOICE_LINE });
  });
  startDrawingWatcher();
  startCacheJanitor();
  startFileWatcher();
  startReferenceShelf();
  setInterval(() => expireDue(), 30_000).unref(); // approvals that ran out: the apps take the buttons away
  setInterval(() => expirePins(), 30_000).unref(); // "for today" pins go at his midnight (13.2)
  // Catch up on anything said before a restart that the memory keeper hasn't read yet.
  setTimeout(() => void runKeeper("startup"), 45_000); // a no-op in dev
  // Forget website logins that sat unused too long (30 days idle, 90 days max): at start, then every 6 hours.
  const expire = () => void expireLogins().catch((err) => console.warn("[browser] expiry:", err instanceof Error ? err.message : err));
  if (!DEV) {
    setTimeout(expire, 60_000);
    setInterval(expire, 6 * 3600_000);
  }
  // Stage 16: a turn in The Brain this gateway was holding when it last stopped was cut off; say so (never patch its files).
  void recoverCutOff().then((cut) => (cut.length ? deliverDue(new Date()) : undefined)).catch((err) => console.warn("[brainlink] restart check:", err instanceof Error ? err.message : err));
  startBrainWatch();
  if (devAllows("SCHEDULER")) startScheduler();
  if (DEV) console.log(`DEV MODE: data in ${DATA_DIR}. No pushes, routines, keeper or browser jobs; approved sends go to the demo outbox.`);
});

/** For tests that run the gateway in-process (tests/gateway.ts); voiceCall takes a scripted call. */
export { server, call as voiceCall, table as roundTable };
