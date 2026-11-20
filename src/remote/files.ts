// Reading a whole file from another computer (Stage 11.4, 11.5): its size first, then piece by piece. The pieces aren't
// logged one by one; the whole read is one audit_log row (path, result, size, how many pieces), never its contents.
import { audit } from "../store/log.js";
import { ask, RemoteError } from "./hub.js";

export const PIECE = 512 * 1024;

export type Whole = { data: Buffer; size: number; changed: string; name: string; pieces: number };

/** The whole file, if it's no bigger than maxBytes. why: what it's for, in the audit row ("read" or "bring"). */
export async function readWhole(computer: string, path: string, maxBytes: number, why: "read" | "bring"): Promise<Whole> {
  const note = (result: string, extra: Record<string, unknown> = {}) => audit("helper", "computer.read", computer, { path: path.slice(0, 400), result, for: why, ...extra });
  try {
    const st = await ask(computer, "stat", { path }, { quiet: true });
    if (st.kind !== "file") throw new RemoteError("not_a_file", "That's a folder, not a file.");
    const size = Number(st.size);
    if (size > maxBytes) throw new RemoteError("too_big", `That file is ${mb(size)}, over the ${mb(maxBytes)} limit.`, { size, limit: maxBytes });
    const parts: Buffer[] = [];
    let got = 0;
    let pieces = 0;
    for (;;) {
      const r = await ask(computer, "read", { path, offset: got, length: PIECE }, { quiet: true, timeoutMs: 60_000 });
      pieces++;
      if (r.changed !== st.changed || Number(r.size) !== size) throw new RemoteError("cant_read", "The file changed while it was being read. Try again in a moment.");
      const piece = Buffer.from(String(r.data ?? ""), "base64");
      parts.push(piece);
      got += piece.length;
      if (r.eof || !piece.length) break;
    }
    if (got !== size) throw new RemoteError("cant_read", "Not all of the file came across. Try again in a moment.");
    note("ok", { size, pieces });
    return { data: Buffer.concat(parts), size, changed: String(st.changed), name: String(st.name ?? path.split("/").pop()), pieces };
  } catch (e) {
    note(e instanceof RemoteError ? e.code : "failed");
    throw e;
  }
}

export const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
