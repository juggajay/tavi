// Box (finger) joint: square fingers on the ends of two boards interlock at a corner. Boards on edge, as the dovetail:
// the first runs along x, the second along y and comes away across its face (along x).
import { type Recipe, dim, fmt, quarterTurn, refuse, span, withCommon } from "./kit.js";

export const boxJoint: Recipe = {
  name: "box_joint",
  what: "square fingers on the ends of two boards interlocking at a corner",
  members: [
    { name: "first", what: "[width, thickness]", default: [140, 19] },
    { name: "second", what: "[width, thickness] (the same width)", default: [140, 19] },
  ],
  params: withCommon([
    { name: "finger", what: "finger width (evened out so the fingers fill the width)", kind: "mm", min: 3, default: (r) => r.members[0][1], defaultText: "the boards' thickness" },
    { name: "first_length", what: "length shown", kind: "mm", min: 20, max: 3000, default: (r) => Math.max(250, 2 * r.members[0][0]), defaultText: "twice the width, at least 250" },
    { name: "second_length", what: "length shown", kind: "mm", min: 20, max: 3000, default: (r) => Math.max(200, 1.5 * r.members[0][0]), defaultText: "one and a half times the width, at least 200" },
  ]),
  make(r) {
    const [[W, tA], [WB, tB]] = r.members;
    const want = r.num("finger");
    const LA = r.num("first_length"),
      LB = r.num("second_length");
    if (Math.abs(W - WB) > 0.01) refuse("both boards need to be the same width for a box joint");
    if (want > W / 2) refuse("the fingers are too wide: there'd be fewer than two");
    if (LA <= tB + 10 || LB <= tA + 10) refuse("the boards are too short for the joint");
    const N = Math.max(2, Math.round(W / want));
    const f = W / N;
    const cutsA = [],
      cutsB = [];
    for (let k = 0; k < N; k++) {
      const z0 = k === 0 ? -1 : k * f,
        z1 = k === N - 1 ? W + 1 : (k + 1) * f;
      if (k % 2) cutsA.push(span([-1, -1, z0], [tB, tA + 1, z1]));
      else cutsB.push(span([-1, -1, z0], [tB + 1, tA, z1]));
    }
    return quarterTurn({
      parts: [
        { id: "first", name: "First board", material: r.material, grain: "x", stock: { type: "box", size: [LA, tA, W] }, cuts: cutsA },
        { id: "second", name: "Second board", material: r.material, grain: "y", stock: { type: "box", size: [tB, LB, W] }, cuts: cutsB, apart: [-(tB + 50), 0, 0], moves: true },
      ],
      dims: [dim([tB + 20, -20, 0], [tB + 20, -20, f], { show: "apart" }), dim([LA + 25, -10, 0], [LA + 25, -10, W])],
      note: `${N} fingers, each ${fmt(f)} wide.`,
    });
  },
};
