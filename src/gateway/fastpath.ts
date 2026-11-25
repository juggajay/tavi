// Short commands answered at once, without the brain: "zoom out", "clear", "go back", "next one", "keep that handy",
// "go blue for today", "what have you shown me today", "zoom in on door 7". Exact phrases only, after dropping filler
// words; anything else goes to the brain. Replies are the lines from DESIGN §7. Only for v2 clients (the new apps).
import { findSheet, locate } from "../drawings/library.js";
import { shownToday } from "../store/items.js";
import { clearPins, listPins, pinScreen, unpinItem } from "../store/pins.js";
import { COLOURS, getSettings, updateSettings, type Colour } from "../store/settings.js";
import { nextLocalMidnight, partsIn } from "../time.js";
import { listShown } from "../brain/showTools.js";
import { newTurn } from "../brain/turn.js";
import { command, surfaceOf } from "./surface.js";
import { clientById } from "./clients.js";
import { browserState, liveHost } from "../browser/host.js";
import { cancelJob, jobBot, latestRunningTask, runningTaskCount } from "../brain/tasks.js";
import { db } from "../store/db.js";
import type { Box, ModelSide, Origin } from "../shared/protocol.js";

export type FastResult = { spoken: string; did: string };

const LEAD = /^(?:hey|ok|okay|um|uh|so|right|alright|please|can you|could you|would you|will you|tavi)\s+/;
const TAIL = /\s+(?:please|thanks|thank you|for me|mate|now)$/;

export function normalise(text: string) {
  let t = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(LEAD, "").replace(TAIL, "").trim();
  }
  return t;
}

const set = (...phrases: string[]) => new Set(phrases);
const CLEAR = set("clear", "clear that", "clear it", "clear the screen", "close that", "close it", "put that away", "put it away");
const ZOOM_OUT = set("zoom out", "zoom right out", "zoom all the way out", "whole sheet", "show the whole sheet", "show me the whole sheet");
const ZOOM_IN = set("zoom in", "closer", "zoom in more", "bit closer", "a bit closer");
const NEXT = set("next", "next one", "next sheet", "next page");
const PREV = set("previous", "previous one", "back one", "last one", "previous sheet", "previous page");
const BACK = set("go back", "back");
// Pins (13.2): "pin this" puts what's on screen (and the pages beside it) on the phone's home screen; "for today" clears
// itself at midnight. A sixth, or anything about a pin by name, goes to the brain, which asks which one to drop.
const PIN = set("keep that handy", "keep this handy", "keep it handy", "pin that", "pin this", "pin it", "pin that one", "pin this one");
const PIN_TODAY = set("pin this for today", "pin that for today", "pin it for today", "pin this one for today", "pin that one for today", "keep that handy for today", "keep this handy for today", "keep it handy for today", "pin this for the day", "pin that for the day");
const UNPIN = set("unpin that", "unpin this", "unpin it", "unpin that one", "unpin this one", "you can let that go", "let that go");
const CLEAR_PINS = set("clear my pins", "clear the pins", "clear all my pins", "clear all the pins", "clear pins", "unpin everything", "unpin all", "unpin them all", "unpin all of them", "get rid of my pins", "get rid of the pins", "remove my pins", "remove all my pins", "remove all the pins");
const NORMAL = set("back to normal", "normal colour", "normal color", "go back to normal", "your normal colour");
const STOP = set("stop that", "stop it", "cancel that", "cancel it", "never mind", "never mind that", "nevermind", "forget it");
// "let me draw it": the sketch pad opens at once, by voice or typed (Stage 8.5), without waiting for a brain turn.
const PAD = set(
  "let me draw it",
  "let me draw",
  "let me draw it for you",
  "i'll draw it",
  "i'll draw it for you",
  "i'll sketch it",
  "i'll sketch it for you",
  "let me sketch it",
  "let me sketch",
  "can i show you",
  "let me show you",
  "can i draw it",
  "can i draw it for you",
  "open the sketch pad",
  "open the pad",
  "sketch pad",
);
// A 3D model on screen (Stage 9.3): pull apart, sizes, a side to look from, turn it round, start again.
const APART = set("pull it apart", "pull apart", "pull them apart", "take it apart", "break it apart", "explode it", "spread it out", "separate it", "show me how it comes apart");
const TOGETHER = set("put it back together", "put it together", "back together", "put them back together", "put it back", "close it up", "assemble it", "together again");
const SIZES = set("show the sizes", "show sizes", "show me the sizes", "sizes on", "show the dimensions", "show dimensions", "show me the dimensions", "show the measurements", "show measurements", "put the sizes on");
const NO_SIZES = set("hide the sizes", "hide sizes", "sizes off", "hide the dimensions", "hide dimensions", "take the sizes off", "no sizes", "hide the measurements");
const TURN = set("turn it round", "turn it around", "spin it round", "spin it around", "rotate it", "turn it", "spin it");
const RESET = set("reset the view", "reset view", "reset it", "back to the start", "start view", "fit it to the screen", "fit it");
const SIDES: Record<string, ModelSide> = { top: "top", above: "top", front: "front", side: "side", left: "side", right: "side", back: "back", behind: "back", underneath: "underneath", under: "underneath", below: "underneath", bottom: "underneath" };
const LOOK = /^(?:look (?:at it )?|show (?:it |me )?|view it |see it )?from (?:the )?(top|above|front|side|left|right|back|behind|underneath|under|below|bottom)$|^(?:the )?(top|front|side|back|underneath|bottom) view$/;
// The live view of the assistant's browser (15.2), and stopping it. On the phone these go to the brain.
const BROWSER = set("show me the browser", "show the browser", "open the browser", "show me what you're doing in the browser", "what are you doing in the browser", "let me see the browser", "show me what you're doing on the web", "watch the browser", "let me watch");
const STOP_BROWSER = set("stop the browser", "stop browsing", "stop the web job", "close the browser", "stop what you're doing in the browser");
// The desktop's file viewer (15.1). On the phone it goes to the brain, which puts up a list.
const FILES = set("show me my files", "show my files", "open my files", "show me the files", "open the files", "show me everything you've got", "my files", "open files", "show files");
const SHOWN = set("what have you shown me today", "what did you show me today", "show me what you showed me today", "what have you shown me", "what did you show me");

const DAY_COLOURS: Colour[] = ["slate", "blue", "teal", "orange", "pink", "sky", "plum"]; // by Date.getDay(), as palette.js
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The colour Pebble has today without an override, and the day's name, in the owner's time zone. */
function usualColour() {
  const s = getSettings();
  const idx = partsIn().dow;
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][idx];
  return { colour: s["ui.pebble_colour_mode"] === "fixed" ? s["ui.pebble_fixed_colour"] : DAY_COLOURS[idx], day };
}

/** Door 7 / D7 / D07 / 07 / 7: the ways a tag might be printed, most specific first. */
const tagVariants = (n: string) => {
  const k = String(Number(n));
  return [`D${k.padStart(2, "0")}`, `D${k}`, k.padStart(2, "0"), k];
};

/** Handles the command if it is one, for the client whose screen it's about. Null: not a fast-path command. */
export async function tryFastPath(text: string, clientId: string | null, origin: Origin | null, bot?: string): Promise<FastResult | null> {
  const t = normalise(text);
  if (!t) return null;
  const { screen, item } = surfaceOf(clientId);
  const page = (screen?.page_index ?? 0) + 1;
  const pages = screen?.page_count ?? (item ? 1 : 0);
  const send = (cmd: Parameters<typeof command>[1]) => clientId && command(clientId, cmd);

  // "Stop that" only when there's exactly one background job it could mean; otherwise the brain sorts it out.
  const own = process.env.LH_V3 === "1" && STOP.has(t) ?
    (db.prepare("SELECT id FROM jobs WHERE kind IN ('task','browser','render') AND status IN ('running','queued')").all() as { id: string }[]).filter((j) => !!bot && jobBot(j.id) === bot) : undefined;
  if (STOP.has(t) && (own ? own.length : runningTaskCount()) === 1) {
    const id = own ? own[0].id : latestRunningTask();
    if (id && cancelJob(id, "user")) return { spoken: "Stopped.", did: `stop ${id}` };
  }

  if (STOP_BROWSER.has(t) || (t === "stop" && browserState().open)) {
    const v = browserState();
    if (!v.open) return { spoken: "The browser isn't doing anything.", did: "stop browser: nothing" };
    if (!(v.job_id && cancelJob(v.job_id, "user"))) await liveHost()?.close();
    return { spoken: "Stopped.", did: "stop browser" };
  }
  if (BROWSER.has(t)) {
    if (!clientId || clientById(clientId)?.kind !== "desktop") return null; // the phone has no live view: the brain answers
    send({ cmd: "browser" });
    const v = browserState();
    return { spoken: v.open ? (v.takeover === "on" ? "You've got it." : v.asking ? `I need you: ${v.asking}.` : `${v.doing || "Here it is"}.`) : "The browser isn't doing anything at the moment.", did: "browser" };
  }
  if (FILES.has(t)) {
    if (!clientId || clientById(clientId)?.kind !== "desktop") return null; // the phone has no viewer: the brain answers
    return send({ cmd: "files" }), { spoken: "Here's everything.", did: "files" };
  }
  if (PAD.has(t)) {
    if (!clientId) return null;
    send({ cmd: "pad" });
    return { spoken: "Go ahead, draw it.", did: "sketch pad" };
  }
  if (CLEAR.has(t)) {
    if (!item) return { spoken: "Nothing's up.", did: "clear: nothing up" };
    send({ cmd: "clear" });
    return { spoken: "Cleared.", did: "clear" };
  }
  if (ZOOM_OUT.has(t)) {
    if (item?.kind === "model") return send({ cmd: "zoom_out" }), { spoken: "That's all of it.", did: "zoom out" };
    if (item?.kind !== "sheet" && item?.kind !== "reference" && item?.kind !== "sketch" && item?.kind !== "shopdrawing") return { spoken: "There's no drawing up at the moment.", did: "zoom out: no drawing" };
    send({ cmd: "zoom_out" });
    return { spoken: "That's the whole sheet.", did: "zoom out" };
  }
  if (ZOOM_IN.has(t)) {
    if (item?.kind !== "sheet" && item?.kind !== "reference" && item?.kind !== "sketch" && item?.kind !== "model" && item?.kind !== "shopdrawing") return { spoken: "There's no drawing up at the moment.", did: "zoom in: no drawing" };
    send({ cmd: "zoom_in" });
    return { spoken: "Okay.", did: "zoom in" };
  }
  // a model on screen: anything else about it goes to the brain; with no model up these aren't commands at all
  if (item?.kind === "model") {
    const look = LOOK.exec(t);
    if (APART.has(t)) return send({ cmd: "model", op: "apart" }), { spoken: "Pulled apart.", did: "model: apart" };
    if (TOGETHER.has(t)) return send({ cmd: "model", op: "together" }), { spoken: "Back together.", did: "model: together" };
    if (SIZES.has(t)) return send({ cmd: "model", op: "sizes" }), { spoken: "Sizes on.", did: "model: sizes" };
    if (NO_SIZES.has(t)) return send({ cmd: "model", op: "no_sizes" }), { spoken: "Sizes off.", did: "model: no sizes" };
    if (TURN.has(t)) return send({ cmd: "model", op: "turn" }), { spoken: "Turning it round.", did: "model: turn" };
    if (RESET.has(t)) return send({ cmd: "model", op: "reset" }), { spoken: "Back to the start.", did: "model: reset" };
    if (look) {
      const side = SIDES[look[1] ?? look[2]];
      send({ cmd: "model", op: "look", side });
      return { spoken: side === "underneath" ? "From underneath." : `From the ${side}.`, did: `model: look ${side}` };
    }
  }
  if (NEXT.has(t)) {
    if (!item) return { spoken: "Nothing's up at the moment.", did: "next: nothing up" };
    if (page >= pages) return { spoken: "That's the last one.", did: "next: at the end" };
    send({ cmd: "next" });
    return { spoken: "Next one.", did: "next" };
  }
  if (PREV.has(t)) {
    if (!item) return { spoken: "Nothing's up at the moment.", did: "previous: nothing up" };
    if (page <= 1) return { spoken: "That's the first one.", did: "previous: at the start" };
    send({ cmd: "prev" });
    return { spoken: "Back one.", did: "previous" };
  }
  if (BACK.has(t)) {
    if (!screen?.stack_depth) return { spoken: "There's nothing to go back to.", did: "back: nothing" };
    send({ cmd: "back" });
    return { spoken: "Back to what you had.", did: "back" };
  }
  if (PIN.has(t) || PIN_TODAY.has(t)) {
    if (!item) return { spoken: "There's nothing up to pin.", did: "pin: nothing up" };
    const today = PIN_TODAY.has(t);
    const r = pinScreen(screen, { for_today: today });
    if (!("pin" in r)) return null; // five already (or it can't be pinned): the brain asks which to drop
    return { spoken: today ? "Pinned for today." : "Pinned.", did: `pin ${r.pin.id}${today ? " for today" : ""}` };
  }
  if (UNPIN.has(t)) {
    if (!item || !unpinItem(item.id)) return null; // not pinned, or about a pin by name: the brain sorts it out
    return { spoken: "Unpinned.", did: `unpin ${item.id}` };
  }
  if (CLEAR_PINS.has(t)) {
    if (!listPins().length) return { spoken: "There's nothing pinned.", did: "clear pins: none" };
    const n = clearPins();
    return { spoken: n === 1 ? "Unpinned it." : "All unpinned.", did: `clear pins: ${n}` };
  }
  if (NORMAL.has(t)) {
    if (process.env.LH_V3 === "1") return null;
    const had = getSettings()["ui.colour_override"];
    updateSettings({ "ui.colour_override": null }, "brain");
    const { colour, day } = usualColour();
    return { spoken: had ? `Back to ${colour} for ${day}.` : `I'm already ${colour} for ${day}.`, did: "colour: normal" };
  }
  const go = /^(?:go|turn|be) (\w+)(?: for (?:today|the day))?$/.exec(t);
  if (go && process.env.LH_V3 === "1") {
    const { colourNamed } = await import("../hq/looks/choices.js");
    const colour = colourNamed(go[1]);
    if (!bot || !colour) return null;
    try {
      const { changeLook } = await import("../hq/toolbox/looks.js");
      changeLook(bot, { colour });
      return { spoken: `${cap(colour)} it is. I'll keep this look.`, did: `colour: ${colour}` };
    } catch { return null; }
  }
  if (go && (COLOURS as readonly string[]).includes(go[1])) {
    updateSettings({ "ui.colour_override": { colour: go[1] as Colour, until: nextLocalMidnight() } }, "brain");
    return { spoken: `${cap(go[1])} it is, until tomorrow.`, did: `colour: ${go[1]}` };
  }
  if (SHOWN.has(t)) {
    const n = shownToday().length;
    if (!n) return { spoken: "Nothing yet today.", did: "shown today: none" };
    listShown(newTurn({ origin }));
    return { spoken: `${n} ${n === 1 ? "thing" : "things"} so far. Tap one to bring it back.`, did: "shown today" };
  }
  // "zoom in on door 7" while a drawing is up: ring it if exactly one tag matches; otherwise the brain works it out.
  const door = /^(?:zoom in on|zoom to|show me|where's|where is|go to|find) door (?:d\s?)?(\d{1,3})$/.exec(t);
  if (door && item?.kind === "sheet") {
    const s = findSheet(item.payload.sheet_id);
    if (!s) return null;
    for (const v of tagVariants(door[1])) {
      const hits = (await locate(s, v, 3)).filter((h) => h.text.replace(/[^\w]/g, "").toUpperCase() === v.toUpperCase());
      if (hits.length === 1) {
        const box = hits[0].box.map((x) => Math.min(1, Math.max(0, x))) as Box;
        send({ cmd: "focus", box, mark: { box, label: v } });
        return { spoken: `Door ${Number(door[1])}. It's ringed.`, did: `focus ${v}` };
      }
      if (hits.length > 1) return null;
    }
  }
  return null;
}
