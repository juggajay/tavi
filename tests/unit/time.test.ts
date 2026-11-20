// One time zone: "today", routine times, quiet hours and dates the brain writes all follow the time.zone setting,
// whatever zone the PC's own clock is in (this test runs with the process clock in New York).
process.env.TZ = "America/New_York";
import "../isolate.js"; // first (imports are hoisted; TZ only matters once dates are made, below)
import assert from "node:assert/strict";
import { addDays, atLocal, localDay, nextLocalMidnight, nowLine, parseLocal, partsIn, startOfDay, weekdayOf } from "../../src/time.js";
import { nextRun } from "../../src/proactive/schedule.js";
import { inQuietHours, quietEndsAt, setSetting } from "../../src/store/proactive.js";
import { updateSettings } from "../../src/store/settings.js";
import { nextWindow } from "../../src/proactive/followups.js";

process.env.TZ = "America/New_York";
updateSettings({ "time.zone": "Australia/Sydney" }, "local");
const at = (iso: string) => new Date(iso);

// 16:20 on Wednesday 11 November in Sydney (AEDT, UTC+11).
const wed = at("2026-11-11T05:20:00Z");
assert.equal(localDay(wed), "2026-11-11");
assert.equal(partsIn(wed).h, 16);
assert.equal(partsIn(wed).dow, 3);
assert.equal(addDays("2026-11-30", 1), "2026-12-01");
assert.equal(weekdayOf("2026-11-14"), 6);
assert.equal(startOfDay(wed).toISOString(), "2026-11-10T13:00:00.000Z");
assert.equal(nextLocalMidnight(wed), "2026-11-11T13:00:00.000Z");
assert.match(nowLine(wed), /Wednesday 11 November 2026.*Australia\/Sydney, UTC\+11:00/);

// Either side of the clocks going forward (Sunday 4 October 2026, 2am).
assert.equal(atLocal("2026-10-03", 6, 0).toISOString(), "2026-10-02T20:00:00.000Z", "AEST, UTC+10");
assert.equal(atLocal("2026-10-04", 6, 0).toISOString(), "2026-10-03T19:00:00.000Z", "AEDT, UTC+11");

// Dates the brain writes without a zone are the owner's time; with a zone, as written.
assert.equal(parseLocal("2026-11-09T07:00").toISOString(), "2026-11-08T20:00:00.000Z");
assert.equal(parseLocal("2026-11-09").toISOString(), "2026-11-08T13:00:00.000Z");
assert.equal(parseLocal("2026-11-09T07:00:00Z").toISOString(), "2026-11-09T07:00:00.000Z");
assert.equal(parseLocal("2026-11-09T07:00:00+08:00").toISOString(), "2026-11-08T23:00:00.000Z");

// Routines: 6:30 each day, weekdays skip the weekend, a one-off at a local time.
assert.equal(nextRun({ kind: "daily", time: "06:30" }, wed)!.toISOString(), "2026-11-11T19:30:00.000Z");
assert.equal(nextRun({ kind: "daily", time: "17:00" }, wed)!.toISOString(), "2026-11-11T06:00:00.000Z");
const friEvening = at("2026-11-13T09:00:00Z"); // Friday 8pm Sydney
assert.equal(nextRun({ kind: "weekdays", time: "06:30" }, friEvening)!.toISOString(), "2026-11-15T19:30:00.000Z", "Monday 6:30am");
assert.equal(nextRun({ kind: "weekly", days: [6], time: "08:00" }, friEvening)!.toISOString(), "2026-11-13T21:00:00.000Z", "Saturday 8am");
assert.equal(nextRun({ kind: "once", at: "2026-11-12T07:00" }, wed)!.toISOString(), "2026-11-11T20:00:00.000Z");

// Quiet hours 9pm to 6am in Sydney.
setSetting("quiet_start", "21:00");
setSetting("quiet_end", "06:00");
assert.equal(inQuietHours(at("2026-11-11T11:00:00Z")), true, "10pm");
assert.equal(inQuietHours(wed), false, "4:20pm");
assert.equal(inQuietHours(at("2026-11-11T18:30:00Z")), true, "5:30am");
assert.equal(quietEndsAt(at("2026-11-11T11:00:00Z")).toISOString(), "2026-11-11T19:00:00.000Z", "6am next morning");

// Follow-up windows (6:00, 12:00, 15:30 on workdays): after 4:20pm Wednesday, the next is 6am Thursday.
assert.equal(nextWindow(wed).toISOString(), "2026-11-11T19:00:00.000Z");
assert.equal(nextWindow(friEvening).toISOString(), "2026-11-15T19:00:00.000Z", "skips the weekend");

// Change the zone: the same instant is a different local day and hour.
updateSettings({ "time.zone": "Australia/Perth" }, "local");
assert.equal(partsIn(wed).h, 13);
assert.equal(nextRun({ kind: "daily", time: "06:30" }, wed)!.toISOString(), "2026-11-11T22:30:00.000Z");

console.log("time: ok");
