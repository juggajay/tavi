import "../isolate.js";
import assert from "node:assert/strict";
import { PAGE_INPUT, PAGE, pageProblem } from "../../src/shared/pages/shape.js";
import { pageFile } from "../../src/pages/export.js";
import { createHash } from "node:crypto";

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
