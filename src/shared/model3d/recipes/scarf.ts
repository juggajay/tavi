// Scarf (Stage 9.2; its kinds, bolts and plates Stage 19.8): two members joined end to end. Frame: the members run along
// x, their depth (width) up z, their thickness along y; the splice runs from x = 0 to its length; the first member is
// on the left, the second on the right. Kinds:
//   plain        one long sloping cut (1 in 8 by default): glued, for long boards in tension or bending;
//   stop_splayed a splay with a square nib at each end, so the halves can't slide along the piece;
//   tabled       stepped halves meeting at a square table in the middle, with a key or a pair of folding wedges in it;
//   halved       a lap: each half cut away for the other.
// Bolts (optional) go square across the joint, through both halves, on the centre line, evenly spaced; with fishplates
// (timber or steel, one each side) the bolts go through plate, member and plate either side of the splice instead.
// Bolt spacing is a rule of thumb (4 bolt diameters from the ends and between bolts, and the member at least 3
// diameters thick), not taken from a standard. None of these is rated for a load: a spliced post or beam that carries a
// floor or a deck needs an engineer's detail, and the model's note says so.
// Where its sizes come from (Stage 20.2's design rules, connected at the merge): a stop-splayed or tabled scarf is four
// times the depth long, the short end of Fairham's framing scarf (4 to 5 times). The halved splice's three times, the
// plain scarf's 1 in 8, the nibs and table (a quarter of the depth) and the bolts' spacing are this recipe's own, from no
// rule on the shelf, so they give no reason with a source.
import type { Solid, Vec3 } from "../../protocol.js";
import { type RPart, type Reader, type Recipe, dim, fmt, prism, refuse, sideCut, span, withCommon } from "./kit.js";
import { timesOf } from "../designRules.js";

/** The kinds whose length is the framing scarf rule's (four times the depth, Fairham). */
const framed = (r: Reader) => r.used.kind === "stop_splayed" || r.used.kind === "tabled";

const KINDS = ["plain", "stop_splayed", "tabled", "halved"] as const;
type Kind = (typeof KINDS)[number];
/** Bolt lengths sold (mm); past these, to the next 10. */
const BOLT_LENGTHS = [50, 60, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 220, 240, 260, 280, 300, 320, 350, 400];
const boltLength = (grip: number, d: number) => BOLT_LENGTHS.find((l) => l >= grip + 2 * d) ?? Math.ceil((grip + 2 * d) / 10) * 10;
/** How far the plates run past the splice: a bolt spacing (4 diameters) before, between and after their bolts. */
const plateRun = (bolts: number, d: number) => (bolts + 1) * 4 * d;
/** The length shown either side: 300, or enough to carry the plates and a little more. */
const shown = (r: Reader) => (r.used.plates && r.used.plates !== "none" ? Math.max(300, plateRun(Number(r.used.bolts ?? 0), Number(r.used.bolt_diameter ?? 12)) + 60) : 300);

export const scarf: Recipe = {
  name: "scarf",
  what:
    "two members joined end to end. kind: plain (a long sloping glued cut: boards, trim, rails), stop_splayed (a splay " +
    "with square nibs at both ends that stop it sliding: a piece pushed end on, like a post), tabled (stepped halves " +
    "locked by a key or folding wedges: resists pulling apart, like a plate), halved (a lap: weak alone, wants bolts or " +
    "plates). Optional bolts square across the joint through both halves, and fishplates (timber or steel) each side. " +
    "Bolt spacing is a rule of thumb (4 diameters), not from a standard. None is rated for a load: a spliced post or " +
    "beam carrying a floor or deck needs an engineer's detail, and the note says so",
  members: [
    { name: "first", what: "[width (its depth across the splice), thickness]", default: [90, 45] },
    { name: "second", what: "[width, thickness] (the same section)", default: [90, 45] },
  ],
  params: withCommon([
    { name: "kind", what: "plain, stop_splayed, tabled or halved", kind: "choice", choices: [...KINDS], default: "plain" },
    { name: "slope", what: "a plain scarf's slope, 1 in this many", kind: "ratio", min: 2, max: 16, default: 8 },
    {
      name: "length",
      what: "the splice's length",
      kind: "mm",
      min: 20,
      max: 3000,
      // stop-splayed and tabled: the design rule framing_scarf (Fairham), four times the depth, as before
      default: (r) => (r.used.kind === "plain" ? r.num("slope") * r.members[0][0] : r.used.kind === "halved" ? 3 * r.members[0][0] : timesOf("framing_scarf", r.members[0][0]).value),
      defaultText: "plain: the slope times the width; halved: 3 times the width; the others 4 times",
      because: (r) => (framed(r) ? `length ${fmt(timesOf("framing_scarf", r.members[0][0]).value)} mm: ${timesOf("framing_scarf", r.members[0][0]).why}` : undefined),
    },
    { name: "nib", what: "a stop-splayed scarf's square nibs, how deep", kind: "mm", min: 3, default: (r) => Math.round(r.members[0][0] / 4), defaultText: "a quarter of the width" },
    { name: "table", what: "a tabled scarf's table, how deep", kind: "mm", min: 3, default: (r) => Math.round(r.members[0][0] / 4), defaultText: "a quarter of the width" },
    { name: "key", what: "a tabled scarf's key: none, key or wedges (a pair of folding wedges)", kind: "choice", choices: ["none", "key", "wedges"], default: "key" },
    { name: "key_width", what: "the gap for the key or wedges", kind: "mm", min: 6, default: (r) => Math.max(10, Math.round(r.members[0][0] / 4)), defaultText: "a quarter of the width, at least 10" },
    { name: "plates", what: "fishplates each side: none, timber or steel", kind: "choice", choices: ["none", "timber", "steel"], default: "none" },
    { name: "plate_thickness", what: "the plates' thickness", kind: "mm", min: 2, max: 100, default: (r) => (r.used.plates === "steel" ? 6 : Math.round(r.members[0][1] / 2)), defaultText: "steel 6; timber half the member's thickness" },
    { name: "bolts", what: "how many bolts (with plates: each side of the splice)", kind: "count", min: 0, max: 8, default: (r) => (r.used.plates !== "none" ? 2 : 0), defaultText: "none; with plates 2 each side" },
    { name: "bolt_diameter", what: "the bolts' diameter (M12 is 12)", kind: "mm", min: 6, max: 24, default: 12 },
    { name: "first_length", what: "length shown before the splice", kind: "mm", min: 20, max: 6000, default: (r) => shown(r), defaultText: "300, or past the plates' bolts" },
    { name: "second_length", what: "length shown after the splice", kind: "mm", min: 20, max: 6000, default: (r) => shown(r), defaultText: "300, or past the plates' bolts" },
  ]),
  make(r) {
    const [[w, t], [w2, t2]] = r.members;
    if (Math.abs(w - w2) > 0.01 || Math.abs(t - t2) > 0.01) refuse("both members need the same section for a splice");
    const kind = r.choice<Kind>("kind");
    if (kind === "plain") r.num("slope");
    const Ls = r.num("length");
    const nib = kind === "stop_splayed" ? r.num("nib") : 0;
    const tb = kind === "tabled" ? r.num("table") : 0;
    const key = kind === "tabled" ? r.choice<"none" | "key" | "wedges">("key") : "none";
    const g = key !== "none" ? r.num("key_width") : 0;
    const plates = r.choice<"none" | "timber" | "steel">("plates");
    const tp = plates !== "none" ? r.num("plate_thickness") : 0;
    const nb = r.num("bolts");
    const d = nb > 0 ? r.num("bolt_diameter") : 0;
    const LA = r.num("first_length"),
      LB = r.num("second_length");
    const gap = r.num("fit_gap");
    if (kind === "stop_splayed" && 2 * nib >= w - 6) refuse("the nibs leave no splay between them; make them shallower");
    if (kind === "stop_splayed" && Ls < 2 * w) refuse(`a stop-splayed scarf wants at least twice the width, ${fmt(2 * w)}, to have a splay`);
    if (kind === "tabled" && tb >= w - 6) refuse("the table is as deep as the member");
    if (kind === "tabled" && g >= Ls / 2) refuse("the key's gap takes half the splice");
    if (nb > 0 && gap > 0) refuse("a gap can't be shown with the bolts in; leave the bolts out, or the gap at 0");
    // the rule of thumb for bolts: on the centre line, 4 diameters from the splice's ends and apart, the member at least
    // 3 diameters thick so each bolt has 1.5 diameters to the faces
    const e = 4 * d;
    if (nb > 0 && t < 3 * d) refuse(`an M${fmt(d)} bolt wants a member at least ${fmt(3 * d)} thick (1.5 diameters each side of it, a rule of thumb)`);
    const y0 = -t / 2 - 1,
      y1 = t / 2 + 1;
    const R = LA + LB + Ls + 2 * w + 200;
    const xm = Ls / 2,
      z1 = w / 2 - tb / 2,
      z2 = w / 2 + tb / 2;
    // the cuts that shape each half: the first runs in from the left and keeps the top of the splice, the second from the
    // right and keeps the bottom
    const firstCuts: Solid[] = [],
      secondCuts: Solid[] = [];
    if (kind === "plain") {
      firstCuts.push(sideCut("xz", [0, 0], [Ls, w], [Ls, 0], R, y0, t + 2));
      secondCuts.push(sideCut("xz", [0, 0], [Ls, w], [0, w], R, y0, t + 2));
    } else if (kind === "stop_splayed") {
      // (the first member ends at Ls, so nothing past it is cut: a third cut there removed nothing, Stage 21)
      firstCuts.push(
        span([0, y0, -1], [R, y1, nib]),
        prism(
          "xz",
          [
            [0, nib],
            [R, nib],
            [R, w - nib],
            [Ls, w - nib],
          ],
          y0,
          t + 2,
        ),
      );
      secondCuts.push(
        prism(
          "xz",
          [
            [-1, nib],
            [0, nib],
            [Ls, w - nib],
            [-1, w - nib],
          ],
          y0,
          t + 2,
        ),
        span([-1, y0, w - nib], [Ls, y1, w + 1]),
      );
    } else if (kind === "tabled") {
      firstCuts.push(span([0, y0, -1], [R, y1, z1]), span([xm - g / 2, y0, z1], [R, y1, z2]));
      secondCuts.push(span([-1, y0, z1], [xm + g / 2, y1, z2]), span([-1, y0, z2], [Ls, y1, w + 1]));
    } else {
      firstCuts.push(span([0, y0, -1], [R, y1, w / 2]));
      secondCuts.push(span([-1, y0, w / 2], [Ls, y1, w + 1]));
    }
    // where the bolts go: across the joint (along z, through both halves) in the splice; with plates, along y through
    // plate, member and plate, either side of the splice
    const evenly = (a: number, b: number, n: number) => (n === 1 ? [(a + b) / 2] : Array.from({ length: n }, (_, k) => a + ((b - a) * k) / (n - 1)));
    let boltsAt: { x: number; z: number; axis: "y" | "z" }[] = [];
    let pe = 0;
    if (nb > 0 && plates === "none") {
      if (Ls < (nb + 1) * e - 1e-6) refuse(`${nb === 1 ? "an" : nb} M${fmt(d)} bolt${nb === 1 ? "" : "s"} want${nb === 1 ? "s" : ""} a splice at least ${fmt((nb + 1) * e)} long (4 diameters from each end and between bolts, a rule of thumb)`);
      let xs = evenly(e, Ls - e, nb);
      // a tabled scarf's bolts keep clear of the key (or wedges) in the middle, either side of it
      if (kind === "tabled") {
        const clear = g / 2 + d / 2 + 3;
        if (xs.some((x) => Math.abs(x - xm) < clear)) {
          const left = Math.ceil(nb / 2),
            right = nb - left;
          const L = [e, xm - clear],
            Rz = [xm + clear, Ls - e];
          const fits = (z: number[], n: number) => n === 0 || (n === 1 ? z[1] >= z[0] : (z[1] - z[0]) / (n - 1) >= e - 1e-6);
          if (!fits(L, left) || !fits(Rz, right)) refuse(`${nb} M${fmt(d)} bolts won't fit either side of the table; use fewer or a longer splice`);
          xs = [...(left ? evenly(L[0], Math.max(L[0], L[1]), left) : []), ...(right ? evenly(Math.min(Rz[0], Rz[1]), Rz[1], right) : [])];
        }
      }
      boltsAt = xs.map((x) => ({ x, z: 0, axis: "z" as const }));
    }
    if (plates !== "none") {
      if (nb < 1) refuse("fishplates need bolts through them; give at least one each side");
      pe = plateRun(nb, d);
      const left = evenly(-pe + e, -e, nb),
        right = evenly(Ls + e, Ls + pe - e, nb);
      boltsAt = [...left, ...right].map((x) => ({ x, z: w / 2, axis: "y" as const }));
      if (LA < pe + 10 || LB < pe + 10) refuse(`the members shown need to run at least ${fmt(pe + 10)} past the splice for the plates`);
    }
    const hole = (b: { x: number; z: number; axis: "y" | "z" }, extra: number): Solid =>
      b.axis === "z" ? { type: "cyl", r: d / 2, h: w + 2 * extra, axis: "z", at: [b.x, 0, -extra] } : { type: "cyl", r: d / 2, h: t + 2 * tp + 2 * extra, axis: "y", at: [b.x, -t / 2 - tp - extra, b.z] };
    for (const b of boltsAt) {
      // each bolt's hole in whichever halves it goes through
      const inFirst = b.axis === "z" || b.x < Ls,
        inSecond = b.axis === "z" || b.x > 0;
      if (inFirst) firstCuts.push(hole(b, 1));
      if (inSecond) secondCuts.push(hole(b, 1));
    }
    const moves = kind === "plain" ? ([80, 0, 0] as Vec3) : ([0, 0, -(w + 60)] as Vec3);
    const parts: RPart[] = [
      { id: "first", name: "First member", material: r.material, grain: "x", stock: { type: "box", size: [LA + Ls, t, w], at: [-LA, -t / 2, 0] }, cuts: firstCuts },
      { id: "second", name: "Second member", material: r.material, grain: "x", stock: { type: "box", size: [Ls + LB, t, w], at: [0, -t / 2, 0] }, cuts: secondCuts, apart: moves, moves: true },
    ];
    if (key === "key") parts.push({ id: "key", name: "Key", material: "hardwood", grain: "y", stock: { type: "box", size: [g, t, tb], at: [xm - g / 2, -t / 2, z1] }, apart: [0, -(t + 60), 0] });
    if (key === "wedges")
      parts.push(
        {
          id: "wedge1",
          name: "Folding wedge",
          material: "hardwood",
          grain: "y",
          stock: prism(
            "xy",
            [
              [xm - g / 2, -t / 2],
              [xm + g / 2, -t / 2],
              [xm - g / 2, t / 2],
            ],
            z1,
            tb,
          ),
          apart: [0, -(t + 60), 0],
        },
        {
          id: "wedge2",
          name: "Folding wedge",
          material: "hardwood",
          grain: "y",
          stock: prism(
            "xy",
            [
              [xm + g / 2, -t / 2],
              [xm + g / 2, t / 2],
              [xm - g / 2, t / 2],
            ],
            z1,
            tb,
          ),
          apart: [0, t + 60, 0],
        },
      );
    if (plates !== "none") {
      const L = Ls + 2 * pe;
      const plateHoles = (side: number): Solid[] => boltsAt.map((b) => ({ type: "cyl" as const, r: d / 2, h: tp + 2, axis: "y" as const, at: [b.x, side < 0 ? -t / 2 - tp - 1 : t / 2 - 1, b.z] as Vec3 }));
      for (const side of [-1, 1])
        parts.push({
          id: side < 0 ? "plate1" : "plate2",
          name: plates === "steel" ? "Steel plate" : "Fishplate",
          material: plates === "steel" ? "steel" : r.material,
          grain: "x",
          stock: { type: "box", size: [L, tp, w], at: [-pe, side < 0 ? -t / 2 - tp : t / 2, 0] },
          cuts: plateHoles(side),
          apart: [0, side * (tp + 80), 0],
        });
    }
    // each bolt: a length sold, long enough for what it goes through plus washers, the nut and a thread or two (twice
    // its diameter, a rule of thumb); its head side a washer's thickness out from the face
    const grip = (b: (typeof boltsAt)[number]) => (b.axis === "z" ? w : t + 2 * tp);
    boltsAt.forEach((b, k) => {
      const lb = boltLength(grip(b), d);
      const wash = Math.round(d / 4);
      parts.push({
        id: `bolt${k + 1}`,
        name: `Bolt ${k + 1}, M${fmt(d)}`,
        material: "steel",
        grain: b.axis,
        stock: b.axis === "z" ? { type: "cyl", r: d / 2, h: lb, axis: "z", at: [b.x, 0, -wash] } : { type: "cyl", r: d / 2, h: lb, axis: "y", at: [b.x, -t / 2 - tp - wash, b.z] },
        apart: b.axis === "z" ? [0, 0, w + 120] : [0, -(t + 2 * tp + 120), 0],
      });
    });
    // the note: what it is, what it suits in plain words (never that it's strong enough), and the engineer line
    const words: Record<Kind, string> = { plain: `A 1 in ${fmt(Ls / w)} scarf`, stop_splayed: `Stop-splayed scarf, ${fmt(nib)} nibs`, tabled: `Tabled scarf, ${fmt(tb)} table${key !== "none" ? (key === "key" ? ", keyed" : ", wedged") : ""}`, halved: "Halved splice" };
    const suits: Record<Kind, string> = {
      plain: "Glued; for boards and trim.",
      stop_splayed: "Nibs stop it sliding; suits end-on load.",
      tabled: key === "none" ? "Tables stop it sliding." : "Key locks it; resists pulling apart.",
      halved: "Weak alone; needs bolts or plates.",
    };
    const nbt = boltsAt.length;
    const fix = nbt ? `, ${nbt} M${fmt(d)} bolt${nbt === 1 ? "" : "s"}${plates !== "none" ? `, ${plates} plates` : ""}` : "";
    const engineer = "A spliced post or beam carrying a floor or deck needs an engineer's detail.";
    const say = [`${words[kind]}, ${fmt(Ls)} long${fix}.`, suits[kind], nbt ? "Bolts spaced by rule of thumb." : "", engineer];
    // the engineer line always stays; then the rule-of-thumb words; the suitability goes first if it's too long
    let note = say.filter(Boolean).join(" ");
    if (note.length > 200) note = [say[0], say[2], engineer].filter(Boolean).join(" ");
    if (note.length > 200) note = [say[0], engineer].join(" ");
    return {
      parts,
      dims: [dim([0, -t / 2, -25], [Ls, -t / 2, -25], { show: "together" }), dim([-LA - 25, -t / 2, 0], [-LA - 25, -t / 2, w])],
      note,
    };
  },
};
