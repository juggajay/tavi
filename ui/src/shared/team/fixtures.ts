import type { Bot, Row, Live } from "../../../../src/hq/contract";
import type { Item, Approval } from "../../../../src/shared/protocol";
export const at = new Date().toISOString();
export const bots = [
  { id: "pebble", name: "Pebble", role: "Your everyday assistant", look: { shape: "pebble", colour: "orange" }, lead: true, computer: false, voice: "marin" },
  { id: "scout", name: "Scout", role: "Finds and compares things", look: { shape: "skimmer", colour: "teal" }, lead: false, computer: true, voice: "cedar" },
  { id: "luna", name: "Luna", role: "Helps with plans and writing", look: { shape: "nugget", colour: "plum" }, lead: false, computer: false, voice: "sage" },
].map(b => ({ ...b, soul: "Ask before changing anything.", engine: "hermes", primary: { provider: "anthropic", model: "claude-sonnet-4-5" }, fallbacks: [], servers: "all", generation: 1, createdAt: at })) as Omit<Bot, "box">[];
export const live: Live[] = bots.map(b => ({ bot: b.id, state: b.id === "scout" ? "working" : "idle", doing: b.id === "scout" ? "Comparing the opening hours" : null, since: new Date(Date.now() - 180_000).toISOString(), steps: 3, queued: 0 }));
export const row = (bot: string, seq: number, body: Row["body"]): Row => ({ bot, seq, rev: seq, generation: 1, ts: at, kind: body.kind, body });
export const jobCard = { version: 1, purpose: "Find and compare everyday options", notFor: "Making purchases", handsBack: "A short comparison with sources", example: null, given: "Only my request", servers: ["show"], stopAndAsk: "Before changing or sharing anything", choice: bots[0].primary, fallbacks: [], computer: false, trials: [{ ask: "Compare two picnic spots", goodAnswer: "A short comparison with sources" }], privateInfo: "none" };
export const rows: Row[] = [
  row("pebble", 1, { kind: "message", from: "owner", text: "Help me plan a quiet Sunday with Maya." }),
  ...["Checked the forecast", "Found three nearby galleries", "Compared their opening hours"].map((label, i) => row("pebble", i + 2, { kind: "step", id: `s${i}`, tool: "search", label, state: "ok", ms: 40_000 })),
  row("pebble", 5, { kind: "message", from: "bot", text: "Start with the gallery at ten, then lunch by the water. Scout is checking the last few details." }),
  row("pebble", 6, { kind: "card", card: "item", ref: "itm_sunday", title: "Your Sunday plan" }),
  row("pebble", 7, { kind: "card", card: "approval", ref: "approval-sunday", title: "Send Maya the plan", state: "waiting" }),
  row("luna", 1, { kind: "notice", tone: "warn", text: "Claude has reached its limit. Try again after 4 pm today. You can check the subscription on the PC.", action: "sign_in" }),
];
export const approval: Approval = { id: "approval-sunday", nonce: "preview-only", kind: "email", operation: "email.send", account: "Personal", to: ["maya@example.com"], cc: [], subject: "Sunday together", body: "Hi Maya,\n\nHow about the gallery at ten, then lunch by the water?", expires_at: "2099-01-01T00:00:00Z" };
const common = { source: "Tavi", origin: "answer", job_id: null, seq: 1, created_at: at, shown_at: at, pinned: false };
export const plan = { ...common, id: "itm_sunday", kind: "note", title: "Your Sunday plan", payload: { text: "10 am · Gallery\n12 pm · Lunch by the water\n2 pm · A walk in the park", rows: [] } } as Item;
export const draft = { ...common, id: "itm_sunday_draft", kind: "draft", title: "Send Maya the plan", payload: { operation: "email.send", summary: "Send Maya the Sunday plan", details: [], editable: true, approval_id: approval.id, to: approval.to, cc: [], subject: approval.subject, body: approval.body, status: "pending", account: "Personal" } } as Item;
export const still = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="750"><rect width="1200" height="750" fill="#173d40"/><rect x="100" y="70" width="1000" height="610" rx="25" fill="#f4f5f1"/><rect x="100" y="70" width="1000" height="55" rx="25" fill="#c8dfda"/><circle cx="130" cy="98" r="8" fill="#cd6a65"/><text x="150" y="205" font-family="sans-serif" font-size="32" fill="#173d40">Sunday, at your pace</text><g font-family="sans-serif" font-size="26" fill="#334a47"><text x="150" y="290">Gallery by the water</text><text x="150" y="345">Open Sunday · 10 am to 5 pm</text><text x="150" y="430">Lunch at the garden café</text><text x="150" y="485">A table outside, if the weather holds</text></g><rect x="150" y="550" width="280" height="60" rx="15" fill="#cfdfc9"/><text x="175" y="590" font-family="sans-serif" font-size="24" fill="#173d40">Two good options</text></svg>`);
