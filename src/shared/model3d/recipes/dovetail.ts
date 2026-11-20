// Through dovetail: tails on the end of one board, pins on the end of the other, at a corner. Both boards stand on
// edge (their width up the z axis). The pin board runs along x, the tail board along y; the tail shapes flare towards
// the tail board's end, so the joint can only go together, or come apart, across the tail board's face (along x).
import { type Recipe, dim, fmt, prism, quarterTurn, refuse, withCommon } from "./kit.js";
import { rule, ruleCite } from "../designRules.js";

type P2 = [number, number];

export const dovetail: Recipe = {
  name: "dovetail",
  what: "a through dovetail at a corner: tails on one board, pins on the other",
  members: [
    { name: "tail_board", what: "[width, thickness]", default: [140, 19] },
    { name: "pin_board", what: "[width, thickness] (the same width)", default: [140, 19] },
  ],
  params: withCommon([
    { name: "tails", what: "how many tails", kind: "count", min: 1, max: 12, default: 3 },
    // the design rule dovetail_slope (Fairham; Noyes): 1 in 8 is the usual, as before
    { name: "slope", what: "the tails' slope, 1 in this many", kind: "ratio", min: 4, max: 14, default: rule("dovetail_slope").value.prefer, because: () => `slope 1 in ${rule("dovetail_slope").value.prefer}: the usual dovetail slope (${ruleCite(rule("dovetail_slope"))}; the books run from about 1 in 5 to 1 in 8)` },
    { name: "pin", what: "the pins' width at their narrow end", kind: "mm", min: 1, default: (r) => Math.max(4, Math.round(0.4 * r.members[1][1])), defaultText: "four tenths of the pin board's thickness, at least 4" },
    { name: "tail_length", what: "length of tail board shown", kind: "mm", min: 20, max: 3000, default: (r) => Math.max(200, 1.5 * r.members[0][0]), defaultText: "one and a half times its width, at least 200" },
    { name: "pin_length", what: "length of pin board shown", kind: "mm", min: 20, max: 3000, default: (r) => Math.max(250, 2 * r.members[0][0]), defaultText: "twice its width, at least 250" },
  ]),
  make(r) {
    const [[W, tT], [WP, tP]] = r.members;
    const n = r.num("tails");
    const slope = r.num("slope");
    const p = r.num("pin");
    const LT = r.num("tail_length"),
      LP = r.num("pin_length");
    if (Math.abs(W - WP) > 0.01) refuse("both boards need to be the same width for a through dovetail at a corner");
    if (LT <= tP + 10 || LP <= tT + 10) refuse("the boards are too short for the joint");
    const s = tP / slope; // each side of a tail moves in this much from the end to the baseline
    const hp = p; // half pins at the edges: the same narrow width
    const tw = (W - 2 * hp - (n - 1) * p) / n; // a tail's width at the end of its board
    if (tw - 2 * s < 2) refuse(`${n} tails won't fit in ${fmt(W)} with pins ${fmt(p)} wide at a 1 in ${fmt(slope)} slope; use fewer tails or narrower pins`);
    const starts = Array.from({ length: n }, (_, i) => hp + i * (tw + p));
    // a tail's sides at depth y into the pin board (y = 0 at the tail board's end, tP at the baseline)
    const left = (z: number, y: number) => z + (s * y) / tP;
    const right = (z: number, y: number) => z + tw - (s * y) / tP;
    const tailShape = (z: number, y0: number, y1: number): P2[] => [
      [y0, left(z, y0)],
      [y0, right(z, y0)],
      [y1, right(z, y1)],
      [y1, left(z, y1)],
    ];
    // The tail board's cuts: the spaces between its tails (and the half pins at each edge), up to the baseline.
    const sockets: P2[][] = [];
    sockets.push([
      [-1, -1],
      [-1, left(starts[0], -1)],
      [tP, left(starts[0], tP)],
      [tP, -1],
    ]);
    for (let i = 0; i + 1 < n; i++)
      sockets.push([
        [-1, right(starts[i], -1)],
        [-1, left(starts[i + 1], -1)],
        [tP, left(starts[i + 1], tP)],
        [tP, right(starts[i], tP)],
      ]);
    sockets.push([
      [-1, right(starts[n - 1], -1)],
      [-1, W + 1],
      [tP, W + 1],
      [tP, right(starts[n - 1], tP)],
    ]);
    const tailCuts = sockets.map((pts) => prism("yz", pts.map(([y, z]) => [y, z] as P2), -1, tT + 2));
    // The pin board's cuts: a socket for each tail, right through its thickness, as deep as the tail board is thick.
    const pinCuts = starts.map((z) => prism("yz", tailShape(z, -1, tP + 1), -1, tT + 1));
    const out = tT + 50;
    return quarterTurn({
      parts: [
        { id: "pins", name: "Pin board", material: r.material, grain: "x", stock: { type: "box", size: [LP, tP, W] }, cuts: pinCuts },
        { id: "tails", name: "Tail board", material: r.material, grain: "y", stock: { type: "box", size: [tT, LT, W] }, cuts: tailCuts, apart: [-out, 0, 0], moves: true },
      ],
      dims: [
        dim([-25, 0, W + 20], [-25, tP, W + 20], { show: "apart" }),
        dim([0, -25, -20], [tT, -25, -20], { part: "tails", show: "apart" }),
        dim([LP + 25, -10, 0], [LP + 25, -10, W]),
        dim([-25, LT, 0], [-25, LT, W], { part: "tails", show: "together" }),
      ],
      note: `${n} tails at 1 in ${fmt(slope)}, pins ${fmt(p)} at their narrow end.`,
    });
  },
};

/** For checking by hand: the tails' total volume (each a trapezoid prism). */
export const tailVolume = (W: number, tT: number, tP: number, n: number, slope: number, p: number) => {
  const s = tP / slope;
  const tw = (W - 2 * p - (n - 1) * p) / n;
  return n * ((tw + (tw - 2 * s)) / 2) * tP * tT;
};
