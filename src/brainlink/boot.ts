// After the assistant itself restarts (Stage 16.2): a turn it was holding open was cut off, because The Brain's run
// dies when nobody reads it. Find those, tell him plainly what happened, and leave The Brain's files alone: if its job
// still shows "running" (which blocks another step), that's for him to clear in The Brain, not for us to patch.
// Also the one line for every turn's Context (and so the morning brief) when a job is waiting on him.
import { audit } from "../store/log.js";
import { queueNotification } from "../proactive/notify.js";
import { GATES } from "./config.js";
import { listJobs } from "./client.js";
import { jobWords, statusWords } from "./runner.js";
import { endTurn, getLinkJob, linkJobs, runningTurns, saveLinkJob, syncWithBoard } from "./store.js";
import { brainUrl } from "./config.js";
import { formatLocal } from "../time.js";

/** Mark turns cut off by a restart and tell him. Returns the jobs it found. check: look at The Brain now (default yes). */
export async function recoverCutOff(o: { check?: boolean } = {}): Promise<string[]> {
  const cut = runningTurns();
  if (!cut.length) return [];
  for (const t of cut) {
    endTurn(t.id, { outcome: "cut_off", error: "the assistant restarted while this was running" });
    saveLinkJob({ job: t.job, state: "cut_off", last_error: "cut off by a restart of the assistant" });
  }
  const jobs = [...new Set(cut.map((t) => t.job))];
  const now = o.check === false ? null : await listJobs();
  for (const id of jobs) {
    const j = getLinkJob(id)!;
    const m = now?.ok ? now.data.jobs.find((x) => x.job === id) : undefined;
    const shows = !now ? "" : !now.ok ? " The Brain isn't answering now, so I couldn't check it." : !m ? " The Brain doesn't list it now." : m.status === "running"
      ? " The Brain still shows it as running, so it won't take another step on that job, and it has no way to clear that itself yet (not its Stop button, not a restart). You can start it again as a new job. I haven't touched its files."
      : ` The Brain shows it as ${statusWords(m.status)}; what it saved is still there. Say "carry on" when you want it to pick up again.`;
    queueNotification({ title: `Cut off: ${j.title}`, spoken: `I restarted while The Brain was working on ${jobWords(j)}, so that step was cut off part-way.${shows}`, priority: "normal", source: `brain:${id}` });
    audit("system", "brainlink.cut_off", id, { shows: m?.status ?? null });
  }
  return jobs;
}

/**
 * Every 10 minutes, while something of his is waiting or ready, glance at The Brain's board (a quick read) so an answer
 * he gave in The Brain itself isn't still reported as waiting here. Nothing else is asked of it.
 */
export function startBrainWatch(everyMs = 10 * 60_000) {
  const t = setInterval(() => {
    if (!brainUrl() || !linkJobs().some((j) => j.state === "waiting" || j.state === "ready")) return;
    void listJobs()
      .then((r) => r.ok && syncWithBoard(r.data.jobs))
      .catch(() => {});
  }, everyMs);
  t.unref?.();
  return t;
}

const when = (iso: string | null) => (iso ? formatLocal(iso, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");

/** One line for the Context (and so the brief): what's running through the link, and what's waiting on him. */
export function brainLine(now = Date.now()): string {
  try {
    const recent = linkJobs().filter((j) => now - Date.parse(j.updated_at) < 14 * 86_400_000);
    const parts: string[] = [];
    for (const j of recent) {
      if (j.state === "running" || j.state === "starting") parts.push(`working on ${jobWords(j)} now`);
      else if (j.state === "waiting") parts.push(`${jobWords(j)} is waiting on his answer${j.gate ? ` at ${GATES[j.gate] ?? j.gate}` : ""} (since ${when(j.asked_at)})`);
      else if (j.state === "ready") parts.push(`${jobWords(j)} is finished and ready to look at (brain_results)`);
      else if (j.state === "cut_off" || j.state === "dropped") parts.push(`${jobWords(j)} was cut off part-way (${when(j.updated_at)})`);
    }
    if (!parts.length) return "";
    return `The Brain (his quoting app; brain_* tools): ${parts.slice(0, 5).join("; ")}. A job waiting on him belongs in the morning brief; his answer goes back in his own words (brain_answer_gate).`;
  } catch {
    return "";
  }
}
