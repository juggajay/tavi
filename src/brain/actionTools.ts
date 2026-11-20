// The one way the brain can get something done through the user's Claude-account connectors that changes anything
// (send an email, create or move a calendar event, share a file): ask, and let the user tap Approve.
// Only for connectors the user has given Write permission in Setup; the tap is needed every time regardless.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { testSafe, type TurnCtx } from "./turn.js";
import { requestConnectorApproval } from "../broker/broker.js";
import { classifyTool, connectorLabel, connectorStates, connectorTool, permissionsFor, serverOf } from "../connectors/claudeai.js";
import { startBrowserJob } from "../browser/worker.js";
import { listSites } from "../browser/sites.js";
import { cancelJob, jobBot, latestRunningTask, startTask, steerWork } from "./tasks.js";
import { browserState } from "../browser/host.js";
import { openSignIn } from "../browser/profile.js";
import { screenOf } from "./showTools.js";
import { clientById } from "../gateway/clients.js";
import { command } from "../gateway/surface.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export const actionTools = (ctx: TurnCtx) =>
  testSafe(ctx, [
    tool(
      "request_action",
      "Ask the user to approve one call to a connector tool (Gmail, Google Calendar, Google Drive...) that changes something: " +
        "sending, creating, updating, deleting, sharing, replying to an invite. The exact call appears on their phone and only runs " +
        "if they tap Approve. Not needed for reading or saving a Gmail draft: just call those tools.",
      {
        tool: z.string().describe("The full tool name, e.g. mcp__claude_ai_Google_Calendar__create_event"),
        input: z.record(z.string(), z.unknown()).describe("The exact input for that tool, as you would pass it"),
        summary: z.string().max(160).describe("One line for the user, e.g. 'Add club meeting, Thu 6:30pm, Example Village, invite Ruvo'"),
      },
      async ({ tool: name, input, summary }) => {
        const server = serverOf(name);
        if (!server) return json({ error: "That isn't a connector tool Tavi can use." });
        const label = connectorLabel(name);
        const state = connectorStates().connectors.find((s) => s.server === server);
        if (state?.status !== "connected") return json({ error: `${label} isn't connected. The user can connect it in Tavi Setup on their PC.` });
        if (!permissionsFor(server).write) {
          return json({ error: `The user hasn't given Tavi write access to ${label}. They can turn it on in Setup → Connections on their PC.` });
        }
        if (!connectorTool(name)) return json({ error: `${name} isn't one of the ${label} tools. Check the exact name.` });
        if (classifyTool(name) !== "write") return json({ error: "That one doesn't need approval. Just call it directly." });
        const view = requestConnectorApproval({ connector: label, tool: name, input, summary, jobId: ctx.turn.job_id ?? undefined });
        return json({
          status: "waiting_for_user",
          approval_id: view.id,
          note: "It's on the user's screen with an Approve button. Don't say it's done; you'll be told the outcome.",
        });
      },
    ),
    tool(
      "browser_task",
      "Do a job on a website in Tavi's own browser, in the background: ordering (groceries, household supplies), bookings, " +
        "forms, checking an account or order status, downloading invoices, comparing prices across shops. Write the task " +
        "self-contained: site, exactly what to do, quantities, dates and times, what to do if something's unavailable. " +
        "sites: the user's saved sites it needs (uses their logins); leave empty for public sites in a fresh browser with no logins. " +
        "It asks the user's go-ahead on the phone before anything is ordered, paid, booked, sent or submitted, and reports back when done.",
      {
        task: z.string().describe("Complete instructions, e.g. 'On woolworths.com.au, add my usual order (past orders, most recent) plus 1kg ground coffee, pick the earliest Tuesday delivery slot, then ask for the go-ahead.'"),
        sites: z.array(z.string()).optional().describe("Saved sites needed, e.g. ['https://www.woolworths.com.au']"),
        summary: z.string().max(80).describe("A short name for the job, e.g. 'Weekly groceries'"),
      },
      async ({ task, sites, summary }) => {
        try {
          const r = startBrowserJob({ task, sites, summary });
          return json({
            started: r.id,
            using: r.mode,
            note: "It runs in the background. Tell the user briefly; the go-ahead and the result come to their phone.",
            saved_sites: listSites().map((s) => s.origin),
          });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err), saved_sites: listSites().map((s) => s.origin) });
        }
      },
    ),
    tool(
      "browser_sign_in",
      "Open a website in Tavi's browser so the user can sign in themselves ('open the saved shop site and let me log in'). " +
        "It opens on their PC, in the desktop app's browser view, with them driving; they type their own password into the page and " +
        "press Done. You never see it. The site is then one of their saved sites for browser_task. Banks, payments, email and " +
        "myGov are refused.",
      { site: z.string().describe("The site, e.g. 'bunnings.com.au'") },
      async ({ site }) => {
        try {
          const r = await openSignIn(site);
          const { clientId } = screenOf(ctx.turn);
          if (clientId && clientById(clientId)?.kind === "desktop") command(clientId, { cmd: "browser" });
          return json({ opened: r.domain, note: "It's open on the PC in the browser view, with them driving. Tell them: sign in there, then press Done. Say nothing about passwords beyond that." });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    ),
    tool(
      "show_browser",
      "Show the user what Tavi's browser is doing ('show me what you're doing in the browser'): on the PC it opens the live " +
        "view beside the conversation. Answers with the site and what it's doing.",
      {},
      async () => {
        const v = browserState();
        const { clientId } = screenOf(ctx.turn);
        const desktop = !!clientId && clientById(clientId)?.kind === "desktop";
        if (desktop) command(clientId!, { cmd: "browser" });
        if (!v.open) return json({ open: false, say: "The browser isn't doing anything right now." });
        return json({ open: true, site: v.domain, doing: v.doing, job: v.summary, taken_over: v.takeover === "on", waiting_for_them: v.asking ?? v.approval ?? undefined, shown: desktop ? "the live view on the PC" : "nothing (the live view is on the PC)" });
      },
    ),
    tool(
      "start_work",
      "Take something away to work on properly when it will take more than about half a minute (designing or modelling a " +
        "piece, a set of drawings, research across several places, weighing options on something that matters), so they " +
        "aren't left waiting in silence. It carries on from this conversation, with everything you know and all your tools, " +
        "while they talk to you about anything else; the result comes back to them (and to you) when it's done. Call it as " +
        "your first step, then answer with only what you understood, that you're on it, and roughly how long.",
      {
        title: z.string().max(80).describe("A short name, e.g. 'Splice for the Bellbird St deck post'"),
        understood: z.string().max(1500).describe("What you take them to want to end up with, in a sentence or two of your own, so they can correct you at once"),
        how_long: z.string().max(40).describe("Your honest guess, e.g. 'about five minutes'"),
      },
      async ({ title, understood, how_long }) => {
        if (ctx.background) return json({ error: "You're already the work: do it here." });
        const id = startTask({ title, brief: `${title}. ${understood}`, origin: ctx.turn.origin, understood, howLong: how_long, fromTurn: ctx.turn.job_id, open: true });
        return json({
          started: id,
          now: "Answer with only this: what you understood (in your own words, not a stock phrase), that you're on it, and roughly how long. Don't start the work in this answer: it carries on separately from here, with everything you know.",
        });
      },
    ),
    tool(
      "update_work",
      "Pass something to a piece of work that's running: what they've added or changed ('make it 2.4 high, not 2.1'), or " +
        "wrap_up: true when they want the quick version now. job: its id from the Context (default the latest).",
      {
        job: z.string().optional(),
        say: z.string().max(600).describe("What they said or want, in a sentence"),
        wrap_up: z.boolean().optional(),
      },
      async ({ job, say, wrap_up }) => {
        const id = job ?? latestRunningTask(ctx.bot);
        if (!id) return json({ error: "Nothing of yours is being worked on. If he wants it done, start it again with start_work." });
        if (ctx.bot && jobBot(id) !== ctx.bot) return json({ error: "That piece of work belongs to another bot, so nothing was passed on." });
        const text = wrap_up
          ? `(Tavi) He wants it now: "${say}". Stop where you are and give him the best answer you have, saying what's unfinished.`
          : `(Tavi) He's just added: "${say}". Take it into account and carry on.`;
        return json(steerWork(id, text) ? { passed_on: id, say: wrap_up ? "Say it'll come straight back with what it has." : "Say you've passed it on." } : { error: "That piece of work isn't running any more." });
      },
    ),
    tool(
      "progress",
      "While you work: a few plain words on what you're doing now, at a real step ('Comparing three ways to splice the post', " +
        "'Checking the bolts go through both halves'). It's the quiet line they see. Not for every small tool call.",
      { now: z.string().max(90) },
      async ({ now }) => {
        ctx.note?.(now);
        return json({ shown: now });
      },
    ),
    tool(
      "cancel_task",
      "Stop a piece of work (start_work) or a browser_task the user wants stopped. Leave job_id out for the most recent one.",
      { job_id: z.string().optional() },
      async ({ job_id }) => {
        const id = job_id ?? latestRunningTask(ctx.bot);
        if (!id) return json({ error: "Nothing of yours is running in the background." });
        if (ctx.bot && jobBot(id) !== ctx.bot) return json({ error: "That piece of work belongs to another bot, so it was left alone." });
        return json(cancelJob(id, "brain") ? { stopped: id } : { error: "That one isn't running." });
      },
    ),
  ], ["show_browser", "progress"]);

export const makeActionServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "actions", version: "0.1.0", alwaysLoad: true, tools: actionTools(ctx) });
