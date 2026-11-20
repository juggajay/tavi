// Housing: the end of a shelf (or a stud) let into a trench across a side (or plate). The side stands upright, its
// thickness along x; the shelf comes in from +x and slides out that way. A stopped housing ends short of the front edge.
import { type Recipe, dim, fmt, refuse, span, withCommon } from "./kit.js";

export const housing: Recipe = {
  name: "housing",
  what: "a shelf or stud end let into a trench across a side or plate (stopped short of the front if asked)",
  members: [
    { name: "side", what: "the one with the trench: [width, thickness]", default: [240, 19] },
    { name: "shelf", what: "the one let in: [width, thickness]", default: [220, 19] },
  ],
  params: withCommon([
    { name: "depth", what: "how deep the trench is", kind: "mm", min: 1, default: (r) => Math.round(r.members[0][1] / 3), defaultText: "a third of the side's thickness" },
    { name: "stop", what: "how far short of the front edge the trench stops (0: right through)", kind: "mm", min: 0, default: 0 },
    { name: "side_length", what: "length of side shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(400, 2 * r.members[0][0]), defaultText: "twice the side's width, at least 400" },
    { name: "shelf_length", what: "length of shelf shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 1.5 * r.members[1][0]), defaultText: "one and a half times the shelf's width, at least 300" },
  ]),
  make(r) {
    const [[ws, ts], [wsh, tsh]] = r.members;
    const depth = r.num("depth");
    const stop = r.num("stop");
    const H = r.num("side_length"),
      L = r.num("shelf_length");
    if (depth >= ts) refuse("the trench is as deep as the side is thick");
    if (wsh > ws) refuse("the shelf is wider than the side");
    if (tsh >= H) refuse("the shelf is thicker than the side is long");
    if (stop > 0 && stop >= wsh) refuse("the trench stops further back than the shelf is wide");
    const h0 = H / 2 - tsh / 2;
    const x0 = ts - depth;
    return {
      parts: [
        { id: "side", name: "Side", material: r.material, grain: "z", stock: { type: "box", size: [ts, ws, H] }, cuts: [span([x0, stop > 0 ? stop : -1, h0], [ts + 1, ws + 1, h0 + tsh])] },
        {
          id: "shelf",
          name: "Shelf",
          material: r.material,
          grain: "x",
          stock: { type: "box", size: [L, wsh, tsh], at: [x0, 0, h0] },
          ...(stop > 0 ? { cuts: [span([x0 - 1, -1, h0 - 1], [ts, stop, h0 + tsh + 1])] } : {}),
          apart: [depth + 60, 0, 0],
          moves: true,
        },
      ],
      dims: [
        dim([x0, -20, h0 + tsh + 25], [ts, -20, h0 + tsh + 25], { show: "apart" }),
        dim([x0 + L + 25, -10, h0], [x0 + L + 25, -10, h0 + tsh], { part: "shelf" }),
        dim([0, -25, H + 20], [ts, -25, H + 20]),
      ],
      note: `Trench ${fmt(depth)} deep${stop > 0 ? `, stopped ${fmt(stop)} from the front` : ", right through"}.`,
    };
  },
};
