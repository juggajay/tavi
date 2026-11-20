import type { EngineChoice, EngineEvent } from "../contract.js";
import { failure, stopped } from "./failures.js";
import { SseDecoder } from "./sse.js";

type Item = { id?: string; call_id?: string; type?: string; name?: string; arguments?: unknown; output?: unknown; phase?: string; content?: { text?: string }[] };
type Frame = { type?: string; delta?: string; text?: string; item_id?: string; output_index?: number; item?: Item;
  response?: { error?: { message?: string; code?: string }; usage?: { input_tokens?: number; output_tokens?: number }; output?: Item[] } };

/** A stream reader with no network or saved data. One instance belongs to one reply. */
export class EngineParser {
  private sse = new SseDecoder();
  private phases = new Map<string, string>();
  private calls = new Map<string, { id: string; name: string }>();
  private ended = new Set<string>();
  private streamed = new Set<string>();
  private heldText = new Map<string, string>();
  text = "";
  terminal = false;
  constructor(private choice: EngineChoice, private now = 0) {}
  push(chunk: string | Uint8Array, end = false): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (const raw of this.sse.push(chunk, end)) {
      if (this.terminal) break;
      let frame: Frame;
      try { frame = JSON.parse(raw.data); } catch { continue; }
      const event = raw.event || frame.type || "";
      const item = frame.item;
      const key = frame.item_id || String(frame.output_index ?? "");
      if (event === "response.output_item.added" && item?.type === "message") {
        this.phases.set(item.id || key, item.phase || "unknown");
        this.phases.set(String(frame.output_index ?? ""), item.phase || "unknown");
      } else if (event === "response.output_text.delta") {
        const delta = frame.delta || "";
        this.streamed.add(key);
        const phase = this.phases.get(key) || this.phases.get(String(frame.output_index ?? ""));
        // Some gateways only say whether this was a working note when the message finishes.
        if (phase === "unknown") this.heldText.set(key, (this.heldText.get(key) || "") + delta);
        else if (phase === "commentary") out.push({ type: "status", text: delta });
        else { this.text += delta; out.push({ type: "text", delta }); }
      } else if (/^response\.reasoning_summary_.*\.delta$/.test(event) || event === "response.reasoning_text.delta") {
        out.push({ type: "thinking", delta: frame.delta || "" });
      } else if (event === "hermes.status" && frame.text) out.push({ type: "status", text: frame.text });
      else if (event === "response.output_item.added" && item?.type === "function_call") {
        const id = item.call_id || item.id || key;
        const call = { id, name: item.name || "tool" };
        this.calls.set(id, call);
        if (item.id) this.calls.set(item.id, call);
        let input = item.arguments;
        if (typeof input === "string") { try { input = JSON.parse(input); } catch { /* Keep the words if they are not a filled form. */ } }
        out.push({ type: "tool", phase: "start", ...call, ...(input !== undefined ? { input } : {}) });
      } else if (event === "response.output_item.done" && item?.type === "message") {
        const id = item.id || key;
        const keys = [...new Set([id, key, String(frame.output_index ?? "")])];
        const held = keys.map((k) => this.heldText.get(k) || "").join("");
        keys.forEach((k) => this.heldText.delete(k));
        if (held || !keys.some((k) => this.streamed.has(k))) {
          const text = held || (item.content || []).map((p) => p.text || "").join("");
          if ((item.phase || this.phases.get(id)) === "commentary") out.push({ type: "status", text });
          else if (text) { this.text += text; out.push({ type: "text", delta: text }); }
        }
      } else if (event === "response.completed") {
        for (const [id, text] of this.heldText) {
          const item = frame.response?.output?.find((i, index) => i.id === id || String(index) === id);
          if (item?.phase === "commentary") out.push({ type: "status", text });
          else { this.text += text; out.push({ type: "text", delta: text }); }
        }
        this.heldText.clear();
        if (!this.text) {
          const text = (frame.response?.output || []).filter((i) => i.type === "message" && i.phase !== "commentary").flatMap((i) => i.content || []).map((p) => p.text || "").join("");
          if (text) { this.text = text; out.push({ type: "text", delta: text }); }
        }
        out.push({ type: "usage", input: frame.response?.usage?.input_tokens || 0, output: frame.response?.usage?.output_tokens || 0, engine: this.choice });
        out.push({ type: "done", text: this.text, engine: this.choice });
        this.terminal = true;
      } else if (event === "response.failed") {
        const error = frame.response?.error;
        out.push(failure(`${error?.code || ""} ${error?.message || ""}`, undefined, this.now));
        this.terminal = true;
      } else if (event === "response.cancelled") { out.push(stopped()); this.terminal = true; }
      if (!this.terminal && item?.type === "function_call_output") {
        const id = item.call_id || item.id || key;
        const call = this.calls.get(id) || { id, name: item.name || "tool" };
        if (!this.ended.has(call.id)) {
          this.ended.add(call.id);
          let output = item.output;
          if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* A tool can answer in words. */ } }
          const bad = typeof output === "object" && output !== null && ("isError" in output && output.isError === true || "error" in output && !!output.error || "ok" in output && output.ok === false || "status" in output && output.status === "error");
          const errorText = typeof output === "string" && /^\s*(error\b|failed\b)/i.test(output);
          out.push({ type: "tool", phase: "end", ...call, ok: !bad && !errorText });
        }
      }
    }
    return out;
  }
}

/** The same chunks always give the same rows, however the connection split them. */
export function parseEngineChunks(chunks: Iterable<string | Uint8Array>, choice: EngineChoice, now = 0): EngineEvent[] {
  const parser = new EngineParser(choice, now);
  return [...chunks].flatMap((chunk) => parser.push(chunk)).concat(parser.push("", true));
}
