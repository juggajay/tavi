// Harmless demo tools for the voice spike. Fixed data for a made-up job; nothing leaves the PC.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { testSafe, type TurnCtx } from "./turn.js";
import { requestEmailApproval, replaceEmailApproval, saveDraft } from "../broker/broker.js";
import { currentJobId } from "../store/jobs.js";
import { findAccount, isEmailAddress } from "../connectors/google.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const READ = { annotations: { readOnlyHint: true } };

export const siteTools = (ctx: TurnCtx) =>
  testSafe(ctx, [
    tool(
      "project_status",
      "DEMO DATA for a made-up job (Club weekend): plans, bookings, deliveries. Not a real job; say so if you use it.",
      {},
      async () =>
        json({
          project: "Club weekend",
          date: "Friday 6 November",
          activities: [{ time: "09:00", what: "Club walk", organiser: "Ruvo Pell" }],
          checks: [{ item: "Room booking", status: "confirmation NOT received", blocks: "Thursday meeting" }],
          deliveries: [{ time: "10:30", what: "Club notebooks", supplier: "Example Club Store" }],
          weather: "24 degrees, rain likely from 2pm (70%)",
        }),
      READ,
    ),
    tool(
      "check_calendars",
      "DEMO DATA until calendars are connected: made-up busy blocks across Work, Gmail and Hotmail. Say it's demo data if you use it.",
      { day: z.string().describe("e.g. Thursday, tomorrow, 12 Nov") },
      async ({ day }) =>
        json({
          day,
          busy: [
            { account: "Work", from: "13:00", to: "14:00", what: "Club meeting" },
            { account: "Gmail", from: "15:15", to: "15:45", what: "School pickup" },
          ],
          hotmail: "nothing",
        }),
      READ,
    ),
    tool(
      "draft_email",
      "Write an email DRAFT in one of the user's accounts and put it in front of the user for approval. " +
        "This never sends. The user sees the exact email on screen and taps Approve to send it; you cannot send it yourself.",
      {
        account: z.enum(["Work", "Gmail", "Hotmail"]),
        to: z.array(z.string()).min(1).describe("Recipient names or addresses, exactly as the user would want them"),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string(),
        replaces: z
          .string()
          .optional()
          .describe("The approval_id of a draft still waiting, when the user asked for a change to it ('make it shorter'): it's replaced on their screen"),
      },
      async (args) => {
        const real = findAccount(args.account);
        if (real) {
          const bad = [...args.to, ...(args.cc ?? [])].filter((r) => !isEmailAddress(r));
          if (bad.length) {
            return json({
              error: `${real.label} is a real account, so recipients must be email addresses. Not addresses: ${bad.join(", ")}. ` +
                "Find the address in past emails with search_email (e.g. from:ruvo), or ask the user.",
            });
          }
        }
        const jobId = ctx.turn.job_id ?? currentJobId();
        const { replaces, ...email } = args;
        if (replaces) {
          try {
            const approval = replaceEmailApproval(replaces, email, jobId);
            return json({ approval_id: approval.id, status: "The changed draft replaced the old one on the user's screen. NOT sent.", expires_in_minutes: 15 });
          } catch (e) {
            return json({ error: e instanceof Error ? e.message : String(e) });
          }
        }
        const draftId = saveDraft({ ...email, jobId });
        const approval = requestEmailApproval(draftId, jobId);
        return json({
          draft_id: draftId,
          approval_id: approval.id,
          status: "Draft is on the user's screen waiting for them to tap Approve. NOT sent.",
          expires_in_minutes: 15,
        });
      },
    ),
  ], ["project_status", "check_calendars"]);

export const makeDemoServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "site", version: "0.1.0", alwaysLoad: true, tools: siteTools(ctx) });

export const TOOL_LABELS: Record<string, string> = {
  start_work: "Taking it away to work on",
  update_work: "Passing it on",
  progress: "Working on it",
  cancel_task: "Stopping it",
  request_action: "Putting it up for your OK",
  browser_task: "Starting that on the web",
  project_status: "Checking today's job status",
  list_drawing_sets: "Checking which drawings I have",
  list_sheets: "Looking at the drawing register",
  search_drawings: "Searching the drawings",
  read_sheet: "Reading the sheet",
  view_drawing: "Looking at the drawing",
  find_on_sheet: "Finding it on the sheet",
  schedule_rows: "Checking the schedule",
  show_drawing: "Putting it on your screen",
  show_card_again: "Bringing it back up",
  show_again: "Bringing it back up",
  show_list: "Putting it on your screen",
  show_table: "Putting it on your screen",
  show_note: "Putting it on your screen",
  list_shown: "Finding what I showed you",
  point_at: "Finding it on the sheet",
  pin_item: "Pinning it",
  unpin_item: "Unpinning it",
  list_pins: "Checking your pins",
  list_folders: "Checking your folders",
  list_files: "Looking through your files",
  search_files: "Searching your files",
  read_file: "Reading a file",
  view_file: "Looking at a photo",
  show_file: "Putting it on your screen",
  check_calendars: "Checking your calendars",
  draft_email: "Writing the draft",
  list_accounts: "Checking your accounts",
  search_email: "Checking your email",
  read_email: "Reading the email",
  remember: "Noting that down",
  recall: "Checking what I know",
  forget: "Forgetting that",
  add_commitment: "Adding a follow-up",
  list_commitments: "Checking what's still open",
  update_commitment: "Updating that follow-up",
  create_routine: "Setting up the routine",
  list_routines: "Checking your routines",
  update_routine: "Updating the routine",
  todays_activity: "Looking back over today",
  set_notification_rules: "Updating when I ping you",
  set_pebble_colour: "Changing colour",
  list_joints: "Checking the joints I know",
  joint_model: "Building the model",
  make_shop_drawing: "Drawing it up",
  show_shop_drawing: "Getting the drawing",
  set_drawing_status: "Reissuing the drawing",
  export_shop_drawing: "Getting the file ready",
  show_model: "Building the model",
  look_at_model: "Having a look at the model",
  save_model: "Saving the model",
  list_computers: "Checking the other computer",
  list_computer_folder: "Looking on the other computer",
  find_on_computer: "Searching the other computer",
  read_from_computer: "Reading it on the other computer",
  bring_from_computer: "Bringing it across",
  name_computer: "Noting that",
  brain_status: "Checking The Brain",
  brain_jobs: "Looking at The Brain's jobs",
  brain_start_job: "Getting the job ready",
  brain_answer_gate: "Passing on your answer",
  brain_cancel_job: "Stopping it",
  brain_results: "Getting what The Brain wrote",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
  // The bots' own web tools (mcp__web__search, mcp__web__read) and the lead's looking tools.
  search: "Searching the web",
  read: "Reading a web page",
  look_now: "Going to look for something useful",
  finds_settings: "Changing how much it looks",
  find_reaction: "Noting what you made of it",
  sent_finds: "Checking what it has sent before",
};
