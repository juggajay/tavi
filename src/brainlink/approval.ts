// His go, with the cost (Stage 16.2). Starting a job in The Brain spends real money, so it's a tap-to-approve action
// like sending an email: the approval shows exactly what will start, with which drawings, the likely cost and today's
// spend, and only his tap runs it, once. Past the day's spend line, his answers at a gate need a tap too.
import { queueNotification, deliverDue } from "../proactive/notify.js";
import { registerOperation, requestOperationApproval, type ApprovalView } from "../broker/broker.js";
import { MODES, type Mode } from "./config.js";
import { money, STEP_CAP } from "./cost.js";
import { sendTurn, type FileRef } from "./runner.js";

export type StartGrant = {
  job: string;
  mode: Mode;
  client: string;
  site: string;
  message: string;
  files: FileRef[];
  cost: { low: number; high: number; basis: "recorded" | "rough"; say: string };
  day: { spent: number; line: number; over: boolean };
  starts_app: boolean;
  summary: string;
};
export type AnswerGrant = { job: string; title: string; words: string; line_id: number | null; day: { spent: number; line: number }; summary: string };

/** How long a tap waits for The Brain to take the job before saying "starting it" and carrying on in the background. */
const WAIT_MS = 20_000;

/** Wait a little for the turn to be taken; if it's still going (The Brain starting up), say so and finish quietly. */
async function settle(p: Promise<Awaited<ReturnType<typeof sendTurn>>>, what: string, okSay: string): Promise<{ status: "accepted" | "failed"; message: string; ref?: string }> {
  const late = new Promise<"late">((r) => setTimeout(() => r("late"), WAIT_MS).unref?.());
  const first = await Promise.race([p, late]);
  if (first === "late") {
    void p.then((r) => {
      queueNotification(
        r.ok
          ? { title: "The Brain: started", spoken: okSay, priority: "normal", source: "brainlink" }
          : { title: "The Brain: didn't start", spoken: `${what} didn't go: ${r.error}`, priority: "normal", source: "brainlink" },
      );
      void deliverDue(new Date()).catch(() => {});
    });
    return { status: "accepted", message: "The Brain is starting up first (about a minute); I'll tell you when it's taken the job." };
  }
  return first.ok ? { status: "accepted", message: okSay, ref: first.job } : { status: "failed", message: `${what} didn't go: ${first.error}` };
}

registerOperation("brain.start", {
  account: "The Brain",
  declined: "No worries, I haven't started anything in The Brain.",
  view: (g) => {
    const s = g as unknown as StartGrant;
    const rows = [
      { label: "What", value: `${MODES[s.mode].say.replace(/^just /, "")} in The Brain` },
      { label: "Client", value: s.client || "(none given)" },
      { label: "Site", value: s.site || "(none given)" },
      { label: "Drawings", value: `${s.files.length} ${s.files.length === 1 ? "file" : "files"}: ${s.files.map((f) => f.name).join(", ")}` },
      { label: "It's told", value: s.message },
      { label: "Likely cost", value: `${s.cost.say} (US dollars, as The Brain reports them)` },
      { label: "Today so far", value: `${money(s.day.spent)}${s.day.over ? `: over your ${money(s.day.line)} a day line` : ` of your ${money(s.day.line)} a day line`}` },
      { label: "Each step", value: `The Brain stops any one step at ${money(STEP_CAP)}; it asks you at each check before going on.` },
      ...(s.starts_app ? [{ label: "First", value: "The Brain isn't running: I'll start it (hidden) first." }] : []),
    ];
    return { subject: s.summary, rows };
  },
  run: async (g, approvalId) => {
    const s = g as unknown as StartGrant;
    const noun = MODES[s.mode].noun;
    return settle(
      sendTurn({ kind: "start", job: s.job, mode: s.mode, client: s.client, site: s.site, message: s.message, files: s.files, approvalId }),
      `The ${noun}`,
      `Started the ${noun} for ${[s.client, s.site].filter(Boolean).join(", ") || "that job"} in The Brain. I'll tell you when it stops to ask you something.`,
    );
  },
});

registerOperation("brain.answer", {
  account: "The Brain",
  declined: "No worries, I haven't sent it. The Brain is still waiting.",
  view: (g) => {
    const a = g as unknown as AnswerGrant;
    return {
      subject: a.summary,
      rows: [
        { label: "Job", value: a.title },
        { label: "Your words", value: a.words },
        { label: "Today so far", value: `${money(a.day.spent)}: over your ${money(a.day.line)} a day line` },
        { label: "This step", value: `could cost up to ${money(STEP_CAP)} (US dollars, as The Brain reports them)` },
      ],
    };
  },
  run: async (g, approvalId) => {
    const a = g as unknown as AnswerGrant;
    return settle(sendTurn({ kind: "answer", job: a.job, words: a.words, lineId: a.line_id, approvalId }), "Your answer", `Sent your answer to The Brain on ${a.title}. I'll tell you when it comes back.`);
  },
});

export const requestStart = (g: StartGrant, jobId?: string): ApprovalView => requestOperationApproval("brain.start", g as unknown as Record<string, unknown>, { jobId });
export const requestAnswer = (g: AnswerGrant, jobId?: string): ApprovalView => requestOperationApproval("brain.answer", g as unknown as Record<string, unknown>, { jobId });
