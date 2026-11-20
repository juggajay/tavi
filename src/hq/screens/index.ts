import { isAgentRequest } from "../../browser/sites.js";
import { screenshot as relayScreenshot } from "./relay.js";
import { guardClient, type GuardClient } from "../guardClient.js";
import { getBot } from "../bots.js";
import type { TurnQueues } from "../turns/index.js";
import { ScreenGuardClient } from "./guard.js";
import { configureScreens } from "./relay.js";

export { attach, configureScreens, createScreenRelay } from "./relay.js";
export const screenshot = Object.assign(relayScreenshot, { isAgentRequest });
export { ensureComputer, allocateScreen, screenPassword, stopComputer } from "./computer.js";
export { ScreenGuardClient } from "./guard.js";
export type { ScreenSession, RelayDeps } from "./relay.js";

// The server calls this once after its turn queues and safety switch are ready.
export function connectScreens(turns: Pick<TurnQueues, "ask">, guard: GuardClient = guardClient(), options: { screens?: ScreenGuardClient; control?: (id: string, on: boolean) => void } = {}) {
  const screens = options.screens ?? new ScreenGuardClient(guard);
  return configureScreens({
    bot: getBot, password: (id) => screens.password(`bot-${id}`), level: () => guard.level(), events: (on) => guard.events(on),
    audit: (id, control) => screens.audit(id, control),
    notice(id, text) { options.control?.(id, text.includes("taken")); turns.ask(id, { text, from: "system", via: "bot", origin: null }); },
  });
}
