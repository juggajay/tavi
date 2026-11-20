export type SseFrame = { event: string; data: string };

/** Keeps split letters and split lines together, without opening a connection. */
export class SseDecoder {
  private decoder = new TextDecoder();
  private pending = "";
  private lines: string[] = [];
  push(chunk: string | Uint8Array, end = false): SseFrame[] {
    this.pending += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    if (end) this.pending += this.decoder.decode();
    const out: SseFrame[] = [];
    let at: number;
    while ((at = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, at).replace(/\r$/, "");
      this.pending = this.pending.slice(at + 1);
      if (line) { this.lines.push(line); continue; }
      let event = "";
      const data: string[] = [];
      for (const part of this.lines) {
        if (part.startsWith(":")) continue;
        const colon = part.indexOf(":");
        const key = colon < 0 ? part : part.slice(0, colon);
        const value = colon < 0 ? "" : part.slice(colon + 1).replace(/^ /, "");
        if (key === "event") event = value;
        if (key === "data") data.push(value);
      }
      this.lines = [];
      if (data.length && data.join("\n") !== "[DONE]") out.push({ event, data: data.join("\n") });
    }
    return out;
  }
}
