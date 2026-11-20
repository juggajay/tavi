// Stage 7.1: the personality starter and the USER.md sections. An unedited old starter SOUL.md is replaced by the new
// one; an edited one is left alone; an older USER.md gains the "Life" section without losing a line.
import "../isolate.js"; // first: a private, throwaway data folder
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProfile, PROFILE_DIR, readSoul, readUser, USER_CAP, USER_SECTIONS, editUser } from "../../src/profile/profile.js";
import { ROLE } from "../../src/brain/rules.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOUL = path.join(PROFILE_DIR, "SOUL.md");
const USER = path.join(PROFILE_DIR, "USER.md");
// The starter as it was before Stage 7 (git may give the fixture Windows line endings; the real file never had them).
const OLD = readFileSync(path.join(here, "../fixtures/soul-starter-v2.md"), "utf8").replace(/\r\n/g, "\n");

// A fresh folder gets the new starter.
const fresh = readSoul();
assert.match(fresh, /I'm your personal assistant/);
assert.doesNotMatch(fresh, /offsider|supervisor|job title/i);

// An unedited old starter is replaced on start-up.
writeFileSync(SOUL, OLD);
ensureProfile();
assert.equal(readSoul(), fresh, "unedited old starter replaced");

// An edited one is left alone.
const edited = OLD.replace("plain Australian English", "plain Australian English, and short");
writeFileSync(SOUL, edited);
ensureProfile();
assert.equal(readSoul(), edited, "edited SOUL.md untouched");

// An existing USER.md (the old five sections, with lines and a note) gains "Life" and keeps every line.
const oldUser = [
  "# About you",
  "<!-- Tavi keeps this current. Change anything by saying \"that's wrong\" or \"forget that\", or edit it in Setup.",
  "     Active lines only; the history is in the change log. Capped at 3,000 characters. Lines end (date learned · source). -->",
  "",
  "## Basics",
  "- Lives in Lumi (2026-11-06 · you said)",
  "",
  "## Work",
  "- Working on the Lumi job (2026-11-07 · you said)",
  "",
  "## People",
  "",
  "## How to talk to them",
  "- Short answers before 7am (2026-11-08 · you (PC))",
  "",
  "## Follow-ups",
  "",
].join("\n");
writeFileSync(USER, oldUser);
ensureProfile();
const now = readUser();
for (const l of oldUser.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("## "))) assert.ok(now.includes(l), `kept: ${l}`);
assert.match(now, /## People\n\n## Life\n\n## How to talk to them/, "Life sits between People and How to talk to them");
assert.match(now, /Capped at 4,000 characters/);
ensureProfile();
assert.equal(readUser(), now, "running it again changes nothing");

// The new section takes lines; the cap is 4,000.
assert.deepEqual([...USER_SECTIONS], ["Basics", "Work", "People", "Life", "How to talk to them", "Follow-ups"]);
assert.equal(USER_CAP, 4000);
editUser({ op: "add", section: "Life", text: "Two kids, Nemi and Ruvo" }, { trust: "user", source: "you said" });
assert.match(readUser(), /## Life\n- Two kids, Nemi and Ruvo \(\d{4}-\d{2}-\d{2} · you said\)/);
assert.ok(readUser().includes("- Lives in Lumi (2026-11-06 · you said)"));

// The prompt no longer says what the owner does for a living.
assert.doesNotMatch(ROLE, /supervisor|construction/i);
console.log("profile starter: all passed");
