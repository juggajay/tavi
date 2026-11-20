// Line drawings of a model when no app can send its pictures.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "../drawings/engine.js";
import type { ModelPayload } from "../shared/protocol.js";
import { buildModel, polysBox, type BuiltModel } from "../shared/model3d/build.js";
import { xf } from "../shared/model3d/math.js";
import { analyseParts, transformPolys } from "../shared/drawing/parts.js";
import { drawView, prepare, VIEWS, viewFrom, type P2, type ViewLines } from "../shared/drawing/hlr.js";
import { boxesHit, segHitsBox, type Box } from "../shared/drawing/prims.js";

export const LOOK_VIEWS = ["front", "side", "top", "iso", "apart", "hero", "back"] as const;
export type LookView = (typeof LOOK_VIEWS)[number];
export type ModelLinePicture = { view: LookView; svg: string };
const WIDTH = 1024;
const HEIGHT = 768;
const MARGIN = 90;
const ABOVE = viewFrom([-0.53, 0.74, -0.42]);
const NAMES: Record<LookView, string> = { front: "Front", side: "Side", top: "Top", iso: "Three-quarter", hero: "Three-quarter", apart: "Pulled apart", back: "Back" };
const number = (n: number) => String(Math.round(n * 1000) / 1000);

/** The viewer moves each finished part by its stored offset at full pull-apart (viewer.ts, applyApart). */
export function pullApart(built: BuiltModel): BuiltModel {
  const parts = built.parts.map((p) => {
    const polys = transformPolys(p.polys, xf(undefined, p.apart));
    return { ...p, polys, bbox: polysBox(polys) };
  });
  return { ...built, parts, bbox: built.bboxApart };
}

/** Draw only the requested views, keeping the same part numbers in every picture. */
export function modelLineViews(model: ModelPayload, views?: readonly LookView[], built = buildModel(model)): ModelLinePicture[] {
  const want = views ?? (model.parts.length > 1 ? ["front", "side", "iso", "apart"] : ["front", "side", "top", "iso"]);
  const selected = [...new Set(want)].filter((v) => v !== "apart" || model.parts.length > 1).slice(0, 4);
  const { parts } = analyseParts(model, built);
  const marks = parts.map((p) => p.mark);
  const together = prepare(built);
  const apart = selected.includes("apart") ? prepare(pullApart(built)) : together;
  return selected.map((view) => {
    const dir = view === "front" ? VIEWS.front : view === "side" ? VIEWS.right : view === "top" ? VIEWS.top : view === "back" ? VIEWS.back : ABOVE;
    const lines = drawView(view === "apart" ? apart : together, dir);
    return { view, svg: viewSvg(lines, marks, NAMES[view]) };
  });
}

function viewSvg(lines: ViewLines, marks: number[], title: string): string {
  const valid = [...lines.min, ...lines.max].every(Number.isFinite);
  const dx = valid ? lines.max[0] - lines.min[0] : 0;
  const dy = valid ? lines.max[1] - lines.min[1] : 0;
  const k = Math.min((WIDTH - 2 * MARGIN) / Math.max(dx, 1), (HEIGHT - 2 * MARGIN) / Math.max(dy, 1));
  const cx = valid ? (lines.min[0] + lines.max[0]) / 2 : 0;
  const cy = valid ? (lines.min[1] + lines.max[1]) / 2 : 0;
  const project = (p: P2): P2 => [WIDTH / 2 + (p[0] - cx) * k, HEIGHT / 2 - (p[1] - cy) * k];
  const paths: { d: string; hidden: boolean }[] = [];
  const edges: { a: P2; b: P2; part: number }[] = [];
  for (const c of lines.chains) {
    const pts = c.pts.map(project);
    if (pts.length < 2) continue;
    paths.push({ d: pts.map((p, i) => `${i ? "L" : "M"}${number(p[0])},${number(p[1])}`).join(" ") + (c.closed ? " Z" : ""), hidden: c.kind === "hidden" });
    for (let i = 0; i < pts.length - (c.closed ? 0 : 1); i++) edges.push({ a: pts[i], b: pts[(i + 1) % pts.length], part: c.kind === "hidden" ? -1 : c.part });
  }
  for (const arc of lines.arcs) {
    const c = project(arc.c), r = arc.r * k;
    const span = arc.a1 - arc.a0;
    const steps = Math.max(2, Math.ceil(span / (Math.PI / 24)));
    const pts: P2[] = Array.from({ length: steps + 1 }, (_, i) => {
      const a = arc.a0 + span * i / steps;
      return [c[0] + r * Math.cos(a), c[1] - r * Math.sin(a)];
    });
    const p = pts[0], q = pts.at(-1)!;
    const d = span >= 2 * Math.PI - 1e-6
      ? `M${number(c[0] - r)},${number(c[1])} a${number(r)},${number(r)} 0 1 0 ${number(2 * r)},0 a${number(r)},${number(r)} 0 1 0 ${number(-2 * r)},0`
      : `M${number(p[0])},${number(p[1])} A${number(r)},${number(r)} 0 ${span > Math.PI ? 1 : 0} 0 ${number(q[0])},${number(q[1])}`;
    paths.push({ d, hidden: arc.kind === "hidden" });
    for (let i = 0; i + 1 < pts.length; i++) edges.push({ a: pts[i], b: pts[i + 1], part: arc.kind === "hidden" ? -1 : arc.part });
  }
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`, `<rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>`, `<text x="24" y="32" font-family="Helvetica, Arial, sans-serif" font-size="20">${title}</text>`];
  // Hidden edges go underneath the solid ones, so a shared edge stays clear.
  for (const hidden of [true, false]) {
    out.push(`<g fill="none" stroke="${hidden ? "#aaa" : "#222"}" stroke-width="${hidden ? 1.1 : 1.8}" stroke-linejoin="round"${hidden ? ' stroke-dasharray="6 4"' : ' stroke-linecap="round"'}>`);
    for (const p of paths) if (p.hidden === hidden) out.push(`<path d="${p.d}"/>`);
    out.push("</g>");
  }
  // Use the existing part numbers. Leave out a number when there is no clear place beside a visible edge.
  const labels: Box[] = [];
  const leaders: { a: P2; b: P2 }[] = [];
  for (const mark of new Set(marks.filter((m) => m > 0))) {
    const candidates = edges.filter((e) => e.part >= 0 && marks[e.part] === mark)
      .map((e): P2 => [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2])
      .sort((a, b) => Math.hypot(b[0] - WIDTH / 2, b[1] - HEIGHT / 2) - Math.hypot(a[0] - WIDTH / 2, a[1] - HEIGHT / 2));
    let placed = false;
    for (const a of candidates) {
      for (const distance of [30, 50, 70]) {
        for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707]]) {
          const b: P2 = [a[0] + ux * distance, a[1] + uy * distance];
          const box: Box = [b[0] - 14, b[1] - 14, b[0] + 14, b[1] + 14];
          const start: P2 = [a[0] + ux * 2, a[1] + uy * 2];
          const end: P2 = [b[0] - ux * 14, b[1] - uy * 14];
          if (box[0] < 20 || box[1] < 50 || box[2] > WIDTH - 20 || box[3] > HEIGHT - 20) continue;
          if (labels.some((other) => boxesHit(box, other, 6) || segHitsBox(start, end, other))) continue;
          if (edges.some((e) => segHitsBox(e.a, e.b, box) || crosses(start, end, e.a, e.b))) continue;
          if (leaders.some((e) => segHitsBox(e.a, e.b, box) || crosses(start, end, e.a, e.b))) continue;
          out.push(`<path d="M${number(a[0])},${number(a[1])} L${number(end[0])},${number(end[1])}" fill="none" stroke="#555" stroke-width="1"/>`, `<circle cx="${number(b[0])}" cy="${number(b[1])}" r="12" fill="white" stroke="#222"/>`, `<text x="${number(b[0])}" y="${number(b[1] + 5)}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15">${mark}</text>`);
          labels.push(box);
          leaders.push({ a, b: end });
          placed = true;
          break;
        }
        if (placed) break;
      }
      if (placed) break;
    }
  }
  if (!valid) out.push('<text x="24" y="80" font-family="Helvetica, Arial, sans-serif" font-size="18">No solid parts remain. Read the model checks.</text>');
  out.push("</svg>");
  return out.join("\n");
}

function crosses(a: P2, b: P2, c: P2, d: P2): boolean {
  const side = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < -1e-6 && side(c, d, a) * side(c, d, b) < -1e-6;
}

/** Use the same drawing worker as sheet pictures. These temporary files are never added to the owner's files. */
export async function modelLinePictures(model: ModelPayload, views?: readonly LookView[], built?: BuiltModel) {
  const pictures = modelLineViews(model, views, built);
  if (!pictures.length) return [];
  const dir = await mkdtemp(path.join(tmpdir(), "tavi-model-look-"));
  try {
    const results = await Promise.allSettled(pictures.map(async ({ view, svg }, i) => {
      const input = path.join(dir, `${i}.svg`), output = path.join(dir, `${i}.png`);
      await writeFile(input, svg, "utf8");
      await render(input, 0, [0, 0, 1, 1], output, WIDTH);
      return { view, png: await readFile(output) };
    }));
    return results.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
