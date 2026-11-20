// Dowelled butt: a rail's end against a post's face with dowels across the joint. Frame in the x-z plane: the post's
// face at x = 0, the rail comes in from +x; dowels run along x, spread up the rail's width.
import type { Vec3 } from "../../protocol.js";
import { type Recipe, dim, fmt, refuse, withCommon } from "./kit.js";

export const dowel: Recipe = {
  name: "dowel",
  what: "a rail's end against a post with dowels across the joint",
  members: [
    { name: "rail", what: "[width, thickness]", default: [90, 45] },
    { name: "post", what: "[width (the way the dowels go in), thickness]", default: [90, 45] },
  ],
  params: withCommon([
    { name: "count", what: "how many dowels", kind: "count", min: 1, max: 8, default: 2 },
    { name: "diameter", what: "dowel diameter", kind: "mm", min: 3, max: 40, default: (r) => (r.members[0][1] < 30 ? 8 : 10), defaultText: "10 (8 for a rail under 30 thick)" },
    { name: "depth", what: "how far each dowel goes into each member", kind: "mm", min: 3, default: (r) => Math.min(30, Math.round(0.6 * r.members[1][0])), defaultText: "30, or six tenths of the post's width if less" },
    { name: "rail_length", what: "length of rail shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times its width, at least 300" },
    { name: "post_length", what: "length of post shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(400, 4 * r.members[0][0]), defaultText: "four times the rail's width, at least 400" },
  ]),
  make(r) {
    const [[rw, rt], [pw, pt]] = r.members;
    const n = r.num("count");
    const d = r.num("diameter");
    const depth = r.num("depth");
    const RL = r.num("rail_length"),
      PL = r.num("post_length");
    if (d >= rt) refuse("the dowels are as thick as the rail, or thicker");
    if (d >= pt) refuse("the dowels are as thick as the post, or thicker");
    if (depth >= pw) refuse("the dowels would come out the far side of the post");
    if (depth >= RL) refuse("the dowels are longer than the rail shown");
    const pitch = rw / (n + 1);
    if (pitch < d + 3) refuse(`${n} dowels of ${fmt(d)} won't fit across a ${fmt(rw)} rail`);
    if (rw > PL) refuse("the rail is wider than the post is long");
    const z0 = PL / 2 - rw / 2;
    const zs = Array.from({ length: n }, (_, k) => z0 + pitch * (k + 1));
    const rr = d / 2;
    const at = (x: number, z: number): Vec3 => [x, 0, z];
    return {
      parts: [
        { id: "post", name: "Post", material: r.material, grain: "z", stock: { type: "box", size: [pw, pt, PL], at: [-pw, -pt / 2, 0] }, cuts: zs.map((z) => ({ type: "cyl" as const, r: rr, h: depth + 1, axis: "x" as const, at: at(-depth, z) })) },
        {
          id: "rail",
          name: "Rail",
          material: r.material,
          grain: "x",
          stock: { type: "box", size: [RL, rt, rw], at: [0, -rt / 2, z0] },
          cuts: zs.map((z) => ({ type: "cyl" as const, r: rr, h: depth + 1, axis: "x" as const, at: at(-1, z) })),
          apart: [2 * depth + 80, 0, 0],
          moves: true,
        },
        ...zs.map((z, k) => ({ id: `dowel${k + 1}`, name: `Dowel ${k + 1}`, material: "hardwood" as const, grain: "x" as const, stock: { type: "cyl" as const, r: rr, h: 2 * depth, axis: "x" as const, at: at(-depth, z) }, apart: [depth + 40, 0, 0] as Vec3 })),
      ],
      dims: [
        dim([depth + 40 - depth, -rr - 12, zs[n - 1] + rr + 12], [depth + 40 + depth, -rr - 12, zs[n - 1] + rr + 12], { show: "apart" }),
        dim([RL + 30, -rt / 2, z0], [RL + 30, -rt / 2, z0 + rw], { part: "rail" }),
      ],
      note: `${n} dowels, ${fmt(d)} across, ${fmt(depth)} into each side.`,
    };
  },
};
