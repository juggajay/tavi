// Asking the app that has a 3D model on screen to draw pictures of it (look_at_model) or make a file of it
// (save_model), and waiting for the answer (Stage 9.3). The app draws; the gateway only passes the request on and
// collects what comes back on /api/v2/model/<item>/pictures and /api/v2/upload?as=model.
import { randomBytes } from "node:crypto";
import { clients } from "./clients.js";
import { bus } from "../events.js";
import type { ModelShot } from "../shared/protocol.js";

/** The v2 client showing this item: the one asking if it is, otherwise the one that reported it most recently. */
export function clientShowing(itemId: string, prefer?: string | null): string | null {
  const showing = [...clients.values()].filter((c) => c.v === 2 && c.screen?.item_id === itemId);
  return (showing.find((c) => c.id === prefer) ?? showing.at(-1))?.id ?? null;
}

type Picture = { view: string; png: Buffer };
type Waiter =
  | { kind: "pictures"; item: string; views: ModelShot[]; got: Map<number, Picture>; done: (p: Picture[] | null) => void; timer: ReturnType<typeof setTimeout> }
  | { kind: "save"; item: string; done: (r: { file: string; name: string } | null) => void; timer: ReturnType<typeof setTimeout> };
const waiting = new Map<string, Waiter>();
const newReq = () => `req_${randomBytes(6).toString("hex")}`;

/** Pictures of a model from the app showing it, or null when no app answered in time. */
export function askPictures(itemId: string, clientId: string, views: ModelShot[], ms = 8000): Promise<Picture[] | null> {
  const req = newReq();
  return new Promise((resolve) => {
    const timer = setTimeout(() => (waiting.delete(req), resolve(null)), ms);
    waiting.set(req, { kind: "pictures", item: itemId, views, got: new Map(), done: (p) => (clearTimeout(timer), waiting.delete(req), resolve(p)), timer });
    bus.emit("surface", { client_id: clientId, cmd: { cmd: "model_pictures", item_id: itemId, req, views } });
  });
}

/** A picture arrived. False when nobody is waiting for it (too late, or made up). */
export function deliverPicture(req: string, itemId: string, n: number, view: string, png: Buffer): boolean {
  const w = waiting.get(req);
  if (!w || w.kind !== "pictures" || w.item !== itemId || !Number.isInteger(n) || n < 0 || n >= w.views.length) return false;
  w.got.set(n, { view: w.views[n] ?? view, png });
  if (w.got.size === w.views.length) w.done([...w.got.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]));
  return true;
}

/** Ask the app showing a model to make a file of it; resolves with the saved file, or null when no answer came in time. */
export function askSave(itemId: string, clientId: string, as: "picture" | "glb" | "stl", name: string, ms = 20_000): Promise<{ file: string; name: string } | null> {
  const req = newReq();
  return new Promise((resolve) => {
    const timer = setTimeout(() => (waiting.delete(req), resolve(null)), ms);
    waiting.set(req, { kind: "save", item: itemId, done: (r) => (clearTimeout(timer), waiting.delete(req), resolve(r)), timer });
    bus.emit("surface", { client_id: clientId, cmd: { cmd: "model_save", item_id: itemId, req, as, name } });
  });
}

/** Whether a save request is still waiting (the upload route checks before keeping a file it was asked for). */
export const saveWaiting = (req: string, itemId: string) => {
  const w = waiting.get(req);
  return !!w && w.kind === "save" && w.item === itemId;
};

export function deliverSaved(req: string, result: { file: string; name: string }) {
  const w = waiting.get(req);
  if (w?.kind === "save") w.done(result);
}
