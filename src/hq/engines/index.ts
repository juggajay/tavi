import type { Bot, Engine } from "../contract.js";
import { HermesEngine, type HermesOptions } from "./hermes.js";
import { BuiltinEngine, type BuiltinOptions } from "./builtin.js";

let hermes: HermesEngine | undefined;
let builtin: BuiltinEngine | undefined;
let chat: BuiltinEngine | undefined;

/** Called by HQ once its toolbox address and server list are known. */
export function configureEngines(options: { hermes: HermesOptions; builtin?: BuiltinOptions }) {
  hermes = new HermesEngine(options.hermes);
  builtin = new BuiltinEngine(options.builtin);
  chat = new BuiltinEngine({ ...options.builtin, chatOnly: true });
}
export function engineFor(bot: Bot): Engine {
  return bot.engine === "hermes" ? hermes ??= new HermesEngine() : builtin ??= new BuiltinEngine();
}
export function chatOnlyEngine(): Engine { return chat ??= new BuiltinEngine({ chatOnly: true }); }
export { HermesEngine, BuiltinEngine };
export { limits } from "./hermes.js";
export const subscriptions = () => (hermes ??= new HermesEngine()).subscriptions();
export { soulFor, standingFor, buildBotPrompt } from "./standing.js";
