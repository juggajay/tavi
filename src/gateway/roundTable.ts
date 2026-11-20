// The round table in the gateway (Stage 17): brings the guest in when the owner asks, runs the chair (src/guest/chair.ts)
// with the real brain as the assistant and the guest through Codex, keeps the screens up to date, writes every line to
// the conversation log (marked as a round table), and ends it when he says so or after ten quiet minutes.
//
// Kept apart from server.ts on purpose (it's what server.ts calls): the gateway passes in its brain queue, its context,
// the apps and the voice. With no round table on, nothing here runs and nothing it touches changes.
//
// The conversation log: the assistant's lines at the table are role "assistant", the guest's are role "guest", both on
// the "table" channel ("test" for a test). The owner's own words are already logged by the gateway as he says or types
// them, before the round table sees them.
import { Chair, startsTable, sentences, type Intent, type TableLine } from "../guest/chair.js";
import { Guest, guestConfig } from "../guest/guest.js";
import { archiveCodex } from "../guest/codex.js";
import { deepPrompt, firstPrompt, nextPrompt, pebbleTaskLine, TABLE_RULES, transcriptText, type Line, type Names } from "../guest/brief.js";
import { assistantName } from "../profile/profile.js";
import { audit, logConversation } from "../store/log.js";
import { finishJob } from "../store/jobs.js";
import { db } from "../store/db.js";
import { RECENT } from "../brain/brain.js";
import { SPOKEN_AFTER_HANDOVER } from "../brain/rules.js";
import type { Origin } from "../shared/protocol.js";
import type { Answer } from "./voiceCall.js";
import type { LineVoices } from "../guest/voice.js";
import { createBotRooms, type RoomTeam } from "../hq/rooms.js";

/** For the live voice while a round table is on: everything goes to the backend, and it never speaks for either of them. */
export const TABLE_VOICE_LINE = (n: Names) =>
  `A round table is on: the user brought in ${n.guest}, a second assistant. The backend's lines and ${n.guest}'s are played on the user's device in their own voices; you don't say them. While it's on, generate <|SpawnThinking|> for EVERYTHING the user says, as soon as they finish saying it, even thanks, goodbyes and small talk. That includes anything said to ${n.guest} by name ("${n.guest}, what do you think?") or to ${n.pebble}: you are how it reaches them, so hand it over at once, never wait for more. Say nothing yourself beyond the one short acknowledgement when asked for it. Never answer ${n.guest}, never repeat or comment on what he says, and if you hear his voice, that isn't the user: ignore it.`;
export const TABLE_OVER_LINE = "The round table is over: go back to the delegation policy in your instructions.";

/** The note that closes a hand-over quietly: the round table says its own lines. */
const QUIET = "(Tavi) The round table is answering this: its lines are played on the user's device. Say nothing about it and don't answer it yourself.";
const ECHO = "(Tavi) That was a voice from the round table coming through the speaker, not the user. Say nothing.";

export type TableDeps = {
  rooms?: RoomTeam;
  /** One of the assistant's turns: the real brain in the gateway's queue (never alongside another request). Its words, or null. */
  think: (a: { request: string; said: string; test: boolean; voice: boolean; origin: Origin | null; clientId: string | null; outside: boolean; signal: AbortSignal; task: string; tableId: string }) => Promise<string | null>;
  /** The usual context for a request (memory, calendar, what's on the asker's screen). */
  context: (said: string, clientId: string | null) => string;
  /** To every v2 app. */
  toApps: (m: Record<string, unknown>) => void;
  /** A line for the live voice's instructions; only called while a call is on. */
  instruct?: (text: string) => void;
  callOn?: () => boolean;
  /** Something to read on screen (what Tim knows, Tim's review), opened on the asker's screen. */
  note: (title: string, text: string, o: { origin: Origin | null; test: boolean; source: string }) => void;
  /** A notice that speaks first when it arrives (Tim's review, done in the background). */
  notify: (title: string, spoken: string) => void;
  /** To one app: by voice, the lines are sent to the app on the call to be said (Stage 17.3). */
  toClient?: (id: string, m: Record<string, unknown>) => void;
  /** What makes the lines' speech (src/guest/voice.ts); null when there's no voice key. */
  voices?: () => LineVoices | null;
  /** The call's own voice: Pebble's lines are said in it, Tim's in another. */
  pebbleVoice?: () => string;
  /** The device mutes the call's own voice while the round table is on, and un-mutes it after (Stage 18.1). */
  muteCall?: (muted: boolean) => void;
  /** Where now is on the call's own timeline (null with no call), for the call's trace. */
  timeline?: () => number | null;
};

/** A line sent to be said by voice, and when (wall clock): its echo through the speaker isn't the owner (Stage 18.1). */
type Played = { id: string; text: string; from: number; to: number | null; cut: boolean };
export type AudioLine = TableLine & { bot?: string; name?: string; voice?: string };
export type AudioTable = Pick<Table, "id" | "mode" | "clientId" | "fakeCall" | "voices" | "played"> & { chair: { stop(): void } };

// Both versions use this one queue and the same word from the phone when a line ends.
export function createTableAudio(d: TableDeps) {
  const waiting = new Map<string, (r: "played" | "cut") => void>();
  const byVoice = (t: AudioTable) => t.mode === "voice" && !!t.clientId && !!d.toClient && (t.fakeCall || !!d.callOn?.());
  const voices = (t: AudioTable) => (t.voices ??= d.voices?.() ?? null);
  function voiceOf(l: AudioLine) {
    if (l.voice) return l.voice;
    const p = d.pebbleVoice?.() ?? "marin";
    const g = guestConfig().voice;
    return l.speaker !== "guest" ? p : g !== p ? g : p === "cedar" ? "marin" : "cedar";
  }
  async function say(t: AudioTable, l: AudioLine, signal: AbortSignal) {
    if (signal.aborted) return;
    const v = voices(t);
    if (!v || !t.clientId || !d.toClient) return;
    v.prepare(l.id, l.text, voiceOf(l));
    if (signal.aborted) return;
    const sent = Date.now();
    const sentAt = d.timeline?.() ?? null;
    const p: Played = { id: l.id, text: l.text, from: sent, to: null, cut: false };
    t.played = [...t.played.slice(-5), p];
    const result = new Promise<"played" | "cut" | "late" | "stopped">((resolve) => {
      const stop = () => finish("stopped");
      const timer = setTimeout(() => finish("late"), 10_000 + l.text.split(/\s+/).length * 500);
      const finish = (how: "played" | "cut" | "late" | "stopped") => {
        clearTimeout(timer); waiting.delete(l.id); signal.removeEventListener("abort", stop); resolve(how);
      };
      waiting.set(l.id, finish);
      signal.addEventListener("abort", stop, { once: true });
    });
    d.toClient(t.clientId, { type: "table_say", id: l.id, speaker: l.speaker, text: l.text, audio: `/api/table/audio/${l.id}`,
      ...(l.bot ? { bot: l.bot, name: l.name } : {}) });
    const r = await result;
    p.to = Date.now(); p.cut = r === "cut" || r === "stopped";
    audit("voice", "table_said", t.id, { id: l.id, speaker: l.speaker, voice: voiceOf(l), ...(l.bot ? { bot: l.bot } : {}), text: l.text.slice(0, 120), how: r,
      ms: Date.now() - sent, made_first_ms: v.get(l.id)?.firstMs ?? null, ...(sentAt !== null ? { at_ms: sentAt } : {}) });
    if (r === "stopped") d.toClient(t.clientId, { type: "table_hush" });
    if (r === "cut") t.chair.stop();
  }
  return { byVoice, voices, say, client(m: Record<string, unknown>) {
    const id = typeof m.id === "string" ? m.id : "";
    if (m.type === "table_played") waiting.get(id)?.("played");
    else if (m.type === "table_cut") waiting.get(id)?.("cut");
  } };
}
/** Just after a line has been said, words that are only its own come back through the microphone a moment later. */
const ECHO_TAIL_MS = 3000;

/** Most of the words heard (at least min of them, of three letters or more) are in what was said. */
function echoWords(heard: string, said: string, min: number) {
  const w = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const h = w(heard).filter((x) => x.length > 2);
  if (h.length < min) return false;
  const s = new Set(w(said));
  return h.filter((x) => s.has(x)).length / h.length >= 0.7;
}

/**
 * The microphone heard the round table's own voice, not him (Stage 18.1). The app stops a line the moment he speaks over
 * it (unless what it hears is only a filler or the line's own words), so: words that came in while a line was being said
 * and it wasn't stopped are the speaker; just after a line, words that are only its own; and within half a minute, words
 * that are mostly one of the last lines. A line he did cut short: what came in with it is his.
 */
function echoOf(t: Table, text: string, h: { first: number; last: number }) {
  const now = Date.now();
  for (const p of t.played) {
    if (p.cut && h.first >= p.from) continue;
    const to = p.to ?? now;
    if (h.first >= p.from && h.first <= to) return true;
    if (h.first > to && h.first - to <= ECHO_TAIL_MS && echoWords(text, p.text, 2)) return true;
    if (now - to < 30_000 && echoWords(text, p.text, 3)) return true;
  }
  // (shown or said, the last few lines of the two: the chair's own echo check, over more than the last line)
  const recent = t.chair.lines.filter((l) => l.speaker !== "owner" && now - l.at < 30_000).slice(-3);
  return recent.some((l) => !t.played.some((p) => p.id === l.id && p.cut) && echoWords(text, l.text, 3));
}

export type TableState = {
  on: boolean;
  id: string | null;
  names: Names;
  brief: string;
  lines: (Pick<TableLine, "id" | "speaker" | "text" | "at"> & { kind?: string })[];
  thinking: "pebble" | "guest" | null;
  speaking: "pebble" | "guest" | null;
  test: boolean;
};

type Table = {
  id: string;
  chair: Chair;
  guest: Guest;
  names: Names & { pebbleAlso: string[] };
  test: boolean;
  origin: Origin | null;
  clientId: string | null;
  mode: "voice" | "typed";
  thinking: "pebble" | "guest" | null;
  speaking: "pebble" | "guest" | null;
  idle: ReturnType<typeof setTimeout> | null;
  /** The voice's hand-over waiting for the round table's first line: closed quietly when it's said. */
  release: ((note: string) => void) | null;
  ending: boolean;
  /** The lines' speech, made while the round table is on by voice (Stage 17.3). */
  voices: LineVoices | null;
  /** Dev only: the screens' checks stand in for a call (no voice service). */
  fakeCall: boolean;
  /** The lines sent to be said by voice (the last few), for telling his words from their echo. */
  played: Played[];
};

/** Ten quiet minutes and the round table ends by itself. */
const IDLE_MS = () => Number(process.env.LH_TABLE_IDLE_MS) || 10 * 60_000;
/** The transcript the assistant is given: the newest lines up to about this many characters, with a summary of the rest. */
const PEBBLE_BUDGET = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** At the table the assistant is Pebble, the character on screen (what the owner calls it: "Pebble, bring in Tim"); its
 * own name, if it has one, still works for talking to it ("Mate, check that"). */
const names = (): Names & { pebbleAlso: string[] } => ({ guest: guestConfig().name, pebble: "Pebble", pebbleAlso: [assistantName() ?? ""].filter(Boolean) });
const lastOwner = (lines: Line[]) => [...lines].reverse().find((l) => l.speaker === "owner")?.text ?? "";

/** The table for the assistant: the newest lines that fit, and what fell out of it summed up by the closes it said. */
export function pebbleView(lines: TableLine[], n: Names, budget = PEBBLE_BUDGET) {
  const kept: TableLine[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].text.length + 20;
    if (size > budget && kept.length >= 4) break;
    kept.unshift(lines[i]);
  }
  const dropped = lines.slice(0, lines.length - kept.length);
  const closes = dropped.filter((l) => l.kind === "close").map((l) => l.text);
  const summary = dropped.length ? `Earlier at the table (${dropped.length} lines, not shown): ${closes.length ? `you summed it up as: ${closes.slice(-3).join(" Then: ")}` : "the start of the discussion."}\n` : "";
  return summary + transcriptText(kept, n);
}

/** A round table cut off by a restart left its Codex conversation open: archived (never deleted) once things settle. */
export async function archiveLeftovers() {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = db.prepare("SELECT event, detail FROM audit_log WHERE actor = 'guest' AND event IN ('said', 'archived') AND ts >= ?").all(since) as { event: string; detail: string }[];
  const done = new Set(rows.filter((r) => r.event === "archived" && JSON.parse(r.detail).ok).map((r) => JSON.parse(r.detail).session as string));
  const open = [...new Set(rows.filter((r) => r.event === "said").map((r) => JSON.parse(r.detail).session as string))].filter((s) => s && !done.has(s));
  for (const s of open) audit("guest", "archived", null, { session: s, ok: await archiveCodex(s), leftover: true });
  return open.length;
}

export function createRoundTable(d: TableDeps) {
  const audio = createTableAudio(d);
  if (process.env.LH_V3 === "1") return createBotRooms(d, audio);
  let cur: Table | null = null;
  /** The last round table's id, for "what does Tim know?" from Settings after it's over. */
  let lastId: string | null = null;
  if (!process.env.LH_QUIET) setTimeout(() => void archiveLeftovers().catch(() => undefined), 30_000).unref?.();

  const state = (): TableState => {
    const t = cur;
    return {
      on: !!t,
      id: t?.id ?? null,
      names: t?.names ?? names(),
      brief: t?.chair.brief ?? "",
      lines: (t?.chair.lines ?? []).slice(-40).map((l) => ({ id: l.id, speaker: l.speaker, text: l.text, at: l.at, ...(l.kind ? { kind: l.kind } : {}) })),
      thinking: t?.thinking ?? null,
      speaking: t?.speaking ?? null,
      test: t?.test ?? false,
    };
  };
  const push = () => d.toApps({ type: "table", ...state() });

  const touch = (t: Table) => {
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(() => void end(t, "quiet"), IDLE_MS());
    t.idle.unref?.();
  };

  const channel = (t: Table) => (t.test ? "test" : "table") as "test" | "table";

  /* ---------- by voice (Stage 17.3): each line made into speech and said by the app on the call, one at a time ---------- */
  /** Who's waiting on an app's word that a line has been said (or cut). */
  const { byVoice, voices } = audio;
  /** Pebble in the call's own voice; Tim in his own, never the same as Pebble's. */
  function voiceOf(speaker: "pebble" | "guest" | "owner") {
    const p = d.pebbleVoice?.() ?? "marin";
    if (speaker !== "guest") return p;
    const g = guestConfig().voice;
    return g !== p ? g : p === "cedar" ? "marin" : "cedar";
  }
  function prepare(t: Table, id: string, speaker: "pebble" | "guest" | "owner", text: string) {
    if (byVoice(t)) voices(t)?.prepare(id, text, voiceOf(speaker));
  }
  /** Said by the app on the call; resolves when it says it's been said, the owner cut in, or it's taken far too long. */
  async function sayByVoice(t: Table, l: TableLine, signal: AbortSignal) {
    return audio.say(t, l, signal);
  }

  /** A line of the assistant's or the guest's: logged, shown, said. */
  async function deliver(t: Table, l: TableLine, signal: AbortSignal) {
    if (signal.aborted || cur !== t) return;
    // the hand-over that asked for this exchange is closed quietly: the round table says its own lines
    t.release?.(QUIET);
    t.release = null;
    logConversation(l.speaker === "guest" ? "guest" : "assistant", channel(t), l.text);
    audit(l.speaker === "guest" ? "guest" : "brain", "table_line", t.id, { id: l.id, kind: l.kind ?? null, chars: l.text.length });
    t.speaking = l.speaker === "owner" ? null : l.speaker;
    push();
    touch(t);
    try {
      if (byVoice(t)) await sayByVoice(t, l, signal);
      else await sleep(signal.aborted ? 0 : 250); // typed: just shown, a beat apart
    } finally {
      if (cur === t && t.speaking === l.speaker) {
        t.speaking = null;
        push();
      }
    }
  }

  function makeTable(o: { origin: Origin | null; clientId: string | null; test: boolean; mode: "voice" | "typed"; fakeCall?: boolean }): Table {
    const id = `tbl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const cfg = guestConfig();
    const t: Table = { id, names: names(), test: o.test, origin: o.origin, clientId: o.clientId, mode: o.mode, thinking: null, speaking: null, idle: null, release: null, ending: false, guest: new Guest(id, cfg), chair: null as unknown as Chair, voices: null, fakeCall: !!o.fakeCall, played: [] };
    t.chair = new Chair({
      names: () => t.names,
      rounds: () => guestConfig().rounds,
      pebble: async ({ task, lines, long, afterOwner, signal }) => {
        const said = lastOwner(lines);
        const voice = t.mode === "voice" && afterOwner && task !== "brief";
        const request = [
          `Context:\n${d.context(said, t.clientId)}`,
          ...(task === "brief" ? [`Recent conversation:\n${RECENT}`] : []),
          TABLE_RULES(t.names),
          ...(t.chair.brief ? [`The brief you gave ${t.names.guest} when he came in: ${t.chair.brief}`] : []),
          `The round table so far:\n${pebbleView(lines, t.names)}`,
          ...(long ? [`What you just said: "${long.replace(/\s+/g, " ")}"`] : []),
          `The chair: ${pebbleTaskLine(task, t.names)}`,
          ...(voice ? [SPOKEN_AFTER_HANDOVER] : []),
          `Round table, your turn: "round-table:${task}"`,
        ].join("\n\n");
        return d.think({ request, said, test: t.test, voice, origin: t.origin, clientId: t.clientId, outside: lines.some((l) => l.speaker === "guest"), signal, task, tableId: t.id });
      },
      guest: ({ task, lines, fresh, signal }) =>
        t.guest.turn((isFresh) => (isFresh ? firstPrompt({ names: t.names, brief: t.chair.brief, lines, task }) : nextPrompt({ names: t.names, lines: fresh, task })), signal),
      deliver: (l, signal) => deliver(t, l, signal),
      ready: (id, speaker, text) => prepare(t, id, speaker, text),
      thinking: (who) => {
        if (cur !== t || t.thinking === who) return;
        t.thinking = who;
        push();
      },
      guestGone: (why) => {
        audit("guest", "unavailable", t.id, { why });
        // he can't come at all: the line saying so has been said; the round table ends quietly
        void end(t, "gone");
      },
    });
    return t;
  }

  /** Bring him in. */
  function start(text: string, o: { origin: Origin | null; clientId: string | null; test: boolean; mode: "voice" | "typed"; fakeCall?: boolean }) {
    const t = makeTable(o);
    cur = t;
    lastId = t.id;
    audit("guest", "table.start", t.id, { by: o.mode, test: o.test, model: t.guest.cfg.model });
    if (d.callOn?.()) d.instruct?.(TABLE_VOICE_LINE(t.names));
    // the call's own voice is muted on the device for as long as it's on: only the table's lines are heard (18.1)
    if (d.callOn?.() || t.fakeCall) d.muteCall?.(true);
    touch(t);
    t.chair.begin(text);
    push();
    return t;
  }

  /** It's over: "thanks Tim", ten quiet minutes, or he couldn't come. */
  async function end(t: Table, why: "asked" | "quiet" | "gone" | "replaced") {
    if (t.ending || cur !== t) return;
    t.ending = true;
    if (t.idle) clearTimeout(t.idle);
    t.chair.stop();
    const line = why === "asked" ? `Thanks, ${t.names.guest}. Just me again.` : why === "quiet" ? `I've let ${t.names.guest} go; it's been quiet a while.` : null;
    if (line) {
      const l = t.chair.add("pebble", line, "end");
      const ac = new AbortController();
      await deliver(t, l, ac.signal);
    }
    t.release?.(QUIET);
    t.release = null;
    if (d.callOn?.()) d.instruct?.(TABLE_OVER_LINE);
    d.muteCall?.(false);
    t.voices?.close();
    audit("guest", "table.end", t.id, { why, lines: t.chair.lines.length });
    if (cur === t) cur = null;
    push();
    await t.guest.close({ keepForReview: true });
  }

  /** "What does Tim know?": everything sent to him, exactly as sent, on screen; the brief said. */
  function know(t: Table) {
    const sent = t.guest.sent;
    const body = sent.length
      ? sent.map((s, i) => `${i + 1}. ${s.kind === "review" ? "For his written review" : "For a turn at the table"}, ${new Date(s.at).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" })}:\n\n${s.prompt}`).join("\n\n————\n\n")
      : `Nothing yet. When he's asked for his view, he'll get his standing brief, this brief and what's said at the table:\n\n${t.chair.brief || "(no brief)"}`;
    d.note(`What ${t.names.guest} knows`, `Everything sent to ${t.names.guest} at this round table, exactly as it was sent. Nothing else of yours reaches him: not your memory, your files, your email or your drawings.\n\n${body}`, { origin: t.origin, test: t.test, source: "Round table" });
    const say = t.chair.brief ? `It's on your screen. In short, I told him this: ${t.chair.brief}` : `It's on your screen. He's heard only what's been said here.`;
    t.chair.exchange([{ who: "pebble", task: "answer", say }], null);
  }

  /** "Ask Tim to sleep on it": his careful model, in the background; a written review later, with one line said. */
  function deep(t: Table, ask: string) {
    const n = t.names;
    t.chair.exchange([{ who: "pebble", task: "answer", say: `I've asked ${n.guest} to sleep on it. His review will come through when it's done, usually a few minutes.` }], null);
    const lines = [...t.chair.lines];
    void (async () => {
      const r = await t.guest.review(deepPrompt({ names: n, brief: t.chair.brief, lines, ask }));
      if (!r.ok) {
        d.notify(`${n.guest}'s review`, r.line);
      } else {
        const first = sentences(r.text)[0] ?? r.text.slice(0, 200);
        d.note(`${n.guest}'s review`, r.text, { origin: t.origin, test: t.test, source: `${n.guest}, on ${t.guest.cfg.deepModel}` });
        logConversation("guest", channel(t), `${n.guest}'s review: ${r.text}`);
        if (cur === t) {
          t.chair.add("guest", r.text, "note");
          push();
        }
        d.notify(`${n.guest}'s review`, `${n.guest}'s review is in. ${first}`);
      }
      audit("guest", "review.delivered", t.id, { ok: r.ok, ms: r.ms });
      if (cur !== t) await t.guest.close();
    })();
  }

  /** The owner said something at the table. */
  function owner(t: Table, text: string, mode: "voice" | "typed"): Intent {
    t.mode = mode;
    const intent = t.chair.owner(text);
    if (intent.kind === "echo" || intent.kind === "filler") return intent;
    touch(t);
    push();
    if (intent.kind === "end") void end(t, "asked");
    else if (intent.kind === "know") know(t);
    else if (intent.kind === "deep") deep(t, intent.ask);
    return intent;
  }

  const api = {
    get on() {
      return !!cur;
    },
    state,
    lastTableId: () => cur?.id ?? lastId,
    /** The round table wants these words: one is on, or they bring the guest in. */
    wants(text: string) {
      if (cur) return true;
      const cfg = guestConfig();
      return cfg.enabled && startsTable(text, cfg.name);
    },
    /** Typed at the table (desktop or phone). jobId: the job the gateway made for the message (marked done here).
     * asVoice (dev only): the screens' checks stand in for a call, so the lines are said by the app as on a real one. */
    typed(text: string, o: { origin: Origin | null; clientId: string | null; test: boolean; jobId?: string; asVoice?: boolean }) {
      if (o.jobId) finishJob(o.jobId, { spoken: "(round table)" });
      const mode = o.asVoice ? "voice" : "typed";
      if (!cur) return void start(text, { ...o, mode, fakeCall: o.asVoice });
      if (o.test !== cur.test && !cur.test) {
        // a test line never joins the owner's own round table
        return;
      }
      if (o.asVoice) (cur.fakeCall = true), (cur.clientId = o.clientId);
      owner(cur, text, mode);
    },
    /** A hand-over from the voice at the table. The answer is a quiet close, sent when the table's first line is said.
     * Anything the round table was saying has already stopped: the app stops it the moment he starts talking. */
    handOver(utterance: string, o: { origin: Origin | null; clientId: string | null; jobId: string; heard?: { first: number; last: number } }): Promise<Answer> {
      finishJob(o.jobId, { spoken: "(round table)" });
      if (cur && o.clientId) cur.clientId = o.clientId; // the lines are said by the app on the call
      // the round table's own voice coming back through the speaker (Stage 18.1): not him, nothing happens
      if (cur && o.heard && echoOf(cur, utterance, o.heard)) {
        audit("voice", "table_echo", cur.id, { text: utterance.slice(0, 200) });
        return Promise.resolve({ silent: ECHO });
      }
      return new Promise<Answer>((resolve) => {
        let done = false;
        const release = (note: string) => {
          if (done) return;
          done = true;
          resolve({ silent: note });
        };
        setTimeout(() => release(QUIET), 45_000).unref?.(); // never left hanging
        if (!cur) {
          const t = start(utterance, { origin: o.origin, clientId: o.clientId, test: false, mode: "voice" });
          t.release = release;
          return;
        }
        const t = cur;
        t.release?.(QUIET); // an older hand-over still waiting: closed now
        t.release = release;
        const intent = owner(t, utterance, "voice");
        if (intent.kind === "echo") release(ECHO);
        else if (intent.kind === "filler") release(QUIET);
      });
    },
    /** From an app: End was tapped, a line it was asked to say has been said, or the owner cut in (Stage 17.3). */
    client(m: Record<string, unknown>) {
      if (m.type === "table_end" && cur) return void end(cur, "asked");
      const id = typeof m.id === "string" ? m.id : "";
      if (m.type === "table_played") {
        if (cur && typeof m.first_ms === "number") audit("voice", "table_heard", cur.id, { id, first_ms: Math.round(m.first_ms), waited_ms: typeof m.waited_ms === "number" ? Math.round(m.waited_ms) : null });
      }
      audio.client(m);
    },
    /** Ends it from outside (the app's End button, a restart). */
    end: (why: "asked" | "replaced" = "asked") => (cur ? end(cur, why) : Promise.resolve()),
    /** Words heard on the call are the round table's own lines coming back through the speaker, not him (Stage 18.1). */
    echo: (text: string, heard: { first: number; last: number }) => {
      const t = cur;
      if (!t || !echoOf(t, text, heard)) return false;
      audit("voice", "table_echo", t.id, { text: text.slice(0, 200) });
      return true;
    },
    /** For tests: wait until nothing is being worked out or said. */
    settled: () => cur?.chair.settled() ?? Promise.resolve(),
    /** "What does Tim know?" for the PC's Settings: every prompt sent at the last round table, from the activity log. */
    sentAt(id: string | null) {
      if (!id) return [];
      return (db.prepare("SELECT ts, detail FROM audit_log WHERE actor = 'guest' AND event = 'sent' AND ref = ? ORDER BY id").all(id) as { ts: string; detail: string }[]).map((r) => {
        const x = JSON.parse(r.detail) as { prompt: string; review?: boolean; model: string };
        return { at: r.ts, kind: x.review ? "review" : "turn", model: x.model, prompt: x.prompt };
      });
    },
  };
  return api;
}
export type RoundTable = ReturnType<typeof createRoundTable>;
