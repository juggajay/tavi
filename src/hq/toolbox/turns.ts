import { newTurn, newTurnCtx, type TurnCtx } from "../../brain/turn.js";
import type { Origin } from "../../shared/protocol.js";
import { laneKey, type TurnLane } from "./lanes.js";

const turns = new Map<string, TurnCtx>();

export function beginBotTurn(botId: string, t: { job_id: string | null; origin: Origin | null; test: boolean; background: boolean; note?: (line: string) => void }, lane: TurnLane = "chat"): TurnCtx {
  const key = laneKey(botId, lane);
  if (turns.has(key)) throw new Error("This bot already has a request in progress.");
  const ctx = newTurnCtx(t.background);
  ctx.bot = botId;
  ctx.test = t.test;
  ctx.note = t.note;
  ctx.turn = newTurn({ job_id: t.job_id, origin: t.origin, background: t.background, persist: !t.test });
  ctx.turn.bot = botId;
  turns.set(key, ctx);
  return ctx;
}

export function endBotTurn(botId: string, lane: TurnLane = "chat"): void {
  turns.delete(laneKey(botId, lane));
}

export function botTurn(botId: string, lane: TurnLane = "chat"): TurnCtx | null {
  return turns.get(laneKey(botId, lane)) ?? null;
}

/** Hermes' own tools can read outside words too. Unfamiliar tools get the same caution. */
export function noteBuiltinTool(botId: string, hermesToolName: string, lane: TurnLane = "chat"): void {
  const ctx = botTurn(botId, lane);
  if (!ctx) return;
  ctx.external.add(hermesToolName === "web_search" || hermesToolName === "web_extract" || hermesToolName.startsWith("browser_") ? "the web" : "its own computer");
}
