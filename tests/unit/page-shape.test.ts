import "../isolate.js";
import assert from "node:assert/strict";
import { PAGE_INPUT, PAGE, pageProblem } from "../../src/shared/pages/shape.js";
import { pageFile } from "../../src/pages/export.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const entry = (i: number) => ({ id: `e${i}`, title: `Album ${i}`, facts: [{ label: "Year", value: "2025" }], tags: ["Quiet"] });
const page = { title: "Albums to listen to", summary: "A few choices for the evening.", blocks: [{ type: "collection", view: "cards", filters: ["Year", "Tags"], entries: Array.from({ length: 2000 }, (_, i) => entry(i)) }] };
assert.equal(pageProblem(page), null);
assert.match(pageProblem({ ...page, script: "run" })!, /script/);
assert.match(pageProblem({ ...page, blocks: [...page.blocks, ...page.blocks] })!, /2,000/);
assert.match(pageProblem({ ...page, blocks: Array.from({ length: 41 }, () => ({ type: "heading", text: "A heading" })) })!, /40/);
assert.match(pageProblem({ title: "Albums", blocks: [{ ...page.blocks[0], entries: [entry(1), entry(1)] }] })!, /repeated/);
assert.match(pageProblem({ title: "Albums", blocks: [{ ...page.blocks[0], filters: ["Unknown"] }] })!, /no fact/);
assert.equal(PAGE_INPUT.safeParse({ title: "Bad link", blocks: [{ type: "paragraph", parts: [{ text: "Open", url: "javascript:alert(1)" }] }] }).success, false);
assert.equal(PAGE_INPUT.safeParse({ title: "Picture", blocks: [{ type: "picture", picture: { type: "sheet", sheet_id: "sheet", box: [0.8, 0, 0.1, 1], alt: "A map" } }] }).success, false);
assert.equal(PAGE_INPUT.safeParse({ title: "Table", blocks: [{ type: "table", columns: ["Name", "Year"], rows: [["One"]] }] }).success, false);
assert.equal(PAGE_INPUT.safeParse({ title: "Picture", blocks: [{ type: "picture", picture: { alt: "Anything", data: "data:image/png;base64,AA==" } }] }).success, false, "A bot cannot supply picture bytes.");
assert.equal(PAGE_INPUT.safeParse({ title: "HTML", blocks: [{ type: "html", html: "<b>hello</b>" }] }).success, false);

const html = pageFile(PAGE.parse({ ...page, title: "Albums </script><script>bad()</script>", blocks: [...page.blocks, { type: "paragraph", parts: [{ text: "<img src=x onerror=bad()>", bold: true, url: "https://example.com" }] }] }));
assert.equal((html.match(/<script>/g) ?? []).length, 1);
assert.ok(!html.includes("https://") && !html.includes("http://"));
assert.ok(!/<(?:link|iframe|object)\b|\son\w+=|<script\s+src=/i.test(html.replace(/<script>[\s\S]*?<\/script>/, "")));
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
assert.ok(html.includes(`sha256-${createHash("sha256").update(script).digest("base64")}`));
console.log("Pages refuse bad shapes and limits, and saved files carry only their own code.");

for (const name of ["recipe", "comparison", "plan", "recipe-asked"]) PAGE_INPUT.parse(JSON.parse(readFileSync(new URL(`../fixtures/pages/${name}.json`, import.meta.url), "utf8")));
const made = { type: "made", prompt: "A bowl of warm tomato stew in natural light.", alt: "Tomato stew" };
const list = (n: number) => ({ type: "list", style: "tick", groups: [{ title: "The sauce", items: Array.from({ length: n }, () => ({ text: "Tomatoes", amount: "400 g", note: "Crushed" })) }] });
const steps = (n: number) => ({ type: "steps", steps: Array.from({ length: n }, () => ({ title: "Stir", label: "Day 1", text: "Stir until smooth.", picture: made, facts: [{ label: "Time", value: "2 min" }], note: { tone: "tip", text: "Keep it gentle." } })) });
const testPage = (patch: object) => ({ title: "A page", blocks: [{ type: "paragraph", parts: [{ text: "A short answer." }] }], ...patch });
assert.equal(pageProblem(testPage({ label: "Recipe", cover: made, facts: [{ label: "Serves", value: "6" }], picture_style: "Soft light.", blocks: [list(200), steps(4)] })), null);
for (const [patch, message] of [
  [{ facts: Array.from({ length: 7 }, () => ({ label: "Time", value: "2 min" })) }, /at most 6 facts/],
  [{ blocks: [list(100), list(101)] }, /200 list items/],
  [{ blocks: [{ ...steps(1), steps: Array.from({ length: 41 }, () => ({ text: "Stir." })) }] }, /40 steps/],
  [{ blocks: [steps(6)], cover: made }, /6 made pictures/],
  [{ blocks: [{ type: "picture", picture: { ...made, prompt: "Too short" } }] }, /at least 20/],
  [{ cover: { ...made, prompt: "x".repeat(601) } }, /600/],
  [{ picture_style: "x".repeat(301) }, /300/],
  [{ picture_style: "Two\nlines" }, /one line/],
  [{ label: "x".repeat(41) }, /40 characters/],
  [{ blocks: [{ type: "steps", steps: [{ text: "Stir.", facts: Array.from({ length: 5 }, () => ({ label: "Time", value: "2 min" })) }] }] }, /4 facts/],
] as [object, RegExp][]) assert.match(pageProblem(testPage(patch))!, message);
for (const style of ["tick", "bullet", "plain"]) assert.equal(pageProblem(testPage({ blocks: [{ ...list(1), style }] })), null);
for (const tone of ["tip", "note", "pick", "question", "warning"]) assert.equal(pageProblem(testPage({ blocks: [{ type: "callout", title: "A thought", text: "Try this.", tone }] })), null);
PAGE.parse(testPage({ cover: { alt: "Stew", source: "Made picture", made: true, pending: true } }));
assert.ok(!PAGE_INPUT.safeParse(testPage({ blocks: [{ type: "steps", steps: [{ text: "Stir.", timer: { minutes: 2, label: "Stir" } }] }] })).success, "Timers are deliberately left out of this stage.");
const standing = readFileSync(new URL("../../src/hq/engines/standing.ts", import.meta.url), "utf8");
for (const words of ["show_page", "one action each", "amount repeated", "long wait", "five at most", "private details", "never one for every step", "page file you can search", "never promise a PDF", "do not wait"]) assert.ok(standing.includes(words), words);

// The example handed back with a refusal is itself a valid page, and a list's style may be left out.
{
  const { PAGE_EXAMPLE, PAGE_INPUT: shape } = await import("../../src/shared/pages/shape.js");
  shape.parse(JSON.parse(PAGE_EXAMPLE));
  const plain = shape.parse({ title: "A list", blocks: [{ type: "list", groups: [{ items: [{ text: "Flour" }] }] }] });
  if (plain.blocks[0].type !== "list" || plain.blocks[0].style !== "tick") throw new Error("a list without a style is ticked off");
  console.log("page-shape: the example page is valid and a list's style may be left out");
}
