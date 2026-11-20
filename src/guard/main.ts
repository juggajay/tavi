import { request } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { Guard, type Level } from "./guard.js";
import { createGuardServer } from "./http.js";
import { createRunner } from "./runner.js";

function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") throw new Error("Set the PIN in a terminal on this PC, where typing can be hidden.");
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt); let value = "";
    const input = process.stdin; input.setRawMode(true); input.resume();
    const done = () => { input.off("data", line); input.setRawMode(false); input.pause(); process.stdout.write("\n"); };
    const line = (chunk: Buffer) => {
      for (const letter of chunk.toString()) {
        if (letter === "\u0003") { done(); reject(new Error("PIN entry was cancelled.")); return; }
        if (letter === "\r" || letter === "\n") { done(); resolve(value); return; }
        if (letter === "\u007f" || letter === "\b") value = value.slice(0, -1);
        else if (/^\d$/.test(letter) && value.length < 12) value += letter;
      }
    };
    input.on("data", line);
  });
}
export function callGuard(secret: string, method: string, route: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: 3091, method, path: route, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } }, (res) => {
      let data = ""; res.setEncoding("utf8"); res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        let value: unknown; try { value = JSON.parse(data); } catch { value = {}; }
        if ((res.statusCode ?? 500) >= 400) reject(new Error((value as { error?: string }).error ?? "The guard refused the request.")); else resolve(value);
      });
    });
    req.setTimeout(180000, () => req.destroy(new Error("The guard did not answer in time.")));
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const messages: Record<Level, string> = {
  open: "Open. The bots may work again.",
  paused: "Paused. The bots have stopped where they are.",
  walled: "Walled off. The bots' Linux space is shut down. To switch back on: npm run guard -- open",
  killed: "Killed. The bots' Linux space is shut down. Evidence and any failed steps are in the guard's data folder. To switch back on: npm run guard -- open",
};
async function direct(level: "walled" | "killed") {
  const guard = new Guard(createRunner());
  // Do not reapply a weaker saved level before an emergency raise.
  if (guard.saved.level === level || guard.saved.level === "killed") await guard.init();
  else await guard.changeLevel({ level, by: "local", reason: "The switch was used on this PC while the guard was not running." }, "local");
  await guard.close(); console.log(messages[guard.saved.level]);
}
export async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command) {
    const guard = new Guard(createRunner());
    const server = createGuardServer(guard);
    let closing = false;
    const close = async (code = 0) => {
      if (closing) return; closing = true;
      server.close(); await guard.close(); server.closeAllConnections(); process.exitCode = code;
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => { void close(); });
    process.on("uncaughtException", () => { console.error("The guard hit a problem. It is shutting down the bots."); void close(1); });
    process.on("unhandledRejection", () => { console.error("The guard hit a problem. It is shutting down the bots."); void close(1); });
    process.on("exit", () => guard.emergencyClose());
    // Claim the port before touching WSL, so a second guard cannot stop the first one's bots.
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(3091, "127.0.0.1", resolve); });
    try { await guard.init(); } catch { await close(1); throw new Error("The guard could not start safely. Check its data folder."); }
    console.log(`Guard listening on this PC, port 3091. ${messages[guard.saved.level]}`);
    console.log(guard.saved.reason); return;
  }
  if (!["state", "open", "pause", "wall", "kill", "pin", "probe", "log"].includes(command)) throw new Error("Use state, open, pause, wall, kill, pin, probe or log.");
  let secret: string;
  const data = process.env.LH_V3_DATA ?? fileURLToPath(new URL("../../data-v3", import.meta.url));
  try { secret = readFileSync(path.join(data, "guard", "secret-local"), "utf8").trim(); }
  catch {
    if (command === "kill" || command === "wall") { await direct(command === "kill" ? "killed" : "walled"); return; }
    throw new Error("Start the guard on this PC first: npm run guard");
  }
  let state: Record<string, unknown>;
  try { state = await callGuard(secret, "GET", "/state") as Record<string, unknown>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" && (command === "kill" || command === "wall")) { await direct(command === "kill" ? "killed" : "walled"); return; }
    throw new Error("The guard did not answer. Start it with npm run guard. Wall and kill also work while it is stopped.");
  }
  if (command === "state") {
    console.log(`${messages[state.level as Level]}\nLinux space: ${state.space}. Lock-down check: ${state.ready ? "passed" : "needed"}.`);
    if (state.ownerUbuntuRunning) console.log("Your other Ubuntu space is running. Bots may reach services it opens on the shared network.");
    if (state.reason) console.log(String(state.reason)); return;
  }
  if (command === "pin") {
    const old = state.pinSet ? await ask("Current PIN: ") : undefined;
    const pin = await ask("New PIN (four to twelve digits): "), again = await ask("Type the new PIN again: ");
    if (pin !== again) throw new Error("The two PINs did not match.");
    await callGuard(secret, "POST", "/pin", { pin, old }); console.log("PIN saved."); return;
  }
  if (command === "probe") { await callGuard(secret, "POST", "/probe"); console.log("The lock-down check passed."); return; }
  if (command === "log") {
    const result = await callGuard(secret, "GET", `/bots/${encodeURIComponent(args[1] ?? "")}/procs/${encodeURIComponent(args[2] ?? "")}/log`) as { lines: string[] };
    console.log(result.lines.join("\n") || "No process output yet."); return;
  }
  const target = ({ open: "open", pause: "paused", wall: "walled", kill: "killed" } as const)[command as "open" | "pause" | "wall" | "kill"];
  const rank = ["open", "paused", "walled", "killed"];
  const pin = state.pinSet && rank.indexOf(target) < rank.indexOf(String(state.level)) ? await ask("PIN: ") : undefined;
  const minutes = args[1] === undefined ? undefined : Number(args[1]);
  await callGuard(secret, "POST", "/level", { level: target, minutes, pin, reason: "The safety switch was used on this PC.", by: "local" });
  console.log(messages[target]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "The guard could not finish."); process.exitCode = 1; });
}
