import type { Bot } from "../contract.js";
import { db } from "../../store/db.js";
import { guardClient } from "../guardClient.js";
import { screenPorts, type ScreenPorts } from "../../guard/fence.js";
import { wallpaper, homePage } from "./desktop.js";
import { ScreenGuardClient } from "./guard.js";
import { deskSettings } from "./desk/settings.js";

export type ComputerDeps = {
  allocate(bot: Bot): ScreenPorts;
  register(ports: ScreenPorts): Promise<{ applied: boolean }>;
  prepare(user: string, wallpaper: string, home: string): Promise<unknown>;
  fence(user: string): Promise<{ applied: boolean }>;
  /** How long a "not in place" answer is asked again before it is believed (tests shorten it). */
  fenceWaitMs?: number;
  start(user: string, kind: string): Promise<unknown>;
};
// The safety switch keeps one answer for "are the checks between bots in place?", and takes it away for the few
// seconds it spends adding any bot's computer to them. With two bots that have computers starting together, one always
// asked during the other's few seconds, was told no, and lost its computer until the next start. So: one computer is
// set up at a time, and a "no" is asked again for a while before it is believed. Nothing is skipped; it only waits.
let line: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = line.then(work, work);
  line = next.catch(() => undefined);
  return next;
}
/** True once the checks between bots are in place for this bot's computer; false if they still are not after waiting. */
export async function fenceApplied(check: (user: string) => Promise<{ applied: boolean }>, user: string, waitMs = 60_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    if ((await check(user)).applied) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(50, waitMs / 10))));
  }
}
export function ensureComputer(bot: Bot, deps: ComputerDeps = defaults()): Promise<void> {
  return oneAtATime(async () => {
    await prepareOne(bot, deps);
    if (!bot.computer) return;
    await deps.start(bot.box.user!, "screen");
    await deps.start(bot.box.user!, "browser");
  });
}
export function prepareComputer(bot: Bot, deps: ComputerDeps): Promise<void> {
  return oneAtATime(() => prepareOne(bot, deps));
}
async function prepareOne(bot: Bot, deps: ComputerDeps): Promise<void> {
  if (!bot.computer) return;
  const ports = deps.allocate(bot);
  bot.box = { user: ports.user, display: ports.display, vncPort: ports.vncPort, cdpPort: ports.cdpPort };
  if (!(await deps.register(ports)).applied) throw new Error("The checks between bots have not passed.");
  const desk = deskSettings(bot.id);
  await deps.prepare(ports.user, wallpaper(bot, ports.width, ports.height, desk), homePage({ ...bot, pinnedAddresses: desk.pinnedAddresses }, desk));
  if (!(await fenceApplied(deps.fence, ports.user, deps.fenceWaitMs))) throw new Error("The checks between bots have not passed.");
}
export function allocateScreen(bot: Bot): ScreenPorts {
  if (bot.box.display !== null) return screenPorts(`bot-${bot.id}`, bot.box);
  // Removed bots keep their number. Never give their old screen to another bot.
  const used = new Set((db.prepare("SELECT box FROM bots").all() as { box: string }[]).map((r) => JSON.parse(r.box).display));
  const display = Math.max(0, ...[...used].filter((n): n is number => Number.isInteger(n))) + 1;
  if (display > 99) throw new Error("All 99 computer numbers have been used. Ask for help before adding another computer.");
  const ports = screenPorts(`bot-${bot.id}`, { display, vncPort: 5910 + display, cdpPort: 9210 + display });
  const box = { user: ports.user, display, vncPort: ports.vncPort, cdpPort: ports.cdpPort };
  db.prepare("UPDATE bots SET box = ? WHERE id = ? AND removed_at IS NULL").run(JSON.stringify(box), bot.id);
  return ports;
}
function defaults(): ComputerDeps {
  const guard = guardClient(), screens = new ScreenGuardClient(guard);
  return { allocate: allocateScreen, register: (p) => screens.setPorts(p), prepare: (u, w, h) => screens.prepare(u, w, h),
    fence: (u) => screens.fence(u), start: (u, k) => guard.startProcess(u, k) };
}
export async function screenPassword(id: string): Promise<string> {
  return new ScreenGuardClient().password(`bot-${id}`);
}
export async function stopComputer(bot: Bot): Promise<void> {
  if (bot.box.user) await new ScreenGuardClient().drop(bot.box.user);
}
