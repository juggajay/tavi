// The test pieces for shop drawings (Stage 12.3): a mortise and tenon from its recipe, a four-legged table with rails
// tenoned into the legs, a cabinet carcass with housed top, bottom and fixed shelves and a back in rebates, and a pergola
// frame (posts slotted for the beams and bolted, rafters notched over the beams); a TV unit; and for Stage 19 a corner
// shelf, a frame-and-panel door and a spliced deck post (a bolted stop-splayed scarf, 19.8). Real, workable sizes; used
// by the tests, the pictures and the fake brain.
import type { ModelPart, ModelPayload, Solid, Vec3 } from "../protocol.js";
import { runRecipe } from "../model3d/recipes/index.js";

const box = (size: Vec3, at?: Vec3): Solid => ({ type: "box", size, ...(at ? { at } : {}) });
/** A box from its low corner to its high corner. */
const span = (a: Vec3, b: Vec3): Solid => box([b[0] - a[0], b[1] - a[1], b[2] - a[2]], a);

export function mortiseTenonPiece(): ModelPayload {
  const r = runRecipe("mortise_tenon", { members: [[90, 45], [90, 90]], material: "hardwood", params: { peg: true, peg_diameter: 10 } });
  if ("error" in r) throw new Error(r.error);
  return r.payload;
}

/**
 * A dining table 1500 × 800 × 750: a 30 top on four 70 × 70 legs, with 110 × 22 aprons set back 10 from the legs' outer
 * faces and tenoned into them (tenons 10 thick, 30 long, 10 shoulders top and bottom, flush with the leg tops). The four
 * legs are one part turned to each corner; each apron pair is one part turned end for end.
 */
export function tablePiece(o: { L?: number; D?: number; H?: number } = {}): ModelPayload {
  const L = o.L ?? 1500,
    D = o.D ?? 800,
    TOP = 30,
    LEG = 70,
    H = (o.H ?? 750) - TOP,
    inset = 40,
    set = 10,
    at = 22,
    aw = 110,
    tl = 30,
    tt = 10,
    sh = 10;
  const tz0 = H - aw + sh,
    tz1 = H - sh; // the tenon's height on the leg
  const t0 = set + (at - tt) / 2; // the tenon's face from the leg's outer face
  const leg: Omit<ModelPart, "id" | "name" | "at" | "rot" | "apart"> = {
    material: "hardwood",
    grain: "z",
    stock: box([LEG, LEG, H]),
    cuts: [
      // the long apron's mortise in the +x face, the short apron's in the +y face
      span([LEG - tl, t0, tz0], [LEG + 1, t0 + tt, tz1]),
      span([t0, LEG - tl, tz0], [t0 + tt, LEG + 1, tz1]),
    ],
  };
  const apronCuts = (len: number): Solid[] => {
    const ends: Solid[] = [];
    for (const [a, b] of [
      [-1, tl],
      [len - tl, len + 1],
    ]) {
      ends.push(span([a, -1, -1], [b, (at - tt) / 2, aw + 1]), span([a, (at + tt) / 2, -1], [b, at + 1, aw + 1]), span([a, -1, -1], [b, at + 1, sh]), span([a, -1, aw - sh], [b, at + 1, aw + 1]));
    }
    return ends;
  };
  const longLen = L - 2 * (inset + LEG) + 2 * tl,
    shortLen = D - 2 * (inset + LEG) + 2 * tl;
  const z0 = H - aw;
  const parts: ModelPart[] = [
    { id: "top", name: "Top", material: "hardwood", grain: "x", stock: box([L, D, TOP]), at: [0, 0, H], apart: [0, 0, 260] },
    { id: "leg-fl", name: "Front left leg", ...leg, at: [inset, inset, 0], apart: [-160, -160, 0] },
    { id: "leg-fr", name: "Front right leg", ...leg, rot: [0, 0, 90], at: [L - inset, inset, 0], apart: [160, -160, 0] },
    { id: "leg-br", name: "Back right leg", ...leg, rot: [0, 0, 180], at: [L - inset, D - inset, 0], apart: [160, 160, 0] },
    { id: "leg-bl", name: "Back left leg", ...leg, rot: [0, 0, 270], at: [inset, D - inset, 0], apart: [-160, 160, 0] },
    { id: "apron-f", name: "Front apron", material: "hardwood", grain: "x", stock: box([longLen, at, aw]), cuts: apronCuts(longLen), at: [inset + LEG - tl, inset + set, z0], apart: [0, -90, 0] },
    { id: "apron-b", name: "Back apron", material: "hardwood", grain: "x", stock: box([longLen, at, aw]), cuts: apronCuts(longLen), rot: [0, 0, 180], at: [L - inset - LEG + tl, D - inset - set, z0], apart: [0, 90, 0] },
    { id: "apron-l", name: "Left end apron", material: "hardwood", grain: "x", stock: box([shortLen, at, aw]), cuts: apronCuts(shortLen), rot: [0, 0, 90], at: [inset + set + at, inset + LEG - tl, z0], apart: [-90, 0, 0] },
    { id: "apron-r", name: "Right end apron", material: "hardwood", grain: "x", stock: box([shortLen, at, aw]), cuts: apronCuts(shortLen), rot: [0, 0, 270], at: [L - inset - set - at, D - inset - LEG + tl, z0], apart: [90, 0, 0] },
  ];
  return { parts, note: `${o.L || o.D || o.H ? "Table" : "Dining table"} ${L} x ${D} x ${H + TOP}. Aprons tenoned into the legs. Top fixings not shown.` };
}

/**
 * A cabinet carcass 600 wide, 720 high, 560 deep in 18 ply: two sides with housings 9 deep for the top, the bottom and
 * two fixed shelves, and a rebate 6 × 9 for a 6 ply back. The sides are a handed pair.
 */
export function cabinetPiece(): ModelPayload {
  const W = 600,
    H = 720,
    D = 560,
    t = 18,
    hd = 9,
    back = 6;
  const levels = [70, 300, 500, 684]; // underside of the bottom, the two shelves, the top
  const inner = W - 2 * t + 2 * hd; // panels run into the housings
  const pd = D - back; // panels stop at the back's rebate
  const sideCuts = (innerX: number, dir: 1 | -1): Solid[] => {
    const x0 = dir === 1 ? innerX - hd : innerX - 1,
      x1 = dir === 1 ? innerX + 1 : innerX + hd;
    return [...levels.map((z) => span([x0, -1, z], [x1, D + 1, z + t])), span([x0, D - back, -1], [x1, D + 1, H + 1])];
  };
  const panel = (id: string, name: string, z: number, apart: Vec3): ModelPart => ({ id, name, material: "ply", grain: "x", stock: box([inner, pd, t]), at: [t - hd, 0, z], apart });
  const parts: ModelPart[] = [
    // a side's own frame: 18 thick along x, 560 deep along y, 720 high; housings on the inner face
    { id: "side-l", name: "Left side", material: "ply", grain: "z", stock: box([t, D, H]), cuts: sideCuts(t, 1), at: [0, 0, 0], apart: [-260, 0, 0] },
    { id: "side-r", name: "Right side", material: "ply", grain: "z", stock: box([t, D, H]), cuts: sideCuts(0, -1), at: [W - t, 0, 0], apart: [260, 0, 0] },
    panel("bottom", "Bottom", levels[0], [0, -120, -60]),
    panel("shelf-1", "Shelf", levels[1], [0, -260, 0]),
    panel("shelf-2", "Shelf", levels[2], [0, -260, 0]),
    panel("top", "Top", levels[3], [0, -120, 120]),
    { id: "back", name: "Back", material: "ply", grain: "z", stock: box([W - 2 * hd, back, levels[3] + t - levels[0]]), at: [hd, D - back, levels[0]], apart: [0, 300, 0] },
  ];
  return { parts, note: "Carcass 600 x 720 x 560 in 18 ply, housed 9 deep, 6 ply back in rebates." };
}

/**
 * A pergola frame 3600 × 3000: four 90 × 90 posts 2400 high, slotted at the top for two 190 × 45 beams and bolted
 * through with two M12 bolts each, and five 140 × 45 rafters at 600 centres notched 20 over the beams.
 */
export function pergolaPiece(): ModelPayload {
  const P = 90,
    PH = 2400,
    BD = 190,
    BT = 45,
    BL = 3600,
    RD = 140,
    RT = 45,
    RL = 3000,
    notch = 20;
  const postX = [300, 3300],
    beamY = [300, 2700],
    boltZ = [PH - BD + 50, PH - 50];
  const post: Omit<ModelPart, "id" | "name" | "at" | "apart"> = {
    material: "pine",
    grain: "z",
    stock: box([P, P, PH]),
    cuts: [span([-1, (P - BT) / 2, PH - BD], [P + 1, (P + BT) / 2, PH + 1]), ...boltZ.map((z) => ({ type: "cyl" as const, r: 6, h: P + 2, axis: "y" as const, at: [P / 2, -1, z] as Vec3 }))],
  };
  const parts: ModelPart[] = [];
  let n = 0;
  for (const x of postX) for (const y of beamY) parts.push({ id: `post-${++n}`, name: `Post ${n}`, ...post, at: [x - P / 2, y - P / 2, 0] });
  beamY.forEach((y, i) =>
    parts.push({
      id: `beam-${i + 1}`,
      name: `Beam ${i + 1}`,
      material: "pine",
      grain: "x",
      stock: box([BL, BT, BD]),
      cuts: postX.flatMap((x) => boltZ.map((z) => ({ type: "cyl" as const, r: 6, h: BT + 2, axis: "y" as const, at: [x, -1, z - (PH - BD)] as Vec3 }))),
      at: [0, y - BT / 2, PH - BD],
      apart: [0, 0, 420],
    }),
  );
  const rafterX = [600, 1200, 1800, 2400, 3000];
  rafterX.forEach((x, i) =>
    parts.push({
      id: `rafter-${i + 1}`,
      name: `Rafter ${i + 1}`,
      material: "pine",
      grain: "y",
      stock: box([RT, RL, RD]),
      cuts: beamY.map((y) => span([-1, y - BT / 2, -1], [RT + 1, y + BT / 2, notch])),
      at: [x - RT / 2, 0, PH - notch],
      apart: [0, 0, 900],
    }),
  );
  let b = 0;
  for (const x of postX)
    for (const y of beamY)
      for (const z of boltZ) parts.push({ id: `bolt-${++b}`, name: `Bolt`, material: "steel", grain: "y", stock: { type: "cyl", r: 6, h: P, axis: "y", at: [0, 0, 0] }, at: [x, y - P / 2, z], apart: [0, y < 1500 ? -260 : 260, 420] });
  return { parts, note: "Pergola frame 3600 x 3000, posts 90 x 90, beams 190 x 45 in slotted post tops, rafters 140 x 45 at 600 centres." };
}

/**
 * A TV unit 1800 wide, 600 high, 450 deep in 18 veneered ply (12.10, a set big enough for a cover sheet): two ends with
 * housings 9 deep for the bottom and two shelves and a rebate for a 6 MDF back; a divider housed into the bottom, the
 * shelves against it; the top sitting on the ends; a kick set back 40 under the bottom; two overlay doors on hinge cups
 * below the shelves and a drawer above each (12 ply sides grooved for a 6 MDF bottom).
 */
export function tvUnitPiece(): ModelPayload {
  const W = 1800,
    D = 450,
    H = 600,
    t = 18,
    hd = 9,
    back = 6,
    kick = 80,
    shelfZ = 320,
    setBack = 40;
  const He = H - t; // the ends stop under the top
  const pd = D - back; // panels stop at the back's rebate
  const mid = W / 2;
  const endCuts = (innerX: number, dir: 1 | -1): Solid[] => {
    const x0 = dir === 1 ? innerX - hd : innerX - 1,
      x1 = dir === 1 ? innerX + 1 : innerX + hd;
    return [span([x0, -1, kick], [x1, D + 1, kick + t]), span([x0, -1, shelfZ], [x1, D + 1, shelfZ + t]), span([x0, D - back, -1], [x1, D + 1, He + 1])];
  };
  const bottomLen = W - 2 * t + 2 * hd;
  const shelfLen = mid - t / 2 - t + hd; // housed into the end, up to the divider
  const divH = He - (kick + t) + hd;
  const parts: ModelPart[] = [
    { id: "end-l", name: "Left end", material: "ply", grain: "z", stock: box([t, D, He]), cuts: endCuts(t, 1), at: [0, 0, 0], apart: [-320, 0, 0] },
    { id: "end-r", name: "Right end", material: "ply", grain: "z", stock: box([t, D, He]), cuts: endCuts(0, -1), at: [W - t, 0, 0], apart: [320, 0, 0] },
    { id: "top", name: "Top", material: "ply", grain: "x", stock: box([W, D, t]), at: [0, 0, He], apart: [0, 0, 260] },
    // the bottom: housed into the ends, a housing 9 deep on its top face for the divider
    { id: "bottom", name: "Bottom", material: "ply", grain: "x", stock: box([bottomLen, pd, t]), cuts: [span([mid - t / 2 - (t - hd), -1, t - hd], [mid + t / 2 - (t - hd), pd + 1, t + 1])], at: [t - hd, 0, kick], apart: [0, -160, -80] },
    // the divider: into the bottom's housing, under the top
    { id: "divider", name: "Divider", material: "ply", grain: "z", stock: box([t, pd, divH]), at: [mid - t / 2, 0, kick + t - hd], apart: [0, -220, 60] },
    { id: "shelf-l", name: "Left shelf", material: "ply", grain: "x", stock: box([shelfLen, pd, t]), at: [t - hd, 0, shelfZ], apart: [-120, -300, 0] },
    { id: "shelf-r", name: "Right shelf", material: "ply", grain: "x", stock: box([shelfLen, pd, t]), at: [mid + t / 2, 0, shelfZ], apart: [120, -300, 0] },
    { id: "back", name: "Back", material: "mdf", stock: box([W - 2 * hd, back, He - kick]), at: [hd, D - back, kick], apart: [0, 340, 0] },
    { id: "kick", name: "Kick", material: "ply", grain: "x", stock: box([W - 2 * t, t, kick]), at: [t, setBack, 0], apart: [0, -260, -60] },
  ];
  // two overlay doors to the lower bays, each with two 35 hinge cups 12 deep in its back face, 21.5 in from its hinge edge
  const dw = (W - 6) / 2,
    dh = shelfZ - kick - 5;
  const cups = (cx: number): Solid[] => [60, dh - 60].map((z) => ({ type: "cyl" as const, r: 17.5, h: 13, axis: "y" as const, at: [cx, t - 12, z] as Vec3 }));
  parts.push(
    { id: "door-l", name: "Left door", material: "ply", grain: "x", stock: box([dw, t, dh]), cuts: cups(21.5), at: [2, -t, kick], apart: [0, -650, -40] },
    { id: "door-r", name: "Right door", material: "ply", grain: "x", stock: box([dw, t, dh]), cuts: cups(dw - 21.5), at: [W - 2 - dw, -t, kick], apart: [0, -650, -40] },
  );
  // a drawer in each upper bay: an overlay front, 12 sides grooved 6 x 6 for a 6 MDF bottom, a 12 back on the bottom
  const fz = shelfZ + 5,
    fh = H - t - 2 - fz; // the front, up to 2 under the top
  const bw = mid - t / 2 - t - 26,
    bd = 400,
    bh = 150,
    st = 12,
    gz = 12; // the groove's underside, up from the box's bottom edge
  const bays = [t, mid + t / 2];
  bays.forEach((x0, k) => {
    const bx = x0 + 13,
      bz = shelfZ + t + 12;
    const side = (id: string, x: number, inner: 1 | -1): ModelPart => ({
      id,
      name: k ? "Right drawer side" : "Left drawer side",
      material: "ply",
      grain: "y",
      stock: box([st, bd, bh]),
      cuts: [span(inner === 1 ? [st - 6, -1, gz] : [-1, -1, gz], inner === 1 ? [st + 1, bd + 1, gz + 6] : [6, bd + 1, gz + 6])],
      at: [x, 0, bz],
      apart: [inner === 1 ? -140 : 140, -120, 560],
    });
    parts.push(
      { id: `dfront-${k}`, name: "Drawer front", material: "ply", grain: "x", stock: box([dw, t, fh]), at: [k ? W - 2 - dw : 2, -t, fz], apart: [0, -360, 720] },
      side(`dside-a${k}`, bx, 1),
      side(`dside-b${k}`, bx + bw - st, -1),
      { id: `dback-${k}`, name: "Drawer back", material: "ply", grain: "x", stock: box([bw - 2 * st, st, bh - gz - 6]), at: [bx + st, bd - st, bz + gz + 6], apart: [0, 140, 560] },
      { id: `dbottom-${k}`, name: "Drawer bottom", material: "mdf", stock: box([bw - 2 * st + 12, bd - st, 6]), at: [bx + st - 6, 0, bz + gz], apart: [0, -120, 460] },
    );
  });
  return { parts, note: "TV unit 1800 x 600 x 450 in 18 ply, housed 9 deep, 6 MDF back in rebates, kick set back 40, two doors on 35 cup hinges, two drawers." };
}

/**
 * A corner shelf unit (Stage 19.5, the kind of thing the owner draws): a 70 × 70 post 1500 high at the outside corner,
 * and at three levels two 190 × 32 shelf boards, one each way, lapped over each other at the corner (end laps, half
 * each) and housed 10 deep into two faces of the post. The boards' far ends sit on wall cleats (not shown).
 */
export function cornerShelfPiece(): ModelPayload {
  const P = 70,
    PH = 1500,
    st = 32,
    sw = 190,
    hd = 10,
    reach = 900; // from the post's outside corner to each board's far end
  const levels = [300, 750, 1200];
  const L = reach - (P - hd); // each board, from the housing's bottom
  const lap = sw - (P - hd); // the lapped square, beyond the housing's bottom
  const parts: ModelPart[] = [
    {
      id: "post",
      name: "Post",
      material: "hardwood",
      grain: "z",
      stock: box([P, P, PH]),
      cuts: levels.flatMap((z) => [span([P - hd, -1, z], [P + 1, P + 1, z + st]), span([-1, P - hd, z], [P + 1, P + 1, z + st])]),
    },
  ];
  levels.forEach((z, i) => {
    // one board runs along x (lapped from the top), the other along y (lapped from the bottom): the same board turned over
    parts.push(
      { id: `shelf-x${i + 1}`, name: "Shelf", material: "hardwood", grain: "x", stock: box([L, sw, st]), cuts: [span([-1, P - hd, st / 2], [lap, sw + 1, st + 1])], at: [P - hd, 0, z], apart: [260, 0, 0] },
      { id: `shelf-y${i + 1}`, name: "Shelf", material: "hardwood", grain: "x", stock: box([L, sw, st]), cuts: [span([-1, -1, -1], [lap, lap, st / 2])], rot: [0, 0, 90], at: [sw, P - hd, z], apart: [0, 260, 0] },
    );
  });
  return { parts, note: "Corner shelf unit, 70 x 70 post, three levels of 190 x 32 shelves lapped at the corner and housed 10 into the post. Far ends on wall cleats, not shown. Joints glued." };
}

/**
 * A frame-and-panel door 820 × 2040 × 40 (Stage 19.5, the hardest joinery here): stiles 115 wide, a top rail 110 and a
 * bottom rail 180, a mullion 100 wide; all grooved 12 wide and 15 deep on their inside edges for two 12 panels, which
 * float with 2 clear at the bottom of the grooves. Rails haunched-tenoned into the stiles (tenons 12 thick, 75 long, in
 * mortises 77 deep), the haunch filling the stile's groove to the end; the mullion stub-tenoned 30 into the rails.
 */
export function doorPiece(): ModelPayload {
  const W = 820,
    H = 2040,
    T = 40,
    sw = 115,
    trh = 110,
    brh = 180,
    mw = 100,
    g0 = 14,
    g1 = 26, // the groove, and every tenon, across the thickness
    gd = 15,
    tl = 75, // a rail's tenon
    md = 77; // its mortise
  const railL = W - 2 * sw + 2 * tl;
  const mid = W / 2;
  // a stile: groove its full length on its inner edge, a mortise for each rail (the right one is the left turned round)
  const stile: Omit<ModelPart, "id" | "name" | "at" | "rot"> = {
    material: "hardwood",
    grain: "z",
    stock: box([sw, T, H]),
    cuts: [span([sw - gd, g0, -1], [sw + 1, g1, H + 1]), span([sw - md, g0, H - trh + gd], [sw + 1, g1, H - 35]), span([sw - md, g0, 75], [sw + 1, g1, brh - gd])],
  };
  // a rail's ends: cheeks off both faces, and beyond the haunch the shoulder (on the outer edge side)
  const railEnds = (h: number, top: boolean): Solid[] => {
    const out: Solid[] = [];
    for (const [a, b, ha, hb] of [
      [-1, tl, -1, tl - gd],
      [railL - tl, railL + 1, railL - tl + gd, railL + 1],
    ])
      out.push(span([a, -1, -1], [b, g0, h + 1]), span([a, g1, -1], [b, T + 1, h + 1]), top ? span([ha, g0 - 1, 75], [hb, g1 + 1, h + 1]) : span([ha, g0 - 1, -1], [hb, g1 + 1, 75]));
    return out;
  };
  const mort = (z0: number, z1: number) => span([mid - 35 - (sw - tl), g0, z0], [mid + 35 - (sw - tl), g1, z1]);
  const parts: ModelPart[] = [
    { id: "stile-l", name: "Left stile", ...stile, at: [0, 0, 0], apart: [-180, 0, 0] },
    { id: "stile-r", name: "Right stile", ...stile, rot: [0, 0, 180], at: [W, T, 0], apart: [180, 0, 0] },
    {
      id: "rail-t",
      name: "Top rail",
      material: "hardwood",
      grain: "x",
      stock: box([railL, T, trh]),
      // groove on its bottom edge, tenons and haunches each end, a mortise for the mullion
      cuts: [span([-1, g0, -1], [railL + 1, g1, gd]), ...railEnds(trh, true), mort(-1, 32)],
      at: [sw - tl, 0, H - trh],
      apart: [0, 0, 260],
    },
    {
      id: "rail-b",
      name: "Bottom rail",
      material: "hardwood",
      grain: "x",
      stock: box([railL, T, brh]),
      cuts: [span([-1, g0, brh - gd], [railL + 1, g1, brh + 1]), ...railEnds(brh, false), mort(brh - 32, brh + 1)],
      at: [sw - tl, 0, 0],
      apart: [0, 0, -260],
    },
    {
      id: "mullion",
      name: "Mullion",
      material: "hardwood",
      grain: "z",
      // between the rails, a 30 stub tenon each end into a 32 mortise
      stock: box([mw, T, H - trh - brh + 60]),
      cuts: (() => {
        const L = H - trh - brh + 60;
        return [span([-1, g0, -1], [gd, g1, L + 1]), span([mw - gd, g0, -1], [mw + 1, g1, L + 1]), span([-1, -1, -1], [mw + 1, g0, 30]), span([-1, g1, -1], [mw + 1, T + 1, 30]), span([-1, -1, L - 30], [mw + 1, g0, L + 1]), span([-1, g1, L - 30], [mw + 1, T + 1, L + 1])];
      })(),
      at: [mid - mw / 2, 0, brh - 30],
      apart: [0, 0, 0],
    },
  ];
  // the panels, 12 thick, 13 into each groove (2 clear)
  const pw = mid - mw / 2 + gd - 2 - (sw - gd + 2),
    ph = H - trh + gd - 2 - (brh - gd + 2);
  parts.push(
    { id: "panel-l", name: "Left panel", material: "hardwood", grain: "z", stock: box([pw, g1 - g0, ph]), at: [sw - gd + 2, g0, brh - gd + 2], apart: [0, -420, 0] },
    { id: "panel-r", name: "Right panel", material: "hardwood", grain: "z", stock: box([pw, g1 - g0, ph]), at: [mid + mw / 2 - gd + 2, g0, brh - gd + 2], apart: [0, -420, 0] },
  );
  return { parts, note: "Frame-and-panel door 820 x 2040 x 40. Rails haunched-tenoned into the stiles, mullion stub-tenoned into the rails, frame joints glued. Panels float in 12 x 15 grooves, 2 clear." };
}

/**
 * A spliced deck post (Stage 19.8): two 90 × 90 lengths joined by a stop-splayed scarf from its recipe, 360 long with
 * 23 nibs and three M12 bolts square across it, stood up (the recipe lies along x; turned so the post is upright).
 */
export function scarfPostPiece(): ModelPayload {
  const r = runRecipe("scarf", { members: [[90, 90], [90, 90]], material: "hardwood", params: { kind: "stop_splayed", bolts: 3, first_length: 900, second_length: 600 } });
  if ("error" in r) throw new Error(r.error);
  // x along the post becomes z, up; the recipe's z (the depth across the splice) becomes -x
  const up = (p: Vec3): Vec3 => [-p[2], p[1], p[0]];
  const names: Record<string, string> = { first: "Lower post", second: "Upper post" };
  return {
    ...r.payload,
    parts: r.payload.parts.map((p) => ({ ...p, name: names[p.id] ?? p.name, rot: [0, -90, 0], at: up(p.at ?? [0, 0, 0]), ...(p.apart ? { apart: up(p.apart) } : {}) })),
    ...(r.payload.dims ? { dims: r.payload.dims.map((d) => ({ ...d, a: up(d.a), b: up(d.b) })) } : {}),
  };
}

export const TEST_PIECES = [
  { id: "mt", title: "Mortise and tenon, 90 x 45 rail into 90 x 90 post", project: "Joint samples", client: "Example Club", payload: mortiseTenonPiece(), materials: { hardwood: "Tas oak, DAR", oak: "Oak dowel" }, finish: "Danish oil" },
  { id: "table", title: "Dining table 1500 x 800", project: "Household table", client: "N. Venn", payload: tablePiece(), materials: { all: "Tas oak, DAR" }, finish: "2 coats clear satin" },
  { id: "cabinet", title: "Cabinet carcass 600 wide", project: "Household cabinet", client: "N. Venn", payload: cabinetPiece(), materials: { back: "6 MDF, white", all: "18 HMR melamine, white" }, finish: "1 mm white ABS edging to exposed edges" },
  { id: "pergola", title: "Pergola frame 3600 x 3000", project: "Household garden", client: "N. Venn", payload: pergolaPiece(), materials: { pine: "MGP10 H3 pine", steel: "M12 galv bolt, nut and washers" }, finish: "2 coats exterior stain" },
  { id: "tv", title: "TV unit 1800 wide", project: "Club room", client: "R. Pell", payload: tvUnitPiece(), materials: { mdf: "6 MDF, black", all: "18 ply, American oak veneer" }, finish: "2 coats clear satin" },
  { id: "corner", title: "Corner shelf unit 900 x 900", project: "Household shelves", client: "R. Pell", payload: cornerShelfPiece(), materials: { all: "Spotted gum, DAR" }, finish: "Decking oil" },
  { id: "door", title: "Frame-and-panel door 820 x 2040", project: "Household door", client: "R. Pell", payload: doorPiece(), materials: { panel: "Western red cedar, DAR", all: "Vic ash, DAR" }, finish: "Primer and 2 coats enamel" },
  { id: "scarf", title: "Deck post splice 90 x 90", project: "Garden repair", client: "R. Pell", payload: scarfPostPiece(), materials: { steel: "M12 galv bolts, nuts and washers", all: "Spotted gum, DAR" }, finish: "Decking oil" },
] as const;
