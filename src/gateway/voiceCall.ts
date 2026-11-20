// One voice call as the gateway sees it through the sideband (Stage 10): what the owner says, what the voice says,
// hand-overs to the brain, and the answers sent back to be spoken. Kept out of server.ts so a scripted run of live events
// can be fed to it in a test.
//
// Everything is written to audit_log so a complaint ("it said okay twice") can be checked against what happened:
//   user  heard       the owner's words, once they're handled (handed: true when they went to the brain)
//   voice said        a finished line of the voice's own speech, with the hand-over it belongs to and whether it came
//                     before or after the answer was sent back
//   voice delegation  a hand-over, and whether new words came with it
//   voice commentary  something sent for the voice to say (its text, length and ms since the hand-over): the answer
//                     whole, or a sentence at a time while the brain writes it (Stage 10.5), or the one "Still on it."
//   voice appended    the voice service's receipt for it (where it landed on the call's timeline)
//   voice answered    the hand-over's answer is complete (how many pieces, how long it took)
//   voice interrupted the owner cut in while an answer was coming: the rest isn't sent
//   voice acted       the gateway started the turn itself, with no hand-over (Stage 18): why, and what the voice had said
//   voice hushed      at a round table the voice started talking by itself: told to stop (its sound is off on the device)
//   voice call.start / call.end
// Every row carries at_ms: where it sits on the call's own timeline (the voice service's clock), so the trace script
// (scripts/voice-trace.mjs) can put them in the order they were heard. A voice line said while the device had the call's
// voice muted (a round table, Stage 18.1) is marked unheard: it's in the record, but he never heard it.
//
// Stage 18: the voice is ears and a mouth; it doesn't decide whether work happens. Two things are done from the
// transcript by the gateway itself, hand-over or not, and the repeat guard (10.3) makes a late hand-over for the same
// words a quiet nothing, so one line of his is one turn:
//   - at a round table (and for the words that start one), each finished line of his goes to the round table about a
//     second after his last word, unless a hand-over has already taken it; the table's own voices coming back through
//     the speaker are dropped (deps.echo);
//   - anywhere else, when the voice answers him by itself with a promise of work, a refusal or a claim about what can be
//     done (promises.ts), or he named it, changed a setting or spoke to the guest by name, and no hand-over came for
//     those words within a short wait, they go to the brain, which is told what the voice already said.
import { audit, logConversation } from "../store/log.js";
import { createJob } from "../store/jobs.js";
import { remainderAfter } from "../brain/spoken.js";
import type { LiveEvent } from "./live.js";
import { continues, mustGo, noise, overreach } from "./promises.js";

/** at: when the words reached the gateway (wall clock), for telling him from the round table's own voices. */
type Heard = { text: string; start: number; end: number; at: number };
export type SidebandLike = { send(e: Record<string, unknown>): string };

/** One hand-over to the brain and what came of it. */
export type Turn = {
  id: string; // delegation id
  utterance: string;
  jobId: string | null;
  handedAt: number; // wall-clock ms
  answered: boolean; // the answer (or its first piece) has been sent to the voice
  readOut: boolean; // the voice has started saying it
  done: boolean;
  finishedAt: number;
  sent: string[];
  abort: AbortController;
  /** Closed without an answer: nothing new came with it (Stage 10.3). */
  ignored?: boolean;
  /** Replaced by this later hand-over (a correction); its own answer is never said. */
  superseded?: string;
  /** The answer's pieces sent so far (Stage 10.5), and where on the call's timeline the first went. */
  pieces: string[];
  firstAt?: number | null;
  /** The owner cut in while the answer was coming: nothing more of it is sent. */
  interrupted?: boolean;
  fillerSent?: boolean;
  fillerTimer?: ReturnType<typeof setTimeout>;
  /** The brain's own latest line of what it's doing (its progress tool, Stage 21.3): said as the one filler, if any. */
  note?: string;
  /** Started by the gateway from the transcript, not by a hand-over (Stage 18): its id is the gateway's own, so what's
   * sent for it goes to the session as a whole (delegation_id null). */
  gateway?: boolean;
};

/** Why the gateway started a turn itself (Stage 18). */
export type ActedBy = "table" | "table-start" | "promise" | "claim" | "naming" | "setting" | "by name";

type Line = { text: string; start: number; end: number; turn: Turn | null; when: "before" | "after" | null; unheard?: boolean };

/** silent: close the hand-over with a note the voice reads but doesn't say (a round table says its own lines, Stage 17). */
export type Answer = { spoken: string; fast?: boolean } | { silent: string } | null;

export type HandOver = {
  delegationId: string;
  utterance: string;
  jobId: string;
  /** What they asked just before, still unanswered, that this corrects or adds to (Stage 10.3). */
  corrects?: string;
  /** Aborted when a correction replaces this hand-over. */
  signal?: AbortSignal;
  /** Send one whole sentence of the answer now, while the rest is still being written (Stage 10.5). */
  speak?: (piece: string) => void;
  /** The brain says, in its own words, what it's doing now (Stage 21.3): kept for the one filler. */
  note?: (line: string) => void;
  /** The gateway started this turn itself (Stage 18), and why. */
  by?: ActedBy;
  /** What the voice had already said to him by itself, for the brain to correct rather than repeat (Stage 18.2). */
  voiceSaid?: string;
  /** When his words reached the gateway (wall clock), first and last: the round table drops its own voices' echo. */
  heard?: { first: number; last: number };
};

export type VoiceDeps = {
  bot?: () => string | undefined;
  deliver?: (text: string, ref: string | null, signal: AbortSignal) => Promise<boolean>;
  /** Answer a hand-over: the fast path or the brain. null when it failed (the voice says sorry). */
  answer: (t: HandOver) => Promise<Answer>;
  /** Stop a job (a correction replaced it). */
  cancel?: (jobId: string) => void;
  /** The gateway's short rolling context. */
  remember?: (line: string) => void;
  now?: () => number;
  /** How long to let trailing transcript words land after a hand-over (ms). */
  settleMs?: number;
  /** With no words at all yet, how long to wait for a late transcript (ms from the hand-over). */
  lateMs?: number;
  /** The longest a hand-over waits for the owner to finish talking (ms). */
  maxWaitMs?: number;
  /** Silence after which a line of the voice's speech counts as finished (ms, wall clock). */
  lineIdleMs?: number;
  /** After this long with nothing said since the acknowledgement, one "Still on it." (ms; 0 for never). */
  fillerMs?: number;
  /** The sit-down is on: its answers are quick, so no filler. */
  sitdown?: () => boolean;
  /** A round table is on (Stage 18.1): every finished line of his goes to it, handed over or not. */
  table?: () => boolean;
  /** These words bring the guest in (Stage 18.1): acted on from the transcript, handed over or not. */
  startsTable?: (text: string) => boolean;
  /** The guest's name (for "anything said to another assistant by name"). */
  guest?: () => string;
  /** Words that came in while a round-table line was being said (or just after): its own voice coming back, not him. */
  echo?: (text: string, heard: { first: number; last: number }) => boolean;
  /** How long after his last word reaches the gateway it acts by itself at a round table (ms). */
  actMs?: number;
  /** After the voice promises work, refuses, or is asked something only the brain may answer, how long a hand-over has
   * to turn up before the gateway sends the words to the brain itself (ms). */
  promiseWaitMs?: number;
};

/** The one filler (Stage 10.5): said once, through the sideband, when an answer has taken FILLER_MS. */
export const FILLER = "Still on it.";
export const FILLER_MS = 6000;
/** A piece of work's result is said only once he hasn't spoken for this long (Stage 21.3): not over him, not mid-sentence. */
export const QUIET_MS = 2500;
/** At a round table, a line of his goes to it this long after his last word arrives, if no hand-over has taken it
 * (Stage 18.1). Words arrive a few tenths of a second after they're said, so that's about 1.3 s after his last word. */
export const ACT_MS = 1000;
/** The voice answered by itself with a promise, a refusal or a claim: a hand-over has this long to show up (Stage 18.2).
 * In the record (13 and 14 November, 59 hand-overs) every hand-over came before the voice said anything: its "okay"
 * starts 1.2 to 1.4 s after the hand-over. So a promise with no hand-over yet almost never gets one; this is the margin. */
export const PROMISE_WAIT_MS = 1500;
/** At a round table, what the gateway tells the voice when it starts talking by itself (its sound is off on the device). */
export const HUSH = "(Tavi) A round table is on: say nothing at all. The user can't hear you; the round table answers for itself. Only listen, and generate <|SpawnThinking|> for whatever the user says.";

const SORRY = "Sorry, I couldn't get that done just now. Try me again in a sec.";

export function joinWords(words: Heard[]) {
  return words.map((w) => w.text).join("").replace(/\s+/g, " ").trim();
}

export class VoiceCall {
  private sb: SidebandLike | undefined;
  private userTurn: Heard[] = []; // what the owner has said since the voice last spoke
  /** Most recent finished owner line (the fallback when a hand-over finds no fresh words). */
  lastUserLine = "";
  private capturing = false; // a hand-over is collecting the owner's words
  private line: Line | null = null; // the voice's line in progress
  private lastVoiceEnd = 0;
  private lineTimer: ReturnType<typeof setTimeout> | null = null;
  private turn: Turn | null = null; // the latest hand-over; lines are counted against it until the next exchange
  /** Owner words the voice has started replying to, which a hand-over arriving now would claim. */
  private claimable: { words: Heard[]; said: string } | null = null;
  readonly turns = new Map<string, Turn>();
  private receipts = new Map<string, { turn: Turn | null; piece: number }>();
  private t0: number | null = null; // wall-clock ms at the call timeline's zero (estimated)
  private lastHeardAt = 0; // real time the owner's last words came in
  private collecting: Promise<void> = Promise.resolve();
  /** Hand-overs still gathering their words (Stage 18: the gateway leaves those words to them). */
  private gathering = 0;
  /** Waiting to act on his words by itself, about a second after his last word (Stage 18.1). */
  private actTimer: ReturnType<typeof setTimeout> | null = null;
  /** The voice answered him by itself with a promise, refusal or claim (or about something only the brain may answer):
   * waiting a moment for a hand-over before the gateway sends his words to the brain (Stage 18.2). */
  private promise: { words: Heard[]; said: string; why: ActedBy; line: Line | null; timer: ReturnType<typeof setTimeout> } | null = null;
  private seq = 0;
  /** The device has the call's voice muted (a round table: its lines are played by the app): what it says is unheard. */
  muted = false;
  private callAbort = new AbortController();

  constructor(private deps: VoiceDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  /** Where "now" sits on the call's timeline, as near as can be told. */
  private atMs() {
    return this.t0 === null ? null : Math.max(0, Math.round(this.now() - this.t0));
  }
  /** The same, for the round table's own rows in the call's record (null with no call). */
  get timeline() {
    return this.sb ? this.atMs() : null;
  }
  /** Things that have already happened (the owner's words, a hand-over) fix the timeline: they can't arrive early. */
  private clock(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const t = this.now() - ms;
    if (this.t0 === null || t < this.t0) this.t0 = t;
  }

  get live() {
    return !!this.sb;
  }

  attach(sb: SidebandLike, sessionId?: string) {
    this.end();
    this.callAbort = new AbortController();
    this.sb = sb;
    audit("voice", "call.start", sessionId ?? null, { ...(this.deps.bot?.() ? { bot: this.deps.bot() } : {}), at_ms: 0 });
  }

  /** The call ended (hung up, closed or replaced): finish the line in progress and forget the call's state. */
  end(usage?: unknown, reason?: string) {
    if (!this.sb) return;
    this.flushLine();
    audit("voice", "call.end", null, { at_ms: this.atMs(), ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) });
    this.sb = undefined;
    this.callAbort.abort();
    if (this.deps.deliver) for (const turn of this.turns.values()) turn.abort.abort();
    this.userTurn = [];
    this.capturing = false;
    this.line = null;
    this.claimable = null;
    this.turn = null;
    this.lastReal = null;
    this.t0 = null;
    this.receipts.clear();
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    if (this.actTimer) clearTimeout(this.actTimer);
    this.actTimer = null;
    if (this.promise) clearTimeout(this.promise.timer);
    this.promise = null;
    this.muted = false;
  }

  send(e: Record<string, unknown>) {
    return this.sb?.send(e);
  }

  onEvent(e: LiveEvent) {
    switch (e.type) {
      case "session.input_transcript.delta": {
        const h = { text: String(e.delta ?? ""), start: Number(e.start_ms ?? 0), end: Number(e.end_ms ?? 0), at: Date.now() };
        this.clock(h.end);
        this.lastHeardAt = h.at;
        this.armAct();
        // Cutting in while a streamed answer is coming: the voice stops by itself; the rest of it is never sent.
        const t = this.turn;
        if (t && t.pieces.length && !t.done && !t.interrupted && t.firstAt != null && h.start > t.firstAt) {
          t.interrupted = true;
          audit("voice", "interrupted", t.id, { sent: t.pieces.length, at_ms: h.start });
        }
        // The owner started talking: whatever the voice was saying has stopped (unless it may be a hand-over's "one
        // sec" still waiting for its event).
        if (this.line && !this.userTurn.length && !this.claimable) this.flushLine();
        this.userTurn.push(h);
        break;
      }
      case "session.output_transcript.delta": {
        const start = Number(e.start_ms ?? 0);
        if (this.line && start - this.lastVoiceEnd > 1500) this.flushLine();
        // The first thing it says after an answer was sent is that answer being read out, whatever the owner said meanwhile.
        const reading = !this.line && !!this.turn?.answered && !this.turn.readOut;
        if (reading) {
          this.turn!.readOut = true;
          this.line = { text: "", start, end: start, turn: this.turn, when: "after" };
        }
        // Otherwise the voice is speaking after the owner said something. Either it's answering them itself, or it's the
        // "one sec" of a hand-over whose event hasn't arrived yet: the words are held until one or the other is clear
        // (a hand-over claims them; otherwise they're the voice's to answer once this line is finished).
        if (!reading && this.userTurn.length && !this.capturing && !this.claimable) {
          const words = this.userTurn;
          this.userTurn = [];
          const said = joinWords(words);
          if (said) {
            this.flushLine();
            this.claimable = { words, said };
            this.lastUserLine = said;
            if (this.turn?.answered) this.turn = null; // a new exchange
          }
        }
        const fresh = !this.line;
        if (!this.line)
          this.line = this.claimable
            ? { text: "", start, end: start, turn: null, when: null }
            : { text: "", start, end: start, turn: this.turn, when: this.turn ? (this.turn.answered ? "after" : "before") : null };
        if (this.muted) this.line.unheard = true;
        this.line.text += String(e.delta ?? "");
        this.line.end = Number(e.end_ms ?? start);
        this.lastVoiceEnd = this.line.end;
        this.armLineTimer();
        if (this.deps.table?.()) {
          // At a round table the voice only listens: something of its own is told to stop (he can't hear it anyway)
          if (fresh && !reading && this.sb) {
            this.sb.send({ type: "session.instructions.append", delegation_id: null, content: HUSH });
            audit("voice", "hushed", null, { at_ms: start });
          }
        } else this.checkOverreach();
        break;
      }
      case "session.delegation.created": {
        const d = e.delegation as { id?: string } | undefined;
        const offset = Number(e.offset_ms ?? 0);
        this.clock(offset);
        if (d?.id) {
          // at a round table the acknowledgement isn't wanted: the call's voice is muted there (Stage 18.1)
          if (this.deps.table?.()) this.sb?.send({ type: "session.thinking.append", delegation_id: d.id, content: "" });
          void this.handOver(d.id, offset);
        }
        break;
      }
      case "session.commentary.appended": {
        const r = this.receipts.get(String(e.client_event_id ?? ""));
        if (r) {
          this.receipts.delete(String(e.client_event_id));
          audit("voice", "appended", r.turn?.id ?? null, { piece: r.piece, start_ms: Number(e.start_ms ?? 0), end_ms: Number(e.end_ms ?? 0), at_ms: Number(e.start_ms ?? 0) });
        }
        break;
      }
    }
  }

  private heard(text: string, words: Heard[], handed: boolean, by?: ActedBy) {
    audit("user", "heard", null, { text, start_ms: words[0]?.start ?? null, end_ms: words.at(-1)?.end ?? null, at_ms: words[0]?.start ?? this.atMs(), handed, ...(by ? { acted: by } : {}) });
  }

  private armLineTimer() {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = setTimeout(() => this.flushLine(), this.deps.lineIdleMs ?? 2000);
    this.lineTimer.unref?.();
  }

  /** A line of the voice's speech is finished: keep it in the rolling context and the audit log. Owner words it was
   * a reply to, unclaimed by a hand-over, were answered by the voice itself. */
  private flushLine() {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
    const l = this.line;
    this.line = null;
    const c = this.claimable;
    if (c) {
      this.claimable = null;
      if (this.deps.table?.() || this.deps.startsTable?.(c.said)) {
        // at a round table (or bringing the guest in) they're never the voice's to answer: the gateway takes them (18.1)
        this.userTurn = [...c.words, ...this.userTurn];
        if (!this.actTimer) this.armAct();
      } else {
        // (words the gateway may still send to the brain itself, Stage 18.2, are written down when that's decided)
        if (this.promise?.words !== c.words) this.heard(c.said, c.words, false);
        this.deps.remember?.(`User: ${c.said}`);
      }
    }
    const text = l?.text.replace(/\s+/g, " ").trim();
    if (!l || !text) return;
    this.deps.remember?.(`Assistant: ${text}`);
    audit("voice", "said", l.turn?.id ?? null, { text, when: l.when, start_ms: l.start, end_ms: l.end, at_ms: l.start, ...(l.unheard ? { unheard: true } : {}) });
  }

  /** Send something for the voice to say, for a hand-over (and record it). */
  private say(turn: Turn, content: string, kind: "answer" | "fast" | "sorry" | "filler", piece = 1, last = true) {
    if (!this.sb) return; // the call has ended: nothing to say it to
    // What the voice said before this is a finished line; what it says from here is the answer (or the filler).
    this.flushLine();
    if (kind !== "filler") turn.answered = true;
    turn.sent.push(content);
    // (a turn the gateway started itself has no hand-over to answer: it goes to the session as a whole)
    const id = this.sb?.send({ type: "session.commentary.append", delegation_id: turn.gateway ? null : turn.id, content });
    if (id) this.receipts.set(id, { turn, piece });
    audit("voice", "commentary", turn.id, { kind, piece, ...(this.deps.bot?.() ? { bot: this.deps.bot() } : {}), ...(kind === "answer" ? { last } : {}), text: content, chars: content.length, ms: this.now() - turn.handedAt, at_ms: this.atMs() });
  }

  /** One whole sentence of the answer, while the rest is still being written (Stage 10.5). Never after the owner has
   * cut in, never for a hand-over that's been replaced or finished. */
  private piece(turn: Turn, text: string) {
    if (!text || turn.done || turn.superseded || turn.interrupted || !this.sb) return;
    if (!turn.pieces.length) turn.firstAt = this.atMs();
    turn.pieces.push(text);
    this.say(turn, text, "answer", turn.pieces.length, false);
  }

  /** The one filler for a hand-over: through the sideband, so it's in the gateway's control. Since Stage 21.3 it's the
   * brain's own latest line of what it's doing ("Checking the official rules for cancelling the booking."), when it has said
   * one; otherwise "Still on it." Still once. */
  private filler(turn: Turn) {
    // (never at a round table: the call's voice is muted there, and the table has its own cue)
    if (turn.fillerSent || turn.answered || turn.done || turn.superseded || this.deps.sitdown?.() || this.deps.table?.()) return;
    turn.fillerSent = true;
    const own = turn.note?.trim().replace(/[.!…]*$/, "");
    this.say(turn, own ? `${own}.` : FILLER, "filler");
  }

  private armFiller(turn: Turn) {
    const ms = this.deps.fillerMs ?? FILLER_MS;
    if (!ms) return;
    turn.fillerTimer = setTimeout(() => this.filler(turn), ms);
    turn.fillerTimer.unref?.();
  }

  /**
   * The owner's words for a hand-over: the words the voice was replying to, then what's come in since, up to 1.5 s
   * after the hand-over and on for as long as they keep talking without a pause. A hand-over often comes at the first
   * pause ("I help at a club. | We meet every week..."), so it waits while words are still arriving (up to maxWaitMs),
   * and, when none have come at all, a little longer for a late transcript (lateMs).
   */
  private async collect(claimed: Heard[], offsetMs: number): Promise<Heard[]> {
    const t0 = Date.now();
    const pick = () => {
      const pool = [...new Set([...claimed, ...this.userTurn])].sort((a, b) => a.start - b.start);
      const take: Heard[] = [];
      for (const h of pool) {
        const prev = take.at(-1);
        if (h.start <= offsetMs + 1500 || (prev && h.start - prev.end <= 700)) take.push(h);
        else break;
      }
      return take;
    };
    await sleep(this.deps.settleMs ?? 350);
    const late = this.deps.lateMs ?? 1200;
    const max = this.deps.maxWaitMs ?? 2500;
    for (;;) {
      const waited = Date.now() - t0;
      const took = pick();
      // they carried on past the point where it handed over: wait for them to stop (600 ms with no new words)
      const carriedOn = took.some((h) => h.start > offsetMs);
      if (waited >= max) break;
      if (!took.length ? waited >= late : !carriedOn || Date.now() - this.lastHeardAt >= 600) break;
      await sleep(100);
    }
    const take = pick();
    this.userTurn = this.userTurn.filter((h) => !take.includes(h));
    return take;
  }

  /** The last hand-over that went to the brain (or the fast path), for spotting repeats and corrections. */
  private lastReal: Turn | null = null;

  /** Close a hand-over without answering it: a silent note for it, never something to say (Stage 10.3). */
  private ignore(turn: Turn, prev: Turn | null, why: "repeat" | "check-in" | "table") {
    turn.done = true;
    turn.ignored = true;
    if (prev) this.turn = prev; // what's said next still belongs to the hand-over being answered
    const content = !prev
      ? "(Tavi) Nothing new: the round table already has what the user said. Say nothing about it."
      : prev.done
        ? `(Tavi) Nothing new: that was "${prev.utterance}", already answered. Don't answer it again; say nothing more about it.`
        : `(Tavi) Nothing new: that's "${prev.utterance}", still being worked on. Its answer will come; don't answer for it and don't fill the wait.`;
    this.sb?.send({ type: "session.thinking.append", delegation_id: turn.id, content });
    if (why === "check-in" && prev && !prev.done) this.filler(prev); // "you still there?": the one "Still on it.", now
    audit("voice", "ignored_repeat", turn.id, { why, utterance: prev?.utterance ?? null, previous: prev?.id ?? null, ms_since: prev?.done ? this.now() - prev.finishedAt : null, at_ms: this.atMs() });
    console.log(`[live] delegation ${turn.id}: ignored (${why}${prev ? ` of ${prev.id}` : ""})`);
  }

  private async handOver(delegationId: string, offsetMs: number) {
    const handedAt = this.now();
    // The acknowledgement is the voice service's automatic one, 800 ms in (live.ts). Nothing is sent to cancel it.
    const turn: Turn = { id: delegationId, utterance: "", jobId: null, handedAt, answered: false, readOut: false, done: false, finishedAt: 0, sent: [], abort: new AbortController(), pieces: [] };
    this.gathering++;
    // A hand-over came after all: the voice's promise (Stage 18.2) is being kept, so the gateway leaves it alone. Words it
    // was waiting on that are no longer the voice's to answer are this hand-over's.
    const pending = this.dropPromise();
    // Words the voice was already replying to are this hand-over's, and that reply was its acknowledgement. So is a
    // line it started after the owner began speaking.
    const claimed = [...(pending && pending.words !== this.claimable?.words ? pending.words : []), ...(this.claimable?.words ?? [])];
    this.claimable = null;
    const ownerFrom = claimed[0]?.start ?? this.userTurn[0]?.start;
    if (this.line && ownerFrom !== undefined && this.line.start >= ownerFrom && (!this.line.turn || this.line.turn.answered))
      Object.assign(this.line, { turn, when: "before" as const });
    // (taken as the latest at once, so a second hand-over arriving while this one collects its words sees it)
    const prev = this.lastReal;
    this.lastReal = turn;
    // Still being answered, or answered under 30 seconds ago: a hand-over with nothing new for it is a repeat.
    const recent = !!prev && (!prev.done || this.now() - prev.finishedAt < 30_000);
    // Nothing new heard yet and it may be a repeat: hold the automatic acknowledgement off (a repeat must say nothing).
    if (recent && !claimed.length && !this.userTurn.length) this.sb?.send({ type: "session.thinking.append", delegation_id: delegationId, content: "" });
    this.turn = turn;
    this.turns.set(delegationId, turn);
    // The delegation event carries no task text: rebuild it from what the owner said since the voice last spoke.
    // One hand-over collects at a time: two close together (the voice handing over at two pauses in one sentence)
    // mustn't split the words between them; the second finds them taken, so it's a repeat.
    const before = this.collecting;
    let release = () => {};
    this.collecting = new Promise<void>((r) => (release = r));
    let words: Heard[];
    try {
      await before;
      this.capturing = true;
      words = await this.collect(claimed, offsetMs).finally(release);
      this.capturing = false;
    } finally {
      this.gathering--;
    }
    // what he said after these words is his next line (the gateway may act on it, Stage 18.1)
    if (this.userTurn.length) this.armAct();
    const fresh = joinWords(words);
    if (prev && recent && (!fresh || (!prev.done && CHECK_IN.test(fresh)))) {
      if (this.lastReal === turn) this.lastReal = prev;
      return this.ignore(turn, prev, fresh ? "check-in" : "repeat");
    }
    // At a round table the gateway takes every line of his itself (Stage 18.1), so a hand-over with nothing new is for
    // words already dealt with (or dropped as the table's own echo): never the "last thing said" again.
    if (!fresh && this.deps.table?.()) {
      if (this.lastReal === turn) this.lastReal = prev;
      return this.ignore(turn, null, "table");
    }
    return this.run(turn, words, fresh, prev, { offsetMs });
  }

  /** A turn with its words: to the brain (or the fast path, or the round table) and its answer back to the voice. */
  private async run(turn: Turn, words: Heard[], fresh: string, prev: Turn | null, o: { offsetMs: number; by?: ActedBy; voiceSaid?: string }) {
    const { handedAt, id: delegationId } = turn;
    // The old fallback, for what it was for: a hand-over whose words never arrived, about something not yet handed over.
    const utterance = fresh || this.lastUserLine;
    turn.utterance = utterance;
    // New words while the last one is still being worked on: one answer, for both (the voice is told a correction
    // changes the work already asked for). The first job is stopped and never said.
    const corrects = prev && !prev.done && fresh ? prev : null;
    if (corrects) {
      corrects.superseded = delegationId;
      corrects.abort.abort();
      if (corrects.jobId) this.deps.cancel?.(corrects.jobId);
      audit("voice", "superseded", corrects.id, { by: delegationId, at_ms: this.atMs() });
    }
    if (utterance) this.lastUserLine = utterance;
    if (fresh) this.heard(fresh, words, true, o.by);
    if (utterance) this.deps.remember?.(`User: ${utterance}`);
    const jobId = createJob("ask", "voice", utterance);
    turn.jobId = jobId;
    logConversation("user", "voice", utterance, jobId);
    // how long after his last word his words went on to be answered (the brain, the fast path or the round table)
    const at = this.atMs();
    const lastWord = words.at(-1)?.end;
    const after = at !== null && lastWord !== undefined ? { words_end_ms: lastWord, sent_on_ms: at - lastWord } : {};
    if (o.by) {
      audit("voice", "acted", delegationId, { by: o.by, utterance, ...(o.voiceSaid ? { voice_said: o.voiceSaid } : {}), at_ms: at ?? lastWord ?? null, ...after, ...(corrects ? { corrects: corrects.id } : {}) });
      console.log(`[live] the gateway acted (${o.by}): "${utterance}"`);
    } else {
      audit("voice", "delegation", delegationId, { utterance, new_words: !!fresh, offset_ms: o.offsetMs, at_ms: o.offsetMs, ...after, ...(corrects ? { corrects: corrects.id } : {}) });
      console.log(`[live] delegation ${delegationId}: "${utterance}"`);
    }

    this.armFiller(turn);
    const speak = (piece: string) => this.piece(turn, piece);
    const note = (line: string) => void (turn.note = line);
    const heard = words.length ? { first: words[0].at, last: words.at(-1)!.at } : undefined;
    const res = await this.deps.answer({ delegationId, utterance, jobId, corrects: corrects?.utterance, signal: turn.abort.signal, speak, note, by: o.by, voiceSaid: o.voiceSaid, heard }).catch(() => null);
    clearTimeout(turn.fillerTimer);
    turn.done = true;
    turn.finishedAt = this.now();
    if (turn.superseded) return; // replaced by a correction: its answer is never said
    if (res && "spoken" in res && this.deps.deliver && !turn.interrupted && !turn.abort.signal.aborted) {
      if (await this.deps.deliver(res.spoken, turn.id, turn.abort.signal)) {
        turn.answered = true; turn.readOut = true;
        this.deps.remember?.(`Assistant (backend result): ${res.spoken}`);
        if (!turn.gateway) this.sb?.send({ type: "session.thinking.append", delegation_id: turn.id, content: "The bot's answer was played on the phone. Say nothing yourself." });
        audit("voice", "answered", turn.id, { bot: this.deps.bot?.(), pieces: 1, chars: res.spoken.length, ms: this.now() - handedAt, at_ms: this.atMs(), silent: true });
        return;
      }
    }
    if (res && "silent" in res) {
      // A round table's hand-over (Stage 17): its lines are said on the device; the voice gets a quiet note and says
      // nothing. (A turn the gateway started has no hand-over to close.)
      turn.answered = true;
      turn.readOut = true; // (there's nothing for the voice to read out: what it says next is its own)
      if (!turn.gateway) this.sb?.send({ type: "session.thinking.append", delegation_id: turn.id, content: res.silent });
      audit("voice", "answered", turn.id, { pieces: 0, chars: 0, ms: this.now() - handedAt, at_ms: this.atMs(), silent: true });
      return;
    }
    if (res) this.deps.remember?.(res.fast ? `Assistant: ${res.spoken}` : `Assistant (backend result): ${res.spoken}`);
    const done = (extra: Record<string, unknown>) =>
      audit("voice", "answered", turn.id, { ...(this.deps.bot?.() ? { bot: this.deps.bot() } : {}), pieces: turn.pieces.length, chars: res?.spoken.length ?? 0, ms: this.now() - handedAt, at_ms: this.atMs(), ...extra });
    if (!turn.pieces.length) {
      // the whole answer at once (not streamed, or nothing whole came before the end)
      if (!turn.interrupted) this.say(turn, res ? res.spoken : SORRY, !res ? "sorry" : res.fast ? "fast" : "answer");
      return done({ streamed: false });
    }
    // Streamed: send what's left after the pieces already said, unless the owner cut in or the answer changed.
    const rest = res ? remainderAfter(res.spoken, turn.pieces) : null;
    if (rest === null) console.warn(`[live] ${turn.id}: the final answer didn't start with what was already said; nothing more sent`);
    else if (rest && !turn.interrupted) this.say(turn, rest, "answer", turn.pieces.length + 1, true);
    done({ streamed: true, ...(rest === null ? { changed: true } : {}), ...(turn.interrupted ? { interrupted: true } : {}) });
  }

  /* ---------- Stage 21.3: a piece of work is done ---------- */

  /** Nothing going on: he isn't talking (nor was in the last 2.5 s), the voice isn't saying anything, no hand-over is
   * gathering words or waiting for its answer, no promise is pending, and no round table is on. */
  private quiet() {
    // (an answer sent but not yet started by the voice is about to be said: that's busy too)
    const busy = (this.turn && (!this.turn.done || (this.turn.answered && !this.turn.readOut && this.now() - this.turn.finishedAt < 15_000))) || this.gathering > 0 || this.capturing || !!this.promise;
    // (words of his nobody handed over, 2.5 s ago or more, aren't a sentence in progress: he's talking to someone else)
    return !busy && !this.claimable && !this.line && Date.now() - this.lastHeardAt > QUIET_MS && !this.deps.table?.();
  }

  /**
   * Say something to him that nobody asked for just now (a piece of work he handed over has finished): when he isn't
   * mid-sentence and nothing else is being said or answered, it waits for such a moment (up to waitMs), then the voice
   * says it, as words for the call as a whole (the brain's words, said once). Resolves true when it was sent, false when
   * the call ended or no quiet moment came (the notice is on his screen either way).
   * waitMs and pollMs are for the tests.
   */
  announce(text: string, ref: string | null = null, waitMs = 120_000, pollMs = 400): Promise<boolean> {
    const until = Date.now() + waitMs;
    const session = this.sb;
    return new Promise((resolve) => {
      const tick = async () => {
        if (!this.sb || this.sb !== session) return resolve(false);
        if (this.quiet()) {
          if (this.deps.deliver && await this.deps.deliver(text, ref, this.callAbort.signal).catch(() => false)) {
            this.deps.remember?.(`Assistant (backend result): ${text}`);
            audit("voice", "commentary", ref, { bot: this.deps.bot?.(), kind: "result", piece: 1, text, chars: text.length, at_ms: this.atMs() });
            return resolve(true);
          }
          const id = this.sb.send({ type: "session.commentary.append", delegation_id: null, content: text });
          if (id) this.receipts.set(id, { turn: null, piece: 1 });
          this.deps.remember?.(`Assistant: ${text}`);
          audit("voice", "commentary", ref, { kind: "result", piece: 1, text, chars: text.length, at_ms: this.atMs() });
          return resolve(true);
        }
        if (Date.now() > until) {
          audit("voice", "result_not_said", ref, { why: "no quiet moment", at_ms: this.atMs() });
          return resolve(false);
        }
        setTimeout(tick, pollMs).unref?.();
      };
      tick();
    });
  }

  /* ---------- Stage 18: the gateway acts on his words itself ---------- */

  /** His words keep coming: about a second after the last of them, see whether the gateway acts on them itself. */
  private armAct() {
    if (this.actTimer) clearTimeout(this.actTimer);
    this.actTimer = setTimeout(() => this.act(), this.deps.actMs ?? ACT_MS);
    this.actTimer.unref?.();
  }

  /**
   * His line is finished. At a round table it goes to the round table now, and so do words that bring the guest in,
   * whether or not the voice handed them over (Stage 18.1). A hand-over still gathering words has them (it goes to the
   * same place); one that turns up later finds nothing new and is closed quietly (the repeat guard).
   */
  private act() {
    this.actTimer = null;
    if (!this.sb || this.gathering > 0) return;
    const pend = this.promise && this.promise.words !== this.claimable?.words ? this.promise.words : [];
    const pool = [...new Set([...pend, ...(this.claimable?.words ?? []), ...this.userTurn])].sort((a, b) => a.start - b.start);
    const text = joinWords(pool);
    if (!text) return;
    const by: ActedBy | null = this.deps.table?.() ? "table" : this.deps.startsTable?.(text) ? "table-start" : null;
    if (!by) return;
    // they're the gateway's now: no hand-over will take them, and nothing the voice said to them is his answer
    this.claimable = null;
    this.userTurn = [];
    this.dropPromise();
    const heardAt = { first: pool[0].at, last: pool.at(-1)!.at };
    if (by === "table") {
      // a filler or a noise, or the round table's own voice coming back through the speaker: not a turn
      const echo = !noise(text) && !!this.deps.echo?.(text, heardAt);
      if (noise(text) || echo) {
        audit("user", "heard", null, { text, start_ms: pool[0].start, end_ms: pool.at(-1)!.end, at_ms: pool[0].start, handed: false, ...(echo ? { echo: true } : {}) });
        return;
      }
    }
    this.gatewayTurn(pool, text, by);
  }

  /** A turn the gateway starts itself (Stage 18): like a hand-over that has its words, with an id of the gateway's own. */
  private gatewayTurn(words: Heard[], text: string, by: ActedBy, voiceSaid?: string) {
    const id = `gw_${Date.now().toString(36)}${(++this.seq).toString(36)}`;
    const turn: Turn = { id, gateway: true, utterance: "", jobId: null, handedAt: this.now(), answered: false, readOut: false, done: false, finishedAt: 0, sent: [], abort: new AbortController(), pieces: [] };
    // what the voice is saying to these words by itself belongs to this turn, said before its answer
    if (this.line && !this.line.turn && words.length && this.line.start >= words[0].start) Object.assign(this.line, { turn, when: "before" as const });
    const prev = this.lastReal;
    this.lastReal = turn;
    this.turn = turn;
    this.turns.set(id, turn);
    void this.run(turn, words, text, prev, { offsetMs: words.at(-1)?.end ?? 0, by, voiceSaid });
  }

  /**
   * The voice is answering him by itself (no hand-over has its words). If that's a promise of work, a refusal or a claim
   * about what can be done, or his words were naming it, changing a setting or said to the guest by name, a hand-over
   * gets a moment to turn up; then the gateway sends his words to the brain itself (Stage 18.2). Not for a filler or a
   * noise of his, nor for the rest of an answer it carries on reading after one.
   */
  private checkOverreach() {
    const c = this.claimable;
    const l = this.line;
    if (!c || !l || l.turn || this.promise || noise(c.said)) return;
    const last = this.turn ?? this.lastReal;
    if (last?.answered && continues(l.text, last.sent.join(" "))) return;
    const g = this.deps.guest?.() ?? "Tim";
    const why: ActedBy | null = mustGo(c.said, g) ?? overreach(l.text, g);
    if (!why) return;
    const timer = setTimeout(() => this.firePromise(), this.deps.promiseWaitMs ?? PROMISE_WAIT_MS);
    timer.unref?.();
    this.promise = { words: c.words, said: c.said, why, line: l, timer };
  }

  /** No hand-over came: his words go to the brain, with what the voice said to them. */
  private firePromise() {
    const p = this.promise;
    if (!p || !this.sb) return;
    this.promise = null;
    if (this.claimable?.words === p.words) this.claimable = null;
    const voiceSaid = (p.line?.text ?? "").replace(/\s+/g, " ").trim();
    this.gatewayTurn(p.words, p.said, p.why, voiceSaid || undefined);
  }

  private dropPromise() {
    const p = this.promise;
    if (!p) return null;
    clearTimeout(p.timer);
    this.promise = null;
    return p;
  }
}

/** Only a filler or "are you there?": while an answer is still coming, that's not a new question. */
const CHECK_IN = /^(?:(?:are )?you (?:still )?there|still there|hello|mm+|hmm+|uh[- ]?huh|yeah|yep|yes|okay|ok|right|cool|sure)[?.!,\s]*$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
