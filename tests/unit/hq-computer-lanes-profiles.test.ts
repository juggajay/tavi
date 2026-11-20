import "../isolate.js";
import assert from "node:assert/strict";
import { rig } from "./hq-api-fixture.test.js";
import { getBot, gatewayKey } from "../../src/hq/bots.js";
import { twinName, twinSecret } from "../../src/hq/toolbox/lanes.js";
import { standingFor } from "../../src/hq/engines/standing.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import type { ScreenPorts } from "../../src/guard/fence.js";
import type { EngineEvent } from "../../src/hq/contract.js";
import { completed } from "../fake-hermes.js";

class Screens extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { return { applied: true, ports }; }
  override async prepare() {}
  override async fence() { return { applied: true, ports: null }; }
  override async drop() {}
}
const r = await rig(undefined, { screenGuard: new Screens(), screenReady: async () => {} });
try {
  r.gateway.options.script = completed("Checked.");
  for (const computer of [true, false, true]) {
    await r.hq.setComputer("tim", computer);
    await r.hq.ensure(getBot("tim")!);
    const bot = getBot("tim")!, twin = twinName(bot.id);
    r.gateway.options.profiles = {
      [bot.id]: { key: gatewayKey(bot.id), tools: computer ? ["browser_navigate", "terminal"] : [] },
      [twin]: { key: twinSecret(bot.id, "gateway-key")!, tools: [] },
    };
    const mainConfig = r.files.get(`/bots/${bot.id}/file/config.yaml`)!;
    const twinConfig = r.files.get(`/bots/${twin}/file/config.yaml`)!;
    assert.equal(mainConfig.includes("terminal, file, browser"), computer);
    assert.ok(twinConfig.includes("api_server: [todo, skills]"));
    for (const tool of ["ssh_host", "cdp_url", '"computers":']) assert.ok(!twinConfig.includes(tool));
    for (const lane of ["chat", "work"] as const) {
      const events: EngineEvent[] = [];
      await r.hq.hermes.run(bot, { lane, text: "Check this", instructions: "Recent conversation supplied here.", conversation: "same-conversation", choice: bot.primary }, (e) => events.push(e), new AbortController().signal);
      assert.equal(events.at(-1)?.type, "done");
      const request = r.gateway.requests.filter((q) => q.path.endsWith("/v1/responses")).at(-1)!;
      assert.equal(request.path, `/p/${lane === "work" ? twin : bot.id}/v1/responses`);
      assert.equal(request.authorization, `Bearer ${lane === "work" ? twinSecret(bot.id, "gateway-key") : gatewayKey(bot.id)}`);
      assert.equal(request.body.instructions, standingFor(bot) + "\n\nRecent conversation supplied here.");
      assert.equal(request.body.conversation, "same-conversation");
    }
  }
  console.log("The main profile alone has computer tools, the twin answers for a bot with a computer, and both receive the bot's instructions and conversation.");
} finally { await r.close(); }
