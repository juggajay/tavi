// A tiny in-process event bus, so tools running inside the brain can reach the phone (e.g. "show me").
import { EventEmitter } from "node:events";
import type { Item, Pin, SurfaceCommand } from "./shared/protocol.js";
import type { TurnInfo } from "./brain/turn.js";

/** A drawing crop for the phone (show_drawing). background: from a routine run, not the conversation. */
export type ShowCard = { title: string; image: string; source: string; background?: boolean };
type Events = {
  show: [ShowCard];
  /** Put an earlier card (by id) back on the phone. */
  reopen: [string];
  drawings: [{ phase: "queued" | "indexing" | "ready" | "failed"; name: string; project: string; detail?: string }];
  /** SOUL.md or USER.md changed: the brain reloads its prompt, the voice card is regenerated. */
  profile: [{ file: "SOUL.md" | "USER.md" }];
  /** A setting changed (store/settings.ts): every setting's current value. */
  settings: [Record<string, unknown>];
  /** v2: something to show (store/items.ts). open: pop it up on the screen of whoever asked. */
  item: [{ item: Item; open: boolean; turn: TurnInfo | null; v1?: boolean; replaces?: string }];
  item_update: [{ id: string; patch: Partial<Item> }];
  /** The pins changed (store/pins.ts): every pin, as the apps get them. */
  pins: [Pin[]];
  /** Something on the desktop's Activity or Memory page changed: it refetches (debounced in the gateway). */
  activity: [];
  memory: [];
  /** Folders or files being read changed (files/library.ts). */
  files: [{ folder?: string }];
  /** A conversation line was written (store/log.ts). */
  line: [{ id: number; role: string; channel: string; text: string; at: string; job_id: string | null }];
  /** Background tasks started or all finished: the phone's quiet "working" line at the top (as routines do). */
  background: [{ phase: "start" | "end"; title: string; doing?: string; job_id?: string }];
  /** A command for one client's pull-up surface (point_at, the voice fast path). */
  surface: [{ client_id: string; cmd: SurfaceCommand }];
  /** The owner sent a photo or a sketch (Stage 8.4, 8.5): the voice is told mid-call. */
  picture: [{ kind: "photo" | "sketch"; file: string; over?: string }];
  /** The assistant's browser changed (Stage 15.2, browser/host.ts): open or closed, where it is, taken over or not. */
  browser: [import("./shared/protocol.js").BrowserView];
  /** The getting-to-know-you sit-down started or ended (memory/sitdown.ts): the voice is told mid-call. */
  sitdown: [{ status: string; was: string }];
};

class Bus extends EventEmitter {
  emit<K extends keyof Events>(event: K, ...args: Events[K]) {
    return super.emit(event, ...args);
  }
  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void) {
    return super.on(event, fn as (...a: unknown[]) => void);
  }
}
export const bus = new Bus();
