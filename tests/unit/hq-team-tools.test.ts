import "../isolate.js";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { db } from "../../src/store/db.js";
import { decide, onBrokerEvent, type ApprovalView } from "../../src/broker/broker.js";
import { createBot, getBot } from "../../src/hq/bots.js";
import { currentCard, dangerousThree, saveCard, type JobCard } from "../../src/hq/cards/index.js";
import { aboutCard, proposeAboutChange } from "../../src/hq/about.js";
import { newTurnCtx, type TurnCtx } from "../../src/brain/turn.js";
import { createTeam, type HandOverRun, type TeamDeps } from "../../src/hq/team/index.js";
import { fakeAccountProtection } from "../fake-hermes.js";

fakeAccountProtection();
const lead = createBot({ id: "main", name: "Main" });
const ctx = newTurnCtx(); ctx.bot = lead.id;
const card: JobCard = { version: 1, purpose: "Compare travel choices", notFor: "Booking or paying", handsBack: "A sourced comparison", example: "Two choices and their costs", given: "Dates and places", servers: ["calc", "show"], stopAndAsk: "When dates are missing", choice: lead.primary, fallbacks: [], computer: false, trials: [{ ask: "Compare two short trips", goodAnswer: "Clear choices with costs" }], privateInfo: "none" };
const views = new Map<string, ApprovalView>();
const off = onBrokerEvent((e) => { if (e.type === "approval") views.set(e.approval.id, e.approval); });
const messages: { bot: string; text: string }[] = [];
const made: string[] = [], activated: string[] = [], trials: { bot: string; test: boolean; purpose: string; ask: string }[] = [];
const starts = new Map<string, HandOverRun>();
const pending = new Map<string, () => void>();
const asked: unknown[] = [];
let trialOK = true;
let trialThrows = false;
let busy = { busy: false, queued: 0 };
const deps: TeamDeps = {
  makeBot: async ({ trialOnly, ...input }) => { assert.equal(trialOnly, true); made.push(input.id); const bot = createBot({ ...input, ...(input.card && dangerousThree(input.card) ? { card: undefined } : {}) }); if (input.card && dangerousThree(input.card)) saveCard(bot.id, input.card, "owner", "Approved first card.", { acknowledgedRisk: true }); return bot; },
  activateBot: async (id) => { activated.push(id); },
  runTrial: async (input) => { trials.push({ bot: input.bot, test: input.test, purpose: input.card.purpose, ask: input.trial.ask }); if (trialThrows) throw new Error("A private failure detail"); return { ok: trialOK, answer: input.card.purpose, usage: 100, ms: 50 }; },
  startHandOver: async (input) => { starts.set(input.job, input); await new Promise<void>((resolve) => { pending.set(input.job, resolve); input.signal.addEventListener("abort", () => resolve(), { once: true }); }); },
  message: (bot, text) => messages.push({ bot, text }),
  askOwner: async (input) => { asked.push(input); }, live: () => busy,
};
const team = createTeam(deps);
const call = async (name: string, args: Record<string, unknown> = {}, who = ctx) => {
  const tool = team.tools(who).find((t) => t.name === name)!;
  assert.ok(tool, name);
  return JSON.parse(((await tool.handler(args, {})).content[0] as { text: string }).text);
};
const approve = async (id: string, yes = true) => {
  const view = views.get(id)!; assert.ok(view);
  return decide(id, view.nonce, yes ? "approve" : "reject");
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
try {
  const draft = await call("draft_job_card", { card: { ...card, example: null } });
  assert.ok(draft.shown.includes(card.purpose));
  assert.ok(draft.warnings.some((s: string) => s.includes("No example")));
  assert.equal((await call("draft_job_card", { card: { ...card, purpose: "" } })).error, "Please check the fields for this request.");
  const proposed = await call("propose_bot", { id: "travel", name: "Travel", look: { shape: "moon", colour: "blue" }, card });
  assert.equal(getBot("travel"), undefined);
  assert.ok(views.get(proposed.approval)?.rows?.some((r) => r.value.includes(card.handsBack)));
  assert.equal((await approve(proposed.approval)).status, "verified");
  assert.deepEqual(made, ["travel"]);
  assert.deepEqual(activated, ["travel"]);
  assert.equal(trials.length, 1);
  assert.equal(trials[0].test, true);
  assert.equal(currentCard("travel")?.version, 1);
  assert.ok(messages.some((m) => m.bot === lead.id && m.text.includes("trials passed")));
  assert.equal((await approve(proposed.approval)).status, "refused");
  const declined = await call("propose_bot", { id: "declined", name: "Declined", look: { shape: "moon", colour: "blue" }, card });
  assert.equal((await approve(declined.approval, false)).status, "rejected");
  assert.equal(getBot("declined"), undefined);
  assert.equal(made.length, 1);
  const changed = await call("change_job_card", { bot: "travel", card: { ...card, purpose: "Compare rail choices" }, why: "Focus on rail" });
  assert.equal(currentCard("travel")?.version, 1);
  assert.equal((await approve(changed.approval)).status, "verified");
  assert.equal(currentCard("travel")?.version, 2);
  assert.equal(trials.length, 3);
  assert.equal(trials[1].purpose, card.purpose);
  assert.equal(trials[2].purpose, "Compare rail choices");
  assert.ok(messages.at(-1)?.text.includes("Before:"));
  assert.ok(messages.at(-1)?.text.includes("After:"));
  const stale1 = await call("change_job_card", { bot: "travel", card, why: "First proposal" });
  const stale2 = await call("change_job_card", { bot: "travel", card, why: "Second proposal" });
  assert.equal((await approve(stale1.approval)).status, "verified");
  assert.equal((await approve(stale2.approval)).status, "refused");
  const extraTrial = { ask: "Compare a longer journey", goodAnswer: "Two checked choices" };
  const kept = await call("change_job_card", { bot: "travel", card: { ...card, trials: [extraTrial] }, why: "Keep the old example and add another" });
  assert.ok(views.get(kept.approval)?.rows?.some((r) => r.value.includes(card.trials[0].ask) && r.value.includes(extraTrial.ask)));
  await approve(kept.approval);
  assert.equal(currentCard("travel")?.trials.length, 2);

  trialOK = false;
  const failed = await call("propose_bot", { id: "needs-work", name: "Needs work", look: { shape: "moon", colour: "blue" }, card });
  await approve(failed.approval);
  assert.ok(getBot("needs-work"));
  assert.ok(!activated.includes("needs-work"));
  assert.equal(currentCard("needs-work")?.version, 1);
  assert.ok(messages.at(-1)?.text.includes("not live"));
  const beforeVersion = currentCard("travel")!.version;
  const failedChange = await call("change_job_card", { bot: "travel", card, why: "A failed trial" });
  trialThrows = true;
  await approve(failedChange.approval);
  trialThrows = false;
  assert.ok(messages.at(-1)?.text.includes("The trial could not finish"));
  assert.ok(!messages.at(-1)?.text.includes("private failure"));
  assert.equal(currentCard("travel")!.version, beforeVersion);
  trialOK = true;
  const recovered = await call("change_job_card", { bot: "needs-work", card, why: "Try the corrected card" });
  await approve(recovered.approval);
  assert.ok(activated.includes("needs-work"));
  assert.equal(currentCard("needs-work")?.version, 2);
  const risky = { ...card, privateInfo: "named", named: ["Trip budget"], servers: ["mail"] };
  assert.match((await call("draft_job_card", { card: risky })).error, /owner's tap/);
  const riskRequest = await call("propose_bot", { id: "risky", name: "Risk review", look: { shape: "moon", colour: "blue" }, card: risky });
  assert.ok(views.get(riskRequest.approval)?.rows?.some((r) => r.value.includes("accept keeping all three")));
  assert.equal(getBot("risky"), undefined);
  await approve(riskRequest.approval);
  assert.equal(currentCard("risky")?.privateInfo, "named");

  const brief = { to: "travel", aim: "Compare the available travel choices", scope: "Two routes for the dates given", given: "Places and dates only", done: "Two clear choices with checked costs", form: "A short table and sources", minutes: 5, usage: 1000 };
  for (const bad of [{ to: lead.id }, { to: "missing" }, { aim: "Too short" }, { done: "Too short" }, { usage: 0 }, { minutes: 0 }, { scope: undefined }, { given: undefined }, { form: undefined }]) assert.ok((await call("hand_over", { ...brief, ...bad })).error);
  busy = { busy: true, queued: 2 };
  assert.match((await call("hand_over", brief)).error, /two jobs waiting/);
  busy = { busy: false, queued: 0 };
  const handed = await call("hand_over", brief);
  await tick();
  const run = starts.get(handed.job)!;
  assert.equal(run.brief.aim, brief.aim);
  assert.ok(!JSON.stringify(run.brief).includes("conversation"));
  assert.equal(run.depth, 1);
  assert.equal((await call("job_status", { job: handed.job })).state, "running");
  const specialist = newTurnCtx(); specialist.bot = "travel"; specialist.turn.job_id = handed.job;
  const beforeReceipts = messages.length;
  const receipt = { summary: "Two routes compared", made: ["itm_example"], sources: [{ what: "A fare", where: "https://example.test/fares", extra: "UNWANTED SECRET" }], unsure: "Check the final price", proposals: [{ kind: "remember", text: "Likes direct trains" }, { kind: "do", text: "Book a ticket" }, { kind: "about", text: "Prefers rail" }], outside: "UNWANTED SECRET" };
  const aboutBefore = aboutCard(), memoryBefore = db.prepare("SELECT * FROM memories").all(), approvalsBefore = views.size;
  assert.equal((await call("hand_back", receipt, specialist)).handedBack, handed.job);
  assert.equal(run.signal.aborted, true);
  assert.equal(messages.length, beforeReceipts + 1);
  assert.equal(messages.at(-1)?.bot, lead.id);
  assert.ok(messages.at(-1)?.text.startsWith("Result from Travel"));
  assert.ok(messages.at(-1)?.text.includes("Proposals (nothing has been done or remembered)"));
  assert.ok(!messages.at(-1)?.text.includes("UNWANTED SECRET"));
  assert.equal(aboutCard(), aboutBefore);
  assert.deepEqual(db.prepare("SELECT * FROM memories").all(), memoryBefore);
  assert.equal(views.size, approvalsBefore);
  assert.ok((await call("hand_back", receipt, specialist)).error);
  pending.get(handed.job)!(); await tick();
  assert.equal((await call("job_status", { job: handed.job })).state, "done");
  assert.ok((await call("propose_bot", { id: "wrong", name: "Wrong", look: { shape: "moon", colour: "blue" }, card }, specialist)).error);
  assert.ok(Array.isArray(await call("list_team", {}, specialist)) || !(await call("list_team", {}, specialist)).error, "any bot may know who is on the team; handing work over stays with the main bot");
  await call("ask_owner", { question: "Which date suits you?", why: "The date changes the answer" }, specialist);
  assert.deepEqual(asked.at(-1), { bot: "travel", question: "Which date suits you?", why: "The date changes the answer" });

  assert.equal(aboutCard(), "");
  assert.throws(() => proposeAboutChange("Travel", "x".repeat(1501), "Too long"), /1,500/);
  const shared = await call("propose_shared_note", { text: "Prefers direct routes", why: "Asked for this repeatedly" }, specialist);
  assert.equal(aboutCard(), "");
  await approve(shared.approval, false); assert.equal(aboutCard(), "");
  const sharedYes = await call("propose_shared_note", { text: "Prefers direct routes", why: "Confirmed by the owner" }, specialist);
  assert.equal((await approve(sharedYes.approval)).status, "verified");
  assert.equal(aboutCard(), "Prefers direct routes");
  const about1 = proposeAboutChange("Main", "First words", "A reason");
  const about2 = proposeAboutChange("Main", "Old proposal", "A reason");
  await approve(about1.id); assert.equal((await approve(about2.id)).status, "refused");
  const list = await call("list_team");
  assert.equal(list.find((b: { id: string }) => b.id === "travel").handsBack, card.handsBack);

  const second = createBot({ id: "second", name: "Second" });
  const third = createBot({ id: "third", name: "Third" });
  const chain1 = await call("hand_over", brief);
  const c1 = newTurnCtx(); c1.bot = "travel"; c1.turn.job_id = chain1.job;
  const chain2 = await call("hand_over", { ...brief, to: second.id }, c1);
  const c2 = newTurnCtx(); c2.bot = second.id; c2.turn.job_id = chain2.job;
  const chain3 = await call("hand_over", { ...brief, to: third.id }, c2);
  const c3 = newTurnCtx(); c3.bot = third.id; c3.turn.job_id = chain3.job;
  assert.match((await call("hand_over", { ...brief, to: "risky" }, c3)).error, /three hand-overs/);
  await tick();
  assert.ok((await call("stop_job", { job: chain1.job }, c3)).error);
  await call("stop_job", { job: chain1.job });
  assert.equal((await call("job_status", { job: chain3.job })).state, "stopped");
  assert.equal(starts.get(chain3.job)?.signal.aborted, true);
  assert.ok((await call("hand_back", receipt, c3)).error);

  const budgetParent = await call("hand_over", brief); await tick();
  starts.get(budgetParent.job)!.progress(400);
  const budgetCtx = newTurnCtx(); budgetCtx.bot = "travel"; budgetCtx.turn.job_id = budgetParent.job;
  const budgetChild = await call("hand_over", { ...brief, to: second.id, usage: 900 }, budgetCtx); await tick();
  assert.equal(budgetChild.usage, 600);
  assert.ok(starts.get(budgetChild.job)!.brief.minutes <= brief.minutes);
  starts.get(budgetChild.job)!.progress(600);
  assert.equal((await call("job_status", { job: budgetParent.job })).state, "stopped");
  assert.equal((await call("job_status", { job: budgetParent.job })).used, 1000);
  const queued = [];
  for (let i = 0; i < 3; i++) queued.push(await call("hand_over", brief));
  assert.match((await call("hand_over", brief)).error, /two jobs waiting/);
  for (const job of queued) await call("stop_job", { job: job.job });

  const limited = await call("hand_over", brief); await tick();
  starts.get(limited.job)!.progress(brief.usage);
  assert.equal((await call("job_status", { job: limited.job })).state, "stopped");
  assert.equal(starts.get(limited.job)!.signal.aborted, true);
  const usageBad = await call("hand_over", brief); await tick();
  starts.get(usageBad.job)!.progress(NaN);
  assert.equal((await call("job_status", { job: usageBad.job })).state, "failed");
  const noReceipt = await call("hand_over", brief); await tick(); pending.get(noReceipt.job)!(); await tick();
  assert.equal((await call("job_status", { job: noReceipt.job })).state, "failed");
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  const timed = await call("hand_over", { ...brief, minutes: 1 }); await tick();
  mock.timers.tick(60_001);
  assert.equal((await call("job_status", { job: timed.job })).state, "stopped");
  const stalled = await call("hand_over", { ...brief, minutes: 5 }); await tick();
  mock.timers.tick(120_001);
  assert.equal((await call("job_status", { job: stalled.job })).state, "stopped");
  assert.ok(messages.at(-1)?.text.includes("no progress"));
  mock.timers.reset();

  const beforeDry = { made: made.length, trials: trials.length, views: views.size, messages: messages.length, asked: asked.length, cards: db.prepare("SELECT * FROM bot_cards").all(), memories: db.prepare("SELECT * FROM memories").all(), about: aboutCard() };
  ctx.test = true; specialist.test = true;
  for (const [name, args, who] of [
    ["propose_bot", { id: "dry", name: "Dry", look: { shape: "moon", colour: "blue" }, card }, ctx],
    ["change_job_card", { bot: "travel", card, why: "Test" }, ctx], ["hand_over", brief, ctx],
    ["stop_job", { job: "not-real" }, ctx], ["hand_back", receipt, specialist],
    ["propose_shared_note", { text: "Do not save", why: "Test" }, specialist], ["ask_owner", { question: "Do not show?", why: "Test" }, specialist],
  ] as [string, Record<string, unknown>, TurnCtx][]) assert.ok(((await team.tools(who).find((t) => t.name === name)!.handler(args, {})).content[0] as { text: string }).text.includes("nothing was saved"));
  assert.deepEqual({ made: made.length, trials: trials.length, views: views.size, messages: messages.length, asked: asked.length, cards: db.prepare("SELECT * FROM bot_cards").all(), memories: db.prepare("SELECT * FROM memories").all(), about: aboutCard() }, beforeDry);
  const closing = createTeam(deps);
  const freshCtx = newTurnCtx(); freshCtx.bot = lead.id;
  const beforeStart = starts.size;
  const deferred = closing.tools(freshCtx).find((t) => t.name === "hand_over")!.handler(brief, {});
  closing.close();
  await deferred; await tick();
  assert.equal(starts.size, beforeStart, "closing before work starts must keep it from starting");
} finally { mock.timers.reset(); team.close(); off(); }
console.log("team tools: approvals, trials, declines, card changes, receipts, proposals, limits, stop and test turns pass");
