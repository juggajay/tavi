// A tool result reaches a Hermes bot with four pictures at most (see fourPictures in src/hq/toolbox/calls.ts).
import "../isolate.js"; // first
import assert from "node:assert/strict";
import { fourPictures, PICTURES_PER_RESULT } from "../../src/hq/toolbox/calls.js";

const pic = (n: number) => ({ type: "image" as const, data: Buffer.from(`picture ${n}`).toString("base64"), mimeType: "image/png" });
const text = (t: string) => ({ type: "text" as const, text: t });

const six = fourPictures({ content: [text("Sheets 1 to 6"), ...[1, 2, 3, 4, 5, 6].map(pic)] } as never) as { content: { type: string; text?: string; data?: string }[] };
assert.equal(six.content.filter((p) => p.type === "image").length, PICTURES_PER_RESULT, "four pictures are kept");
assert.deepEqual(six.content.filter((p) => p.type === "image").map((p) => Buffer.from(p.data!, "base64").toString()), ["picture 1", "picture 2", "picture 3", "picture 4"], "the first four, in order, untouched");
assert.equal(six.content[0].text, "Sheets 1 to 6", "the words stay first");
assert.match(six.content.at(-1)!.text!, /2 more pictures were left out/, "and it says how many were left out");

const four = { content: [text("a"), ...[1, 2, 3, 4].map(pic)] };
assert.equal(fourPictures(four as never), four, "four or fewer: the result is handed on as it is");
const five = fourPictures({ content: [...[1, 2, 3, 4, 5].map(pic)] } as never) as { content: { type: string; text?: string }[] };
assert.match(five.content.at(-1)!.text!, /1 more picture was left out/);
const none = { content: [text("no pictures")] };
assert.equal(fourPictures(none as never), none);
const failed = fourPictures({ isError: true, content: [text("x"), ...[1, 2, 3, 4, 5].map(pic)] } as never) as { isError?: boolean };
assert.equal(failed.isError, true, "an error stays an error");
console.log("toolbox pictures: four at most reach a bot, and it is told when there were more");
