// One turn in The Brain at a time, held to the end (Stage 16.2). A start (after his tap) or his own answer at a gate is
// posted; the gateway then keeps reading the job's stream in the background until it finishes, however long that is,
// whether or not his phone is still there (The Brain's run dies if nobody reads it). As it goes, the conversation is
// mirrored into The Brain's own thread, so its screens show what was asked through here. When the turn ends he is told
// plainly: a question at a gate (a push, and the question on screen), a finished result, a problem, or that the line
// dropped and we don't know how far it got. Everything is in the audit log.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { audit } from "../store/log.js";
import { deliverDue, queueNotification } from "../proactive/notify.js";
import { createItem, publishItem } from "../store/items.js";
import { newTurn } from "../brain/turn.js";
import { bus } from "../events.js";
import { GATES, MODES, type Mode } from "./config.js";
import { getJob, listJobs, openTurn, putThread, type BrainEvent, type Thread, type ThreadLine, type TurnFields, type TurnFile } from "./client.js";
import { ensureRunning } from "./launch.js";
import { activeTurn, claim, claimedFor, setActive, unclaim } from "./state.js";
import { addTurn, endTurn, getLinkJob, saveLinkJob, type LinkJob, type LinkState } from "./store.js";
import { money } from "./cost.js";

export type FileRef = { name: string; path: string; sha256: string; size: number; from: string };

/** Its markers (GATE: scope, TAKEOFF READY) are for the app, not for him. */
export const stripMarkers = (t: string) => t.replace(/^[`*\s]*GATE:.*$/gim, "").replace(/^[`*\s]*(?:QUOTE|TAKEOFF) READY[`*\s]*$/gm, "").trim();
const short = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
export const titleOf = (j: Pick<LinkJob, "title" | "client" | "site" | "job">) => j.title || [j.client, j.site].filter(Boolean).join(", ") || j.job;
const kindOf = (mode: string | null) => (mode && mode in MODES ? MODES[mode as Mode].noun : "job");
/** "the Venn, Example Lake take-off" */
export const jobWords = (j: Pick<LinkJob, "title" | "client" | "site" | "job" | "mode">) => `the ${[j.client, j.site].filter(Boolean).join(", ") || titleOf(j)} ${kindOf(j.mode)}`;

/** What an activity line in its thread says (its own screen words these in its own way; ours are plain). */
function activity(name: string, target: string): string {
  const base = target ? path.basename(target.replace(/\\/g, "/")) : "";
  if (name === "Read") return base ? `reading ${base}` : "reading";
  if (name === "Write" || name === "Edit") return base ? `writing ${base}` : "writing";
  if (name === "Bash") return "running a script";
  if (name === "WebSearch" || name === "WebFetch") return "looking on the web";
  if (name === "Glob" || name === "Grep") return "looking through its files";
  if (name === "TodoWrite") return "planning";
  return name.toLowerCase();
}

/** Keeps The Brain's own copy of the conversation in step, a few seconds behind, and once more at the end. */
class Mirror {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  failed = 0;
  constructor(
    private job: string,
    public slot: Thread,
  ) {}
  add(line: ThreadLine) {
    this.slot.m.push(line);
    if (this.slot.m.length > 300) this.slot.m = this.slot.m.slice(-300);
    this.kick();
  }
  kick() {
    this.dirty = true;
    this.timer ??= setTimeout(() => void this.flush(), 2000);
  }
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const r = await putThread(this.job, this.slot);
    if (!r.ok) this.failed++;
  }
}

export type TurnStart = { ok: true; job: string; startedApp: boolean } | { ok: false; error: string; busy?: boolean };

type Spec =
  | { kind: "start"; job: string; mode: Mode; client: string; site: string; message: string; files: FileRef[]; approvalId: string | null }
  | { kind: "answer"; job: string; words: string; lineId: number | null; approvalId: string | null };

/** Is The Brain busy: a turn through the link, or one of its jobs running (started in the app, say)? */
export async function busyWith(): Promise<string | null> {
  const a = activeTurn();
  if (a) return `It's already working on ${a.title} for you. One job at a time through me.`;
  if (claimedFor()) return "It's just taking another job of yours now. One job at a time through me.";
  const jobs = await listJobs();
  const running = jobs.ok ? jobs.data.jobs.find((j) => j.status === "running") : undefined;
  if (running) return `It's already working on ${running.title || running.job} (started in The Brain itself). One at a time.`;
  return null;
}

/**
 * Send one turn. Resolves when The Brain has taken it (the stream is open, and from then on it's held in the
 * background) or refused it. Nothing here decides anything for him: a start only comes from his tap, an answer only
 * with his own words (both checked by the callers).
 */
export async function sendTurn(spec: Spec): Promise<TurnStart> {
  const busyNow = await busyWith();
  if (busyNow) return { ok: false, busy: true, error: busyNow };
  // The line is claimed before anything else is awaited: a second tap at the same moment gets "one at a time".
  if (!claim(spec.job)) return { ok: false, busy: true, error: "It's just taking another job of yours now. One job at a time through me." };
  try {
    const r = await prepareAndSend(spec);
    if (!r.ok) unclaim(spec.job);
    return r;
  } catch (err) {
    unclaim(spec.job);
    throw err;
  }
}

async function prepareAndSend(spec: Spec): Promise<TurnStart> {
  const up = await ensureRunning();
  if (!up.ok) return { ok: false, error: up.error };
  const jobs = await listJobs();
  const running = jobs.ok ? jobs.data.jobs.find((j) => j.status === "running") : undefined;
  if (running) return { ok: false, busy: true, error: `It's already working on ${running.title || running.job} (started in The Brain itself). One at a time.` };

  let fields: TurnFields;
  let files: TurnFile[] = [];
  let mirror: Mirror;
  let prev: LinkJob | undefined = getLinkJob(spec.job);
  if (spec.kind === "start") {
    // The drawings, byte for byte what he approved.
    try {
      for (const f of spec.files) {
        const data = await readFile(f.path);
        if (createHash("sha256").update(data).digest("hex") !== f.sha256) return { ok: false, error: `${f.name} has changed since you approved it, so I didn't start the job. Ask me again.` };
        files.push({ name: f.name, data, type: /\.pdf$/i.test(f.name) ? "application/pdf" : undefined });
      }
    } catch {
      return { ok: false, error: "I couldn't read one of the drawings any more, so I didn't start the job." };
    }
    fields = { message: spec.message, job: spec.job, mode: spec.mode, client: spec.client, site: spec.site, persona: "auto", template: "none" };
    prev = saveLinkJob({ job: spec.job, title: [spec.client, spec.site].filter(Boolean).join(", ") || spec.job, mode: spec.mode, client: spec.client, site: spec.site, state: "starting", started_by: "link", files_json: JSON.stringify(spec.files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size, from: f.from }))) });
    mirror = new Mirror(spec.job, { j: spec.job, m: [] });
    mirror.slot.m.push({ kind: "user", text: `📄 ${spec.files.map((f) => f.name).join(", ")}` }, { kind: "user", text: spec.message, at: Date.now() });
  } else {
    const d = await getJob(spec.job);
    if (!d.ok) return { ok: false, error: d.down ? "The Brain isn't answering." : `The Brain can't find that job (${d.error}).` };
    const m = d.data.manifest;
    if (m.status === "running") return { ok: false, busy: true, error: "The Brain shows that job as still running, so it won't take your answer yet. If nothing's really running (after a crash), The Brain can't clear that itself yet; you can start it again as a new job." };
    if (m.status === "issued" || m.status === "superseded") return { ok: false, error: "That job's been issued in The Brain. Carrying it on needs a new draft, opened in The Brain itself." };
    const session = m.session ?? prev?.session;
    if (!session) return { ok: false, error: "The Brain has no conversation saved for that job, so there's nothing to carry on." };
    fields = { message: spec.words, job: spec.job, sessionId: session };
    prev = saveLinkJob({ job: spec.job, title: prev?.title ?? m.title ?? spec.job, mode: prev?.mode ?? m.mode ?? null, client: prev?.client ?? m.client ?? null, site: prev?.site ?? m.site ?? null, session, started_by: prev?.started_by ?? "app", state: prev?.state ?? "waiting" });
    const base = d.data.thread && Array.isArray(d.data.thread.m) ? d.data.thread : { s: session, j: spec.job, m: [] };
    mirror = new Mirror(spec.job, { ...base, s: base.s ?? session, j: spec.job, m: [...base.m] });
    mirror.slot.m.push({ kind: "user", text: spec.words, at: Date.now() });
  }

  const title = jobWords(prev!);
  const turnId = addTurn({ job: spec.job, kind: spec.kind, words: spec.kind === "start" ? spec.message : spec.words, line_id: spec.kind === "answer" ? spec.lineId : null, approval_id: spec.approvalId });
  const t0 = Date.now();
  let lastText = "";
  let done: Extract<BrainEvent, { type: "done" }> | null = null;
  const errors: string[] = [];
  let stoppedByOwner = false;
  let lastActivity = "";
  const onEvent = (e: BrainEvent) => {
    if (e.type === "session" && e.id) {
      saveLinkJob({ job: spec.job, session: e.id });
      mirror.slot.s = e.id;
    } else if (e.type === "tool" && e.agent === "main") {
      lastActivity = activity(e.name, e.target);
      mirror.add({ kind: "activity", text: lastActivity, turn: t0, at: Date.now(), action: e.name, detail: e.target });
    } else if (e.type === "text") {
      lastText = e.text;
      const clean = stripMarkers(e.text);
      if (clean) mirror.add({ kind: "agent", text: clean });
    } else if (e.type === "error") {
      errors.push(String(e.error ?? "something went wrong"));
      mirror.add({ kind: "activity", text: `error: ${e.error}`, turn: t0, at: Date.now() });
    } else if (e.type === "done") {
      done = e;
      if (e.gate) mirror.slot.st = ["scope", "takeoff", "rates", "draft"].indexOf(e.gate);
      if (e.ready) (mirror.slot.r = true), (mirror.slot.st = 4);
      mirror.slot.c = (mirror.slot.c ?? 0) + (Number(e.costUsd) || 0);
      mirror.kick();
    }
    progress.at = Date.now();
    progress.what = lastActivity;
  };
  const progress = { at: Date.now(), what: "" };
  const stream = openTurn(fields, files, onEvent);
  files = []; // let the drawings' bytes go
  setActive({ job: spec.job, turn: turnId, title, started: t0, stop: () => (stoppedByOwner = true) });
  activeProgress.set(spec.job, progress);
  const opened = await stream.opened;
  if (!opened.ok) {
    setActive(null);
    activeProgress.delete(spec.job);
    endTurn(turnId, { outcome: "refused", error: opened.error });
    saveLinkJob({ job: spec.job, state: spec.kind === "start" ? "failed" : (prev?.state as LinkState) ?? "waiting", last_error: opened.error });
    audit("system", "brainlink.turn.refused", spec.job, { kind: spec.kind, error: opened.error, status: opened.status });
    return { ok: false, error: opened.down ? "The Brain stopped answering before it took the job." : `The Brain wouldn't take it: ${opened.error}` };
  }
  saveLinkJob({ job: spec.job, state: "running", last_error: null });
  audit("system", "brainlink.turn.started", spec.job, { kind: spec.kind, turn: turnId, approval: spec.approvalId, mode: prev?.mode, files: spec.kind === "start" ? spec.files.map((f) => f.name) : undefined });
  bus.emit("activity");
  mirror.kick();
  void mirror.flush(); // its own screens show the job (and his words) at once

  void stream.ended.then(async (end) => {
    await mirror.flush();
    setActive(null);
    activeProgress.delete(spec.job);
    const job = getLinkJob(spec.job)!;
    const d = done as Extract<BrainEvent, { type: "done" }> | null;
    const cost = d ? Number(d.costUsd) || 0 : null;
    const total = job.cost_usd + (cost ?? 0);
    const said = stripMarkers(lastText);
    let outcome: string;
    let state: LinkState;
    let notice: { title: string; spoken: string; priority: "normal" | "low" } | null = null;
    let showQuestion = false;
    const capped = errors.find((e) => /spend cap/i.test(e));
    if (stoppedByOwner) {
      outcome = "stopped";
      state = "stopped";
      notice = { title: `Stopped: ${titleOf(job)}`, spoken: `Stopped ${title} in The Brain, as you asked.${cost ? ` That step cost ${money(cost)}.` : ""}`, priority: "low" };
    } else if (d && d.ready) {
      outcome = "ready";
      state = "ready";
      notice = { title: `Ready: ${titleOf(job)}`, spoken: `The Brain has finished ${title}${cost ? ` (that step ${money(cost)}, ${money(total)} in all)` : ""}. Want to see it?`, priority: "normal" };
    } else if (d) {
      outcome = d.gate ? "gate" : "done";
      state = "waiting";
      showQuestion = true;
      const where = d.gate ? `stopped at ${GATES[d.gate] ?? d.gate} on ${title}` : `come back on ${title}`;
      notice = {
        title: `The Brain needs you: ${titleOf(job)}`,
        spoken: `The Brain has ${where} and needs your answer${said ? `: "${short(said.replace(/\s+/g, " "), 220)}"` : "."} The whole of it is in the app.${capped ? ` It stopped at its ${money(20)} cap for one step.` : ""}`,
        priority: "normal",
      };
    } else if (errors.length) {
      outcome = "error";
      state = "stopped";
      notice = { title: `Problem: ${titleOf(job)}`, spoken: `The Brain hit a problem on ${title}: ${short(errors.at(-1)!, 200)} Nothing more is running.`, priority: "normal" };
    } else {
      // No end from it: the line dropped (it may have crashed, or been shut). Say what we know and no more.
      outcome = "dropped";
      state = "dropped";
      const now = await listJobs();
      const m = now.ok ? now.data.jobs.find((j) => j.job === spec.job) : undefined;
      const shows = !now.ok ? "I can't reach it now to check" : !m ? "it doesn't list the job" : m.status === "running" ? "it still shows the job as running, so it won't take another step on it (The Brain has no way to clear that itself yet; you can start it again as a new job)" : `it shows the job as ${statusWords(m.status)}`;
      notice = { title: `Lost the line: ${titleOf(job)}`, spoken: `The line to The Brain dropped part-way through ${title}, so I don't know whether it finished that step. ${shows.charAt(0).toUpperCase()}${shows.slice(1)}. Nothing more is running through me.`, priority: "normal" };
    }
    endTurn(turnId, { outcome, gate: d?.gate ?? null, cost_usd: cost, error: errors.at(-1) ?? (outcome === "dropped" ? end.error ?? "dropped" : null) });
    saveLinkJob({ job: spec.job, state, cost_usd: total, gate: d?.gate ?? null, question: showQuestion ? said || null : null, asked_at: showQuestion ? new Date().toISOString() : null, last_error: errors.at(-1) ?? null });
    audit("system", "brainlink.turn.ended", spec.job, { turn: turnId, outcome, gate: d?.gate ?? null, cost_usd: cost, total_usd: total, ms: Date.now() - t0, error: errors.at(-1), mirror_failed: mirror.failed || undefined });
    if (showQuestion && said) showOnScreen(getLinkJob(spec.job)!, said);
    if (notice) {
      queueNotification({ ...notice, source: `brain:${spec.job}` });
      await deliverDue(new Date()).catch(() => {});
    }
    bus.emit("activity");
  });
  return { ok: true, job: spec.job, startedApp: up.started };
}

/** While a turn runs: when it last did something, and what. */
export const activeProgress = new Map<string, { at: number; what: string }>();

/** Its question (and what led to it), on screen in the apps: listed, ready to open; never popped over what he's doing. */
function showOnScreen(job: LinkJob, said: string) {
  try {
    const turn = newTurn({ job_id: `brain_${job.job}`, origin: null, background: true });
    const rows = [
      { label: "Job", value: titleOf(job) },
      { label: "Kind", value: kindOf(job.mode) },
      ...(job.gate ? [{ label: "Stopped at", value: GATES[job.gate] ?? job.gate }] : []),
      { label: "Cost so far", value: `${money(job.cost_usd)} (as The Brain reports it)` },
    ];
    const text = said.length > 3900 ? `${said.slice(0, 3900)}…\n(The rest is in The Brain.)` : said;
    const item = createItem(turn, { kind: "note", title: `The Brain asks: ${titleOf(job)}`, source: "The Brain (its words)", payload: { rows, text }, origin: "notice" });
    publishItem(item, turn, false, false);
  } catch (err) {
    console.warn("[brainlink] question not shown:", err instanceof Error ? err.message : err);
  }
}

/** Its job status, in his words. */
export function statusWords(s: string | undefined): string {
  if (!s || s === "active") return "waiting for the next word";
  if (s === "running") return "running";
  if (s.startsWith("gate:")) return `stopped at ${GATES[s.slice(5)] ?? s.slice(5)}, waiting for an answer`;
  if (s === "ready") return "finished, ready to review";
  if (s === "issued") return "issued";
  if (s === "superseded") return "replaced by a newer draft";
  return s;
}
