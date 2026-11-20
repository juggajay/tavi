// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import type { Item, Approval } from "../../../../src/shared/protocol";
import type { EngineInfo, HqState, Row, TeamBot, SafetyLevel, Subscription, ToolGroup } from "../types";
export const fixtureMode = new URLSearchParams(location.search).has("fixtures");
let shownBots: TeamBot[] = [];
export function rememberFixtureComputer(id: string, on: boolean) { const bot = shownBots.find(bot => bot.id === id); if (bot) bot.computer = on; }
export const fixtureRoutines = [
  { id: "preview-morning", title: "Morning brief", when: "Weekdays at 07:00", status: "active", builtin: "morning_brief", bot: "pebble" },
  { id: "preview-wrap", title: "Wrap-up", when: "Weekdays at 16:00", status: "paused", builtin: "wrap_up", bot: "pebble" },
];
export function fixtureComputer(bot: TeamBot): import("../lib/computer").Computer {
  return { has: bot.computer, state: bot.id === "nora" ? "starting" : bot.computer ? "ready" : "off", why: bot.id === "nora" ? "Preparing its browser and screen." : "", width: 1440, height: 900, controlledBy: null };
}
export const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700"><rect width="1000" height="700" fill="#faf9f6"/><g fill="none" stroke="#a34313" stroke-width="4"><circle cx="330" cy="300" r="140"/><rect x="470" y="180" width="290" height="240" rx="25"/><path d="M240 460L580 130L800 490Z"/></g><g font-family="sans-serif" fill="#303b36"><text x="100" y="585" font-size="32">Plan · circles, squares and triangles</text><text x="100" y="630" font-size="20">A study of simple shapes · made for this preview</text></g></svg>`;
export const drawingUrl = `data:image/svg+xml,${encodeURIComponent(drawing)}`;
export const desktopUrl = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900"><rect width="1440" height="900" fill="#ead8ca"/><rect x="60" y="60" width="1320" height="740" rx="22" fill="#faf9f6"/><path d="M60 125H1380" stroke="#d8cec7"/><g font-family="sans-serif" fill="#34302d"><text x="100" y="101" font-size="22">Tavi · Research notes · example.com</text><text x="120" y="205" font-size="40">A laptop for everyday life</text><text x="120" y="260" font-size="23">Three made-up choices, compared side by side</text><rect x="120" y="310" width="1190" height="350" rx="18" fill="#f1ece5"/><text x="165" y="375" font-size="28">Model</text><text x="580" y="375" font-size="28">Battery</text><text x="975" y="375" font-size="28">Weight</text><text x="165" y="455" font-size="26">Aster 13</text><text x="580" y="455" font-size="26">12 hours</text><text x="975" y="455" font-size="26">1.2 kg</text><text x="165" y="535" font-size="26">Mora 14</text><text x="580" y="535" font-size="26">10 hours</text><text x="975" y="535" font-size="26">1.4 kg</text><text x="165" y="615" font-size="26">Luma 15</text><text x="580" y="615" font-size="26">9 hours</text><text x="975" y="615" font-size="26">1.6 kg</text><text x="120" y="735" font-size="20">Preview facts only · sources linked in the conversation</text></g></svg>`)}`;
const ts = "2026-11-18T03:15:00.000Z";
const bot = (id: string, name: string, role: string, shape: string, colour: string, computer = false): TeamBot => ({ id, name, role, look: { shape, colour }, computer, soul: "Help with the task. Ask before changing anything.", engine: "hermes", primary: { provider: "anthropic", model: "claude-sonnet-4-5", effort: "high" }, fallbacks: [{ provider: "openai-codex", model: "gpt-5", effort: "medium" }, { provider: "anthropic", model: "claude-haiku-4-5", effort: "low" }], servers: "all", voice: "cedar", generation: 1, lead: id === "pebble", createdAt: ts });
export const newFixtureBot = (id: string, name: string, role: string) => bot(id, name, role, "pebble", "orange");
export const toolGroups: ToolGroup[] = [
  { id: "computers", name: "Web research", description: "Read web pages and keep links to sources." },
  { id: "files", name: "Files", description: "Read the documents you choose to share." },
  { id: "mail", name: "Email", description: "Read and draft email; ask before sending." },
  { id: "show", name: "Show results", description: "Show documents, notes and comparisons in the app." },
  { id: "actions", name: "Reminders and tasks", description: "Keep track of tasks and reminders." },
];
const base = { source: "Weekend ideas", origin: "answer" as const, job_id: null, seq: 1, created_at: ts, shown_at: ts, pinned: false };
function item<K extends Item["kind"]>(kind: K, title: string, payload: Extract<Item, { kind: K }>["payload"]): Item { return { ...base, id: `preview-${kind}`, kind, title, payload } as Item; }
const email = { operation: "email.send", account: "Your email", to: ["ruvo@example.com"], cc: [], subject: "A weekend away?", body: "Hi Ruvo,\n\nWould you like to join me for a weekend by the lake? We could leave on Saturday morning.\n\nNemi" };
export const fixtureItems: Item[] = [
  item("sheet", "Plan · shape study", { sheet_id: "preview", sheet_no: "P-01", title: "Shape study", revision: "B", status: "current", project: "Shape collection", aspect: 10 / 7, marks: [], view: [0, 0, 1, 1] }),
  item("shopdrawing", "Drawing set · shape collection", { drawing_id: "preview", number: "D-03", rev: "A", status: "PRELIMINARY", project: "Shape collection", client: "Nemi", model_item: null, sheets: [{ title: "Circles and squares", aspect: 10 / 7 }, { title: "Triangles", aspect: 10 / 7 }], revisions: [{ rev: "A", date: "2026-11-18", text: "First drawing", status: "PRELIMINARY" }], pdf: "/api/shopdrawings/preview/A/pdf", dxf: "/api/shopdrawings/preview/A/dxf" }),
  item("model", "Model · two solids", { parts: [{ id: "cube", name: "Cube", material: "plain", stock: { type: "box", size: [100, 100, 100] } }, { id: "bar", name: "Rectangle", material: "plain", stock: { type: "box", size: [160, 45, 50] }, at: [160, 0, 0] }], note: "A study of two simple solids." }),
  item("sketch", "Sketch · shape study", { shapes: [{ type: "rect", x: 0, y: 0, w: 200, h: 120 }, { type: "line", a: [0, 0], b: [200, 120] }] }),
  item("reference", "Travel guide · page 4", { book_id: "preview-guide", page: 4, printed: "4", aspect: 10 / 7, marks: [], view: [0, 0, 1, 1] }),
  item("doc", "Document · weekend itinerary", { file_id: "preview", name: "Weekend itinerary", part_label: "Part 1", text: "Saturday: leave after breakfast, then walk by the lake.\nSunday: visit the gallery before heading home.", more: true }),
  item("note", "Note · things to bring", { rows: [{ label: "Remember", value: "A jacket, camera and walking shoes." }], text: "Check the weather before leaving." }),
  { ...item("note", "Calendar · lakeside walk", { rows: [{ label: "When", value: "Saturday, 21 November · 10 am" }, { label: "Who", value: "Nemi and Ruvo" }, { label: "Where", value: "The lakeside path" }], text: "An example calendar entry for this preview." }), id: "preview-calendar" },
  item("list", "Weekend ideas", { heading: "Weekend ideas", rows: [{ id: "plan", cells: ["Shape collection", "A gallery visit"], target: { type: "item", item_id: "preview-sheet" } }, { id: "walk", cells: ["Lakeside walk", "A quiet afternoon"], url: "https://example.com/lake" }] }),
  item("table", "Table · laptop comparison", { columns: ["Model", "Battery", "Weight"], rows: [["Aster 13", "12 hours", "1.2 kg"], ["Mora 14", "10 hours", "1.4 kg"], ["Luma 15", "9 hours", "1.6 kg"]], note: "Made-up examples for this preview." }),
  item("image", "Picture · abstract shapes", { src: drawingUrl, w: 1000, h: 700, alt: "Overlapping circles, a square and a triangle" }),
  item("legacy", "Earlier notes · gallery ideas", { images: [{ src: drawingUrl, caption: "Shape study" }], rows: [{ label: "Sunday", value: "Visit the gallery" }] }),
  item("draft", "Email Ruvo about the weekend", { ...email, approval_id: "preview-approval", summary: "Send Ruvo the weekend invitation", details: [], editable: true, status: "pending" }),
];
export const fixtureApproval: Approval & { item_id: string } = { ...email, id: "preview-approval", nonce: "preview-only", kind: "email", expires_at: "2099-01-01T00:00:00Z", item_id: "preview-draft" };
fixtureItems.push(item("page", "Page · laptop shortlist", { title: "Laptop shortlist", summary: "Three made-up choices for everyday travel.", blocks: [{ type: "table", columns: ["Model", "Weight"], rows: [["Aster 13", "1.2 kg"], ["Mora 14", "1.4 kg"], ["Luma 15", "1.6 kg"]] }] }));
export function makeFixtures(): { state: HqState; rows: Row[]; engines: Record<string, EngineInfo>; subscriptions: Subscription[] } {
  const bots = [bot("pebble", "Pebble", "Your main assistant", "pebble", "orange"), bot("tim", "Tim", "Drafting and editing", "shard", "slate"), bot("scout", "Scout", "Research with sources", "skimmer", "teal", true)];
  bots.push(bot("nora", "Nora", "Notes and lists", "moon", "plum", true));
  shownBots = bots;
  const params = new URLSearchParams(location.search);
  const level = (["open", "paused", "walled", "killed"].includes(params.get("safety") ?? "") ? params.get("safety") : "open") as SafetyLevel;
  const bodies: Row["body"][] = [
    { kind: "message", from: "owner", text: "Plan a weekend by the lake and draft an invitation for Ruvo." },
    { kind: "step", id: "read", tool: "read_page", label: "Read the travel guide", state: "ok", ms: 4300 },
    { kind: "step", id: "check", tool: "calendar", label: "Checked the weekend dates", state: "ok", ms: 2600 },
    { kind: "step", id: "draft", tool: "draft_email", label: "Wrote an invitation for Ruvo", state: "ok", ms: 2100 },
    { kind: "message", from: "bot", text: "How about **two days by the lake**? A walk on Saturday and the gallery on Sunday leaves plenty of time to relax.\n\nI've drafted an invitation for Ruvo. Have a look before it goes out." },
    { kind: "card", card: "item", ref: "preview-doc", title: "Document · weekend itinerary" },
    { kind: "card", card: "approval", ref: "preview-approval", title: "Send Ruvo the weekend invitation", state: "waiting" },
    { kind: "notice", tone: "warn", text: "OpenAI has reached today's limit. It can work again at 4 pm.", action: "sign_in" },
  ];
  const rows: Row[] = bodies.map((body, i) => ({ bot: "pebble", generation: 1, seq: i + 1, rev: i + 1, ts: new Date(Date.parse(ts) + i * 2000).toISOString(), kind: body.kind, body }));
  rows.push({ bot: "scout", generation: 1, seq: 1, rev: 1, ts, kind: "message", body: { kind: "message", from: "bot", text: "I compared three made-up laptops: **Aster 13**, **Mora 14** and **Luma 15**. Aster is the lightest; Mora has the best balance of screen size and weight.\n\nSources: [Aster notes](https://example.com/aster), [Mora notes](https://example.com/mora), [Luma notes](https://example.com/luma). These are preview examples." } });
  rows.push({ bot: "scout", generation: 1, seq: 2, rev: 2, ts, kind: "card", body: { kind: "card", card: "item", ref: "preview-table", title: "Table · laptop comparison" } });
  const scoutRow = (body: Row["body"], at: number) => {
    const seq = rows.filter(row => row.bot === "scout").length + 1;
    rows.push({ bot: "scout", generation: 1, seq, rev: seq, ts: new Date(at).toISOString(), kind: body.kind, body });
  };
  const now = Date.now();
  for (const [index, title] of ["Checked laptop weights", "Compared battery life"].entries()) {
    const start = now - 600000 + index * 180000, end = start + 45000;
    scoutRow({ kind: "step", id: `finished-${index}-read`, job: `finished-${index}`, jobTitle: title, jobSince: new Date(start).toISOString(), tool: "read_file", label: "Read the comparison notes", state: "ok", ms: 12000 }, start);
    scoutRow({ kind: "step", id: `finished-${index}-check`, job: `finished-${index}`, jobTitle: title, jobSince: new Date(start).toISOString(), jobEndedAt: new Date(end).toISOString(), tool: "read_page", label: "Checked the source", state: "ok", ms: 9000 }, end);
  }
  for (const kind of ["sheet", "model", "page"]) {
    const item = fixtureItems.find(item => item.kind === kind)!;
    scoutRow({ kind: "card", card: "item", ref: item.id, title: item.title }, now - 240000 + rows.length * 1000);
  }
  scoutRow({ kind: "step", id: "running-read", job: "laptops", jobTitle: "Choosing a laptop", jobSince: new Date(now - 85000).toISOString(), tool: "read_page", label: "Checking keyboard reviews", state: "running" }, now - 2000);
  const state: HqState = { on: true, bots: params.has("empty") ? [] : bots, live: bots.map(b => ({ bot: b.id, state: b.id === "pebble" ? "waiting_for_owner" : "idle", doing: b.id === "pebble" ? "Waiting for your OK on Ruvo's email" : null, since: new Date(Date.now() - 25000).toISOString(), steps: 3, queued: 0, work: b.id === "pebble" ? [{ id: "weekend", title: "Weekend options", since: new Date(Date.now() - 180000).toISOString(), steps: 7, doing: "Comparing places to stay by the lake" }] : [] })), safety: { level, until: null, pinSet: true, since: ts }, guard: params.has("guard-down") ? "down" : "up" };
  const scoutLive = state.live.find(live => live.bot === "scout")!;
  scoutLive.work = [{ id: "laptops", title: "Choosing a laptop", since: new Date(now - 85000).toISOString(), steps: 6, doing: "Checking keyboard reviews" }];
  const subscriptions: Subscription[] = [
    { provider: "anthropic", name: "Claude", signedIn: !params.has("unsigned"), usedBy: bots.map(b => b.id), usage: { today: 18400, week: 96200 }, models: [{ id: "claude-sonnet-4-5", name: "Sonnet" }, { id: "claude-haiku-4-5", name: "Haiku" }] },
    { provider: "openai-codex", name: "OpenAI", signedIn: !params.has("unsigned"), usedBy: bots.map(b => b.id), usage: { today: 8500, week: 42000 }, limitedUntil: "2026-11-18T05:00:00Z", models: [{ id: "gpt-5", name: "GPT 5" }, { id: "gpt-5-mini", name: "GPT 5 mini" }] },
  ];
  const engines = Object.fromEntries(bots.map(b => [b.id, { primary: b.primary, fallbacks: b.fallbacks, status: params.has("unsigned") ? "not_signed_in" : "ready", signedIn: { anthropic: !params.has("unsigned") }, usage: { today: 18400, week: 96200 }, limits: null } as EngineInfo]));
  const fixtures = { state, rows, engines, subscriptions };
  return params.has("scale") ? scaleFixtures(fixtures, params.has("scale-ended")) : fixtures;
}

// A fuller conversation for comparing the window with the supplied pictures.
function scaleFixtures(fixtures: { state: HqState; rows: Row[]; engines: Record<string, EngineInfo>; subscriptions: Subscription[] }, ended: boolean) {
  const now = Date.now(), since = new Date(now - 85000).toISOString();
  const pebble = fixtures.state.bots.find(bot => bot.id === "pebble")!;
  pebble.computer = true;
  const bodies: Row["body"][] = [
    { kind: "message", from: "bot", text: "The invitation is ready for you to read. Here's the plan for the weekend:\n\n**Saturday:** leave after breakfast, have lunch by the lake, then take the short walking path.\n\n**Sunday:** visit the gallery before heading home. I've left the afternoon free so there's no rush." },
    { kind: "message", from: "owner", text: "Did Ruvo ever reply about the weekend? Check my inbox and the travel notes." },
    ...["Read Ruvo's reply", "Checked the travel dates", "Read the itinerary", "Checked the gallery hours", "Compared the options", "Checked the source", "Kept the notes together"].map((label, i) => ({ kind: "step" as const, id: `scale-finished-${i}`, tool: "read_file", label, state: "ok" as const, ms: 1200 })),
    { kind: "message", from: "bot", text: "Yes. Ruvo can come on Saturday and would like to visit the gallery on Sunday. The earlier opening time gives you a quieter morning. I've kept the reply with the itinerary so you can read them together." },
    { kind: "message", from: "owner", text: "Great. Draft a reply to Ruvo and put a reminder in my calendar for Friday." },
    ...["Read the conversation", "Checked the invitation", "Read the weekend notes", "Checked the gallery hours", "Looking at your calendar"].map((label, i) => ({ kind: "step" as const, id: `scale-current-${i}`, job: "scale-weekend", jobTitle: "Planning the weekend", jobSince: since, tool: "calendar", label, state: i === 4 ? "running" as const : "ok" as const, ms: i === 4 ? undefined : 1800 })),
    { kind: "notice", tone: "warn", text: "OpenAI has reached today's limit. It can work again at 4 pm.", action: "sign_in" },
  ];
  if (ended) bodies.push({ kind:"notice", tone:"warn", text:"Planning the weekend: I stopped at this job's time limit. I kept the notes from OpenAI with the itinerary." });
  fixtures.rows = [...fixtures.rows.filter(row => row.bot !== "pebble"), ...bodies.map((body, i) => ({ bot: "pebble", generation: 1, seq: i + 1, rev: i + 1, ts: new Date(now - 300000 + i * 5000).toISOString(), kind: body.kind, body }))];
  fixtures.state.live = fixtures.state.live.map(live => live.bot === "pebble" ? { ...live, state: "idle", doing: null, steps: 0, work: [{ id: "scale-weekend", title: "Planning the weekend", since, steps: 5, doing: "Checking Friday for anything that clashes with a reminder" }] } : live);
  return fixtures;
}
