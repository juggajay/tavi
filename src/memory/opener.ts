// The opening line: when the phone or desktop opens after a quiet spell (four hours with nothing said), Pebble may show
// one short line of text. Not spoken, no buzz. It's written ahead of time (after each memory keeper pass and at the
// morning window) by the small model, from what's actually on: commitments due today or tomorrow (or overdue),
// follow-up questions still unanswered, and what the owner said yesterday they'd be doing today.
// No reason, no line: with nothing to go on the model isn't even asked, the model may return nothing, and code drops any
// line that doesn't name something from that material. It's never the same line twice, and it lapses at local midnight.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { db, nowIso } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSetting, listCommitments, setSetting } from "../store/proactive.js";
import { awaitingAnswers, type FollowUp } from "../proactive/followups.js";
import { addDays, formatLocal, localDay, nextLocalMidnight, startOfDay } from "../time.js";
import { fold } from "./keeper.js";

const KEY = "opener";
const HISTORY = "opener_history";
const QUIET_MS = 4 * 3600_000;
export type Opener = { line: string; until: string; made_at: string };

/** Words too general to count as naming something ("check", "today"). */
const GENERIC = new Set(
  "about after again also back been before being booked check checked could does doing done from have here into just know like make more need only other over said should some still than that their them then there these they this those today tomorrow tonight morning afternoon arvo yesterday week very want what when where which while will with would your yours yet sorted sure thing things".split(" "),
);
const nameWords = (text: string) => [...new Set(fold(text).split(" ").filter((w) => w.length >= 4 && !GENERIC.has(w)))];

/** What a line may be written from, as plain lines for the prompt, and the words that count as naming one of them. */
export function openerMaterial(now = new Date()): { lines: string[]; names: string[] } {
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  const lines: string[] = [];
  for (const c of listCommitments("open", 30) as FollowUp[]) {
    const day = c.due_at ? localDay(new Date(c.due_at)) : null;
    if (!day || day > tomorrow) continue;
    const when = day < today ? "overdue" : day === today ? "due today" : "due tomorrow";
    lines.push(`Commitment ${when}: ${c.title}${c.site ? ` (at ${c.site})` : ""}${c.counterpart ? ` (with ${c.counterpart})` : ""}`);
  }
  for (const a of awaitingAnswers(now)) lines.push(`Follow-up question still unanswered: "${a.line}"`);
  // What they said yesterday about today ("tomorrow I'm at the club").
  const y0 = startOfDay(new Date(new Date(startOfDay(now)).getTime() - 12 * 3600_000)).toISOString();
  const y1 = startOfDay(now).toISOString();
  const said = db
    .prepare("SELECT text FROM conversation_log WHERE role = 'user' AND channel != 'test' AND ts >= ? AND ts < ? AND lower(text) LIKE '%tomorrow%' ORDER BY id DESC LIMIT 3")
    .all(y0, y1) as { text: string }[];
  for (const s of said) lines.push(`Yesterday they said: "${s.text.slice(0, 200)}"`);
  return { lines, names: nameWords(lines.join(" ").replace(/^(Commitment (overdue|due today|due tomorrow)|Follow-up question still unanswered|Yesterday they said):/gm, "")) };
}

function seen(): string[] {
  try {
    return JSON.parse(getSetting(HISTORY) || "[]") as string[];
  } catch {
    return [];
  }
}

/** Why a written line can't be used, or null if it can. */
export function rejectOpener(line: string, names: string[]): string | null {
  const t = line.trim();
  if (!t) return "empty";
  if (t.length > 140) return "too long";
  const words = new Set(fold(t).split(" "));
  if (!names.some((n) => words.has(n) || [...words].some((w) => w.length >= 4 && (w.startsWith(n.slice(0, 5)) || n.startsWith(w.slice(0, 5)))))) return "names nothing from the Context";
  if (seen().includes(fold(t))) return "said before";
  return null;
}

/** Keep a line for the rest of today (it lapses at local midnight). */
export function storeOpener(line: string, now = new Date()): Opener {
  const o = { line: line.trim(), until: nextLocalMidnight(now), made_at: now.toISOString() };
  setSetting(KEY, JSON.stringify(o));
  setSetting(HISTORY, JSON.stringify([...seen(), fold(o.line)].slice(-60)));
  return o;
}

const clear = () => db.prepare("DELETE FROM settings WHERE key = ?").run(KEY);

/** The line to show on opening now, or null: only after four quiet hours, and only until it lapses. */
export function openerFor(now = new Date()): string | null {
  let o: Opener | null = null;
  try {
    o = JSON.parse(getSetting(KEY) || "null") as Opener | null;
  } catch {}
  if (!o?.line || new Date(o.until) <= now) return null;
  const last = db.prepare("SELECT MAX(ts) ts FROM conversation_log WHERE role IN ('user','assistant') AND channel != 'test'").get() as { ts: string | null };
  if (last.ts && now.getTime() - new Date(last.ts).getTime() < QUIET_MS) return null;
  return o.line;
}

const PROMPT = `You write the one short line a personal assistant's app shows (as text, under its character) when the owner opens
it after a few quiet hours. Use ONLY the material given. Pick the single most useful thing in it and say it in under 15
words, plain English, naming the thing (the job, the person, the place or the task) exactly as written there.
No greeting, no "good morning", no sign-off, no emoji. If nothing there is worth a line, return an empty line.
Example: "The club room is needed tomorrow. Booked yet?"`;

export type OpenerWriter = (prompt: string) => Promise<string>;
const askSmallModel: OpenerWriter = async (prompt) => {
  let line = "";
  const q = query({
    prompt,
    options: {
      model: process.env.KEEPER_MODEL || "claude-haiku-5-5",
      effort: "low",
      systemPrompt: PROMPT,
      settingSources: [],
      tools: [],
      permissionMode: "dontAsk",
      maxTurns: 2,
      persistSession: false,
      outputFormat: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["line"], properties: { line: { type: "string" } } } },
    },
  });
  for await (const m of q) if (m.type === "result" && m.subtype === "success") line = String((m.structured_output as { line?: string })?.line ?? "");
  return line;
};

/** Write (or clear) the opening line. Tests pass their own writer (no model calls). */
export async function writeOpener(reason: string, writer: OpenerWriter = askSmallModel, now = new Date()): Promise<string | null> {
  const m = openerMaterial(now);
  if (!m.lines.length) {
    clear(); // no reason, no line
    return null;
  }
  let line = "";
  try {
    line = await writer(`Now: ${formatLocal(now, { weekday: "long", hour: "numeric", minute: "2-digit" })}\n\nMaterial:\n${m.lines.map((l) => `- ${l}`).join("\n")}`);
  } catch (err) {
    audit("system", "opener.failed", null, { reason, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const why = rejectOpener(line, m.names);
  if (why) {
    if (line.trim()) audit("system", "opener.dropped", null, { reason, line: line.slice(0, 200), why });
    clear();
    return null;
  }
  storeOpener(line, now);
  audit("system", "opener.written", null, { reason, line, at: nowIso() });
  return line.trim();
}
