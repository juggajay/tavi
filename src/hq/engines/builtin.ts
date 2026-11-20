import type { Engine, Bot, EngineEvent, TurnInput, SafetyLevel } from "../contract.js";
import { guardClient } from "../guardClient.js";
import { soulFor } from "../soul.js";
import { failure, stopped, engineDown } from "./failures.js";
import type { BrainResult, think } from "../../brain/brain.js";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { limitIn } from "../../brain/limit.js";
import { DEFAULT_CHOICES } from "../bots.js";

type Ask = typeof think;
type ChatQuery = (input: { prompt: string; options: Options }) => Pick<Query, typeof Symbol.asyncIterator>;
export type BuiltinOptions = {
  chatOnly?: boolean;
  guard?: { level(): SafetyLevel; events?: (on: () => void) => () => void };
  ask?: Ask; query?: ChatQuery;
};

/** The existing brain remains the ordinary route. Walled chat gets a separate session with every tool refused. */
export class BuiltinEngine implements Engine {
  readonly kind = "builtin" as const;
  private history = new Map<string, string[]>();
  constructor(private options: BuiltinOptions = {}) {}
  private guard() { return this.options.guard || guardClient(); }
  async ready(_bot: Bot) {
    const level = this.guard().level();
    return level === "open" || level === "walled" ? { ok: true } : { ok: false, reason: "stopped" as const, why: "The safety switch has stopped the bots." };
  }
  async run(bot: Bot, input: TurnInput, on: (event: EngineEvent) => void, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const level = this.guard().level();
    const chat = this.options.chatOnly || level === "walled";
    const off = this.guard().events?.(() => {
      const current = this.guard().level();
      if (current === "paused" || current === "killed" || !chat && current !== "open") abort();
    });
    let finished = false;
    const emit = (event: EngineEvent) => {
      if (finished) return;
      if (controller.signal.aborted && event.type !== "failed") return;
      if (event.type === "done" || event.type === "failed") finished = true;
      on(event);
    };
    try {
      if (controller.signal.aborted || !(await this.ready(bot)).ok) { emit(stopped()); return; }
      if (chat) await this.chat(bot, input, emit, controller);
      else {
        const ask = this.options.ask || (await import("../../brain/brain.js")).think;
        if (controller.signal.aborted || this.guard().level() !== "open") { emit(stopped()); return; }
        let text = "";
        let tool: { id: string; name: string } | undefined;
        let count = 0;
        const endTool = (ok: boolean) => { if (tool) { emit({ type: "tool", phase: "end", ...tool, ok }); tool = undefined; } };
        let result: BrainResult;
        try {
          result = await ask(`${soulFor(bot)}\n\n${input.instructions}\n\n${input.text}`, {
            signal: controller.signal,
            onSpoken: (next) => {
              if (next.startsWith(text)) { const delta = next.slice(text.length); text = next; if (delta) emit({ type: "text", delta }); }
            },
            onProgress: (line, name) => {
              endTool(true);
              if (name) { tool = { id: `builtin-${++count}`, name }; emit({ type: "tool", phase: "start", ...tool }); }
              emit({ type: "status", text: line });
            },
          });
          endTool(true);
        } catch (error) { endTool(false); throw error; }
        if (controller.signal.aborted) { emit(stopped()); return; }
        if (result.spoken.startsWith(text) && result.spoken.length > text.length) emit({ type: "text", delta: result.spoken.slice(text.length) });
        emit({ type: "done", text: result.spoken, engine: { provider: "anthropic", model: result.model || DEFAULT_CHOICES.anthropic.model } });
      }
    } catch (error) {
      emit(controller.signal.aborted ? stopped() : failure(error instanceof Error ? error.message : ""));
    } finally {
      signal.removeEventListener("abort", abort); off?.();
      if (!finished) emit(controller.signal.aborted ? stopped() : engineDown());
    }
  }
  private async chat(bot: Bot, input: TurnInput, on: (event: EngineEvent) => void, controller: AbortController) {
    const query = this.options.query || (await import("@anthropic-ai/claude-agent-sdk")).query;
    if (controller.signal.aborted) { on(stopped()); return; }
    const key = `${bot.id}:${bot.generation}:${input.conversation}`;
    const choice = input.choice.provider === "anthropic" ? input.choice : DEFAULT_CHOICES.anthropic;
    const options: Options = {
      model: choice.model, effort: choice.effort === "minimal" ? "low" : choice.effort,
      abortController: controller, systemPrompt: `${soulFor(bot)}\n\nYou have no tools in this conversation. Answer from the conversation, and say when you cannot check something.`,
      settingSources: [], tools: [], allowedTools: [], disallowedTools: ["*"], mcpServers: {}, strictMcpConfig: true,
      canUseTool: async () => ({ behavior: "deny", message: "The safety switch has turned tools off for this conversation." }),
      permissionMode: "dontAsk", persistSession: false, maxTurns: 2,
    };
    const earlier = this.history.get(key) || [];
    const q = query({ prompt: [...earlier, `Current instructions: ${input.instructions}`, `Owner: ${input.text}`].join("\n\n"), options });
    let text = "";
    for await (const message of q) {
      if (controller.signal.aborted) { on(stopped()); return; }
      if (message.type === "assistant") {
        for (const block of message.message.content) if (block.type === "text") { text += block.text; on({ type: "text", delta: block.text }); }
      } else if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) { on(failure(message.subtype === "success" ? message.result : message.errors.join(" "))); return; }
        if (limitIn(message.result) || /^\s*API Error\b/.test(message.result)) { on(failure(message.result)); return; }
        if (!text && message.result) { text = message.result; on({ type: "text", delta: text }); }
        this.history.set(key, [...earlier, `Owner: ${input.text}`, `Bot: ${text}`].slice(-40));
        on({ type: "usage", input: message.usage.input_tokens, output: message.usage.output_tokens, engine: choice });
        on({ type: "done", text, engine: choice });
        return;
      }
    }
    on(engineDown());
  }
}
