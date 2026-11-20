import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardClient, type GuardClient } from "../guardClient.js";
import type { ScreenPorts } from "../../guard/fence.js";

export class ScreenGuardClient {
  constructor(readonly guard: GuardClient = guardClient(), private options: { baseUrl?: string; secretPath?: string } = {}) {}
  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    try {
      const secretPath = this.options.secretPath ?? path.join(process.env.LH_V3_DATA ?? fileURLToPath(new URL("../../../data-v3", import.meta.url)), "guard", "secret-relay");
      const secret = (await readFile(secretPath, "utf8")).trim();
      if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error();
      const response = await fetch((this.options.baseUrl ?? this.guard.baseUrl) + route, { method,
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error();
      return await response.json() as T;
    } catch { throw new Error("The safety switch could not set up or check the bot's computer."); }
  }
  setPorts(p: ScreenPorts) { return this.call<{ applied: boolean; ports: ScreenPorts }>("PUT", `/bots/${encodeURIComponent(p.user)}/ports`, p); }
  fence(user: string) { return this.call<{ applied: boolean; ports: ScreenPorts | null }>("GET", `/bots/${encodeURIComponent(user)}/ports`); }
  drop(user: string) { return this.call<void>("DELETE", `/bots/${encodeURIComponent(user)}/ports`, {}); }
  prepare(user: string, wallpaper: string, home: string) { return this.call<void>("PUT", `/bots/${encodeURIComponent(user)}/screen`, { wallpaper, home }); }
  audit(botId: string, control: boolean) { return this.call<void>("POST", "/screen-audit", { botId, control }); }
  async password(user: string) { return (await this.call<{ password: string }>("GET", `/bots/${encodeURIComponent(user)}/screen/key`)).password; }
}
