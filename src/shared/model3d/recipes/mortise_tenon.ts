// Mortise and tenon: a rail's tenon into a mortise in a post, blind or right through, with an optional peg. Frame in
// the x-z plane: the post stands with its face at x = 0, the rail comes in from +x and slides out that way. The rail
// stands on edge: its width is its height.
import { type Recipe, dim, fmt, refuse, span, withCommon } from "./kit.js";
import { fractionOf } from "../designRules.js";

export const mortiseTenon: Recipe = {
  name: "mortise_tenon",
  what: "a rail's tenon into a mortise in a post, blind or right through, optionally pegged",
  members: [
    { name: "rail", what: "the one with the tenon: [width, thickness]", default: [90, 45] },
    { name: "post", what: "the one with the mortise: [width (the way the tenon goes in), thickness (the face it goes into)]", default: [90, 90] },
  ],
  params: withCommon([
    { name: "type", what: "blind (stops inside the post) or through", kind: "choice", choices: ["blind", "through"], default: "blind" },
    {
      name: "tenon",
      what: "tenon thickness",
      kind: "mm",
      min: 1,
      // the design rule tenon_third (Fairham; Noyes): a third of the rail, to the millimetre, as before
      default: (r) => fractionOf("tenon_third", r.members[0][1], { what: "rail" }).value,
      defaultText: "a third of the rail's thickness",
      because: (r) => `tenon ${fractionOf("tenon_third", r.members[0][1], { what: "rail" }).value} mm: ${fractionOf("tenon_third", r.members[0][1], { what: "rail" }).why}`,
    },
    {
      name: "length",
      what: "how far the tenon goes in (through: the post's width)",
      kind: "mm",
      min: 1,
      default: (r) => (r.used.type === "through" ? r.members[1][0] : Math.round((2 * r.members[1][0]) / 3)),
      defaultText: "two thirds of the post's width (through: all of it)",
    },
    { name: "shoulder", what: "shoulder above and below the tenon", kind: "mm", min: 0, default: (r) => Math.max(5, Math.round(r.members[0][0] / 9)), defaultText: "a ninth of the rail's width, at least 5" },
    { name: "peg", what: "a peg across through the post and tenon", kind: "bool", default: false },
    { name: "peg_diameter", what: "the peg's diameter", kind: "mm", min: 3, max: 40, default: 10 },
    { name: "rail_length", what: "length of rail shown outside the post", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(300, 4 * r.members[0][0]), defaultText: "four times the rail's width, at least 300" },
    { name: "post_length", what: "length of post shown", kind: "mm", min: 20, max: 6000, default: (r) => Math.max(500, 5 * r.members[0][0]), defaultText: "five times the rail's width, at least 500" },
  ]),
  make(r) {
    const [[rw, rt], [pw, pt]] = r.members;
    const type = r.choice<"blind" | "through">("type");
    const tt = r.num("tenon");
    const sh = r.num("shoulder");
    const len = r.num("length");
    const peg = r.bool("peg");
    const pd = peg ? r.num("peg_diameter") : 0;
    const RL = r.num("rail_length"),
      PL = r.num("post_length");
    const gap = r.num("fit_gap");
    if (tt >= rt) refuse("the tenon is as thick as the rail, or thicker");
    if (rt > pt) refuse("the rail is thicker than the post's face is wide");
    if (tt >= pt) refuse("the mortise would be as wide as the post");
    const th = rw - 2 * sh;
    if (th <= 0) refuse("the shoulders leave no tenon (they take the rail's whole width)");
    if (type === "blind" && len >= pw) refuse("a blind tenon that long would come out the far side of the post; make it through, or shorter");
    if (type === "through" && len !== pw) refuse(`a through tenon goes right through the post, which is ${fmt(pw)} wide`);
    if (rw > PL) refuse("the rail is wider than the post is long");
    if (peg && (pd >= th || pd >= len)) refuse("the peg is too big for the tenon");
    if (peg && gap > 0) refuse("a gap can't be shown with the peg in; leave the peg out, or the gap at 0");
    const z0 = PL / 2 - rw / 2;
    const zt0 = z0 + sh,
      zt1 = z0 + rw - sh;
    const back = type === "through" ? -pw - 1 : -len;
    const pegX = -len / 2,
      pegZ = (zt0 + zt1) / 2;
    const front = -pt / 2;
    return {
      parts: [
        {
          id: "post",
          name: "Post",
          material: r.material,
          grain: "z",
          stock: { type: "box", size: [pw, pt, PL], at: [-pw, -pt / 2, 0] },
          cuts: [span([back, -tt / 2, zt0], [1, tt / 2, zt1]), ...(peg ? [{ type: "cyl" as const, r: pd / 2, h: pt + 2, axis: "y" as const, at: [pegX, -pt / 2 - 1, pegZ] as [number, number, number] }] : [])],
        },
        {
          id: "rail",
          name: "Rail",
          material: r.material,
          grain: "x",
          stock: { type: "box", size: [RL + len, rt, rw], at: [-len, -rt / 2, z0] },
          cuts: [
            span([-len - 1, -rt / 2 - 1, z0 - 1], [0, -tt / 2, z0 + rw + 1]),
            span([-len - 1, tt / 2, z0 - 1], [0, rt / 2 + 1, z0 + rw + 1]),
            span([-len - 1, -rt / 2 - 1, z0 - 1], [0, rt / 2 + 1, zt0]),
            span([-len - 1, -rt / 2 - 1, zt1], [0, rt / 2 + 1, z0 + rw + 1]),
            ...(peg ? [{ type: "cyl" as const, r: pd / 2, h: rt + 2, axis: "y" as const, at: [pegX, -rt / 2 - 1, pegZ] as [number, number, number] }] : []),
          ],
          apart: [Math.round(len + 70), 0, 0],
          moves: true,
        },
        ...(peg ? [{ id: "peg", name: "Peg", material: "oak" as const, grain: "y" as const, stock: { type: "cyl" as const, r: pd / 2, h: pt, axis: "y" as const, at: [pegX, -pt / 2, pegZ] as [number, number, number] }, apart: [0, -(pt + 60), 0] as [number, number, number] }] : []),
      ],
      dims: [
        // the tenon's sizes go with the rail and show when it's pulled apart
        dim([-len, -tt / 2, zt1 + 14], [0, -tt / 2, zt1 + 14], { part: "rail", show: "apart" }),
        dim([-len - 14, -tt / 2, zt0], [-len - 14, -tt / 2, zt1], { part: "rail", show: "apart" }),
        dim([-len, -tt / 2, zt0 - 14], [-len, tt / 2, zt0 - 14], { part: "rail", show: "apart" }),
        // the members
        dim([RL + 30, -rt / 2, z0], [RL + 30, -rt / 2, z0 + rw], { part: "rail" }),
        dim([-pw, front - 25, PL + 25], [0, front - 25, PL + 25]),
      ],
      note: `${type === "through" ? "Through" : "Blind"} tenon ${fmt(tt)} thick, ${fmt(th)} wide, ${fmt(len)} long${peg ? `, pegged with a ${fmt(pd)} peg` : ""}.`,
    };
  },
};
