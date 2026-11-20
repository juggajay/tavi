// What the phone and the desktop share for the round table (Stage 17.3): the messages, who's doing what, and the words
// for the screen. Each app draws it its own way (phone/table.ts, desktop/table.ts).
import type { ServerTable, TableLineView } from "../../../src/shared/protocol";

export type TableState = Omit<ServerTable, "type">;
export type TableSay = { id: string; speaker: "pebble" | "guest"; text: string; audio: string };
export type { TableLineView };

/** Who's talking now: what's being heard by voice (exact), else the line just shown (typed: for as long as it'd take to say). */
export function nowSpeaking(st: TableState, heard: "pebble" | "guest" | null, shownAt: Map<string, number>): "pebble" | "guest" | null {
  if (heard) return heard;
  const last = st.lines.at(-1);
  if (!last || last.speaker === "owner") return null;
  const at = shownAt.get(last.id) ?? 0;
  const words = last.text.split(/\s+/).length;
  return performance.now() - at < Math.min(5000, 900 + words * 110) ? last.speaker : null;
}

/** The speaker's label on screen. */
export const labelOf = (l: TableLineView, st: TableState) => (l.speaker === "owner" ? "You" : l.speaker === "pebble" ? st.names.pebble : st.names.guest);

/** What Tim is doing, for his character: thinking, talking, listening to someone else, or sitting back. */
export function timState(st: TableState, speaking: "pebble" | "guest" | null): "idle" | "listening" | "thinking" | "speaking" {
  if (speaking === "guest") return "speaking";
  if (st.thinking === "guest") return "thinking";
  if (speaking === "pebble") return "listening";
  return "idle";
}
