import { db } from "../../store/db.js";
import { getSetting, setSetting } from "../../store/proactive.js";
import { listBots } from "../bots.js";
import { readMap, writeMap } from "./map.js";
import { conversationStart } from "./sources.js";

export const STEPS = ["hello", "bot", "subscription", "pin", "voice", "phone", "computer", "ready"] as const;
export type Step = typeof STEPS[number];
export type Welcome = { step: Step; bot: string | null; opened: boolean; options: Partial<Record<"voice" | "phone" | "computer", "chosen" | "skipped">> };
const KEY = "hq.onboarding.welcome";
// Remember whether a team existed before the server adds its old starting team.
const arrivedWithoutTeam = !db.prepare("SELECT id FROM bots LIMIT 1").get();
export function initializeWelcome(fresh = arrivedWithoutTeam) {
  if (!fresh || getSetting(KEY)) return;
  saveWelcome({ step: "hello", bot: null, opened: false, options: {} });
}
export function readWelcome(): Welcome | null {
  try {
    const value = JSON.parse(getSetting(KEY));
    if (!STEPS.includes(value.step)) return null;
    return value;
  } catch { return null; }
}
export function saveWelcome(value: Welcome) { setSetting(KEY, JSON.stringify(value)); return value; }
export function welcomeState() { return { welcome: readWelcome(), map: readMap(), lead: listBots().find(b => b.lead)?.id ?? null }; }
export function advanceWelcome(expected: Step, input: { bot?: string; skip?: boolean } = {}) {
  const state = readWelcome();
  if (!state) throw new Error("Your team is already set up.");
  if (state.step !== expected) throw new Error("This step has already changed. Open it again to carry on.");
  if (expected === "ready") return state;
  if (input.skip && !["voice", "phone", "computer"].includes(expected)) throw new Error("Finish this step before carrying on.");
  if (["voice", "phone", "computer"].includes(expected)) state.options[expected as "voice" | "phone" | "computer"] = input.skip ? "skipped" : "chosen";
  if (input.bot) state.bot = input.bot;
  state.step = STEPS[STEPS.indexOf(expected) + 1];
  return saveWelcome(state);
}
export function openFirstConversation(enqueue: (bot: string, text: string) => unknown) {
  const state = readWelcome();
  if (!state || state.step !== "ready" || state.opened) return { opened: false };
  const bot = listBots().find(b => b.id === state.bot && b.lead);
  if (!bot) throw new Error("Choose your main bot first.");
  // Once the request is accepted, keep that fact so reopening the app cannot start it again.
  const map = readMap();
  writeMap({ ...map, status: "active" });
  try {
    const result = enqueue(bot.id, "The welcome steps are finished. Open the first conversation and get to know the person, one thing at a time.");
    if (result && typeof result === "object" && "job_id" in result) conversationStart(String(result.job_id));
    saveWelcome({ ...state, opened: true });
    return { opened: true, result };
  } catch (error) { writeMap(map); throw error; }
}
