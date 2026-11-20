// Bridle: an open mortise and tenon. The post has an open slot in its top end; the rail drops into it, its cheeks cut
// away (at a corner) or trenched (a tee, the rail running through). Frame in the x-z plane; the rail lifts off upwards.
import { type Recipe, dim, fmt, refuse, span, withCommon } from "./kit.js";
import { fractionOf } from "../designRules.js";

export const bridle: Recipe = {
  name: "bridle",
  what: "an open mortise and tenon: a slot in the end of the post takes the rail, at a corner or with the rail running through (tee)",
  members: [
    { name: "rail", what: "the one that drops into the slot: [width, thickness]", default: [90, 45] },
    { name: "post", what: "the one with the slot in its end: [width, thickness]", default: [90, 45] },
  ],
  params: withCommon([
    { name: "layout", what: "corner, or tee (the rail runs through)", kind: "choice", choices: ["corner", "tee"], default: "corner" },
    {
      name: "slot",
      what: "slot width (the rail's tongue thickness)",
      kind: "mm",
      min: 1,
      // the design rule bridle_thirds (Fairham): the thickness in thirds, to the millimetre, as before
      default: (r) => fractionOf("bridle_thirds", r.members[1][1], { what: "post" }).value,
      defaultText: "a third of the post's thickness",
      because: (r) => `slot ${fractionOf("bridle_thirds", r.members[1][1], { what: "post" }).value} mm: ${fractionOf("bridle_thirds", r.members[1][1], { what: "post" }).why}`,
    },
    { name: "rail_length", what: "length of rail shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[1][0]), defaultText: "four times the post's width, at least 300" },
    { name: "post_length", what: "length of post shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times the rail's width, at least 300" },
  ]),
  make(r) {
    const [[wA, tA], [wB, tB]] = r.members;
    const layout = r.choice<"corner" | "tee">("layout");
    const s = r.num("slot");
    const LA = r.num("rail_length"),
      LB = r.num("post_length");
    if (s >= tB) refuse("the slot is as wide as the post is thick");
    if (s >= tA) refuse("the slot is as wide as the rail is thick");
    if (wA >= LB) refuse("the rail is wider than the post is long");
    if (LA < wB + (layout === "tee" ? 40 : 10)) refuse("the rail is too short for that post");
    const zt = LB - wA;
    const xA = layout === "corner" ? 0 : wB / 2 - LA / 2;
    const xr0 = layout === "corner" ? -1 : 0; // the rail's cheeks: cut off at a corner, trenched for a tee
    const big = Math.max(tA, tB) / 2 + 1;
    return {
      parts: [
        { id: "post", name: "Post", material: r.material, grain: "z", stock: { type: "box", size: [wB, tB, LB], at: [0, -tB / 2, 0] }, cuts: [span([-1, -s / 2, zt], [wB + 1, s / 2, LB + 1])] },
        {
          id: "rail",
          name: "Rail",
          material: r.material,
          grain: "x",
          stock: { type: "box", size: [LA, tA, wA], at: [xA, -tA / 2, zt] },
          cuts: [span([xr0, -big, zt - 1], [wB, -s / 2, LB + 1]), span([xr0, s / 2, zt - 1], [wB, big, LB + 1])],
          apart: [0, 0, wA + 60],
          moves: true,
        },
      ],
      dims: [
        dim([wB + 20, -s / 2, LB + 15], [wB + 20, s / 2, LB + 15], { show: "apart" }),
        dim([xA + LA + 25, -tA / 2, zt], [xA + LA + 25, -tA / 2, LB], { part: "rail" }),
        dim([0, -tB / 2 - 25, -25], [wB, -tB / 2 - 25, -25]),
      ],
      note: `${layout === "corner" ? "Corner" : "Tee"} bridle, slot ${fmt(s)} wide.`,
    };
  },
};
