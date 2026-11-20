// What the voice is given to say: cleaned of stray markup, without a second "okay" in front (Stage 10.2), and, while
// the brain is still writing, a whole sentence at a time (Stage 10.5).

/**
 * What the voice will say, without markup the model sometimes leaks into its answer ("...map links.</spoken></invoke>").
 * The voice reads it aloud, so stray tags must never reach it.
 */
export function cleanSpoken(text: string) {
  return text
    .replace(/<\/?(?:spoken|card|invoke|parameter|function_calls|antml:[\w-]+)\b[^>]*>/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Stock acknowledgements the brain sometimes opens a spoken answer with. On a voice turn the voice has already said its
 * "okay", so one of these in front of the answer is a second one (Stage 10.2). Short and exact on purpose.
 */
const STOCK_ACKS = ["okay", "ok", "got it", "righto", "right-o", "sure thing", "sure", "no worries", "good stuff", "yep", "yeah", "alright", "all right", "gotcha", "will do", "too easy", "nice one"];
/** These answer a yes-or-no question, so they stay when that's what was asked. */
const AFFIRMATIVE = new Set(["yep", "yeah", "sure", "sure thing"]);
const YES_NO =
  /^\s*(?:(?:and|so|but|ok(?:ay)?|hey),?\s+)?(is|are|am|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|may|might|must|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|don['’]t|doesn['’]t|didn['’]t|can['’]t|couldn['’]t|won['’]t|wouldn['’]t|shouldn['’]t|hasn['’]t|haven['’]t)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Voice turns only: take one stock acknowledgement (with an optional name and comma, and a following "so") off the front
 * of the answer: "Okay Nemi, …", "Got it. …", "Righto, so …". Kept when the question was a yes-or-no one and it's a yes,
 * and whenever what's left would be under three words ("Okay." stays). names: what the user is called (from USER.md).
 */
export function stripOpening(spoken: string, question: string, names: string[] = []) {
  const who = [...names.filter(Boolean).map(esc), "mate"].join("|");
  const acks = STOCK_ACKS.map((a) => esc(a).replace(/ /g, "\\s+")).join("|");
  const m = new RegExp(`^\\s*(${acks})(?:[\\s,]+(?:${who}))?\\s*[,.!:;—–-]+\\s*(?:so,?\\s+)?(.*)$`, "is").exec(spoken);
  if (!m) return spoken;
  if (AFFIRMATIVE.has(m[1].toLowerCase().replace(/\s+/g, " ")) && YES_NO.test(question)) return spoken;
  const rest = m[2].trim();
  if (wordCount(rest) < 3) return spoken;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** A line the talking brain gives when it passes a question up (it's not the answer; on a voice turn it's never said). */
export const PASS_UP_LINE = /^\s*(let me|i'?ll|i will|i'?m going to) (have|take) a (proper|closer|careful|good) look\b/i;

/**
 * The spoken answer, a whole sentence at a time, while the brain is still writing it (Stage 10.5). update() is given
 * the answer so far (raw, as the model writes it); each sentence that's complete goes to emit once, cleaned, and the
 * first through stripOpening (held until there are at least three words after it, so "Got it." alone is never sent).
 * A sentence ends at . ! or ? followed by a space (so "D2.14" and "3.25" don't end one).
 */
export class SpokenPieces {
  private done = 0; // characters of the raw text already sent
  private seen = ""; // the raw text so far
  private closed = false;
  private sent: string[] = [];
  constructor(private o: { question: string; names: string[]; emit: (piece: string) => void; voice?: boolean }) {}

  get pieces() {
    return [...this.sent];
  }

  /** Stop: nothing more is sent (the owner cut in, or the answer was replaced). */
  close() {
    this.closed = true;
  }

  update(raw: string) {
    if (this.closed) return;
    // A different text from the start (a second brain took over): fine if nothing was sent yet, otherwise it isn't said.
    if (!raw.startsWith(this.seen.slice(0, this.done))) {
      if (this.sent.length) return void (this.closed = true);
      this.done = 0;
    }
    this.seen = raw;
    for (;;) {
      const rest = raw.slice(this.done);
      const m = /^[\s\S]*?[.!?]["'’”)\]]*\s+(?=\S)/.exec(rest);
      if (!m) return;
      let piece = cleanSpoken(m[0]);
      if (!this.sent.length) {
        // the first piece: one leading "okay" comes off, and it waits until there's something left to say
        const head = stripOpening(piece, this.o.question, this.o.names);
        if (head === piece && wordCount(piece) < 3 && /^\s*\p{L}+(?:\s+\p{L}+)?[.!?]\s*$/u.test(piece)) {
          // e.g. "Got it." on its own: take the next sentence with it
          const two = /^[\s\S]*?[.!?]["'’”)\]]*\s+[\s\S]*?[.!?]["'’”)\]]*\s+(?=\S)/.exec(rest);
          if (!two) return;
          piece = stripOpening(cleanSpoken(two[0]), this.o.question, this.o.names);
          this.done += two[0].length;
        } else {
          piece = head;
          this.done += m[0].length;
        }
        if (this.o.voice && PASS_UP_LINE.test(piece)) return void (this.done = 0); // a pass-up line is never said
      } else this.done += m[0].length;
      if (!piece || this.closed) continue;
      this.sent.push(piece);
      this.o.emit(piece);
    }
  }
}

/**
 * The "spoken" answer so far, from the structured answer's JSON while the model is still writing it, or null when the
 * JSON doesn't start with "spoken" (a pass-up starts with "escalate"; anything else isn't streamed).
 */
export function partialSpoken(json: string): string | null {
  const m = /^\s*\{\s*"spoken"\s*:\s*"/.exec(json);
  if (!m) return null;
  let out = "";
  for (let i = m[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = json[i + 1];
    if (n === undefined) return out;
    if (n === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-f]{4}$/i.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[n] ?? n;
    i++;
  }
  return out;
}

/** What's left of the final answer once the pieces already sent are taken off its front; null when it doesn't start
 * with them (it changed: nothing more is sent, so nothing is said twice). */
export function remainderAfter(final: string, pieces: string[]): string | null {
  let rest = final.trim();
  for (const p of pieces) {
    if (!rest.startsWith(p)) return null;
    rest = rest.slice(p.length).trimStart();
  }
  return rest;
}
