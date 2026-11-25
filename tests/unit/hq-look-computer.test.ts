import "../isolate.js";
import assert from "node:assert/strict";
import { rig, until } from "./hq-api-fixture.test.js";
import { ScreenGuardClient } from "../../src/hq/screens/guard.js";
import type { ScreenPorts } from "../../src/guard/fence.js";
import { getBot } from "../../src/hq/bots.js";
import { newTurnCtx } from "../../src/brain/turn.js";
import { lookTools } from "../../src/hq/toolbox/looks.js";
import { shapes, colours } from "../../src/shared/faces/shapes.js";

const pictures: string[] = [];
class Screens extends ScreenGuardClient {
  constructor() { super({} as ConstructorParameters<typeof ScreenGuardClient>[0]); }
  override async setPorts(ports: ScreenPorts) { return { applied: true, ports }; }
  override async prepare(_user: string, picture: string) { pictures.push(picture); }
  override async fence() { return { applied: true, ports: null }; }
  override async drop() {}
}
const r = await rig(undefined, { screenGuard: new Screens(), screenReady: async () => {} });
try {
  await r.hq.setComputer("pebble", true);
  await until(() => r.hq.computer("pebble").state === "ready");
  const before = pictures.length;
  const ctx = newTurnCtx(); ctx.bot = "pebble";
  const tool = lookTools(ctx).find(tool => tool.name === "set_look")!;
  const result = await tool.handler({ shape: "round", colour: "green", ownerAsked: true }, {});
  assert.ok(!result.isError);
  await until(() => pictures.length > before);
  await until(() => r.hq.computer("pebble").state === "ready");
  assert.ok(pictures.at(-1)!.includes(shapes.marble));
  assert.ok(pictures.at(-1)!.includes(colours.green[0]));
  assert.deepEqual(getBot("pebble")!.look, { shape: "marble", colour: "green" });
  for (const tag of pictures.at(-1)!.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const names = [...tag.matchAll(/\s([a-zA-Z_:][\w:.-]*)\s*=/g)].map(match => match[1]);
    assert.equal(new Set(names).size, names.length, "The changed wallpaper has no repeated attributes");
  }
  console.log("A tool changes the saved look and refreshes the open computer with a strict wallpaper.");
} finally { await r.close(); }
