import { networkInterfaces } from "node:os";
import { ALL_SERVERS } from "./tools.js";

export function wslHostAddress(): string | null {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!name.startsWith("vEthernet (WSL")) continue;
    const address = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (address) return address.address;
  }
  return null;
}

/**
 * Hermes has features of its own called "memory" (and switches a tool server's tools on and off by the server's
 * name), so a server of ours with the same name gets tangled up with it: found on the real gateway, where our
 * memory tools landed inside Hermes' own switched-off "memory" group. Inside Hermes that one server goes by another
 * name. Everything on our side (rules, the outside-reads table, labels, the audit log) keeps the usual name.
 */
export const HERMES_NAME: Record<string, string> = { memory: "notebook", web: "public_web" };
const OUR_NAME = Object.fromEntries(Object.entries(HERMES_NAME).map(([ours, theirs]) => [theirs, ours]));
/** A tool name as Hermes reports it (mcp__notebook__remember) → the name we use everywhere (mcp__memory__remember). */
export function ourToolName(name: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return m && OUR_NAME[m[1]] ? `mcp__${OUR_NAME[m[1]]}__${m[2]}` : name;
}

/** The mcp_servers block for one bot's Hermes settings. */
export function hermesMcpServers(botId: string, o: { baseUrl: string; token: string; servers: string[] }): Record<string, { url: string; headers: { Authorization: string }; timeout: number; connect_timeout: number }> {
  const base = new URL(o.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Please use a plain web address for the toolbox.");
  const root = base.href.replace(/\/+$/, "");
  return Object.fromEntries([...new Set([...o.servers, "team"])].map((server) => {
    if (!ALL_SERVERS.includes(server)) throw new Error("That tool server is not available.");
    return [HERMES_NAME[server] ?? server, { url: `${root}/mcp/${encodeURIComponent(botId)}/${server}`, headers: { Authorization: `Bearer ${o.token}` }, timeout: 600, connect_timeout: 30 }];
  }));
}
