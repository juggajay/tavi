// Pebble's colours: every weekday passes the contrast rule in both themes (DESIGN §3.6), and the colour chosen for
// "now" follows the settings (today-only override, then a fixed colour, then the weekday in the owner's time zone).
import "../isolate.js"; // first
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The UI module is browser code; load it at run time so the server's type check doesn't read it.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/src/shared/palette.ts");
const P = (await import(pathToFileURL(file).href)) as {
  report: () => { day: string; ringWhite: number; ringPaperDark: number; btnL: number; btnD: number; inkL: number; inkD: number }[];
  colourFor: (s: Record<string, unknown>, now?: Date) => { name: string };
};

for (const r of P.report()) {
  assert.ok(r.ringWhite >= 3, `${r.day} ring on white ${r.ringWhite}`);
  assert.ok(r.ringPaperDark >= 3, `${r.day} ring on dark paper ${r.ringPaperDark}`);
  assert.ok(r.btnL >= 4.5 && r.btnD >= 4.5, `${r.day} buttons ${r.btnL} ${r.btnD}`);
  assert.ok(r.inkL >= 4.5 && r.inkD >= 4.5, `${r.day} accent text ${r.inkL} ${r.inkD}`);
}

const wed = new Date("2026-11-11T02:00:00Z"); // Wednesday afternoon in Sydney
assert.equal(P.colourFor({ "time.zone": "Australia/Sydney" }, wed).name, "Orange");
assert.equal(P.colourFor({ "time.zone": "America/Los_Angeles" }, wed).name, "Teal", "still Tuesday there");
assert.equal(P.colourFor({ "ui.pebble_colour_mode": "fixed", "ui.pebble_fixed_colour": "sky", "time.zone": "Australia/Sydney" }, wed).name, "Sky");
const until = new Date(wed.getTime() + 3600_000).toISOString();
assert.equal(P.colourFor({ "ui.colour_override": { colour: "plum", until }, "ui.pebble_colour_mode": "fixed", "ui.pebble_fixed_colour": "teal" }, wed).name, "Plum");
assert.equal(P.colourFor({ "ui.colour_override": { colour: "plum", until }, "time.zone": "Australia/Sydney" }, new Date(wed.getTime() + 7200_000)).name, "Orange", "override over");
console.log("palette: contrast passes every day in both themes; colour follows the settings");
