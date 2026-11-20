// Mitre: two members cut at an angle each so they meet in a corner (45° each makes a square corner). Frame in the x-z
// plane: the first member runs along x, the second rises from the same outside corner.
import type { Vec3 } from "../../protocol.js";
import { apply, invert, xf } from "../math.js";
import { type Recipe, dim, fmt, refuse, sideCut, withCommon } from "./kit.js";

export const mitre: Recipe = {
  name: "mitre",
  what: "two members each cut at an angle to meet in a corner (45° each makes a square corner)",
  members: [
    { name: "first", what: "[width, thickness]", default: [90, 45] },
    { name: "second", what: "[width, thickness]", default: [90, 45] },
  ],
  params: withCommon([
    { name: "angle", what: "the cut on each piece, in degrees (the corner is twice this)", kind: "deg", min: 15, max: 75, default: 45 },
    { name: "first_length", what: "length shown, along its outside edge", kind: "mm", min: 50, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times its width, at least 300" },
    { name: "second_length", what: "length shown, along its outside edge", kind: "mm", min: 50, max: 6000, default: (r) => Math.max(300, 4 * r.members[1][0]), defaultText: "four times its width, at least 300" },
  ]),
  make(r) {
    const [[wA, tA], [wB, tB]] = r.members;
    const a = r.num("angle");
    const LA = r.num("first_length"),
      LB = r.num("second_length");
    const phi = (2 * a * Math.PI) / 180;
    const d: [number, number] = [Math.cos(phi), Math.sin(phi)];
    const nB: [number, number] = [Math.sin(phi), -Math.cos(phi)]; // the second member's inside, from its outside edge
    // inside corner: on the first's inside edge (z = wA) and the second's inside edge
    const s = (wA + wB * Math.cos(phi)) / Math.sin(phi);
    const I: [number, number] = [s * d[0] + wB * nB[0], s * d[1] + wB * nB[1]];
    if (I[0] > LA - 1 || s > LB - 1) refuse("the pieces are too short for that mitre");
    const reach = LA + LB + wA + wB;
    const t = Math.max(tA, tB) / 2 + 1;
    // the second piece is made along x in its own frame and turned up into place
    const rot: Vec3 = [0, -2 * a, 0];
    const own = invert(xf(rot));
    const toOwn = (p: [number, number]): [number, number] => {
      const q = apply(own, [p[0], 0, p[1]]);
      return [q[0], q[2]];
    };
    const ml = Math.hypot(I[0], I[1]);
    const n: [number, number] = [-I[1] / ml, I[0] / ml]; // normal to the mitre, towards the second piece
    return {
      parts: [
        { id: "first", name: "First piece", material: r.material, grain: "x", stock: { type: "box", size: [LA, tA, wA], at: [0, -tA / 2, 0] }, cuts: [sideCut("xz", [0, 0], I, [d[0] * LB, d[1] * LB], reach, -t, 2 * t)] },
        {
          id: "second",
          name: "Second piece",
          material: r.material,
          grain: "x",
          rot,
          stock: { type: "box", size: [LB, tB, wB], at: [0, -tB / 2, -wB] },
          cuts: [sideCut("xz", toOwn([0, 0]), toOwn(I), toOwn([LA, wA / 2]), reach, -t, 2 * t)],
          apart: [Math.round(n[0] * 60 * 10) / 10, 0, Math.round(n[1] * 60 * 10) / 10],
          moves: true,
        },
      ],
      dims: [
        dim([LA + 30, -t, 0], [LA + 30, -t, wA]),
        dim([d[0] * LB + nB[0] * wB + d[0] * 30, -t, d[1] * LB + nB[1] * wB + d[1] * 30], [d[0] * LB + d[0] * 30, -t, d[1] * LB + d[1] * 30], { part: "second" }),
      ],
      note: `Each piece cut at ${fmt(a)}°, making a ${fmt(2 * a)}° corner.`,
    };
  },
};
