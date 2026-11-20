// Tongue and groove: two boards edge to edge, a tongue on one fitting a groove in the other. Laid flat (thickness up
// z), side by side across y; the second board slides away across y.
import { type Recipe, dim, fmt, refuse, span, withCommon } from "./kit.js";

export const tongueGroove: Recipe = {
  name: "tongue_groove",
  what: "two boards edge to edge, a tongue on one fitting a groove in the other",
  members: [
    { name: "tongue_board", what: "[width, thickness]", default: [140, 19] },
    { name: "groove_board", what: "[width, thickness] (the same thickness)", default: [140, 19] },
  ],
  params: withCommon([
    { name: "tongue", what: "tongue thickness", kind: "mm", min: 1, default: (r) => Math.round(r.members[0][1] / 3), defaultText: "a third of the boards' thickness" },
    { name: "tongue_length", what: "how far the tongue stands out", kind: "mm", min: 1, default: (r) => Math.max(5, Math.round(r.members[0][1] / 3)), defaultText: "a third of the boards' thickness, at least 5" },
    { name: "length", what: "length of boards shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(400, 2.5 * r.members[0][0]), defaultText: "two and a half times their width, at least 400" },
  ]),
  make(r) {
    const [[WA, t], [WB, tB]] = r.members;
    const tt = r.num("tongue");
    const tl = r.num("tongue_length");
    const L = r.num("length");
    if (Math.abs(t - tB) > 0.01) refuse("both boards need to be the same thickness");
    if (tt >= t) refuse("the tongue is as thick as the boards, or thicker");
    if (tl >= WB / 2) refuse("the tongue is too long for the groove board's width");
    const z0 = (t - tt) / 2,
      z1 = z0 + tt;
    return {
      parts: [
        {
          id: "tongue",
          name: "Tongue board",
          material: r.material,
          grain: "x",
          stock: { type: "box", size: [L, WA + tl, t] },
          cuts: [span([-1, WA, -1], [L + 1, WA + tl + 1, z0]), span([-1, WA, z1], [L + 1, WA + tl + 1, t + 1])],
        },
        { id: "groove", name: "Groove board", material: r.material, grain: "x", stock: { type: "box", size: [L, WB, t], at: [0, WA, 0] }, cuts: [span([-1, WA - 1, z0], [L + 1, WA + tl, z1])], apart: [0, tl + 40, 0], moves: true },
      ],
      dims: [dim([-20, WA, z1 + 12], [-20, WA + tl, z1 + 12], { show: "apart" }), dim([-20, WA + tl + 6, z0], [-20, WA + tl + 6, z1], { show: "apart" }), dim([L + 25, 0, 0], [L + 25, WA, 0])],
      note: `Tongue ${fmt(tt)} thick, standing ${fmt(tl)} out.`,
    };
  },
};
