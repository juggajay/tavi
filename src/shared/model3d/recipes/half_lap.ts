// Half lap: each member has half its thickness taken away where they cross, so they sit flush. Laid flat (thickness
// up the z axis): the first runs along x, the second along y and lifts off upwards when pulled apart.
import { type Recipe, dim, fmt, refuse, span, withCommon } from "./kit.js";
import { fractionOf } from "../designRules.js";

export const halfLap: Recipe = {
  name: "half_lap",
  what: "each member halved where they cross so they sit flush: at a corner, a tee or a cross",
  members: [
    { name: "first", what: "the one cut on top: [width, thickness]", default: [90, 45] },
    { name: "second", what: "the one cut underneath: [width, thickness]", default: [90, 45] },
  ],
  params: withCommon([
    { name: "layout", what: "corner, tee (the second's end over the middle of the first) or cross", kind: "choice", choices: ["corner", "tee", "cross"], default: "corner" },
    {
      name: "depth",
      what: "how deep the first is cut (the second takes the rest so the tops are flush)",
      kind: "mm",
      min: 1,
      // the design rule halving_half (Fairham; Noyes): exactly half, not rounded, as before
      default: (r) => fractionOf("halving_half", r.members[0][1], { round: false, what: "first member" }).value,
      defaultText: "half the first's thickness",
      because: (r) => `cut ${fmt(fractionOf("halving_half", r.members[0][1], { round: false }).value)} mm deep: ${fractionOf("halving_half", r.members[0][1], { round: false, what: "first member" }).why}`,
    },
    { name: "first_length", what: "length shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[1][0]), defaultText: "four times the second's width, at least 300" },
    { name: "second_length", what: "length shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times the first's width, at least 300" },
  ]),
  make(r) {
    const [[wA, tA], [wB, tB]] = r.members;
    const layout = r.choice<"corner" | "tee" | "cross">("layout");
    const dA = r.num("depth");
    const LA = r.num("first_length"),
      LB = r.num("second_length");
    if (dA >= tA) refuse("the lap is as deep as the first member is thick");
    const dB = tB - dA;
    if (dB <= 0) refuse("the lap is deeper than the second member is thick");
    if (layout !== "corner" && LA < wB + 20) refuse("the first member is too short for the second to cross it");
    if (layout === "cross" && LB < wA + 20) refuse("the second member is too short to cross the first");
    const zB = tA - tB; // tops flush
    const floor = tA - dA; // where the two meet
    const xc = layout === "corner" ? wB / 2 : LA / 2;
    const x0 = xc - wB / 2,
      x1 = xc + wB / 2;
    const y0 = layout === "cross" ? wA / 2 - LB / 2 : 0;
    const cutA = layout === "corner" ? span([-1, -1, floor], [x1, wA + 1, tA + 1]) : span([x0, -1, floor], [x1, wA + 1, tA + 1]);
    const cutB = span([x0 - 1, layout === "cross" ? 0 : -1, zB - 1], [x1 + 1, wA, floor]);
    const lift = Math.max(tA, tB) + 50;
    return {
      parts: [
        { id: "first", name: "First member", material: r.material, grain: "x", stock: { type: "box", size: [LA, wA, tA], at: [0, 0, 0] }, cuts: [cutA] },
        { id: "second", name: "Second member", material: r.material, grain: "y", stock: { type: "box", size: [wB, LB, tB], at: [x0, y0, zB] }, cuts: [cutB], apart: [0, 0, lift], moves: true },
      ],
      dims: [
        dim([x1 + 15, -20, floor], [x1 + 15, -20, tA], { show: "apart" }),
        dim([x0, -30, tA + 20], [x1, -30, tA + 20], { part: "second", show: "together" }),
        dim([LA + 30, 0, 0], [LA + 30, wA, 0]),
      ],
      note: `Cut ${fmt(dA)} deep on the first and ${fmt(dB)} on the second, tops flush.`,
    };
  },
};
