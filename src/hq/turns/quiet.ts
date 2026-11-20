import type { Bot, Engine, EngineChoice, EngineEvent, Live } from "../contract.js";
import type { TurnCtx } from "../../brain/turn.js";
import { sourcesOf } from "../../brain/sourceLedger.js";
import { addUsage } from "./usage.js";

export type QuietRequest = {
  id: string; text: string; test: boolean; choice: EngineChoice; signal: AbortSignal;
  event(e: EngineEvent): void;
};
export type QuietReply = { text: string; ok: boolean; read: string[] };
type Deps = {
  available(bot: Bot): boolean;
  engine(bot: Bot): Engine;
  context(bot: Bot, text: string): string;
  run(bot: Bot, signal: AbortSignal, body: () => Promise<void>, request: QuietRequest): Promise<void>;
  turn(bot: Bot): TurnCtx | null;
  live(bot: string): Live;
  show(bot: string, work: NonNullable<Live["work"]>): void;
};

// Quiet looks always use the twin. Only their working light reaches the conversation.
export function createQuietTurns(d: Deps) {
  const active = new Map<string, { controller: AbortController; id: string }>();
  const available = (bot: Bot) => !active.has(bot.id) && d.available(bot);
  return {
    available,
    owns(bot: string, id: string) { return active.get(bot)?.id === id; },
    stop(bot: string) { active.get(bot)?.controller.abort(); },
    async run(bot: Bot, request: QuietRequest): Promise<QuietReply> {
      if (!available(bot)) throw new Error("The lead's separate work lane is busy or unavailable.");
      const own = new AbortController();
      active.set(bot.id, { controller: own, id: request.id });
      const signal = AbortSignal.any([own.signal, request.signal]);
      let text = "", ok = false, read: string[] = [], steps = 0;
      const light = { id: request.id, title: "Looking for something useful", state: "working" as const, doing: "Looking for something useful", since: new Date().toISOString(), steps };
      const show = () => d.show(bot.id, [...(d.live(bot.id).work ?? []).filter((w) => w.id !== request.id), { ...light, steps }]);
      show();
      try {
        await d.run(bot, signal, async () => {
          await d.engine(bot).run(bot, {
            lane: "work", text: request.text, instructions: d.context(bot, request.text),
            conversation: request.id, choice: request.choice,
          }, (event) => {
            request.event(event);
            if (event.type === "usage" && !request.test) addUsage(bot.id, event.engine.provider, event.input, event.output, new Date());
            if (signal.aborted) return;
            if (event.type === "tool" && event.phase === "start") { steps++; show(); }
            if (event.type === "done") { text = event.text; ok = true; }
            if (event.type === "failed") ok = false;
          }, signal);
          const ctx = d.turn(bot);
          read = ctx ? sourcesOf(ctx.turn).filter((s) => s.kind === "web" && s.tool === "mcp__web__read" && s.place).map((s) => s.place!) : [];
        }, request);
        return { text, ok: ok && !signal.aborted, read };
      } finally {
        active.delete(bot.id);
        d.show(bot.id, (d.live(bot.id).work ?? []).filter((w) => w.id !== request.id));
      }
    },
  };
}
