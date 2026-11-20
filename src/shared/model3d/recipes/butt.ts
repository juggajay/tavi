// Butt joint: the end of a rail square against the side of a post, nothing cut. Frame in the x-z plane, seen from the front.
import { type Recipe, dim, refuse, withCommon } from "./kit.js";

export const butt: Recipe = {
  name: "butt",
  what: "two members meeting square, the end of one against the side of the other, nothing cut",
  members: [
    { name: "rail", what: "the one whose end butts: [width, thickness]", default: [90, 45] },
    { name: "post", what: "the one it butts against: [width, thickness]", default: [90, 45] },
  ],
  params: withCommon([
    { name: "layout", what: "corner: at the post's end; tee: part-way along it", kind: "choice", choices: ["corner", "tee"], default: "corner" },
    { name: "rail_length", what: "length of rail shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times the rail's width, at least 300" },
    { name: "post_length", what: "length of post shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(400, 4 * r.members[0][0]), defaultText: "four times the rail's width, at least 400" },
  ]),
  make(r) {
    const [[rw, rt], [pw, pt]] = r.members;
    const layout = r.choice<"corner" | "tee">("layout");
    const RL = r.num("rail_length"),
      PL = r.num("post_length");
    if (rw > PL) refuse("the rail is wider than the post is long");
    const z0 = layout === "corner" ? PL - rw : PL / 2 - rw / 2;
    const front = -Math.max(pt, rt) / 2;
    return {
      parts: [
        { id: "post", name: "Post", material: r.material, grain: "z", stock: { type: "box", size: [pw, pt, PL], at: [0, -pt / 2, 0] } },
        { id: "rail", name: "Rail", material: r.material, grain: "x", stock: { type: "box", size: [RL, rt, rw], at: [pw, -rt / 2, z0] }, apart: [80, 0, 0], moves: true },
      ],
      dims: [
        dim([pw + RL + 30, front, z0], [pw + RL + 30, front, z0 + rw], { part: "rail" }),
        dim([0, front, (layout === "corner" ? 0 : PL) + (layout === "corner" ? -30 : 30)], [pw, front, (layout === "corner" ? 0 : PL) + (layout === "corner" ? -30 : 30)]),
      ],
      note: "A plain butt: it relies on fixings or glue, which aren't shown.",
    };
  },
};
