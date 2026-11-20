// Birdsmouth: a rafter notched to sit on a top plate, the seat cut level on the plate and the plumb cut against its
// outside face. The rise of the notch and the rafter's plumb depth come from the Stage 8 roof maths (roofGeometry), so
// they agree with the figures the calculator gives. The plate runs along y; the rafter rises towards +x (inwards) in
// the x-z plane and overhangs outwards; it is built along x in its own frame and tipped up to the pitch.
import type { Vec3 } from "../../protocol.js";
import { roofGeometry } from "../../../calc/geometry.js";
import { type Recipe, dim, fmt, prism, refuse, sideCut, withCommon } from "./kit.js";

type P2 = [number, number];

export const birdsmouth: Recipe = {
  name: "birdsmouth",
  what: "a rafter notched to sit on a top plate: a level seat cut on the plate and a plumb cut against its outside face",
  members: [
    { name: "rafter", what: "[depth, thickness]", default: [140, 45] },
    { name: "plate", what: "[width, thickness] (lying flat)", default: [90, 45] },
  ],
  params: withCommon([
    { name: "pitch", what: "roof pitch in degrees", kind: "deg", min: 5, max: 60, default: 22.5 },
    { name: "seat", what: "seat cut, measured level along the plate", kind: "mm", min: 1, default: (r) => r.members[1][0], defaultText: "the plate's width" },
    { name: "plumb_cut", what: "the notch's depth at the plumb cut (give this or the seat, not both)", kind: "mm", min: 1 },
    { name: "overhang", what: "how far the rafter runs past the plate, measured level", kind: "mm", min: 0, max: 3000, default: 300 },
    { name: "rafter_run", what: "how far the rafter is shown inside the plate, measured level", kind: "mm", min: 100, max: 6000, default: 700 },
    { name: "plate_length", what: "length of plate shown", kind: "mm", min: 50, max: 6000, default: (r) => Math.max(400, 4 * r.members[0][1]), defaultText: "four times the rafter's thickness, at least 400" },
  ]),
  make(r) {
    const [[D, rt], [pw, pt]] = r.members;
    const pitch = r.num("pitch");
    const th = (pitch * Math.PI) / 180;
    const plumbGiven = r.maybe("plumb_cut");
    if (plumbGiven !== undefined && r.has("seat")) refuse("give the seat or the plumb cut, not both: one follows from the other at a given pitch");
    const S = plumbGiven !== undefined ? plumbGiven / Math.tan(th) : r.num("seat");
    if (plumbGiven !== undefined) r.used.seat = Math.round(S * 10) / 10;
    const oh = r.num("overhang");
    const run = r.num("rafter_run");
    const PL = r.num("plate_length");
    if (S > pw + 1e-6) refuse(`a ${fmt(S)} seat is wider than the ${fmt(pw)} plate`);
    // The Stage 8 maths: over a run equal to the seat, the rise is the notch's plumb cut; the rafter's plumb depth too.
    const g = roofGeometry({ run_mm: S, pitch_deg: pitch, rafter_depth_mm: D });
    const notch = S * Math.tan(th); // = g.rise_mm, unrounded
    const plumbDepth = Number(g.plumb_depth_mm);
    if (notch >= D / Math.cos(th) - 1) refuse(`the birdsmouth would cut right through the rafter: the notch is ${fmt(notch)} deep plumb, the rafter ${fmt(plumbDepth)}`);
    if (rt >= PL) refuse("the plate shown is shorter than the rafter is thick");
    const cos = Math.cos(th),
      sin = Math.sin(th);
    // own (x', z') → model: x = S + x' cos − z' sin, z = x' sin + z' cos (the underside is z' = 0)
    const toOwn = (x: number, z: number): P2 => [(x - S) * cos + z * sin, -(x - S) * sin + z * cos];
    const xa = (x: number) => (x - S) / cos; // where the underside is at model x
    const x0 = xa(-oh) - 2,
      x1 = xa(pw + run) + D * Math.tan(th) + 2;
    const y0 = -rt / 2 - 1,
      depthY = rt + 2;
    const reach = (x1 - x0) + D + 100;
    // the notch: the heel C (plumb meets seat), the underside at the plumb cut A, the end of the seat B
    const A = toOwn(0, -notch),
      C = toOwn(0, 0),
      B = toOwn(S, 0);
    const past = (from: P2, to: P2): P2 => {
      // carry the line from→to on to just below the underside, so the cut doesn't end exactly on a face
      const t = (-1 - from[1]) / (to[1] - from[1]);
      return [from[0] + (to[0] - from[0]) * t, -1];
    };
    const notchCut = prism("xz", [C, past(C, B), past(C, A)], y0, depthY);
    const tail = sideCut("xz", toOwn(-oh, 0), toOwn(-oh, 100), toOwn(-oh - 100, 0), reach, y0, depthY);
    const top = sideCut("xz", toOwn(pw + run, 0), toOwn(pw + run, 100), toOwn(pw + run + 100, 0), reach, y0, depthY);
    const front = -rt / 2 - 20;
    const underAt = (x: number) => Math.tan(th) * (x - S);
    const rot: Vec3 = [0, -pitch, 0];
    return {
      parts: [
        { id: "plate", name: "Top plate", material: r.material, grain: "y", stock: { type: "box", size: [pw, PL, pt], at: [0, -PL / 2, -pt] } },
        {
          id: "rafter",
          name: "Rafter",
          material: r.material,
          grain: "x",
          rot,
          at: [S, 0, 0],
          stock: { type: "box", size: [x1 - x0, rt, D], at: [x0, -rt / 2, 0] },
          cuts: [notchCut, tail, top],
          apart: [0, 0, 90],
          moves: true,
        },
      ],
      dims: [
        dim([0, front, 0], [S, front, 0], { part: "rafter", show: "apart" }),
        dim([-14, front, -notch], [-14, front, 0], { part: "rafter", show: "apart" }),
        dim([-oh - 25, front, underAt(-oh)], [-oh - 25, front, underAt(-oh) + plumbDepth], { part: "rafter" }),
        dim([-oh, front, -pt - 35], [0, front, -pt - 35], { show: "together" }),
        dim([0, -PL / 2 - 20, -pt - 20], [pw, -PL / 2 - 20, -pt - 20]),
      ],
      note: `${fmt(pitch)}° pitch: seat ${fmt(S)} on the plate, ${fmt(notch)} deep at the plumb cut.`,
    };
  },
};
