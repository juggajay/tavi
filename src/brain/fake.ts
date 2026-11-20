// Fake brain for dev and UI tests (LH_FAKE_BRAIN=1, dev mode only): scripted replies in well under a second, no model
// calls, no cost. Each script row matches the user's words and may call the real app code (drafts, approvals, the show
// tools) so the screens it drives are the real ones. Rows use the fixture "Sample House" drawing set.
import { DEV } from "../dev.js";
import { requestEmailApproval, saveDraft } from "../broker/broker.js";
import { currentJobId } from "../store/jobs.js";
import type { BackgroundResult, BrainResult } from "./brain.js";
import { onSteer, startTask, workLimits, type TaskSpec } from "./tasks.js";
import { actionTools } from "./actionTools.js";
import { listShown, openSketchPad, showAgain, showList, showSheet, showSketch, showTable } from "./showTools.js";
import { SAMPLE_SKETCHES } from "../shared/sketches.js";
import { referenceTools, showReference } from "./referenceTools.js";
import { findBook } from "../reference/library.js";
import { newTurn, newTurnCtx, type TurnInfo } from "./turn.js";
import { fileTools, showFiles } from "./fileTools.js";
import { findSheet, listSheets, locate, scheduleRows } from "../drawings/library.js";
import { getSitdown, JUST_OFFERED_MARK, moveSitdown, OFFER_LINE, OFFER_MARK } from "../memory/sitdown.js";
import { editUser, readUser } from "../profile/profile.js";
import { jointModel, modelTools, showModel } from "./modelTools.js";
import { SAMPLE_MODELS } from "../shared/model3d/samples.js";
import { getItem } from "../store/items.js";
import { addDrawingView, exportShopDrawing, makeShopDrawing, removeDrawingView, setDrawingDetails, setDrawingStatus, showShopDrawing } from "./shopTools.js";
import { doorPiece, tablePiece } from "../shared/drawing/testpieces.js";

export const FAKE = process.env.LH_FAKE_BRAIN === "1";
if (FAKE && !DEV) throw new Error("LH_FAKE_BRAIN=1 only works in dev mode (LH_DEV=1). Use npm run dev -- --fake.");

const DELAY = Number(process.env.LH_FAKE_DELAY_MS ?? 400);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PROJECT = "Sample House";

export type FakeStep = { utterance: string; request: string; match: RegExpMatchArray; turn: TurnInfo; progress: (label: string) => void; wait: (ms: number) => Promise<void> };
export type FakeRow = { match: RegExp; run: (s: FakeStep) => Promise<Omit<BrainResult, "ms">> | Omit<BrainResult, "ms"> };

/** The real show_file tool, as the brain would call it. */
async function showFile(turn: TurnInfo, args: Record<string, unknown>) {
  const ctx = { ...newTurnCtx(), turn };
  await fileTools(ctx).find((t) => t.name === "show_file")!.handler(args, {});
}

/** The plan a door tag is on (A-101 or A-102 in the fixture set). */
async function sheetWith(tag: string) {
  for (const s of listSheets({ project: PROJECT }).filter((x) => /plan/i.test(x.title ?? ""))) {
    const full = findSheet(s.id);
    if (full && (await locate(full, tag, 1)).length) return full.sheet_no ?? full.id;
  }
  return undefined;
}

/** A model tool as the brain would call it (look_at_model, save_model): the real handler, its words back. */
async function modelTool(turn: TurnInfo, name: string, args: Record<string, unknown>) {
  const ctx = { ...newTurnCtx(), turn };
  const out = (await modelTools(ctx).find((t) => t.name === name)!.handler(args, {})) as { content: ({ type: "text"; text: string } | { type: "image"; data: string })[] };
  return out.content;
}

/** The model the Context says is on screen. */
const modelOnScreen = (request: string) => /a 3D model: [^\n]*\[item (itm_\w+)\]/.exec(request)?.[1];
/** The shop drawing the Context says is on screen. */
const drawingOnScreen = (request: string) => /shop drawing [^\n]*\[item (itm_\w+)\]/.exec(request)?.[1];

/** An action tool as the brain would call it (start_work, update_work, Stage 21.3): the real handler, its JSON back. */
async function actionTool(turn: TurnInfo, name: string, args: Record<string, unknown>) {
  const ctx = { ...newTurnCtx(), turn };
  const out = (await actionTools(ctx).find((t) => t.name === name)!.handler(args as never, {})) as { content: { type: string; text?: string }[] };
  return JSON.parse(out.content[0].text ?? "{}") as Record<string, unknown>;
}

/** A reference tool as the brain would call it (Stage 20.4's checks): the real handler, its JSON back. */
async function referenceTool(turn: TurnInfo, name: string, args: Record<string, unknown>) {
  const ctx = { ...newTurnCtx(), turn };
  const out = (await referenceTools(ctx).find((t) => t.name === name)!.handler(args, {})) as { content: { type: string; text?: string }[] };
  return JSON.parse(out.content[0].text ?? "{}") as Record<string, unknown>;
}

/** What the assistant says after adding a view (19.3): the question back, the error, or what went where. */
const viewSaid = (r: Awaited<ReturnType<typeof addDrawingView>>) => ("ask" in r && r.ask ? r.ask : "error" in r && r.error ? r.error : "added" in r ? `Added ${String(r.added).replace(/ drawn larger$/, ", drawn larger")} on sheet ${r.sheet}.` : "Done.");

/**
 * The hall table (19.7's fake turns): 1200 x 350 x 800, aprons tenoned into the legs, the top on buttons. Built as his
 * joints (he said them) or as the assistant's design (said first in two sentences, the list on screen).
 */
function hallTable(turn: TurnInfo, by: "owner" | "assistant") {
  const payload = {
    ...tablePiece({ L: 1200, D: 350, H: 800 }),
    // its picks carry where each came from (the merge of 19 and 20): the tenon its own call (10 in a 22 apron isn't
    // the third the rule gives), the buttons the old rule from Fairham
    design: {
      by,
      joints: [
        { parts: ["apron", "leg"], kind: "mortise and tenon", by },
        { parts: ["top", "apron"], kind: "buttons", fixing: by === "owner" ? "Top screwed through buttons" : "Buttons, screwed to the top", by, ...(by === "assistant" ? { rules: ["top_buttoned"] } : {}) },
      ],
    },
  };
  const r = showModel(turn, { title: "Hall table 1200 x 350 x 800", payload });
  if ("error" in r) return { spoken: r.error };
  if (by === "owner") return { spoken: "Done with your joints: mortise and tenons for the rails, and the top screwed through buttons." };
  showList(turn, { heading: "What I picked for the hall table", columns: ["Joint", "What", "Why", "From"], rows: [{ cells: ["Rails to legs", "Mortise and tenon, 10 thick, 30 long", "Legs are 70 square: room for a good tenon", "My own call"] }, { cells: ["Top to rails", "Buttons, screwed to the top", "Lets the top move with the seasons", "Fairham, Woodwork Joints, Buttoning (p. 184)"] }] });
  return { spoken: "I've gone with mortise and tenons for the rails, since the legs are 70 square, and the top on buttons so it can move. The list is on screen; say if you want anything different." };
}

/** Script rows, first match wins. */
export const SCRIPT: FakeRow[] = [
  // Working in the open (Stage 21.3): "work on ..." takes it away with the real start_work tool and answers with what it
  // understood; "how's that going?" answers from the Context's work-in-progress line; "the quick version" hurries it
  // with the real update_work tool.
  {
    match: /\bwork on (?:a |an |the )?(.+?)[.?!]*$/i,
    run: async ({ turn, match }) => {
      if (!turn.persist) return { spoken: "(test) I'd take that away to work on, but test turns don't start jobs." };
      const what = match[1];
      const understood = `You want a ${what} you'd be proud of, made properly, not just something that fits the words.`;
      const r = await actionTool(turn, "start_work", { title: `${what[0].toUpperCase()}${what.slice(1)}`, understood, how_long: "about a minute" });
      if (r.error) return { spoken: String(r.error) };
      return { spoken: `${understood} I'm on it; give me about a minute, and talk to me about anything meanwhile.` };
    },
  },
  {
    match: /\bhow'?s (?:that|it) going\b/i,
    run: ({ request }) => {
      const now = /^- \[job_\w+\] [^\n]*?; now: ([^;\n]+)/m.exec(request)?.[1];
      return { spoken: now ? `Still on it. Right now: ${now.toLowerCase()}.` : "There's nothing on the go right now." };
    },
  },
  {
    match: /\bquick version\b/i,
    run: async ({ turn, utterance }) => {
      const r = await actionTool(turn, "update_work", { say: utterance, wrap_up: true });
      return { spoken: r.error ? String(r.error) : "Righto, it'll come straight back with what it's got." };
    },
  },
  // How it uses its shelf (Stage 20.4): the real tools, so the source checks' plumbing is tested end to end.
  {
    match: /\bunit shrinkage of (.+?)[?.!]*$/i,
    run: async ({ turn, match }) => {
      const r = await referenceTool(turn, "timber_species", { name: match[1] });
      if (r.error) return { spoken: "That species isn't in the timber data on my shelf, so I won't give you a figure." };
      const s = (r.species as { name: string; unit_shrinkage: string; cite_as: string }[])[0];
      return { spoken: `${s.name}: ${s.unit_shrinkage.replace(/—.*$/, "")}. That's from the Queensland timber data; it's on screen.` };
    },
  },
  {
    match: /\bwhere did you get that\b/i,
    run: async ({ turn }) => {
      const r = await referenceTool(turn, "how_do_you_know", {});
      const first = (r.sources as { source: string; date: string }[] | undefined)?.[0];
      return { spoken: first ? `That's from ${first.source}${first.date ? `, ${first.date}` : ""}. It's on screen.` : String(r.say ?? "That was my own judgement.") };
    },
  },
  {
    match: /\bnail spacing for (\w+)/i,
    run: async ({ turn, match }) => {
      const r = await referenceTool(turn, "find_in_reference", { query: "nail spacing", maker: match[1] });
      return { spoken: r.error ? `There's no ${match[1]} guide on my shelf, so I won't guess a spacing. Their own installation guide will have it.` : "It's in the maker's guide; it's on screen." };
    },
  },
  // The file viewer (Stage 15.1): the real show_files, as the brain would call it.
  {
    match: /\b(?:everything|all (?:my |the )?files) for (?:the )?(.+?)(?: job| site)?[.?!]*$/i,
    run: async ({ turn, match }) => {
      const r = await showFiles(turn, { job: match[1] });
      return { spoken: r.found ? `${r.found} things for ${r.job ?? match[1]}. They're on screen.` : `I've got nothing for ${match[1]}.` };
    },
  },
  {
    match: /\bfind (?:the |my )?(.+?shop drawings?)\b/i,
    run: async ({ turn, match }) => {
      const r = await showFiles(turn, { words: match[1] });
      return { spoken: r.found ? `Found ${r.found}. On screen.` : "No shop drawings by that name." };
    },
  },
  {
    match: /\bshow me (?:my|the) (photos|sketches|guides|3d models|documents)\b/i,
    run: async ({ turn, match }) => {
      const group = ({ photos: "photos", sketches: "sketches", guides: "guides", "3d models": "models", documents: "documents" } as const)[match[1].toLowerCase() as "photos"];
      const r = await showFiles(turn, { group });
      return { spoken: `${r.found} ${match[1].toLowerCase()}. On screen.` };
    },
  },
  {
    // The round table (Stage 17): the assistant's turns there end with "round-table:<task>". The owner's last words steer
    // it for tests: "[long]" gives a turn too long to say, "[agree]" a turn that only agrees.
    match: /^round-table:(\w+)$/,
    run: ({ match, request }) => {
      const task = match[1];
      const owner = [...request.matchAll(/^Owner: (.*)$/gm)].pop()?.[1] ?? "";
      if (task === "brief") return { spoken: `He wants a second opinion on this: ${owner.replace(/[.?!]+$/, "").slice(0, 80)}.` };
      if (task === "shorter") return { spoken: "Short version: check the numbers first." };
      if (/\[long\]/.test(owner)) return { spoken: "One thing. Two things. Three things. Four things. Five things. Six things." };
      if (/\[agree\]/.test(owner) && task !== "open") return { spoken: "I agree, nothing to add." };
      if (task === "close") return { spoken: "We agree it comes down to how often it's out. We differ on buying or leasing. How many days a week would it be on the road?" };
      if (task === "reply") return { spoken: "Fair point, but a hire ute won't have your racks on it, and that's half a morning each time." };
      if (task === "answer") return { spoken: "Here's my take: count the days the second crew waits on a vehicle, then decide." };
      return { spoken: "If the second crew's out most days, buying wins. Under that, hire and keep the cash free." };
    },
  },
  {
    // The adequacy wall (Stage 21.2): first a claim it must never make; the gateway's guard has it said again without.
    match: /\bstrong enough\b/i,
    run: ({ request }) =>
      /^\(Tavi, not the user\) Your answer says or implies/m.test(request)
        ? { spoken: "I can't tell you that: whether a 90 by 90 post is up to the deck is for an engineer. I can model the post on a stirrup for you to show them." }
        : { spoken: "Yes, a 90 by 90 post is strong enough for the deck." },
  },
  {
    // A longer answer after some work (Stage 10.5's tests): it streams a sentence at a time once the "tools" are done.
    match: /\bhow many doors\b/i,
    run: async ({ progress, wait }) => {
      progress("Looking through the drawings");
      await wait(150);
      progress("Reading the door schedule");
      await wait(150);
      return { spoken: "There are eight doors on the ground floor, D01 to D08, on A-101 revision C. D06 is the only fire door, sixty minutes. The list is on screen now." };
    },
  },
  {
    // Opens with a stock acknowledgement and the name, as the real brain did before Stage 10 (the voice turn's
    // backstop takes it off; a typed turn keeps it).
    match: /\bwhat time is it\b/i,
    run: () => ({ spoken: "Okay Nemi, it's twenty past ten." }),
  },
  {
    // A background task: answers at once, the result comes later as a notice with a table (fakeTask below).
    match: /\bbackground\b/i,
    run: ({ turn }) => {
      if (!turn.persist) return { spoken: "(test) I'd hand that to the background, but test turns don't start jobs." };
      startTask({ title: "Ground floor doors check", brief: "Check every door on the ground floor plan against the door schedule.", origin: turn.origin });
      return { spoken: "On it. I'll tell you when it's done." };
    },
  },
  {
    match: /\bslow\b/i,
    run: async ({ progress, wait }) => {
      for (const label of ["Looking through the drawings", "Reading the door schedule", "Checking three example shops"]) {
        progress(label);
        await wait(2000);
      }
      return { spoken: "That took a while, but it's done." };
    },
  },
  {
    // the plan's weekly limit, as the CLI words it (Stage 21: said to him in one plain sentence, never as it comes)
    match: /\bweekly limit\b/i,
    run: () => {
      throw new Error("You've hit your weekly limit · resets Nov 17, 9pm (Australia/Sydney)");
    },
  },
  {
    match: /\bhit your limit\b/i,
    run: () => {
      throw new Error("Claude AI usage limit reached");
    },
  },
  {
    match: /\bfail\b/i,
    run: () => {
      throw new Error("fake brain: asked to fail");
    },
  },
  {
    match: /\b(email|draft)\b/i,
    run: async ({ progress }) => {
      progress("Writing the email");
      const jobId = currentJobId(); // as draft_email does: the gateway opens the draft on the screen that asked
      const draft = saveDraft({
        jobId,
        account: "Work email",
        to: ["ruvo@example.com"],
        subject: "Window sizes for Sample House",
        body: "Hi Ruvo,\n\nCould you send the window sizes for Sample House by Thursday? The frame goes up next week.\n\nThanks,\nNemi",
      });
      requestEmailApproval(draft, jobId);
      return { spoken: "I've drafted the email to Ruvo. Have a look before it goes." };
    },
  },
  {
    // A reference book page (Stage 8.2): the made-up span tables in the fixture shelf, with the row used ringed.
    match: /\bspan table\b/i,
    run: async ({ turn, progress }) => {
      progress("Looking it up in the books");
      const book = findBook("Made-up Span Tables");
      if (!book) return { spoken: "The reference books aren't ready yet." };
      const r = await showReference(turn, { book: book.id, page: 3, caption: "Rafters, MGP10, 450 centres", mark: [0.08, 0.17, 0.5, 0.2] });
      if ("error" in r) return { spoken: r.error };
      return { spoken: "A 90 by 35 spans 2,310 at 450 centres. That's Table 29, page 4. It's on screen." };
    },
  },
  {
    // Working a problem through (Stage 8.6), scripted: a question, one question back, then an answer that names the
    // table and page, with the page and a sketch. Uses the made-up span tables in the fixture shelf.
    match: /\bwhat size rafter\b/i,
    run: () => ({ spoken: "What spacing are the rafters, 450 or 600?" }),
  },
  {
    match: /^(450|600)\b/,
    run: async ({ request, turn, match, progress }) => {
      if (!/What spacing are the rafters/.test(request)) return { spoken: `You said: ${match[0]}` };
      progress("Looking it up in the books");
      const book = findBook("Made-up Span Tables");
      if (!book) return { spoken: "The reference books aren't ready yet." };
      const at600 = match[1] === "600";
      const page = at600 ? 4 : 3;
      await showReference(turn, { book: book.id, page, caption: `Rafters, MGP10, ${match[1]} centres` });
      showSketch(turn, {
        title: "Rafter, 3600 span",
        shapes: [
          { type: "line", a: [0, 0], b: [3600, 0], weight: 2 },
          { type: "rect", x: 0, y: 0, w: 3600, h: 140, fill: "timber" },
          { type: "dim", a: [0, 0], b: [3600, 0], offset: -200 },
          { type: "label", at: [1800, 500], text: "140 × 45 MGP10", leader: [1800, 70] },
        ],
      });
      return { spoken: `A 140 by 45 does it at ${match[1]} centres. That's Table 29, page ${page + 1}. The page and a sketch are on screen.` };
    },
  },
  {
    // The owner's sketch from the pad (Stage 8.5 Part B): looked at and said back.
    match: /^here's my sketch\b/i,
    run: () => ({ spoken: "Got your sketch. That's the corner you meant, I think." }),
  },
  {
    // The brain opening the pad for the owner, with a question at the top (the UI tests' way in).
    match: /\bhow do i show you\b/i,
    run: ({ turn }) => {
      const r = openSketchPad(turn, { prompt: "Draw me the corner you mean." });
      return { spoken: "error" in r ? r.error : "Draw it for me." };
    },
  },
  // Shop drawings (Stage 12): the dining table test piece, drawn up, changed and reissued, marked for approval, shared.
  {
    match: /\b(?:dining )?table\b.*\b(?:3d|model)\b|\b(?:3d|model)\b.*\btable\b/i,
    run: ({ turn }) => {
      const r = showModel(turn, { title: "Dining table 1500 x 800", payload: tablePiece() });
      return { spoken: "error" in r ? r.error : "Here's the table: seventy legs, aprons tenoned in, a thirty top." };
    },
  },
  // Asking before designing (Stage 19.7): a piece with no joints said gets one question first, unless USER.md has his
  // standing answer; his joints are used as he said them; "you design it" says what was picked, then builds.
  {
    match: /\bmake me a hall table\b(.*)$/i,
    run: ({ turn, match }) => {
      const said = match[1];
      if (/\b(mortise|tenon|dowel|housing|halving|lap|screw|button|biscuit|domino|pocket)/i.test(said)) return hallTable(turn, "owner");
      if (/design it unless I say otherwise/i.test(readUser())) return hallTable(turn, "assistant");
      return { spoken: "Do you want to tell me the joints, or shall I design it and show you what I've picked?" };
    },
  },
  {
    match: /^(?:you )?design it\b|^you pick\b/i,
    run: ({ turn, request }) => (/tell me the joints, or shall I design it/.test(request) ? hallTable(turn, "assistant") : { spoken: "Design what? Tell me what you'd like made." }),
  },
  {
    match: /\bmortise and tenons? for the rails\b/i,
    run: ({ turn }) => hallTable(turn, "owner"),
  },
  {
    match: /\b(just design it unless i say otherwise|always ask me)\b/i,
    run: ({ match }) => {
      const designIt = /design it/i.test(match[1]);
      editUser({ op: "add", section: "How to talk to them", text: designIt ? "Making a piece: just design it unless I say otherwise (say what was picked)." : "Making a piece: always ask whether I want to give the joints." }, { trust: "user", source: "you said" });
      return { spoken: designIt ? "Righto, I'll design it and tell you what I picked, unless you say otherwise." : "Got it, I'll always ask first." };
    },
  },
  {
    // the frame-and-panel door (Stage 19's test piece)
    match: /\bdoor\b.*\b(?:3d|model)\b|\b(?:3d|model)\b.*\bdoor\b/i,
    run: ({ turn }) => {
      const r = showModel(turn, { title: "Front door 820 x 2040", payload: doorPiece() });
      return { spoken: "error" in r ? r.error : "Here's the door: stiles and rails, a mullion, two panels in grooves." };
    },
  },
  // Views he asks for on a shop drawing (Stage 19.3), as add_drawing_view and remove_drawing_view.
  {
    match: /\b(?:add )?a section through (?:the middle of )?(?:the |that |this )?([a-z ]+?)(?: (across|along)(?: it)?)?[.?!]*$/i,
    run: async ({ turn, match }) => {
      const whole = /\b(table|door|piece|unit|cabinet|middle)\b/i.test(match[0]) && !/\b(shelf|rail|stile|leg|apron|back|side|panel|mullion|post|beam)\b/i.test(match[1]);
      const r = await addDrawingView(turn, { kind: "section", ...(whole ? {} : { part: match[1] }), ...(match[2] ? { way: match[2].toLowerCase() as "across" | "along" } : {}) });
      return { spoken: viewSaid(r) };
    },
  },
  {
    match: /\bhow the ([a-z ]+?) goes into the ([a-z ]+?)(?: from (above|below|the front|the back|the left|the right))?[.?!]*$/i,
    run: async ({ turn, match }) => {
      const from = (match[3] ?? "above").replace(/^the /, "") as "above";
      const r = await addDrawingView(turn, { kind: "detail", parts: [match[1], match[2]], from });
      return { spoken: viewSaid(r) };
    },
  },
  {
    match: /\bmake (?:that|this|detail ([a-z])) (?:detail )?bigger\b/i,
    run: async ({ turn, match }) => {
      const r = await addDrawingView(turn, { kind: "bigger", detail: match[1] ?? "that" });
      return { spoken: viewSaid(r) };
    },
  },
  {
    match: /\btake (the last one|that|section [a-z]|detail [a-z]|the 3d view) off\b/i,
    run: async ({ turn, match }) => {
      const r = await removeDrawingView(turn, { view: /last|that/i.test(match[1]) ? "last" : match[1] });
      return { spoken: "error" in r ? r.error! : `Taken off: ${r.removed}. That's revision ${r.revision}.` };
    },
  },
  {
    match: /\btop (\d+) wider\b/i,
    run: async ({ turn, request, match }) => {
      const on = drawingOnScreen(request);
      const d = on ? getItem(on) : null;
      if (d?.kind !== "shopdrawing" || !d.payload.model_item) return { spoken: "There's no drawing up to change." };
      const old = getItem(d.payload.model_item);
      if (old?.kind !== "model") return { spoken: "I can't find the model it was drawn from." };
      const n = Number(match[1]);
      const parts = old.payload.parts.map((p) => (p.id === "top" && p.stock.type === "box" ? { ...p, stock: { ...p.stock, size: [p.stock.size[0], p.stock.size[1] + n, p.stock.size[2]] as [number, number, number] } } : p));
      const m = showModel(turn, { title: old.title, payload: { ...old.payload, parts }, replaces: old.id });
      if ("error" in m) return { spoken: m.error };
      const r = await makeShopDrawing(turn, { model: m.item.id, drawing: d.payload.number, change: `Top ${n} wider` });
      return { spoken: "error" in r ? r.error! : "needs" in r ? "I need a bit more first." : `Done: the top's ${n} wider, reissued as ${r.number} revision ${r.revision}.` };
    },
  },
  {
    match: /\b(?:shop drawings?\b|draw (?:it|that|this) up\b)/i,
    run: async ({ turn, request }) => {
      if (/\b(list|which)\b/i.test(request.split("\n").pop() ?? "")) {
        const r = showShopDrawing(turn, {});
        return { spoken: "error" in r ? r.error! : "Here are the shop drawings, by job." };
      }
      // as if they'd answered the one question: Tas oak, DAR, and a clear satin finish (12.10)
      const r = await makeShopDrawing(turn, { model: modelOnScreen(request), project: "Household table", client: "N. Venn", title: "Dining table", materials: { all: "Tas oak, DAR" }, finish: "2 coats clear satin", asked: true });
      if ("error" in r) return { spoken: r.error! };
      if ("needs" in r) return { spoken: `I need ${r.needs!.join(", ")}.` };
      return { spoken: `Drawn up as ${r.number}, ${r.sheets.length} sheets, in Tas oak with a clear satin finish.` };
    },
  },
  {
    // the title block's details, set by talking (12.10)
    match: /\b(?:put (.+?) on the drawings|take the company(?: name)? off|add our (?:phone number|number),? (.+)|my initials are (\w+))\b/i,
    run: ({ turn, match }) => {
      const a = match[1] ? { company: match[1] } : match[2] ? { line: match[2] } : match[3] ? { drawn_by: match[3] } : { company: null };
      const r = setDrawingDetails(turn, a);
      return { spoken: "error" in r ? r.error! : `Done. New drawings carry it; the ones already made pick it up on their next revision.` };
    },
  },
  {
    match: /\b(?:mark it |issue it )?for (approval|construction)\b/i,
    run: async ({ turn, match }) => {
      const r = await setDrawingStatus(turn, { status: /construction/i.test(match[1]) ? "FOR CONSTRUCTION" : "FOR APPROVAL" });
      return { spoken: "error" in r ? r.error! : `Marked ${r.status.toLowerCase()}, revision ${r.revision}.` };
    },
  },
  {
    match: /\bsend me the (pdf|dxf)\b/i,
    run: ({ turn, match }) => {
      const r = exportShopDrawing(turn, { as: match[1].toLowerCase() as "pdf" | "dxf" });
      return { spoken: "error" in r ? r.error! : "It's up with a Share button; tap it to send it where you want." };
    },
  },
  {
    match: /\bpull up the (.+?) drawing\b/i,
    run: ({ turn, match }) => {
      const r = showShopDrawing(turn, { query: match[1] });
      return { spoken: "error" in r ? r.error! : "shown" in r ? `${r.number} revision ${r.revision}.` : "Here's the list." };
    },
  },
  {
    // 3D models (Stage 9): the gallery examples from their recipes, changed by talking, looked at and saved.
    match: /\bmortise and tenon\b/i,
    run: ({ turn }) => {
      const r = jointModel(turn, { type: "mortise_tenon", title: SAMPLE_MODELS[0].title, members: [[90, 45], [90, 90]], material: "hardwood" });
      return { spoken: "error" in r ? r.error : "Here's the mortise and tenon. I made the tenon fifteen thick, a third of the rail. Pull it apart to see it." };
    },
  },
  {
    match: /\bdovetail\b/i,
    run: ({ turn }) => {
      const r = jointModel(turn, { type: "dovetail", title: SAMPLE_MODELS[1].title, members: [[140, 19], [140, 19]], params: { tails: 3 }, material: "oak" });
      return { spoken: "error" in r ? r.error : "A through dovetail with three tails, at one in eight." };
    },
  },
  {
    match: /\bworkbench\b/i,
    run: ({ turn }) => {
      const r = showModel(turn, { title: SAMPLE_MODELS[3].title, payload: SAMPLE_MODELS[3].payload });
      return { spoken: "error" in r ? r.error : "Here's the bench, ninety by forty-five frame with a nineteen ply top." };
    },
  },
  {
    match: /\b(?:3d|model)\b.*\bbirdsmouth\b|\bbirdsmouth\b.*\b(?:3d|model)\b/i,
    run: ({ turn }) => {
      const r = showModel(turn, { title: SAMPLE_MODELS[2].title, payload: SAMPLE_MODELS[2].payload });
      return { spoken: "error" in r ? r.error : "The rafter on its plate, in 3D." };
    },
  },
  {
    match: /\btenon (\d+) longer\b/i,
    run: ({ turn, request, match }) => {
      const id = modelOnScreen(request);
      const old = id ? getItem(id) : null;
      if (!id || old?.kind !== "model" || !old.payload.made_by) return { spoken: "There's no joint up to change." };
      const length = Number(old.payload.made_by.params.length) + Number(match[1]);
      const r = jointModel(turn, { type: old.payload.made_by.recipe, title: old.title, replaces: id, params: { length } });
      return { spoken: "error" in r ? r.error : `Done, the tenon's ${length} long now.` };
    },
  },
  {
    match: /\blook at (?:the |that )?model\b/i,
    run: async ({ turn }) => {
      const out = await modelTool(turn, "look_at_model", {});
      const pics = out.filter((c) => c.type === "image") as { data: string }[];
      if (!pics.length) return { spoken: "I couldn't see it just now." };
      return { spoken: `I looked at it: ${pics.length} pictures, ${pics.map((p) => Math.round((p.data.length * 3) / 4)).join(" and ")} bytes.` };
    },
  },
  {
    match: /\bsave (?:that|it) as (?:a )?(3d file|picture|stl)\b/i,
    run: async ({ turn, match }) => {
      const as = /picture/i.test(match[1]) ? "picture" : /stl/i.test(match[1]) ? "stl" : "glb";
      const out = await modelTool(turn, "save_model", { as });
      const r = JSON.parse((out[0] as { text: string }).text) as { saved?: string; file?: string; error?: string };
      return { spoken: r.saved ? `Saved as ${r.saved}.` : (r.error ?? "That didn't save.") };
    },
  },
  {
    // A sketch the assistant draws (Stage 8.5): the two gallery examples.
    match: /\b(birdsmouth|sketch the stairs?|draw (me )?the stairs?)\b/i,
    run: ({ turn, match }) => {
      const s = SAMPLE_SKETCHES[/stair/i.test(match[0]) ? 1 : 0];
      const r = showSketch(turn, { title: s.title, shapes: [...s.payload.shapes], note: s.payload.note });
      return { spoken: "error" in r ? r.error : "Here it is drawn up, with the sizes on." };
    },
  },
  {
    // "show me that again" (the last thing shown), "show me the rafters again" (by its words)
    match: /\bshow me (?:the )?(.+?) again\b/i,
    run: ({ turn, match }) => {
      const r = showAgain(turn, match[1] === "that" ? "" : match[1]);
      return { spoken: "error" in r ? "Nothing to bring back." : "Here it is again." };
    },
  },
  {
    match: /\bshown me\b|\bshowed me\b/i,
    run: ({ turn }) => {
      listShown(turn);
      return { spoken: "Here's what I've shown you today." };
    },
  },
  {
    match: /\bdoor schedule\b|\bwhich doors\b/i,
    run: async ({ turn, progress }) => {
      progress("Reading the door schedule");
      const tags = Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`);
      const found = await scheduleRows(PROJECT, { numbers: tags });
      const rows = [];
      for (const f of found.found) {
        const [tag, type, width, height] = f.rows[0].row.split(" ");
        rows.push({ cells: [tag, `${width} × ${height}`, type], sheet: await sheetWith(tag), project: PROJECT, around: tag });
      }
      await showList(turn, { heading: "Door schedule", sub: "A-501 Rev A · 12 doors", columns: ["Door", "Size", "Type"], rows, source: "A-501 Door schedule · Rev A" });
      return { spoken: "Here's the door schedule. Tap a door to see it on the plan." };
    },
  },
  {
    match: /\bboth floors\b/i,
    run: async ({ turn }) => {
      await showSheet(turn, { sheet: "A-101", project: PROJECT, caption: "Ground floor plan" });
      await showSheet(turn, { sheet: "A-102", project: PROJECT, caption: "First floor plan" });
      return { spoken: "Both floor plans. Swipe across for the first floor." };
    },
  },
  {
    // the whole set, four sheets to swipe through (12.0: how smoothly sheets swipe)
    match: /\bevery sheet\b|\ball (?:the |four )?sheets\b/i,
    run: async ({ turn }) => {
      for (const [sheet, caption] of [
        ["A-101", "Ground floor plan"],
        ["A-102", "First floor plan"],
        ["A-201", "Elevations"],
        ["A-501", "Door schedule"],
      ])
        await showSheet(turn, { sheet, project: PROJECT, caption });
      return { spoken: "All four sheets. Swipe across to go through them." };
    },
  },
  {
    match: /\bground floor\b|\ba-?101\b/i,
    run: async ({ turn }) => {
      await showSheet(turn, { sheet: "A-101", project: PROJECT, caption: "Ground floor plan" });
      return { spoken: "Here's the ground floor plan." };
    },
  },
  {
    match: /\bdoor d?0?(\d{1,2})\b/i,
    run: async ({ turn, match }) => {
      const tag = `D${match[1].padStart(2, "0")}`;
      const sheet = await sheetWith(tag);
      if (!sheet) return { spoken: `I can't find door ${match[1]} on the plans.` };
      await showSheet(turn, { sheet, project: PROJECT, around: tag, caption: `Door ${tag}` });
      return { spoken: `Here's door ${tag}.` };
    },
  },
  {
    match: /\bcut list\b/i,
    run: async ({ turn }) => {
      await showFile(turn, { file: "Timber schedule.xlsx", part: 0, caption: "Cut list, Lee renovation" });
      return { spoken: "Here's the cut list for the Lee job." };
    },
  },
  {
    match: /\bphoto\b/i,
    run: async ({ turn }) => {
      await showFile(turn, { file: "Frame north wall.jpg", caption: "Frame, north wall" });
      return { spoken: "Here's the photo of the north wall frame." };
    },
  },
  {
    match: /\bspec(ification)?\b/i,
    run: async ({ turn }) => {
      await showFile(turn, { file: "Specification v3.docx", part: 0, caption: "Kitchen specification" });
      return { spoken: "Here's the kitchen part of the spec." };
    },
  },
  {
    match: /\brestaurants?\b/i,
    run: async ({ turn, progress }) => {
      progress("Searching the web");
      await showList(turn, {
        heading: "Dinner near Example Village",
        sub: "Made-up ratings for this demo",
        rows: [
          { cells: ["Example Cafe", "Old-school Italian, big plates", "Example Village", "4.6 ★", "$$"], url: "https://cafe.example.com/" },
          { cells: ["Example Kitchen", "Busy trattoria, no bookings at lunch", "Example Lake", "4.5 ★", "$$$"], url: "https://kitchen.example.com/" },
          { cells: ["Example Pizza", "Pizza and pasta, delivers to Example Village", "Example Village", "4.3 ★", "$"], url: "javascript:alert(1)" },
        ],
        source: "Made-up demo data",
      });
      return { spoken: "Three made-up examples. Example Cafe is the pick." };
    },
  },
  {
    match: /\bprices?\b/i,
    run: ({ turn, progress }) => {
      progress("Checking three example shops");
      showTable(turn, {
        title: "Club notebooks",
        columns: ["Shop", "Per pack", "6 packs", "In stock"],
        rows: [
          ["Example Store A", "$7.95", "$47.70", "Yes"],
          ["Example Store B", "$8.40", "$50.40", "Yes"],
          ["Example Store C", "$8.10", "$48.60", "Next week"],
        ],
        highlight: [{ row: 0, col: 1 }],
        note: "Prices include GST.",
        source: "Made-up shop prices",
      });
      return { spoken: "Example Store A's cheapest at seven ninety-five a pack." };
    },
  },
];

/** The user's words from a brain request (its last line holds them in quotes). */
export function utteranceOf(request: string) {
  const last = request.trim().split("\n").at(-1) ?? "";
  const m = last.match(/"(.*)"\s*$/);
  return (m ? m[1] : last).trim();
}

/**
 * The sit-down, scripted (three questions): "now" after the offer (or "get to know me") starts it; the answers land in
 * USER.md under Basics, Work and People; then a two-sentence close with one offer, and it's done. Null: not a sit-down turn.
 */
function fakeSitdown(utterance: string, request: string, turn: TurnInfo): Omit<BrainResult, "ms"> | null {
  if (!turn.persist) return null; // test turns never save
  const s = getSitdown();
  const said = { trust: "user" as const, source: "you said" };
  const start = () => (moveSitdown({ status: "in_progress" }), { spoken: "Good. First up, what should I call you?" });
  if (s.status !== "in_progress") {
    if (/\b(get to know me|sit-?down)\b/i.test(utterance)) return start();
    if (request.includes(JUST_OFFERED_MARK) && /^(now|yes|yep|sure|go on|righto)\b/i.test(utterance)) return start();
    if (request.includes(JUST_OFFERED_MARK) && /^no\b/i.test(utterance)) return (moveSitdown({ status: "declined" }), { spoken: "No worries." });
    return null;
  }
  const answer = utterance.replace(/[.!]+$/, "");
  if (!s.covered.length) {
    editUser({ op: "add", section: "Basics", text: `Likes to be called ${answer}` }, said);
    moveSitdown({ covered: ["what to call them"] });
    return { spoken: `${answer} it is. What do you do for work?` };
  }
  if (s.covered.length === 1) {
    editUser({ op: "add", section: "Work", text: answer }, said);
    moveSitdown({ covered: ["work"] });
    return { spoken: "Sounds busy. Who are the people that matter most, at work or at home?" };
  }
  editUser({ op: "add", section: "People", text: answer }, said);
  moveSitdown({ covered: ["people"], status: "done" });
  return { spoken: "Thanks, that helps. I've got your work and your people down. Want me to start by keeping track of your follow-ups?" };
}

/** Like the real brain (Stage 10.5): the spoken answer comes out a few characters at a time as it's "written", after
 * the row's tools have run. */
async function streamOut(spoken: string, onSpoken?: (soFar: string) => void) {
  if (!onSpoken) return;
  for (let i = 8; i < spoken.length; i += 8) {
    onSpoken(spoken.slice(0, i));
    await sleep(15);
  }
  onSpoken(spoken);
}

export async function fakeThink(request: string, opts: { onProgress?: (label: string, tool?: string) => void; turn?: TurnInfo; onSpoken?: (soFar: string) => void } = {}): Promise<BrainResult> {
  const started = Date.now();
  const utterance = utteranceOf(request);
  const step = { utterance, request, turn: opts.turn ?? newTurn(), progress: (l: string) => opts.onProgress?.(l), wait: sleep };
  await sleep(DELAY / 2);
  step.progress("Thinking");
  const sit = fakeSitdown(utterance, request, step.turn);
  if (sit) {
    await sleep(DELAY / 2);
    return { ...sit, ms: Date.now() - started };
  }
  // The Context asks for the sit-down offer: help first, then offer it (as the real brain is told to).
  const offer = (out: Omit<BrainResult, "ms">) => {
    if (!request.includes(OFFER_MARK) || !step.turn.persist) return out;
    moveSitdown({ status: "offered" });
    return { ...out, spoken: `${out.spoken} ${OFFER_LINE}` };
  };
  for (const row of SCRIPT) {
    const match = utterance.match(row.match);
    if (!match) continue;
    const out = offer(await row.run({ ...step, match }));
    await sleep(DELAY / 2);
    await streamOut(out.spoken, opts.onSpoken);
    return { ...out, ms: Date.now() - started };
  }
  await sleep(DELAY / 2);
  const out = offer({ spoken: `You said: ${utterance}` });
  await streamOut(out.spoken, opts.onSpoken);
  return { ...out, ms: Date.now() - started };
}

export async function fakeBackground(task: string): Promise<BackgroundResult> {
  await sleep(DELAY);
  return { notify: false, priority: "low", title: "Fake background run", spoken: `(fake) ${task.slice(0, 80)}`, ms: DELAY };
}

/**
 * A fake piece of work (Stage 21.3): plain-words progress lines over LH_FAKE_TASK_MS, then a table on the asker's screen
 * and a result with its notes; "the quick version" (update_work) brings back what it has at once; the limit
 * (LH_WORK_LIMIT_MS in dev) stops it with what it has and what's left; Stop stops it.
 */
async function fakeWork(t: TaskSpec, turn: TurnInfo, progress: (label: string, tool?: string) => void, signal: AbortSignal) {
  const total = Number(process.env.LH_FAKE_TASK_MS ?? 10_000);
  const limit = workLimits().ms;
  const started = Date.now();
  let hurry = false;
  const added: string[] = [];
  const unsteer = onSteer(t.id, (text) => (/He wants it now/.test(text) ? (hurry = true) : added.push(text)));
  const steps = ["Looking at a few good examples", "Building it", "Checking it against what you wanted"];
  if (/\blimit\b/i.test(t.title)) {
    progress(steps[0]);
    await sleep(100);
    throw new Error("You've hit your weekly limit · resets Nov 17, 9pm (Australia/Sydney)");
  }
  if (/\bfail\b/i.test(t.title)) {
    progress(steps[0]);
    await sleep(100);
    throw new Error("fake brain: asked to fail");
  }
  const notes = (done: number) => `Done: ${steps.slice(0, done).join("; ").toLowerCase() || "nothing yet"}. Assumed the usual sizes.${added.length ? ` He added: ${added.join(" ")}` : ""} Left: ${steps.slice(done).join("; ").toLowerCase() || "nothing"}.`;
  try {
    for (let i = 0; i < steps.length; i++) {
      progress(steps[i]);
      for (const end = Date.now() + total / steps.length; Date.now() < end; ) {
        if (signal.aborted) throw new Error("stopped");
        if (hurry) return { spoken: `Here's the quick version: I got as far as ${steps[i].toLowerCase()}. Still to do: ${steps.slice(i + 1).join(", ").toLowerCase() || "the last check"}.`, notes: notes(i), limit: "asked" as const };
        if (Date.now() - started >= limit) return { spoken: `I ran out of room on ${t.title.toLowerCase()}. What I have: ${steps.slice(0, i).join(", ").toLowerCase() || "a start"}. What's left: ${steps.slice(i).join(", ").toLowerCase()}.`, notes: notes(i), limit: "time" as const };
        await sleep(20);
      }
    }
    showTable(turn, { title: t.title, columns: ["Part", "Size"], rows: [["Top", "1200 × 380 × 30"], ["Legs", "45 × 45, tapered"]], source: "My design (sample data)" });
    return { spoken: `${t.title} is done and on your screen: tapered legs, tenoned rails, the top on buttons so it can move. The height's yours to decide.`, notes: notes(steps.length) };
  } finally {
    unsteer();
  }
}

/** A fake background task: a few progress steps over LH_FAKE_TASK_MS (10 s by default), then a table, unless stopped. */
export async function fakeTask(t: TaskSpec, turn: TurnInfo, progress: (label: string, tool?: string) => void, signal: AbortSignal): Promise<{ spoken: string; notes?: string; costUsd?: number; limit?: "time" | "asked" }> {
  if (t.understood) return fakeWork(t, turn, progress, signal);
  const total = Number(process.env.LH_FAKE_TASK_MS ?? 10_000);
  for (const label of ["Looking through the drawings", "Reading the door schedule", "Checking each door"]) {
    if (signal.aborted) throw new Error("stopped");
    progress(label, "fake");
    await sleep(total / 3);
  }
  if (signal.aborted) throw new Error("stopped");
  showTable(turn, {
    title: t.title,
    columns: ["Door", "On plan", "In schedule"],
    rows: [
      ["D03", "Yes", "No"],
      ["D09", "Yes", "No"],
    ],
    source: "A-101, A-501 (sample data)",
  });
  return { spoken: "Two doors on the ground floor aren't in the schedule: D03 and D09." };
}
