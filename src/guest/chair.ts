// The chair (Stage 17.2): the app, not the models, decides whose turn it is, how long a turn may be, and when to stop and
// hand back to the owner. Two models left to themselves agree politely or go round in circles.
//
// The rules, in code:
//   - the owner speaking always takes the floor: whatever is being worked out or said stops;
//   - a turn addressed by name goes to that one ("Tim, what do you think?", "Pebble, check that");
//   - an open question: the assistant answers first, then the guest responds to the question and to that answer;
//   - "discuss it" / "you two work it through" / "argue it out": up to `rounds` rounds of the two (at most four), then stop;
//   - "devil's advocate": the guest argues the strongest case against for this exchange, and says so;
//   - after any exchange between the two, the assistant closes in two sentences (where they agree, where they differ, the
//     question back to the owner), then silence until the owner speaks; "keep going" gives another round;
//   - a turn that only agrees ("I agree, nothing to add") ends the exchange there;
//   - a turn too long to say gets one request for the short version; if that's still long, its first four whole
//     sentences are kept (never cut mid-thought);
//   - never more lines from the two between the owner's turns than the round limit allows.
// The speakers and the way a line is said or shown are passed in, so tests drive it with scripted speakers.
import type { GuestTask, Line, Names, PebbleTask, Speaker } from "./brief.js";
import type { GuestReply } from "./guest.js";

export type TableLine = Line & { id: string; at: number; kind?: "start" | "end" | "note" | "close" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (t: string) => t.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
const words = (t: string) => norm(t).split(" ").filter(Boolean);

/* ---------------- what the owner's words mean ---------------- */

/** Bringing the guest in: "bring in Tim", "pull up Tim there", "pull Tim into this", "get Tim's view", "let's put this to
 * Tim", "a round table with Tim". The gateway acts on these from the transcript itself (Stage 18.1), not only when the
 * voice hands them over. */
export function startsTable(text: string, guest: string) {
  const g = esc(norm(guest));
  const t = norm(text);
  return new RegExp(
    [
      `\\b(bring|get|grab|call|invite|rope|pull|loop|wheel|have)( ${g} in| in ${g}| ${g} into)\\b`,
      `\\b(bring|get|loop|rope|pull|grab) ${g} (in|into|on|onto|up|over)\\b`,
      // "pull up Tim there, will ya" (Stage 18.1, from the record; not "pull up Tim's number")
      `\\b(pull|bring|get|grab) up ${g}(?!'?s\\b)\\b`,
      `\\b${g}'?s (view|take|opinion|thoughts|two cents|angle)\\b`,
      `\\b(put|run|throw|bounce|pass|take) (this|that|it|the idea|the question|them) (to|past|by|at|off|over to) ${g}\\b`,
      `\\b(ask|see what|find out what|hear what|what does|what would) ${g} (thinks?|reckons?|says?|would say)\\b`,
      `\\bround ?table\\b.*\\b${g}\\b`,
      `\\b${g}\\b.*\\bround ?table\\b`,
    ].join("|"),
  ).test(t);
}

export type Intent =
  | { kind: "end" }
  | { kind: "know" }
  | { kind: "deep"; ask: string }
  | { kind: "keep" }
  | { kind: "to"; who: "guest" | "pebble"; devil: boolean }
  | { kind: "discuss"; devil: boolean }
  | { kind: "devil" }
  | { kind: "open" }
  | { kind: "filler" }
  | { kind: "echo" };

const FILLER = /^(mm+|hmm+|mhm|uh huh|uh|um|yeah|yep|yes|right|okay|ok|sure|cool|go on|true)$/;

/** pebble: the assistant's names (its own, and "Pebble"). */
export function classify(text: string, n: { guest: string; pebble: string[] }): Intent {
  const t = norm(text);
  const g = esc(norm(n.guest));
  const p = n.pebble.map((x) => esc(norm(x))).filter(Boolean).join("|") || "pebble";
  if (!t || FILLER.test(t)) return { kind: "filler" };
  const ws = t.split(" ");
  // ending it: "thanks Tim", "that's all, Tim", "cheers Tim, see you", "end the round table" (but not "thanks Tim, but what about…")
  const thanks = new RegExp(`^(ok |okay |righto |right |good |great |nice )?(thanks|thank you|cheers|ta)( mate)? ${g}\\b(.*)$`).exec(t);
  if (thanks && words(thanks[4]).filter((w) => !/^(mate|that'?s|all|it|for now|now|bye|see|you|ya|later|good|great|done|for|that|very|much|heaps|appreciate)$/.test(w)).length <= 1) return { kind: "end" };
  if (new RegExp(`\\b(that'?s (all|it|enough|everything)|that'?ll do|we'?re (done|finished)|all done|you can go|off you go|see (you|ya)|bye|goodbye|later)( for now)?,? ${g}\\b`).test(t)) return { kind: "end" };
  if (new RegExp(`\\b(let ${g} go|send ${g} (away|off|home)|${g} can go|say (bye|goodbye) to ${g})\\b`).test(t)) return { kind: "end" };
  if (/\b(end|close|finish|stop|wrap up) (the |this )?round ?table\b/.test(t)) return { kind: "end" };
  // "what does Tim know?"
  if (new RegExp(`\\bwhat (does|did) ${g} know\\b|\\bwhat (have|did|'?ve) you (told|tell|sent|send|given|give) ${g}\\b|\\bwhat('s| has| was| is) ${g} (been )?(told|sent|given)\\b`).test(t)) return { kind: "know" };
  // a proper review in the background
  if (/\b(sleep on (it|that|this)|review (this|that|it) properly|properly review|proper (review|look|think)|take (his|your) time (with|on|over) (it|this|that)|think (it|this|that) over properly|mull (it|this|that) over)\b/.test(t)) return { kind: "deep", ask: text.trim() };
  if (/^(keep going|carry on|go on then|continue|another round|go another round|keep at it|more|go again|one more round|again)$/.test(t) || /\b(keep going|carry on|another round)\b/.test(t)) return { kind: "keep" };
  const devil = /\bdevil'?s advocate\b/.test(t);
  // (a question to both, "what would you two do?", is an open question, not "discuss it")
  const verb = "(discuss|work|sort|thrash|hash|argue|talk|nut|debate|figure|chew|have it out)";
  if (new RegExp(`\\b(discuss (it|this|that)|(you two|you both|the two of you),? ${verb}|between (you|yourselves|the two of you)|work it (out|through)|argue it out|thrash it out|hash it out|nut it out|talk it (through|over|out)|debate (it|this|that))\\b`).test(t))
    return { kind: "discuss", devil };
  // addressed by name: at the start ("Tim, what…", "Tim what do you reckon") or at the end ("…, Tim?", "over to you Tim")
  const first = ws.slice(0, 2).join(" ");
  const last = ws.slice(-2).join(" ");
  const toG = new RegExp(`^(hey |ok |okay |so |and |right )?${g}\\b`).test(first) || new RegExp(`\\b${g}$`).test(last) || new RegExp(`\\b(over to you|your turn|what do you (think|reckon)|your (view|take)),? ${g}\\b`).test(t);
  const toP = new RegExp(`^(hey |ok |okay |so |and |right )?(${p})\\b`).test(first) || new RegExp(`\\b(${p})$`).test(last);
  if (toG && (!toP || new RegExp(`^(hey |ok |okay |so |and |right )?${g}\\b`).test(first))) return { kind: "to", who: "guest", devil };
  if (devil) return { kind: "devil" };
  if (toP) return { kind: "to", who: "pebble", devil: false };
  return { kind: "open" };
}

/** What bringing the guest in asks for: his view straight away ("get Tim's view on this", "bring in Tim, should I buy a
 * second ute?"), the two of them discussing it, him arguing against it, or nothing yet ("bring in Tim"). */
export function inviteWants(text: string, guest: string): "view" | "discuss" | "devil" | null {
  const t = norm(text);
  const g = esc(norm(guest));
  if (/\bdevil'?s advocate\b/.test(t)) return "devil";
  if (/\b((you two|you both|the two of you),? (discuss|work|sort|thrash|hash|argue|talk|nut|debate|figure)|between (you|yourselves|the two of you)|discuss (it|this|that)|argue it out|thrash it out|hash it out|work it (out|through))\b/.test(t)) return "discuss";
  if (new RegExp(`\\b${g}'?s (view|take|opinion|thoughts|two cents|angle)\\b|\\b(put|run|throw|bounce|pass|take) (this|that|it|the idea|the question|them) (to|past|by|at|off|over to) ${g}\\b|\\b(ask|see what|find out what|hear what|what does|what would) ${g} (thinks?|reckons?|says?|would say)\\b|\\bsecond opinion\\b`).test(t)) return "view";
  // the invitation with a question or a topic in it ("bring in Tim, should I buy a second ute?")
  const rest = t
    .replace(new RegExp(`\\b(hey |can you |could you |let'?s |lets |please |i want to |i'?d like to |we should )?(bring|get|grab|call|invite|rope|pull|loop|wheel|have) (in |up )?${g}( in| into| on| up| over)?( (the|this) (conversation|chat|table))?\\b`), " ")
    .replace(/\b(pebble|so we can|and then|we can|have a|dialogue|chat|between the three of us|the three of us|here|there|now|mate|please|will ya|will you|okay|ok|righto|for a (sec|minute|bit))\b/g, " ");
  return words(rest).filter((w) => w.length > 2).length >= 3 || /\?/.test(text) ? "view" : null;
}

/** Only agreeing, nothing added: "I agree, nothing to add." */
export function agreesOnly(text: string) {
  const t = norm(text);
  if (words(text).length > 12) return false;
  return /^(i )?(agree|agreed|totally agree|fully agree|same|same here|i'?m with (him|her|them|you|\p{L}+))\b.*\b(nothing (more |else |much )?to add|no notes|that'?s (it|all))$/u.test(t) || /^(nothing (more |else )?to add|no notes|i agree|agreed)$/.test(t);
}

/** The most a turn may run to at the table: about 25 seconds spoken. */
export const MAX_WORDS = 70;
/** Too long to say at the table: more than four sentences, or past about 70 words. */
export function tooLong(text: string) {
  return sentences(text).length > 4 || words(text).length > MAX_WORDS;
}
/** The short version when asking again didn't give one: whole sentences, at most four, up to the word limit (at least one). */
export function keepWhole(text: string) {
  const out: string[] = [];
  let n = 0;
  for (const s of sentences(text).slice(0, 4)) {
    const w = words(s).length;
    if (out.length && n + w > MAX_WORDS) break;
    out.push(s);
    n += w;
  }
  return out.join(" ");
}
export function sentences(text: string) {
  // a sentence ends at . ! or ? followed by a space ("3.5", "D2.14" and "A-101." at the very end are handled)
  return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?]["”’)]*)\s+/).map((s) => s.trim()).filter(Boolean);
}
/** The first n whole sentences: never a cut mid-thought. */
export const firstSentences = (text: string, n: number) => sentences(text).slice(0, n).join(" ");

/** What the microphone heard is one of the speakers' own lines coming back through the speaker, not the owner. */
export function isEcho(heard: string, said: string) {
  const h = words(heard).filter((w) => w.length > 2);
  if (h.length < 3) return false;
  const s = new Set(words(said));
  return h.filter((w) => s.has(w)).length / h.length >= 0.7;
}

/* ---------------- whose turn ---------------- */

/** say: a fixed line of the assistant's (the chair's own words: "I've asked Tim to sleep on it"), not a brain turn. */
export type Step = { who: "pebble"; task: PebbleTask; say?: string } | { who: "guest"; task: GuestTask };
export type Shape = "open" | "discuss" | "devil";

/** The turns for one exchange. rounds: the "discuss it" setting (1 to 4). */
export function planFor(intent: Intent, rounds: number, last: Shape | null): { steps: Step[]; shape: Shape | null } {
  const R = Math.max(1, Math.min(4, rounds));
  const P = (task: PebbleTask): Step => ({ who: "pebble", task });
  const G = (task: GuestTask): Step => ({ who: "guest", task });
  switch (intent.kind) {
    case "to":
      if (intent.who === "pebble") return { steps: [P("answer")], shape: null };
      return intent.devil ? { steps: [G("against"), P("close")], shape: "devil" } : { steps: [G("answer")], shape: null };
    case "devil":
      return { steps: [G("against"), P("close")], shape: "devil" };
    case "discuss": {
      const lead: Step[] = intent.devil ? [G("against")] : [P("open"), G("respond")];
      const more: Step[] = [];
      for (let i = 1; i < R; i++) more.push(P("reply"), intent.devil ? G("against") : G("again"));
      return { steps: [...lead, ...more, P("close")], shape: intent.devil ? "devil" : "discuss" };
    }
    case "keep":
      return { steps: [P("reply"), last === "devil" ? G("against") : G("again"), P("close")], shape: last ?? "discuss" };
    case "open":
      return { steps: [P("open"), G("respond"), P("close")], shape: "open" };
    default:
      return { steps: [], shape: null };
  }
}

/** The most lines the two may say between the owner's turns: every round of the two, and the close. */
export const lineLimit = (rounds: number) => 2 * Math.max(1, Math.min(4, rounds)) + 1;

/* ---------------- the chair itself ---------------- */

export type ChairDeps = {
  names: () => Names & { pebbleAlso?: string[] };
  rounds: () => number;
  /** The assistant's turn (the real brain, with its tools). lines: the table so far; long: its own last answer, when
   * asked for the short version. Null when it couldn't answer. */
  pebble: (a: { task: PebbleTask; lines: TableLine[]; long?: string; afterOwner: boolean; signal: AbortSignal }) => Promise<string | null>;
  /** The guest's turn. fresh: what's been said since its last turn (it carries its own conversation). */
  guest: (a: { task: GuestTask; lines: TableLine[]; fresh: TableLine[]; signal: AbortSignal }) => Promise<GuestReply>;
  /** Say or show a line; resolves once it has been said (or shown, typed). The signal is the exchange's: stop if it goes. */
  deliver: (l: TableLine, signal: AbortSignal) => Promise<void>;
  /** A line's words are known (its id is the one it will be delivered with): its speech can be made now. */
  ready?: (id: string, speaker: "pebble" | "guest", text: string) => void;
  /** The owner's words, as they join the table. */
  heard?: (l: TableLine) => void;
  thinking?: (who: "pebble" | "guest" | null) => void;
  /** The guest couldn't be reached at all (missing, signed out, switched off): the round table can't go on. */
  guestGone?: (why: string) => void;
};

let seq = 0;
const lineId = () => `tl_${Date.now().toString(36)}${(++seq).toString(36)}`;

export class Chair {
  readonly lines: TableLine[] = [];
  brief = "";
  /** How far into lines the guest has heard (it carries its own conversation, so it only needs what's after). */
  private guestHeard = 0;
  private ac: AbortController | null = null;
  private running: Promise<void> | null = null;
  private last: Shape | null = null;
  /** Lines the two have said since the owner last spoke (never more than lineLimit). */
  spoke = 0;

  constructor(private d: ChairDeps) {}

  get busy() {
    return !!this.ac;
  }

  add(speaker: Speaker, text: string, kind?: TableLine["kind"], id = lineId()): TableLine {
    const l: TableLine = { id, speaker, text: text.trim(), at: Date.now(), ...(kind ? { kind } : {}) };
    this.lines.push(l);
    return l;
  }

  /** The owner took the floor: anything being worked out or said stops now. */
  stop() {
    this.ac?.abort();
    this.ac = null;
    this.d.thinking?.(null);
  }

  /** Wait for the exchange in progress (tests, and the end of a round table). */
  settled() {
    return this.running ?? Promise.resolve();
  }

  /** The last line either of the two said (for telling an echo from the owner). */
  lastSaid() {
    for (let i = this.lines.length - 1; i >= 0; i--) if (this.lines[i].speaker !== "owner") return this.lines[i];
    return null;
  }

  /**
   * The owner said something at the table. Returns what it meant; an exchange it starts runs on (await settled()).
   * end, know and deep are the round table's to act on; the chair only notes the owner's words for them.
   */
  owner(text: string): Intent {
    const said = this.lastSaid();
    if (said && Date.now() - said.at < 30_000 && isEcho(text, said.text)) return { kind: "echo" };
    const n = this.d.names();
    const intent = classify(text, { guest: n.guest, pebble: [n.pebble, "pebble", ...(n.pebbleAlso ?? [])] });
    if (intent.kind === "filler") return intent;
    this.stop();
    this.spoke = 0;
    const l = this.add("owner", text);
    this.d.heard?.(l);
    const plan = planFor(intent, this.d.rounds(), this.last);
    if (plan.steps.length) this.exchange(plan.steps, plan.shape);
    return intent;
  }

  /** The owner brought the guest in: the brief and "Tim's here", then whatever the invitation asked for. */
  begin(text: string) {
    this.stop();
    const l = this.add("owner", text);
    this.d.heard?.(l);
    const wants = inviteWants(text, this.d.names().guest);
    const R = this.d.rounds();
    const rest =
      wants === "discuss" ? planFor({ kind: "discuss", devil: false }, R, null)
      : wants === "devil" ? planFor({ kind: "devil" }, R, null)
      : wants === "view" ? { steps: [{ who: "guest", task: "first" } as Step], shape: null }
      : { steps: [] as Step[], shape: null };
    this.exchange([{ who: "pebble", task: "brief" }, ...rest.steps], rest.shape);
  }

  /** Run one exchange: each speaker's next line is worked out while the one before it is still being said. */
  exchange(steps: Step[], shape: Shape | null) {
    this.stop();
    const ac = new AbortController();
    this.ac = ac;
    if (shape) this.last = shape;
    const limit = lineLimit(this.d.rounds());
    const run = async () => {
      let saying: Promise<void> = Promise.resolve();
      let first = true;
      for (const step of steps) {
        if (ac.signal.aborted || this.spoke >= limit) break;
        const said = await this.speak(step, ac.signal, first);
        if (ac.signal.aborted || !said) break;
        this.d.thinking?.(null); // the words are ready: nobody's thinking until the next one starts
        // a speaker who couldn't answer: the assistant says so in one plain line, and the exchange stops there
        const id = lineId();
        const who = "note" in said ? ("pebble" as const) : step.who;
        const text = "note" in said ? said.note : said.text;
        this.d.ready?.(id, who, text); // its speech can be made while the line before is still being said
        await saying; // the line before has been said
        if (ac.signal.aborted) break;
        const l = this.add(who, text, "note" in said ? "note" : said.kind, id);
        if (step.who === "guest" && "text" in said) this.guestHeard = this.lines.length;
        if (l.kind !== "start") this.spoke++; // "Tim's here" isn't one of the exchange's lines
        saying = this.d.deliver(l, ac.signal).catch(() => undefined);
        if ("note" in said) {
          // he can't come at all: once that's been said, the round table hears it (and ends)
          if (said.gone) {
            await saying;
            this.d.guestGone?.(said.gone);
          }
          break;
        }
        if (l.kind === "start") continue;
        // only agreeing ends the exchange there (no close needed: there's nothing between them to sum up)
        if (!first && agreesOnly(said.text)) break;
        first = false;
      }
      await saying;
      if (this.ac === ac) this.ac = null;
      this.d.thinking?.(null);
    };
    this.running = run().catch((e) => console.warn("[table] exchange failed:", e instanceof Error ? e.message : e));
  }

  /** One speaker's words for a step, kept short enough to say; or the plain line to say instead when it couldn't answer.
   * Null: stopped. */
  private async speak(step: Step, signal: AbortSignal, first: boolean): Promise<{ text: string; kind?: TableLine["kind"] } | { note: string; gone?: string } | null> {
    if (step.who === "pebble" && step.say) return { text: step.say, kind: "note" };
    this.d.thinking?.(step.who);
    if (step.who === "pebble" && step.task === "brief") {
      // Bringing the guest in: the assistant writes his brief (shown to the owner, never read out whole), and says one line.
      const brief = await this.d.pebble({ task: "brief", lines: this.lines, afterOwner: true, signal });
      if (signal.aborted) return null;
      this.brief = (brief ?? "").replace(/\s+/g, " ").trim();
      return { text: `${this.d.names().guest}'s here${this.brief ? ", and I've filled him in" : ""}.`, kind: "start" };
    }
    if (step.who === "pebble") {
      let text = await this.d.pebble({ task: step.task, lines: this.lines, afterOwner: first, signal });
      if (signal.aborted) return null;
      if (text === null) return { note: "Sorry, I lost my thread there. Say that again?" };
      if (tooLong(text)) {
        const again = await this.d.pebble({ task: "shorter", lines: this.lines, long: text, afterOwner: first, signal });
        if (signal.aborted) return null;
        text = keepWhole(again && words(again).length < words(text).length ? again : text);
      }
      return { text, ...(step.task === "close" ? { kind: "close" as const } : {}) };
    }
    const fresh = this.lines.slice(this.guestHeard);
    const r = await this.d.guest({ task: step.task, lines: this.lines, fresh, signal });
    if (signal.aborted) return null;
    if (!r.ok) return { note: r.line, ...(r.why === "missing" || r.why === "signed_out" || r.why === "off" ? { gone: r.why } : {}) };
    this.guestHeard = this.lines.length;
    let text = r.text;
    if (tooLong(text)) {
      const again = await this.d.guest({ task: "shorter", lines: this.lines, fresh: [], signal });
      if (signal.aborted) return null;
      text = keepWhole(again.ok && words(again.text).length < words(text).length ? again.text : text);
    }
    return { text };
  }
}
