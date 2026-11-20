// Two example sketches (Stage 8.5): a rafter end with its birdsmouth, and a stair flight. Used by the gallery page and
// the fake brain. Made-up sizes, worked out here so the dimensions agree with the drawing. Data only; no imports.
import type { Pt, SketchPayload, SketchShape } from "./protocol.js";

const T = Math.tan((22.5 * Math.PI) / 180);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** A 140 deep rafter at 22.5° over a 90 wide wall plate, with a 300 overhang (measured level). */
function rafter(): SketchPayload {
  const under = (x: number) => T * (x - 90); // underside of the rafter: meets the top of the plate at its inside edge
  const plumb = 140 / Math.cos((22.5 * Math.PI) / 180); // the rafter's depth measured plumb
  const end = 620;
  const p = (x: number, y: number): Pt => [r1(x), r1(y)];
  const shapes: SketchShape[] = [
    { type: "rect", x: 0, y: -420, w: 90, h: 385, fill: "timber" },
    { type: "rect", x: 0, y: -35, w: 90, h: 35, fill: "timber" },
    { type: "poly", points: [p(-300, under(-300)), p(0, under(0)), p(0, 0), p(90, 0), p(end, under(end)), p(end, under(end) + plumb), p(-300, under(-300) + plumb)], fill: "timber" },
    { type: "line", a: p(end, under(end) - 25), b: p(end, under(end) + plumb + 25), style: "dashed" },
    { type: "dim", a: [0, 0], b: [90, 0], offset: -75, text: "90" },
    { type: "dim", a: p(0, under(0)), b: [0, 0], offset: 70, text: "37" },
    { type: "dim", a: p(-300, under(-300)), b: [0, under(-300)], offset: -60, text: "300 overhang" },
    { type: "dim", a: p(end, under(end)), b: p(end, under(end) + plumb), offset: -45 },
    { type: "angle", at: p(90, 0), from_deg: 0, to_deg: 22.5, text: "22.5°" },
    { type: "label", at: [200, 380], text: "140 × 45 rafter", leader: p(330, under(330) + plumb / 2) },
    { type: "label", at: [190, -230], text: "Top plate", leader: [70, -18] },
  ];
  return { shapes, note: "Birdsmouth: seat cut 90 on the plate, 37 deep at the plumb cut." };
}

/** A straight flight: 2,700 rise, 15 risers of 180, 14 goings of 250. */
function stair(): SketchPayload {
  const pts: Pt[] = [[0, 0]];
  for (let i = 0; i < 15; i++) {
    const [x, y] = pts[pts.length - 1];
    pts.push([x, y + 180]);
    if (i < 14) pts.push([x + 250, y + 180]);
  }
  const top = pts[pts.length - 1];
  const shapes: SketchShape[] = [
    { type: "line", a: [-400, 0], b: [0, 0], weight: 2 },
    { type: "line", a: top, b: [top[0] + 600, top[1]], weight: 2 },
    { type: "poly", points: pts, fill: "none" },
    { type: "line", a: [250, -40], b: [top[0], top[1] - 300], style: "dashed" },
    { type: "dim", a: [0, 0], b: [0, 2700], offset: 300, text: "2700 total rise" },
    { type: "dim", a: [0, 0], b: [3500, 0], offset: -260, text: "3500 total going" },
    { type: "dim", a: [3250, 2520], b: [3500, 2520], offset: 260, text: "250" },
    { type: "dim", a: [3500, 2520], b: [3500, 2700], offset: -260, text: "180" },
    { type: "angle", at: [250, -40], from_deg: 0, to_deg: 35.8 },
    { type: "label", at: [1700, 500], text: "15 risers @ 180, 14 goings @ 250", leader: [1500, 1080] },
  ];
  return { shapes, note: "2R + G = 610. Check the current code before building." };
}

export const SAMPLE_SKETCHES = [
  { title: "Rafter birdsmouth", payload: rafter() },
  { title: "Stair, 2700 rise", payload: stair() },
] as const;
