// The scoring checklist's code checks (Stage 12, plan section B, A1 to A16; 12.10 added A17 to A21), run on a finished
// set. Each returns pass or fail with the reasons, so a test can show exactly what's wrong and on which sheet. B1 to B12
// are judged by eye.
import { AREA, COL_X, FRAME, type DrawingSet, gaHiddenLengths } from "./sheets.js";
import { type Box, type DxfFile, PAGE, type Prim, type Text, segHitsBox, textBox } from "./prims.js";
import { SCALES } from "./render.js";

export type Check = { id: string; ok: boolean; why: string[] };

const raw = (t: Text): Box => {
  const b = textBox(t);
  return [b[0] + 0.4, b[1] + 0.4, b[2] - 0.4, b[3] - 0.4];
};
const overlap = (a: Box, b: Box, by = 0.25) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > by && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > by;
const lineSegs = (p: Prim): [[number, number], [number, number]][] => {
  if (p.t === "line") return [[p.a, p.b]];
  if (p.t === "poly" && !p.fill) {
    const out: [[number, number], [number, number]][] = [];
    for (let i = 0; i + 1 < p.pts.length + (p.closed ? 1 : 0); i++) out.push([p.pts[i], p.pts[(i + 1) % p.pts.length]]);
    return out;
  }
  return [];
};

/** files: the set's PDF bytes, and its DXF files already read (dxf.ts readDxf), when they have been written. */
export function checkSet(set: DrawingSet, files: { pdf?: Uint8Array; dxf?: DxfFile; partDxf?: { mark: number; dxf: DxfFile }[] } = {}): Check[] {
  const out: Check[] = [];
  const add = (id: string, why: string[]) => out.push({ id, ok: !why.length, why });
  const sheets = set.sheets;

  // A1: page size and all vector (from the PDF's own numbers)
  {
    const why: string[] = [];
    if (files.pdf) {
      const s = new TextDecoder("latin1").decode(files.pdf);
      const boxes = [...s.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
      if (boxes.length !== sheets.length) why.push(`${boxes.length} pages in the PDF for ${sheets.length} sheets`);
      for (const [w, h] of boxes) if (Math.abs((w * 25.4) / 72 - PAGE[0]) > 0.01 || Math.abs((h * 25.4) / 72 - PAGE[1]) > 0.01) why.push(`page ${((w * 25.4) / 72).toFixed(2)} x ${((h * 25.4) / 72).toFixed(2)} mm`);
      const images = [...s.matchAll(/\/Subtype \/Image/g)].length;
      const logo = /\/Logo \d+ 0 R/.test(s);
      if (images > (logo ? 2 : 0)) why.push(`${images} images (only a logo is allowed)`);
    } else {
      // no PDF yet: every primitive is a vector one, on the page
      for (const sh of sheets)
        for (const p of sh.prims) {
          const pts = p.t === "line" ? [p.a, p.b] : p.t === "poly" ? p.pts : p.t === "text" ? [p.at] : [p.c];
          if (pts.some((q) => q[0] < 0 || q[1] < 0 || q[0] > PAGE[0] || q[1] > PAGE[1])) {
            why.push(`sheet ${sh.meta.sheet}: something off the page`);
            break;
          }
        }
    }
    add("A1", why);
  }

  // A2: the same title block fields on every sheet
  {
    const why: string[] = [];
    // the company is the owner's to put on, or not (12.10): if it's there it's on every sheet
    const need = ["project", "client", "title", "number", "sheet", "scale", "size", "date", "drawn", "revision", "status"];
    for (const sh of sheets) {
      const texts = new Set(sh.prims.filter((p): p is Text => p.t === "text" && p.layer === "TITLE").map((p) => p.s));
      for (const f of need) if (!sh.meta.fields[f]) why.push(`sheet ${sh.meta.sheet}: no ${f}`);
      for (const [label, value] of [
        ["number", sh.meta.fields.number],
        ["revision", sh.meta.fields.revision],
        ["sheet", sh.meta.fields.sheet],
        ["scale", sh.meta.fields.scale],
        ["size", "A3"],
        ["status", sh.meta.fields.status],
        ["date", sh.meta.fields.date],
      ])
        if (!texts.has(value)) why.push(`sheet ${sh.meta.sheet}: ${label} "${value}" isn't in the title block`);
      for (const cap of ["CHECKED", "DRAWN", "PROJECT", "CLIENT", "DRAWING TITLE", "DRAWING NO."]) if (!texts.has(cap)) why.push(`sheet ${sh.meta.sheet}: no "${cap}" box`);
      if (sh.meta.fields.company && !sh.prims.some((p) => p.t === "text" && p.layer === "TITLE" && p.s === sh.meta.fields.company.toUpperCase())) why.push(`sheet ${sh.meta.sheet}: company name missing`);
    }
    const keys = sheets.map((s) => JSON.stringify({ ...s.meta.fields, sheet: "", title: "", scale: "" }));
    if (new Set(keys).size > 1) why.push("title block fields differ between sheets");
    add("A2", why);
  }

  // A3: a revision table, its last row the title block's revision
  {
    const why: string[] = [];
    for (const sh of sheets) {
      if (!sh.prims.some((p) => p.t === "text" && p.s === "REVISIONS")) why.push(`sheet ${sh.meta.sheet}: no revision table`);
      const last = sh.meta.revisions[sh.meta.revisions.length - 1];
      if (!last || last.rev !== sh.meta.revision) why.push(`sheet ${sh.meta.sheet}: last revision row ${last?.rev ?? "none"} vs title block ${sh.meta.revision}`);
    }
    add("A3", why);
  }

  // A4: every view titled, identified, at a standard scale
  {
    const why: string[] = [];
    for (const sh of sheets)
      for (const v of sh.meta.views) {
        if (!(SCALES as readonly number[]).includes(v.scale)) why.push(`sheet ${sh.meta.sheet} view ${v.id}: scale 1:${v.scale}`);
        // a view in a joint detail (19.2): its caption under it, and the detail's bubble, title and scale under the group
        if (v.group) {
          const texts = sh.prims.filter((p): p is Text => p.t === "text");
          if (!texts.some((t) => t.view === v.id && t.s.endsWith(v.title))) why.push(`sheet ${sh.meta.sheet} view ${v.id}: caption "${v.title}" not drawn`);
          if (!texts.some((t) => (t.view === v.group && t.s === `SCALE 1:${v.scale}`) || (t.view === v.id && t.s.endsWith(`SCALE 1:${v.scale}`)))) why.push(`sheet ${sh.meta.sheet} view ${v.id}: detail ${v.group}'s scale not written`);
          if (!texts.some((t) => t.view === v.group && t.layer === "SYMBOLS" && t.s === v.group)) why.push(`sheet ${sh.meta.sheet} view ${v.id}: no bubble for detail ${v.group}`);
          continue;
        }
        if (!v.title) {
          // a part's views in projection share its title
          if (!v.aligned?.length) why.push(`sheet ${sh.meta.sheet} view ${v.id}: no title`);
          continue;
        }
        const texts = sh.prims.filter((p): p is Text => p.t === "text" && p.view === v.id);
        if (!texts.some((t) => t.s === v.title)) why.push(`sheet ${sh.meta.sheet} view ${v.id}: title "${v.title}" not drawn`);
        if (!texts.some((t) => t.s.startsWith(`SCALE 1:${v.scale}`))) why.push(`sheet ${sh.meta.sheet} view ${v.id}: scale not written under it`);
        if (!texts.some((t) => t.role === "title" && t.layer === "SYMBOLS")) why.push(`sheet ${sh.meta.sheet} view ${v.id}: no identifier bubble`);
      }
    add("A4", why);
  }

  // A5: every section marker has its view, every section view a marker
  {
    const why: string[] = [];
    const marked = new Set(sheets.flatMap((s) => s.meta.markers.map((m) => m.letter)));
    // (a joint detail is one view group, lettered: 19.2)
    const views = new Set(sheets.flatMap((s) => s.meta.views.flatMap((v) => (v.kind === "section" ? [v.id] : v.group ? [v.group] : []))));
    for (const m of marked) if (!views.has(m)) why.push(`marker ${m} has no section view`);
    for (const v of views) if (!marked.has(v)) why.push(`section ${v} isn't marked anywhere`);
    for (const l of [...marked, ...views]) if (/[IOQ]/.test(l)) why.push(`letter ${l} is one of I, O, Q`);
    add("A5", why);
  }

  // A6: no text on text; no text across a visible line (a dimension's own line excepted)
  {
    const why: string[] = [];
    for (const sh of sheets) {
      const texts = sh.prims.filter((p): p is Text => p.t === "text");
      const boxes = texts.map(raw);
      for (let i = 0; i < texts.length; i++)
        for (let j = i + 1; j < texts.length; j++)
          if (overlap(boxes[i], boxes[j])) {
            // a balloon's or bubble's number sits inside its own circle with nothing else; the same text twice is a fault
            why.push(`sheet ${sh.meta.sheet}: "${texts[i].s}" on "${texts[j].s}"`);
          }
      const lines = sh.prims.filter((p) => (p.t === "line" || p.t === "poly") && p.layer !== "HATCH" && !(p.t === "poly" && p.fill));
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i],
          b = boxes[i];
        for (const l of lines) {
          // a dimension's value sits on its own chain's lines; a table's and the title block's text sits in its cells
          if (t.role === "dim" && l.layer === "DIMS") continue;
          if ((t.layer === "TITLE" || t.layer === "TABLES") && (l.layer === "TITLE" || l.layer === "TABLES" || l.layer === "BORDER")) {
            if (lineSegs(l).some(([a, c]) => segHitsBox(a, c, [b[0] + 0.3, b[1] + 0.3, b[2] - 0.3, b[3] - 0.3]))) why.push(`sheet ${sh.meta.sheet}: "${t.s}" crosses a ${l.layer.toLowerCase()} line`);
            continue;
          }
          if (lineSegs(l).some(([a, c]) => segHitsBox(a, c, b))) {
            why.push(`sheet ${sh.meta.sheet}: "${t.s}" crosses a ${l.layer.toLowerCase()} line`);
            break;
          }
        }
        // a view's title never sits inside another view (in the empty middle of a frame, say)
        if (t.role === "title")
          for (const v of sh.meta.views) if (v.id !== t.view && overlap(b, v.box)) why.push(`sheet ${sh.meta.sheet}: "${t.s}" is inside view ${v.id}`);
      }
    }
    add("A6", [...new Set(why)]);
  }

  // A7: dimension lines don't overlap each other, and don't cross the object they're on
  {
    const why: string[] = [];
    for (const sh of sheets) {
      const dims = sh.meta.dims;
      const lines = [...new Map(dims.map((d) => [`${d.chain}`, d])).values()].map((d) => ({ d, a: d.line[0], b: d.line[1] }));
      for (let i = 0; i < dims.length; i++)
        for (let j = i + 1; j < dims.length; j++) {
          const a = dims[i],
            b = dims[j];
          if (a.chain === b.chain) continue;
          const ha = Math.abs(a.line[0][1] - a.line[1][1]) < 1e-6,
            hb = Math.abs(b.line[0][1] - b.line[1][1]) < 1e-6;
          if (ha !== hb) continue;
          const i0 = ha ? 0 : 1,
            j0 = ha ? 1 : 0;
          if (Math.abs(a.line[0][j0] - b.line[0][j0]) > 0.3) continue;
          const lo = Math.max(Math.min(a.line[0][i0], a.line[1][i0]), Math.min(b.line[0][i0], b.line[1][i0])),
            hi = Math.min(Math.max(a.line[0][i0], a.line[1][i0]), Math.max(b.line[0][i0], b.line[1][i0]));
          if (hi - lo > 0.3) why.push(`sheet ${sh.meta.sheet}: dimensions ${mmv(a.value)} and ${mmv(b.value)} on the same line`);
        }
      for (const { d, a, b } of lines) {
        const v = sh.meta.views.find((x) => x.id === d.view);
        if (!v) continue;
        const inner: Box = [v.box[0] + 0.5, v.box[1] + 0.5, v.box[2] - 0.5, v.box[3] - 0.5];
        if (segHitsBox(a, b, inner)) why.push(`sheet ${sh.meta.sheet} view ${v.id}: a dimension line crosses the drawing`);
      }
    }
    add("A7", why);
  }

  // A8: chains add up to their overall; no size given twice (references in brackets aside)
  {
    const why: string[] = [];
    const seen = new Map<string, string>();
    for (const sh of sheets) {
      const chains = new Map<string, number>();
      for (const d of sh.meta.dims) {
        if (d.chain) chains.set(d.chain, (chains.get(d.chain) ?? 0) + d.value);
        if (d.ref) continue;
        const where = `sheet ${sh.meta.sheet} view ${d.view}`;
        if (seen.has(d.key)) why.push(`${mmv(d.value)} given twice: ${seen.get(d.key)} and ${where} (${d.key})`);
        else seen.set(d.key, where);
      }
      for (const [c, sum] of chains) {
        const m = /=([\d.]+)$/.exec(c);
        if (!m || c.includes("~partial")) continue;
        if (Math.abs(sum - Number(m[1])) > 0.05) why.push(`sheet ${sh.meta.sheet}: chain ${c} adds to ${sum}, not ${m[1]}`);
      }
    }
    add("A8", why);
  }

  // A9: no dimension starts from a hidden line: each extension line's foot is on visible linework or a centre line
  {
    const why: string[] = [];
    for (const sh of sheets) {
      for (const d of sh.meta.dims) {
        const lines = sh.prims.filter((p) => p.view === d.view && (p.layer === "OUTLINE" || p.layer === "CUT" || p.layer === "CENTRE"));
        for (const f of d.feet) {
          const on = lines.some((p) => {
            if (p.t === "circle" || p.t === "arc") return Math.abs(Math.hypot(f[0] - p.c[0], f[1] - p.c[1]) - p.r) < 0.15;
            return lineSegs(p).some(([a, b]) => distToSeg(f, a, b) < 0.15);
          });
          if (!on) {
            const hidden = sh.prims.some((p) => p.view === d.view && p.layer === "HIDDEN" && lineSegs(p).some(([a, b]) => distToSeg(f, a, b) < 0.15));
            why.push(`sheet ${sh.meta.sheet} view ${d.view}: ${mmv(d.value)} starts ${hidden ? "on a hidden line" : "on nothing"} at ${f.map((x) => x.toFixed(1))}`);
          }
        }
      }
    }
    add("A9", [...new Set(why)]);
  }

  // A10: text at least 2.5 high; four heights at most
  {
    const why: string[] = [];
    const hs = new Set<number>();
    for (const sh of sheets)
      for (const p of sh.prims)
        if (p.t === "text") {
          hs.add(p.h);
          if (p.h < 2.5 - 1e-9) why.push(`sheet ${sh.meta.sheet}: "${p.s}" is ${p.h} high`);
        }
    if (hs.size > 4) why.push(`${hs.size} text heights: ${[...hs].join(", ")}`);
    add("A10", why);
  }

  // A11: three line weights or more, none under 0.18; cut outlines the heaviest in their view
  {
    const why: string[] = [];
    for (const sh of sheets) {
      const ws = new Set<number>();
      for (const p of sh.prims) {
        if (p.t === "text" || ((p.t === "poly" || p.t === "circle") && p.fill)) continue;
        ws.add(p.w);
        if (p.w < 0.18 - 1e-9) why.push(`sheet ${sh.meta.sheet}: a ${p.layer.toLowerCase()} line ${p.w} thick`);
      }
      if (ws.size < 3) why.push(`sheet ${sh.meta.sheet}: only ${ws.size} line weights`);
      for (const v of sh.meta.views) {
        const ps = sh.prims.filter((p) => p.view === v.id && p.t !== "text" && !((p.t === "poly" || p.t === "circle") && p.fill));
        const cut = ps.filter((p) => p.layer === "CUT");
        if (!cut.length) continue;
        const cw = Math.max(...cut.map((p) => (p as { w: number }).w));
        const heavier = ps.filter((p) => (p as { w: number }).w > cw + 1e-9);
        if (heavier.length) why.push(`sheet ${sh.meta.sheet} view ${v.id}: ${heavier.length} lines heavier than the cut outline`);
      }
    }
    add("A11", [...new Set(why)]);
  }

  // A12: every part numbered, scheduled with the right count, ballooned once on the arrangement
  {
    const why: string[] = [];
    const schedule = sheets.find((s) => s.meta.schedule)?.meta.schedule ?? [];
    const live = set.built.parts.filter((p) => p.polys.length).length;
    const total = schedule.reduce((t, r) => t + r.qty, 0);
    if (total !== live) why.push(`schedule counts ${total} parts; the model has ${live}`);
    for (const mk of set.marks) {
      if (!schedule.some((r) => r.mark === mk.mark && r.qty === mk.qty)) why.push(`part ${mk.mark} (${mk.label}) not in the schedule as ${mk.qty}`);
      const n = sheets.flatMap((s) => s.meta.balloons).filter((b) => b.mark === mk.mark).length;
      if (n !== 1) why.push(`part ${mk.mark} (${mk.label}) ballooned ${n} times`);
    }
    for (const p of set.parts) if (set.built.parts[p.index].polys.length && !p.mark) why.push(`${p.name} has no part number`);
    add("A12", why);
  }

  // A13: every part's material, thickness, width and length; scheduled lengths equal the model's
  {
    const why: string[] = [];
    const schedule = sheets.find((s) => s.meta.schedule)?.meta.schedule ?? [];
    for (const mk of set.marks) {
      const r = schedule.find((x) => x.mark === mk.mark);
      if (!r) continue;
      // what it's made of as the owner said it, or TBC where he couldn't say (12.10): never blank
      if (!r.material?.trim()) why.push(`part ${mk.mark}: no material`);
      for (const [k, v] of [
        ["thickness", r.T],
        ["width", r.W],
        ["length", r.L],
      ] as const)
        if (!(v > 0)) why.push(`part ${mk.mark}: no ${k}`);
      for (const pi of mk.parts) {
        const s = set.built.parts[pi].size;
        const sorted = [...s].sort((a, b) => a - b);
        const mine = [r.T, r.W, r.L].sort((a, b) => a - b);
        if (sorted.some((v, i) => Math.abs(v - mine[i]) > 0.05)) why.push(`part ${mk.mark}: schedule ${mine.join(" x ")} vs model ${sorted.map((v) => Math.round(v * 10) / 10).join(" x ")}`);
      }
    }
    add("A13", why);
  }

  // A14: the standing notes on every sheet
  {
    const why: string[] = [];
    const want: [string, RegExp][] = [
      ["do not scale", /DO NOT SCALE/],
      ["millimetres", /MILLIMETRES/],
      ["verify on site", /VERIFY .*ON SITE/],
      ["not a certification", /NOT A STRUCTURAL DESIGN OR CERTIFICATION/],
      ["projection", /THIRD ANGLE PROJECTION/],
    ];
    for (const sh of sheets) {
      const all = sh.prims.filter((p): p is Text => p.t === "text").map((p) => p.s).join(" ");
      for (const [name, re] of want) if (!re.test(all)) why.push(`sheet ${sh.meta.sheet}: no "${name}" note`);
      if (/\b(CERTIFIED|STRUCTURALLY ADEQUATE|COMPLIES WITH)\b/.test(all)) why.push(`sheet ${sh.meta.sheet}: claims certification`);
    }
    add("A14", why);
  }

  // A15: views in projection line up
  {
    const why: string[] = [];
    for (const sh of sheets) for (const v of sh.meta.views) for (const a of v.aligned ?? []) if (Math.abs(a.at - a.other) > 0.1) why.push(`sheet ${sh.meta.sheet}: view ${v.id} is ${Math.abs(a.at - a.other).toFixed(2)} out of line with ${a.with}`);
    add("A15", why);
  }

  // A16: the DXF reads back, has its layers, and a part measures the same as the model
  {
    const why: string[] = [];
    if (files.dxf) {
      const d = files.dxf;
      if (d.version !== "AC1009") why.push(`DXF version ${d.version}`);
      if (d.units !== 4) why.push("DXF units aren't millimetres");
      for (const l of ["OUTLINE", "HIDDEN", "DIMS", "CENTRE"]) if (!d.layers.includes(l)) why.push(`DXF has no ${l} layer`);
      if (!d.entities.some((e) => e.layer === "DIMS")) why.push("DXF has no dimensions on their layer");
    } else why.push("no DXF to check");
    for (const pd of files.partDxf ?? []) {
      const mk = set.marks.find((m) => m.mark === pd.mark)!;
      const d = pd.dxf;
      const outline = d.entities.filter((e) => e.layer === "OUTLINE" && e.type === "POLYLINE");
      if (!outline.length || !outline.every((e) => e.closed)) why.push(`part ${pd.mark}: outline not closed`);
      const xs = outline.flatMap((e) => e.pts.map((p) => p[0])),
        ys = outline.flatMap((e) => e.pts.map((p) => p[1]));
      const w = Math.max(...xs) - Math.min(...xs),
        h = Math.max(...ys) - Math.min(...ys);
      if (Math.abs(w - mk.first.L) > 0.01 || Math.abs(h - mk.first.W) > 0.01) why.push(`part ${pd.mark}: DXF outline ${w.toFixed(2)} x ${h.toFixed(2)}, model ${mk.first.L} x ${mk.first.W}`);
    }
    add("A16", why);
  }

  // A17 (12.10): no sheet under 40% used (what's laid out on it, over the drawing area), unless it's the only one
  {
    const why: string[] = [];
    if (sheets.length > 1)
      for (const sh of sheets) {
        // (the cover is the project, the index and the piece assembled: a title sheet, not a working one; Stage 19)
        if (sh.meta.cover) continue;
        const f = usedArea(sh.meta.blocks ?? []);
        if (f < 0.4) why.push(`sheet ${sh.meta.sheet}: ${Math.round(f * 100)}% used`);
      }
    add("A17", why);
  }

  // A18 (12.10): a plan carries the overall length and depth (as sizes, or in brackets where they're given elsewhere)
  {
    const why: string[] = [];
    for (const sh of sheets)
      for (const v of sh.meta.views.filter((x) => x.kind === "ga" && x.title === "PLAN")) {
        const ds = sh.meta.dims.filter((d) => d.view === v.id && (d.overall || d.ref));
        const hor = ds.some((d) => Math.abs(d.line[0][1] - d.line[1][1]) < 1e-6),
          ver = ds.some((d) => Math.abs(d.line[0][0] - d.line[1][0]) < 1e-6);
        if (!hor || !ver) why.push(`sheet ${sh.meta.sheet}: the plan has no overall ${!hor ? "length" : "depth"}`);
      }
    add("A18", why);
  }

  // A19 (12.10): the same part under different names is drawn once (one part view for all its numbers)
  {
    const why: string[] = [];
    const schedule = sheets.find((s) => s.meta.schedule)?.meta.schedule ?? [];
    const matOf = (n: number) => schedule.find((r) => r.mark === n)?.material ?? "";
    const drawnIn = new Map<number, string>();
    for (const sh of sheets) for (const v of sh.meta.views) if (v.kind === "part" && v.title) for (const n of v.marks ?? (v.mark ? [v.mark] : [])) drawnIn.set(n, v.id);
    for (let i = 0; i < set.marks.length; i++)
      for (let j = i + 1; j < set.marks.length; j++) {
        const a = set.marks[i],
          b = set.marks[j];
        if (a.shape !== b.shape || matOf(a.mark) !== matOf(b.mark)) continue;
        if (drawnIn.get(a.mark) !== drawnIn.get(b.mark)) why.push(`parts ${a.mark} and ${b.mark} are the same part, drawn twice`);
      }
    for (const mk of set.marks) if (!drawnIn.has(mk.mark)) why.push(`part ${mk.mark} has no part view`);
    add("A19", why);
  }

  // A20 (12.10): no size's line runs through hatching
  {
    const why: string[] = [];
    for (const sh of sheets) {
      const hatch = sh.prims.filter((p) => p.layer === "HATCH").flatMap(lineSegs);
      const dims = sh.prims.filter((p) => p.layer === "DIMS").flatMap(lineSegs);
      let n = 0;
      for (const [a, b] of dims) for (const [c, d] of hatch) if (segsCross(a, b, c, d)) n++;
      if (n) why.push(`sheet ${sh.meta.sheet}: ${n} crossings of a size's line and hatching`);
    }
    add("A20", why);
  }

  // A21 (12.10): the title block is whole with or without a company: nothing standing in for one, no empty box
  {
    const why: string[] = [];
    const logo = set.logoAt;
    for (const sh of sheets) {
      const tt = sh.prims.filter((p): p is Text => p.t === "text" && p.layer === "TITLE");
      if (!sh.meta.fields.company && tt.some((t) => /COMPANY|\bTBC\b/.test(t.s) && !/FINISH/.test(t.s))) why.push(`sheet ${sh.meta.sheet}: a stand-in for the company`);
      // every band across the column between two full-width lines holds some text (or the logo)
      const ys = [
        ...new Set(
          sh.prims
            .filter((p) => p.t === "line" && p.layer === "TITLE" && Math.abs(p.a[1] - p.b[1]) < 1e-6 && Math.min(p.a[0], p.b[0]) <= COL_X + 0.01 && Math.max(p.a[0], p.b[0]) >= FRAME[2] - 0.01)
            .map((p) => Math.round((p as { a: [number, number] }).a[1] * 100) / 100),
        ),
      ].sort((a, b) => a - b);
      const bands = [FRAME[1], ...ys, FRAME[3]];
      for (let i = 0; i + 1 < bands.length; i++) {
        const y0 = bands[i],
          y1 = bands[i + 1];
        if (y1 - y0 < 2) continue;
        const has = tt.some((t) => t.at[0] >= COL_X && t.at[1] > y0 && t.at[1] < y1);
        const isLogo = logo[2] > 0 && logo[1] >= y0 - 0.01 && logo[1] + logo[3] <= y1 + 0.01;
        if (!has && !isLogo) why.push(`sheet ${sh.meta.sheet}: an empty box in the title column at ${y0.toFixed(1)} to ${y1.toFixed(1)}`);
      }
    }
    add("A21", why);
  }

  // ---- Stage 19.2: the joint details ----
  const groups = new Map<string, { sheet: number; views: (typeof sheets)[number]["meta"]["views"] }>();
  for (const sh of sheets)
    for (const v of sh.meta.views)
      if (v.group && v.role !== "extra") {
        const g = groups.get(v.group) ?? { sheet: sh.meta.sheet, views: [] };
        g.views.push(v);
        groups.set(v.group, g);
      }
  const markedLetters = new Set(sheets.flatMap((s) => s.meta.markers.map((m) => m.letter)));

  // A22: every joint type has a detail (or is a plain butt in the schedule only, more than six kinds) and a marker
  {
    const why: string[] = [];
    for (const t of set.joints.types) {
      if (!t.letter) {
        if (!(t.butt && set.joints.buttsInScheduleOnly)) why.push(`${t.title} (${t.name}) has no detail`);
        continue;
      }
      if (!groups.has(t.letter)) why.push(`detail ${t.letter} (${t.title}) isn't drawn`);
      if (!markedLetters.has(t.letter)) why.push(`detail ${t.letter} (${t.title}) isn't marked on the arrangement`);
    }
    add("A22", why);
  }

  // A23: a detail's sizes are the model's cuts: each size of a part is the distance between two of that part's own
  // stations in its frame; and the joint's own sizes (a tenon's length, a mortise's depth...) are on its detail
  {
    const why: string[] = [];
    for (const [letter, g] of groups) {
      const ids = new Set(g.views.map((v) => v.id));
      const dims = sheets.flatMap((s) => s.meta.dims.filter((d) => ids.has(d.view)));
      for (const d of dims) {
        const m = /^(?:ref:)?part\d+:[xyz]:(-?[\d.]+):(-?[\d.]+)/.exec(d.key);
        if (m && Math.abs(Math.abs(Number(m[2]) - Number(m[1])) - d.value) > 0.11) why.push(`detail ${letter}: ${mmv(d.value)} isn't the model's ${mmv(Math.abs(Number(m[2]) - Number(m[1])))} (${d.key})`);
      }
      const jd = set.details.find((x) => x.letter === letter);
      if (!jd) continue;
      const s = jd.inst.sizes;
      const want: [string, number | undefined][] = jd.type.butt
        ? []
        : jd.inst.kind === "scarf"
          ? [
              ["the splice's length", s.splice],
              ["the nibs", s.nib],
              ["the table", s.table],
              ["the lap", s.lap],
            ]
          : [
              ["the depth of the cut", s.depth],
              ["what goes in", s.len],
            ];
      for (const [what, v] of want) if (v !== undefined && v > 0.5 && !dims.some((d) => Math.abs(d.value - v) < 0.06)) why.push(`detail ${letter}: ${what} (${mmv(v)}) isn't dimensioned`);
    }
    add("A23", why);
  }

  // A24: each detail's pulled-apart view shows the joint's own parts (each numbered) and no sizes
  {
    const why: string[] = [];
    for (const [letter, g] of groups) {
      const ap = g.views.find((v) => v.role === "apart");
      if (!ap) {
        why.push(`detail ${letter} has no pulled-apart view`);
        continue;
      }
      const jd = set.details.find((x) => x.letter === letter);
      const want = jd ? [...new Set(jd.inst.parts.map((i) => set.parts[i].mark))].sort((a, b) => a - b) : [];
      if (jd && JSON.stringify(ap.ballooned ?? []) !== JSON.stringify(want)) why.push(`detail ${letter}: pulled apart shows parts ${ap.ballooned?.join(", ")}, the joint is ${want.join(", ")}`);
      if (sheets.some((s) => s.meta.dims.some((d) => d.view === ap.id))) why.push(`detail ${letter}: the pulled-apart view has sizes on it`);
    }
    add("A24", why);
  }

  // A25: the joint schedule's places equal the joints found, type by type
  {
    const why: string[] = [];
    const rows = sheets.flatMap((s) => s.meta.jointSchedule ?? []);
    if (set.joints.types.length && !rows.length) why.push("no joint schedule");
    if (rows.length) {
      const total = rows.reduce((t, r) => t + r.places, 0);
      if (total !== set.joints.insts.length) why.push(`the schedule counts ${total} joints; ${set.joints.insts.length} were found`);
      for (const t of set.joints.types) {
        const r = rows.find((x) => x.detail === t.letter && x.kind === t.kind && x.places === t.insts.length);
        if (!r) why.push(`${t.title}: not in the schedule as ${t.insts.length} places`);
      }
    }
    add("A25", why);
  }

  // A26: a size on a joint detail isn't given again on a part view (it may be there in brackets, for reference)
  {
    const why: string[] = [];
    const onDetail = new Map<string, string>();
    for (const sh of sheets) for (const d of sh.meta.dims) if (!d.ref && groups.has(sh.meta.views.find((v) => v.id === d.view)?.group ?? "")) onDetail.set(d.key, `detail on sheet ${sh.meta.sheet}`);
    for (const sh of sheets)
      for (const d of sh.meta.dims) {
        const v = sh.meta.views.find((x) => x.id === d.view);
        if (!d.ref && v?.kind === "part" && onDetail.has(d.key)) why.push(`${mmv(d.value)} on part view ${v.id} (sheet ${sh.meta.sheet}) and on a ${onDetail.get(d.key)} (${d.key})`);
      }
    add("A26", why);
  }

  // ---- Stage 19.4: less clutter ----
  // A27: the arrangement draws only the hidden lines that explain something: no more than Stage 12 drew (on a busy
  // piece, fewer), and every joint marked on it still has its outline (seen or hidden) inside the marker's circle
  {
    const why: string[] = [];
    const h = gaHiddenLengths(set);
    // (the joint outlines at the markers are extra, by design: one compact outline a type)
    if (h.others > h.before + 0.5) why.push(`the arrangement has ${Math.round(h.others)} mm of hidden line besides joint outlines, more than the ${Math.round(h.before)} mm before`);
    for (const sh of sheets)
      for (const m of sh.meta.markers) {
        if (!m.at || !m.r) continue;
        const near = sh.prims.some((p) => p.view === m.view && (p.layer === "OUTLINE" || p.layer === "HIDDEN" || p.layer === "CUT") && lineSegs(p).some(([a, b]) => distToSeg(m.at!, a, b) < m.r! + 0.5));
        if (!near) why.push(`sheet ${sh.meta.sheet}: nothing of joint ${m.letter} inside its marker on view ${m.view}`);
      }
    add("A27", why);
  }

  // A28: no pulled-apart view carries more than eight part numbers (more: split into sub-assemblies)
  {
    const why: string[] = [];
    const per = new Map<string, number>();
    for (const sh of sheets) for (const b of sh.meta.balloons) per.set(`${sh.meta.sheet}:${b.view ?? "?"}`, (per.get(`${sh.meta.sheet}:${b.view ?? "?"}`) ?? 0) + 1);
    for (const [k, n] of per) if (n > 8) why.push(`sheet ${k.split(":")[0]} view ${k.split(":")[1]}: ${n} part numbers on one pulled-apart view`);
    add("A28", why);
  }
  return out;
}

/** The share of the drawing area the boxes cover (2 mm cells, overlaps counted once). */
function usedArea(boxes: Box[]): number {
  const c = 2;
  const nx = Math.ceil((AREA[2] - AREA[0]) / c),
    ny = Math.ceil((AREA[3] - AREA[1]) / c);
  const g = new Uint8Array(nx * ny);
  for (const b of boxes) {
    const i0 = Math.max(0, Math.floor((b[0] - AREA[0]) / c)),
      i1 = Math.min(nx - 1, Math.floor((b[2] - AREA[0]) / c));
    const j0 = Math.max(0, Math.floor((b[1] - AREA[1]) / c)),
      j1 = Math.min(ny - 1, Math.floor((b[3] - AREA[1]) / c));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) g[j * nx + i] = 1;
  }
  return g.reduce((t, v) => t + v, 0) / (nx * ny);
}

/** Two segments cross (not just touch at an end). */
function segsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a),
    d2 = o(c, d, b),
    d3 = o(a, b, c),
    d4 = o(a, b, d);
  const e = 1e-6;
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}

const mmv = (v: number) => String(Math.round(v * 10) / 10);
function distToSeg(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

/** A one-line summary per check, for a report. */
export const summary = (cs: Check[]) => cs.map((c) => `${c.id} ${c.ok ? "pass" : `FAIL: ${c.why.slice(0, 4).join("; ")}${c.why.length > 4 ? ` (+${c.why.length - 4} more)` : ""}`}`).join("\n");
