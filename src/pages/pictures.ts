import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { webFetchBlockReason } from "../brain/guards.js";
import type { KeptPicture } from "../shared/pages/shape.js";

export class PictureProblem extends Error {}
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(ip, bits, "ipv4");
const global6 = new BlockList(); global6.addSubnet("2000::", 3, "ipv6");
const blocked6 = new BlockList(); blocked6.addSubnet("2001::", 23, "ipv6"); blocked6.addSubnet("2002::", 16, "ipv6"); blocked6.addSubnet("3fff::", 20, "ipv6");
blocked6.addSubnet("2001:db8::", 32, "ipv6");
export function publicAddress(ip: string) { const family = isIP(ip); return family === 4 ? !blocked.check(ip, "ipv4") : family === 6 && global6.check(ip, "ipv6") && !blocked6.check(ip, "ipv6"); }
export type PictureFetch = (url: URL, address: string, signal: AbortSignal) => Promise<{ status: number; type: string; location?: string; length?: number; body: AsyncIterable<Uint8Array> }>;
const fetchPicture: PictureFetch = (url, address, signal) => new Promise((resolve, reject) => {
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    signal, headers: { Accept: "image/png,image/jpeg,image/webp,image/gif", "User-Agent": "Tavi page pictures" },
    // The connection uses the address already checked, even if the name changes afterwards.
    lookup: (_host, options, callback) => { const record = { address, family: isIP(address) }; if (options.all) callback(null, [record]); else callback(null, address, record.family); },
  }, res => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), location: res.headers.location, length: res.headers["content-length"] ? Number(res.headers["content-length"]) : undefined, body: res }));
  req.on("error", reject); req.end();
});

/** Keep ordinary picture bytes only. Markup, including SVG, is never a page picture. */
export function checkedImage(bytes: Buffer, declared?: string): string {
  if (bytes.length > MAX_PICTURE_BYTES) throw new PictureProblem("The picture is larger than 2 MB.");
  let mime = "";
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.length >= 33 && bytes.toString("ascii", 12, 16) === "IHDR") {
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (!w || !h || w * h > 40_000_000) throw new PictureProblem("The picture's size is too large or unreadable.");
    mime = "image/png";
  } else if (bytes.length > 20 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) mime = "image/jpeg";
  else if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") mime = "image/webp";
  else if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6)) && bytes[bytes.length - 1] === 59) mime = "image/gif";
  if (!mime || declared && declared.split(";")[0].trim().toLowerCase() !== mime) throw new PictureProblem("That address did not return a supported picture.");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function webPicture(url: string, alt: string, deps: { fetch?: PictureFetch; resolve?: (host: string) => Promise<string[]>; timeoutMs?: number } = {}): Promise<KeptPicture> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    let current = new URL(url);
    for (let hop = 0; hop < 4; hop++) {
      const refusal = webFetchBlockReason(current.href); if (refusal) throw new PictureProblem(refusal);
      const host = current.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host) ? [host] : await (deps.resolve ?? (async h => (await lookup(h, { all: true })).map(a => a.address)))(host);
      if (!addresses.length || addresses.some(a => !publicAddress(a))) throw new PictureProblem("Local and private network addresses can't be opened.");
      const response = await (deps.fetch ?? fetchPicture)(current, addresses[0], controller.signal);
      if ([301,302,303,307,308].includes(response.status)) {
        controller.signal.throwIfAborted();
        // Close a redirect body before making another connection.
        if ("destroy" in response.body && typeof response.body.destroy === "function") response.body.destroy();
        if (!response.location) throw new PictureProblem("The picture moved without giving another address.");
        current = new URL(response.location, current); continue;
      }
      if (response.status !== 200) throw new PictureProblem("The picture couldn't be fetched.");
      if (!/^image\/(png|jpeg|webp|gif)(;|$)/i.test(response.type)) { controller.abort(); throw new PictureProblem("That address did not return a supported picture."); }
      if ((response.length ?? 0) > MAX_PICTURE_BYTES) { controller.abort(); throw new PictureProblem("The picture is larger than 2 MB."); }
      const parts: Buffer[] = []; let size = 0;
      for await (const part of response.body) { size += part.length; if (size > MAX_PICTURE_BYTES) { controller.abort(); throw new PictureProblem("The picture is larger than 2 MB."); } parts.push(Buffer.from(part)); }
      return { alt, source: current.href, data: checkedImage(Buffer.concat(parts), response.type) };
    }
    throw new PictureProblem("The picture moved too many times.");
  };
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new PictureProblem("The picture took too long to arrive.")); }, deps.timeoutMs ?? 6000); })]);
  } catch (e) { return { alt, source: url, missing: e instanceof PictureProblem ? e.message : "The picture couldn't be fetched. Try another address." }; }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}
