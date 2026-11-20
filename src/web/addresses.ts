import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { webFetchBlockReason } from "../brain/guards.js";
import { keepOutReason } from "../brain/keepOut.js";

const blocked = new BlockList();
const global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
blocked.addSubnet("192.88.99.0", 24, "ipv4");
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
export function publicIP(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  if (isIP(a) === 4) return !blocked.check(a, "ipv4");
  if (isIP(a) !== 6) return false;
  // Only global unicast addresses; this also excludes mapped private IPv4 addresses.
  return global6.check(a, "ipv6") && !blocked.check(a, "ipv6");
}
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;
export const resolvePublic: Resolve = (host) => lookup(host, { all: true, verbatim: true });
export async function checkAddress(raw: string, resolve: Resolve = resolvePublic) {
  const reason = webFetchBlockReason(raw);
  if (reason) throw new Error(reason);
  const url = new URL(raw);
  url.hostname = url.hostname.replace(/\.$/, "");
  const normalizedReason = webFetchBlockReason(url.href);
  if (normalizedReason) throw new Error(normalizedReason);
  const keep = keepOutReason(url.hostname);
  if (keep) throw new Error(keep);
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Use a public page on its normal web port.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!addresses.length || addresses.some((a) => !publicIP(a.address))) throw new Error("Only public internet addresses can be read. Choose a public source.");
  return { url, address: addresses[0] };
}
