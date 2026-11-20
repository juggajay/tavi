// Real drawing tools: search the indexed sets, read a sheet's text, LOOK at any part of a sheet,
// and put a crop on the user's phone. Answers must cite sheet + revision and use the current issue.
import { readFile } from "node:fs/promises";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { cropSheet, describeSheet, findSheet, listProjects, listSheets, locate, regionFor, scheduleRows, search, type Sheet } from "../drawings/library.js";
import { showSheet } from "./showTools.js";
import { testSafe, type TurnCtx } from "./turn.js";

const READ = { annotations: { readOnlyHint: true } };
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const err = (message: string) => json({ error: message });

const brief = (s: Sheet) => ({
  sheet_id: s.id,
  sheet_no: s.sheet_no,
  title: s.title,
  revision: s.revision,
  status: s.status,
  discipline: s.discipline,
  project: s.project,
  has_text: s.read_path === "text",
  confidence: s.confidence,
});

const where = {
  sheet: z.string().describe("Sheet number (e.g. A-2000) or a sheet_id from another drawing tool"),
  project: z.string().optional().describe("Drawing set / job name; needed if several jobs share sheet numbers"),
  region: z.enum(["whole", "title_block", "top_left", "top_right", "bottom_left", "bottom_right", "centre"]).optional(),
  box: z.array(z.number().min(0).max(1)).length(4).optional().describe("Exact region [x0, y0, x1, y1] as fractions of the page (0-1)"),
  around: z.string().optional().describe("Centre the view on this text, e.g. a door mark 'D2.14' or a note"),
  close: z.boolean().optional().describe("Tighter zoom around the text"),
};

export const drawingTools = (ctx: TurnCtx) =>
  testSafe(ctx, [
    tool(
      "list_drawing_sets",
      "List the drawing sets (jobs) Tavi has indexed, with sheet counts and any still indexing.",
      {},
      async () => json({ sets: listProjects() }),
      READ,
    ),
    tool(
      "list_sheets",
      "The drawing register for a set: sheet number, title, revision and status. Superseded sheets are hidden unless asked.",
      { project: z.string().optional(), discipline: z.string().optional(), include_superseded: z.boolean().optional() },
      async ({ project, discipline, include_superseded }) =>
        json({ sheets: listSheets({ project, discipline, includeSuperseded: include_superseded }).slice(0, 150).map(brief) }),
      READ,
    ),
    tool(
      "search_drawings",
      "Full-text search across every indexed sheet (door marks, room names, notes, specs, dimensions written as text). " +
        "Returns matching sheets with a snippet and where on the page it was found. Only the current issue unless asked.",
      { query: z.string(), project: z.string().optional(), include_superseded: z.boolean().optional() },
      async ({ query, project, include_superseded }) => json({ results: await search(query, { project, includeSuperseded: include_superseded }) }),
      READ,
    ),
    tool(
      "read_sheet",
      "Read all the text on one sheet (schedules, notes, labels). Sheets without a text layer return nothing: use view_drawing to look at them.",
      { sheet: where.sheet, project: where.project },
      async ({ sheet, project }) => {
        const s = findSheet(sheet, project);
        if (!s) return err(`No sheet "${sheet}" found. Use list_sheets or search_drawings.`);
        const { db } = await import("../store/db.js");
        const row = db.prepare("SELECT body FROM sheet_fts WHERE sheet_id = ?").get(s.id) as { body: string } | undefined;
        const text = row?.body ?? "";
        return json({
          sheet: brief(s),
          cite_as: describeSheet(s),
          // Dense schedule sheets run to ~30k characters; cutting them short drops rows.
          text: text.length > 32000 ? `${text.slice(0, 32000)}\n[... truncated; use view_drawing or search_drawings for the rest]` : text,
          note: s.read_path === "text" ? undefined : "This sheet has no text layer (outlined or scanned). Use view_drawing to look at it.",
        });
      },
      READ,
    ),
    tool(
      "view_drawing",
      "LOOK at a sheet or part of it: returns an image you can read (linework, dimensions, symbols, hatching, tags). " +
        "Start with region 'whole' for layout, then zoom with 'around' (text to centre on) or 'box'. Use this to check anything visual.",
      { ...where },
      async ({ sheet, project, region, box, around, close }) => {
        const s = findSheet(sheet, project);
        if (!s) return err(`No sheet "${sheet}" found. Use list_sheets or search_drawings.`);
        const b = await regionFor(s, { region, box, around, close });
        const c = await cropSheet(s, b);
        const data = (await readFile(c.path)).toString("base64");
        return {
          content: [
            { type: "image" as const, data, mimeType: "image/png" },
            {
              type: "text" as const,
              text: `${describeSheet(s)}. Region [${b.map((v) => v.toFixed(3)).join(", ")}] of the page (fractions, x0 y0 x1 y1). To zoom further, pass a box inside this one.`,
            },
          ],
        };
      },
      READ,
    ),
    tool(
      "find_on_sheet",
      "Where a piece of text appears on a sheet (boxes as page fractions), so you can view or show exactly that spot.",
      { sheet: where.sheet, project: where.project, text: z.string() },
      async ({ sheet, project, text }) => {
        const s = findSheet(sheet, project);
        if (!s) return err(`No sheet "${sheet}" found.`);
        return json({ sheet: brief(s), hits: await locate(s, text, 8) });
      },
      READ,
    ),
    tool(
      "schedule_rows",
      "Exact rows from every current schedule sheet of a set (door, window, finishes...). Give item numbers (door 0033.1, or " +
        "a type like D04S for every door of that type), or from_plan: a plan sheet, for every item numbered on that plan. " +
        "from_plan is how to answer 'which doors in area 1 / on level 2'. Rows come back word for word.",
      {
        project: z.string(),
        numbers: z.array(z.string()).optional(),
        from_plan: z.string().optional().describe("Plan sheet number, e.g. A2-201"),
        schedule: z.string().optional().describe("Words in the schedule sheets' title, e.g. 'door schedule'. Default 'schedule'"),
      },
      async ({ project, numbers, from_plan, schedule }) => {
        const plan = from_plan ? findSheet(from_plan, project) : undefined;
        if (from_plan && !plan) return err(`No sheet "${from_plan}" in ${project}. Use list_sheets.`);
        if (!plan && !numbers?.length) return err("Give numbers or from_plan.");
        const res = await scheduleRows(project, { numbers, fromPlan: plan, schedule });
        if (!res.schedules.length)
          return err(
            res.not_tables.length
              ? `The schedules in ${project} aren't laid out one item per row, so look them up with read_sheet or view_drawing: ${res.not_tables.slice(0, 12).join("; ")}`
              : `No schedule sheets in ${project} with "${schedule ?? "schedule"}" in the title. Use list_sheets.`,
          );
        return json({ plan: plan && describeSheet(plan), ...res });
      },
      READ,
    ),
    tool(
      "show_drawing",
      "Put a drawing on the owner's screen ('show me', 'where is it'): the real sheet, zoomable, opened at the spot that proves " +
        "your answer with what they asked about ringed. around: the text to ring and centre on (a door mark, a room name), or " +
        "several to ring more than one. Each call is one page they can swipe to (up to 5 a turn).",
      {
        sheet: where.sheet,
        project: where.project,
        region: where.region,
        box: where.box,
        around: z.union([z.string(), z.array(z.string()).max(6)]).optional().describe("Text to ring and centre on, e.g. 'D07', or ['D07', 'D08']"),
        caption: z.string().describe("One short line, e.g. 'Door D07, ground floor'"),
      },
      async ({ sheet, project, region, box, around, caption }) => {
        const r = await showSheet(ctx.turn, { sheet, project, region, box, around, caption });
        if ("error" in r) return err(r.error);
        const p = r.item.payload as { sheet_no: string | null; revision: string | null };
        return json({ showing: `${p.sheet_no ?? "sheet"} Rev ${p.revision ?? "?"}`, rings: r.marks, note: r.marks || !around ? undefined : "That text wasn't found on the sheet, so nothing is ringed." });
      },
    ),
  ], ["list_drawing_sets", "list_sheets", "search_drawings", "read_sheet", "view_drawing", "find_on_sheet", "schedule_rows", "show_drawing"]);

export const makeDrawingServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "drawings", version: "0.1.0", alwaysLoad: true, tools: drawingTools(ctx) });
