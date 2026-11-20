// Fresh context attached to every request: the time, what we know about the user, and what's open.
// Fetched per turn (never frozen into the session) so it can't go stale.
import { db } from "../store/db.js";
import { activeMemories, listCommitments, listRoutines, notificationRules } from "../store/proactive.js";
import { addDays, formatLocal, localDay as dayOf, nowLine } from "../time.js";
import { connectorSummary } from "../connectors/claudeai.js";
import { describeHeld, heldWrites } from "../profile/profile.js";
import { awaitingAnswers, describeControls, type FollowUp } from "../proactive/followups.js";
import { dayInBrief, pendingOffers, probablyRelevant, relatedTo } from "../memory/keeper.js";
import { gettingToKnowNote } from "../memory/getToKnow.js";
import { sitdownBusy, sitdownNote } from "../memory/sitdown.js";
import { folderSummaries, getDoc, recentPictures, type DocRow } from "../files/library.js";
import { listPaired, spokenName } from "../remote/computers.js";
import { foldersOf, isConnected } from "../remote/hub.js";
import { brainLine } from "../brainlink/boot.js";
import { workLines } from "./tasks.js";
import { getItem, recentItems } from "../store/items.js";
import { madeFileBot, makerLine, makerName, mayUseFile, mayUseItem } from "../hq/ownership.js";
import { newTurn, type TurnInfo } from "./turn.js";

const fmt = (iso: string | null) => (iso ? formatLocal(iso, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "no date");

const localDay = (offsetDays = 0) => addDays(dayOf(), offsetDays);

/** One line on the folders it can read, so the brain knows there's something to search. */
function filesLine(turn?: TurnInfo) {
  try {
    const fs = folderSummaries(turn).filter((f) => f.enabled);
    if (!fs.length) return "";
    const total = fs.reduce((t, f) => t + f.count, 0);
    const newest = turn?.bot
      ? (db.prepare("SELECT * FROM docs ORDER BY mtime DESC").all() as DocRow[]).find((d) => mayUseFile(turn, d))
      : db.prepare("SELECT project, MAX(mtime) m FROM docs GROUP BY project ORDER BY m DESC LIMIT 1").get() as { project: string; m: number } | undefined;
    return `Files you can read: ${fs.length} ${fs.length === 1 ? "folder" : "folders"} (${fs.map((f) => f.label).join(", ")}), ${total} files${newest ? `; most recently changed: ${newest.project}` : ""}. Use search_files.`;
  } catch {
    return "";
  }
}

/** One line on the owner's other computers (Stage 11): what each is called, whether it's on now, and its folders. */
export function computersLine() {
  try {
    const all = listPaired();
    if (!all.length) return "";
    const one = (c: (typeof all)[number]) =>
      `${spokenName(c)} (${c.name}): ${isConnected(c.name) ? `connected now${foldersOf(c.name)?.length ? `, folders ${foldersOf(c.name)!.join(", ")}` : ""}` : `away${c.last_seen ? `, last seen ${fmt(c.last_seen)}` : ", not connected yet"}`}`;
    return `Other computers (look, don't touch: list_computer_folder, find_on_computer, read_from_computer): ${all.map(one).join("; ")}.`;
  } catch {
    return "";
  }
}

/** Photos and sketches the owner sent in the last 30 minutes (Stage 8.4, 8.5), so "what's this?" can be about them. */
export function picturesLines(now = Date.now(), turn?: TurnInfo): string[] {
  try {
    const pics = recentPictures(now).filter((p) => !turn || [p.id, p.over].filter(Boolean).every((id) => { const doc = getDoc(id!); return !doc || mayUseFile(turn, doc); }));
    if (!pics.length) return [];
    const ago = (iso: string) => {
      const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
      return m < 1 ? "just now" : `${m} min ago`;
    };
    return [
      "Photos sent from the phone in the last 30 minutes (newest first):",
      ...pics.map((p) => {
        const doc = turn?.bot ? getDoc(p.id) : null;
        const maker = doc ? madeFileBot(doc) : null;
        return `- [${p.id}] ${p.kind === "sketch" ? `their sketch${p.over ? ` drawn over photo ${p.over}` : ""}` : "a photo"}, ${ago(p.at)}${maker && maker !== turn?.bot ? ` This was made by ${makerName(maker)}.` : ""}`;
      }),
    ];
  } catch {
    return [];
  }
}

/** request: what the user just said, so things that are probably relevant can be found without being asked. */
/** onScreen: what the asking v2 app shows right now (gateway/surface.ts; null = nothing up), so "that one" makes sense.
 * Left out (undefined) when the asker can't report it: the original phone page, routines. */
/** background: a routine or follow-up check with nobody listening (no held writes, no getting-to-know-you notes). */
export function buildContext(request = "", onScreen?: string | null, opts: { background?: boolean; bot?: string; given_items?: string[] } = {}): string {
  const turn = newTurn({ bot: opts.bot, given_items: opts.given_items });
  if (opts.bot && onScreen) {
    const id = /\bitem (itm_[a-z0-9]+)\]/.exec(onScreen)?.[1];
    const item = id ? getItem(id) : null;
    const maker = item ? makerLine(turn, item) : "";
    if (maker) onScreen += ` ${maker}`;
  }
  const facts = activeMemories(12, ["user", "preference", "person", "project"]);
  const open = listCommitments("open", 10);
  const waiting = db.prepare("SELECT title, spoken, created_at FROM notifications WHERE status IN ('queued','delivered') ORDER BY created_at DESC LIMIT 5").all() as {
    title: string;
    spoken: string;
  }[];
  const approvals = (db.prepare("SELECT COUNT(*) n FROM approvals WHERE status = 'pending' AND expires_at > ?").get(new Date().toISOString()) as { n: number }).n;
  const routines = listRoutines(false).slice(0, 8);

  const conns = connectorSummary();
  const lines = [`Now: ${nowLine()}`, `Notification rules: ${notificationRules()}`];
  if (onScreen !== undefined) lines.splice(1, 0, onScreen ?? "On screen now: nothing (only Pebble).");
  if (conns) lines.push(`Connectors (the user's permissions): ${conns}`);
  const folders = filesLine(turn);
  if (folders) lines.push(folders);
  const computers = computersLine();
  if (computers) lines.push(computers);
  const brain = brainLine(); // Stage 16: a job in The Brain running or waiting on him (and so in the morning brief)
  if (brain) lines.push(brain);
  const pictures = opts.background ? [] : picturesLines(Date.now(), turn);
  if (pictures.length) lines.push(...pictures);
  if (opts.bot) {
    const recent = recentItems(500).filter((it) => mayUseItem(turn, it)).slice(0, 8);
    if (recent.length) lines.push("Recent things shown:", ...recent.map((it) => `- [${it.id}] ${it.title}${makerLine(turn, it) ? ` ${makerLine(turn, it)}` : ""}`));
  }
  // Work it took away (Stage 21.3): what's running and what it's doing now; what finished lately, with its notes.
  if (!opts.background) {
    try {
      lines.push(...workLines(Date.now(), opts.bot));
    } catch {}
  }
  // What makes it "just know": things related to this request, found without being asked, and what happened lately.
  const related = request ? probablyRelevant(request) : [];
  if (related.length) lines.push("Probably relevant to this (from memory and past conversations; use naturally, don't recite):", ...related.map((r) => `- ${r}`));
  const yesterday = dayInBrief(localDay(-1));
  if (yesterday) lines.push(`Yesterday in brief: ${yesterday}`);
  const today = dayInBrief(localDay(0));
  if (today) lines.push(`Earlier today: ${today}`);
  if (facts.length) lines.push("What you know (recent saved facts):", ...facts.map((f) => `- [${f.id}] ${f.subject}: ${f.fact}`));
  // The sit-down (its offer, or the conversation itself) takes the place of the everyday getting-to-know-you note.
  const sitdown = opts.background ? null : sitdownNote();
  const getToKnow = opts.background || sitdown || sitdownBusy() ? null : gettingToKnowNote();
  if (sitdown) lines.push(sitdown);
  if (getToKnow) lines.push(getToKnow);
  const offers = pendingOffers();
  if (offers.length)
    lines.push(
      "Noticed but not tracked (offer once, when it fits: \"You mentioned X, want me to track that?\"; then answer_offer):",
      ...offers.map((o) => `- [${o.id}] ${o.title}${o.evidence ? ` (they said: "${o.evidence.slice(0, 120)}")` : ""}`),
    );
  lines.push(
    open.length ? "Open commitments:" : "Open commitments: none",
    ...(open as FollowUp[]).map(
      (c) =>
        `- [${c.id}] ${c.title}${c.site ? ` @ ${c.site}` : ""} (${c.kind ?? "task"}; owner: ${c.owner}${c.counterpart ? `, with ${c.counterpart}` : ""}; ` +
        `due ${fmt(c.due_at)}${c.event_at ? `; for ${fmt(c.event_at)}` : ""}; ${c.muted ? "muted, not asking" : `next check ${fmt(c.next_check_at)}`})`,
    ),
  );
  const asked = awaitingAnswers();
  if (asked.length) lines.push("You asked the user (no answer yet; if they answer, call answer_followup):", ...asked.map((a) => `- [${a.id}] "${a.line}" (${fmt(a.asked_at)})`));
  const controls = describeControls();
  if (controls) lines.push(`Follow-up controls (the user's): ${controls}`);
  if (waiting.length) lines.push("Waiting for the user to hear (not yet seen; it's already on their screen, so bring one up only when it bears on what they're asking):", ...waiting.map((w) => `- ${w.title}: ${w.spoken}`));
  if (approvals) lines.push(`Waiting for the user's approval tap: ${approvals}`);
  // A write held because its turn read outside content: at most one, and only when what they just said is about it.
  const held = opts.background || !request ? undefined : heldWrites().find((h) => relatedTo(request, describeHeld(h)));
  if (held) lines.push("Held for the user's yes (ask only if it fits this, then answer_held_write):", `- [${held.id}] ${describeHeld(held)}`);
  if (routines.length) lines.push("Routines:", ...routines.map((r) => `- [${r.id}] ${r.title}: ${r.when}`));
  return lines.join("\n");
}
