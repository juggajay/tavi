// The owner's own words (Stage 16). A gate in The Brain is answered by him, never by the assistant: what goes back is
// exactly what he said in the turn he's having now (typed, by voice or by Siri), read from the conversation log by the
// turn's job id, never from the brain's own text. The brain may leave out words addressed to the assistant at the start
// ("tell it ...") and a separate sentence at the end, but never anything that could change the answer: no negation or
// hesitation is ever left out, and words in the middle can't be dropped.
import { db } from "../store/db.js";

/** The channels a line of his own arrives on. "test" is a test script, "system" and "proactive" are the assistant. */
const OWN = ["voice", "typed", "siri"] as const;

export type OwnerLine = { id: number; text: string; channel: string; at: string };

/** What the owner said in this turn (null: a turn he didn't start, such as a routine, a background task or a notice). */
export function ownerLineFor(jobId: string | null | undefined): OwnerLine | null {
  if (!jobId) return null;
  const rows = db
    .prepare(`SELECT id, text, channel, ts FROM conversation_log WHERE job_id = ? AND role = 'user' AND channel IN (${OWN.map(() => "?").join(", ")}) ORDER BY id`)
    .all(jobId, ...OWN) as { id: number; text: string; channel: string; ts: string }[];
  const said = rows.map((r) => r.text.trim()).filter(Boolean);
  if (!said.length) return null;
  const text = said.join(" ");
  // Siri's stand-ins for "he only shared something" aren't words of his.
  if (/^\((shared something|sent a file)/i.test(text)) return null;
  return { id: rows[0].id, text, channel: rows[0].channel, at: rows[0].ts };
}

type Tok = { norm: string; start: number; end: number };
const TOKEN = /[\p{L}\p{N}]+(?:['’./-][\p{L}\p{N}]+)*/gu;
const norm = (t: string) => t.toLowerCase().replace(/['’]/g, "");

export function tokens(s: string): Tok[] {
  return [...s.matchAll(TOKEN)].map((m) => ({ norm: norm(m[0]), start: m.index!, end: m.index! + m[0].length }));
}

/**
 * Words that change or doubt what comes next or before: if any is among the words left out, the brain must send all
 * of his words (or ask him). "Go on" from "don't go on", or "go on" from "go on, actually wait", must never get through.
 */
export const DOUBT = new Set([
  "no", "not", "nah", "nope", "dont", "never", "didnt", "doesnt", "wont", "cant", "cannot", "isnt", "shouldnt", "wouldnt",
  "wait", "hold", "stop", "cancel", "actually", "but", "unless", "except", "instead", "scratch", "hang", "however", "although",
  "maybe", "perhaps", "unsure", "dunno", "if", "or", "rather", "first", "before", "until", "later", "yet",
]);

export type Excerpt = { ok: true; text: string; whole: boolean } | { ok: false; why: string };

/**
 * The words to send: all of what he said, or (with `pick`) a run of his own words taken from it. The text that goes is
 * always cut from what he said, never the brain's copy, so not even the punctuation can change.
 */
export function excerpt(said: string, pick?: string | null): Excerpt {
  const whole = said.trim();
  if (!whole) return { ok: false, why: "He hasn't said anything in this turn, so there's nothing of his to send." };
  if (!pick || !pick.trim()) return { ok: true, text: whole, whole: true };
  const all = tokens(whole);
  const want = tokens(pick).map((t) => t.norm);
  if (!want.length) return { ok: false, why: "Those aren't words he said." };
  let at = -1;
  for (let i = 0; i + want.length <= all.length && at < 0; i++) if (want.every((w, j) => all[i + j].norm === w)) at = i;
  if (at < 0) return { ok: false, why: "Those aren't his words as he said them. Send exactly what he said (leave out `words` to send all of it), or ask him." };
  const head = all.slice(0, at);
  const tail = all.slice(at + want.length);
  if (!tail.length && !head.length) return { ok: true, text: whole, whole: true };
  const doubt = [...head, ...tail].find((t) => DOUBT.has(t.norm));
  if (doubt) return { ok: false, why: `Leaving out "${whole.slice(doubt.start, doubt.end)}" could change his answer. Send all of his words, or ask him what he wants.` };
  const end = all[at + want.length - 1].end;
  if (tail.length) {
    // Only a separate sentence can be left off the end: what's between the pick and the rest must close a sentence.
    const between = whole.slice(end, tail[0].start);
    if (!/[.?!]/.test(between)) return { ok: false, why: "That would cut his answer off part-way. Send all of his words, or ask him." };
  }
  const start = all[at].start;
  // Keep the punctuation that ends what he said (a question mark matters).
  const closing = /^[.?!]+/.exec(whole.slice(end))?.[0] ?? "";
  return { ok: true, text: whole.slice(start, end) + closing, whole: false };
}
