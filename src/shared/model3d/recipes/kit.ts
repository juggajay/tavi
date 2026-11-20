// What every joint recipe (Stage 9.2) shares: reading the member sections and sizes it was given (with the defaults it
// used, so the assistant can say what it assumed), refusing sizes that can't work with a plain reason, a few shape
// helpers, and the finishing step that opens the joint by fit_gap. Pure functions; millimetres; z up.
import type { Dim3, ModelMaterial, ModelPart, ModelPayload, Solid, Vec3 } from "../../protocol.js";

export type Sec = [number, number];
export type ParamValue = number | string | boolean;
export type ParamSpec = {
  name: string;
  what: string;
  kind: "mm" | "deg" | "count" | "ratio" | "choice" | "bool";
  choices?: string[];
  /** A fixed default, or one worked out from the members (with words for the list). */
  default?: ParamValue | ((r: Reader) => ParamValue | undefined);
  defaultText?: string;
  /**
   * Why the default is what it is, with its source (Stage 20.2, designRules.ts): "tenon 15 mm: a third of the 45 mm rail
   * (Fairham)". Nothing when this default isn't the rule's (the scarf's length for a halved splice).
   */
  because?: (r: Reader) => string | undefined;
  min?: number;
  max?: number;
};
export type MemberSpec = { name: string; what: string; default: Sec };

/** A size that can't work, in words the assistant can pass on ("the tenon is thicker than the rail"). */
export class RecipeError extends Error {}
export const refuse = (why: string): never => {
  throw new RecipeError(why);
};

/** A part the recipe made; moves: it's the one fit_gap slides along its apart direction. */
export type RPart = ModelPart & { moves?: boolean };
export type Made = { parts: RPart[]; dims?: Dim3[]; note?: string };

export type Recipe = {
  name: string;
  what: string;
  members: MemberSpec[];
  params: ParamSpec[];
  make: (r: Reader) => Made;
};

const FIT_GAP: ParamSpec = { name: "fit_gap", what: "opens the joint by this much so it reads better on screen (0: the parts touch exactly)", kind: "mm", default: 0, min: 0, max: 50 };
export const withCommon = (params: ParamSpec[]) => [...params, FIT_GAP];

export type RecipeInput = { members?: unknown; params?: Record<string, unknown>; material?: ModelMaterial };

export class Reader {
  readonly members: Sec[];
  readonly material: ModelMaterial;
  /** Everything it used that wasn't given, as the assistant should say it. */
  readonly assumed: Record<string, ParamValue> = {};
  readonly used: Record<string, ParamValue> = {};
  /** For each default taken from a design rule: why, with its source (20.2). */
  readonly basis: Record<string, string> = {};
  private given: Record<string, unknown>;
  constructor(
    private recipe: Recipe,
    input: RecipeInput,
  ) {
    this.material = input.material ?? "pine";
    this.given = { ...(input.params ?? {}) };
    const known = new Set(recipe.params.map((p) => p.name));
    for (const k of Object.keys(this.given)) if (!known.has(k)) refuse(`${recipe.name} doesn't take "${k}". It takes: ${recipe.params.map((p) => p.name).join(", ")}.`);
    const raw = input.members;
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : refuse("members is a list of sections, each [width, thickness] in mm, e.g. [[90, 45], [90, 90]].");
    if (list.length > recipe.members.length) refuse(`${recipe.name} joins ${recipe.members.length} members: ${recipe.members.map((m) => m.name).join(" and ")}.`);
    this.members = recipe.members.map((m, i) => {
      const s = list[i];
      if (s === undefined) {
        this.assumed[m.name] = `${m.default[0]} x ${m.default[1]}`;
        return [...m.default] as Sec;
      }
      if (!Array.isArray(s) || s.length !== 2 || !s.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 5000))
        return refuse(`The ${m.name} needs a section [width, thickness] in mm, each above zero and at most 5000.`);
      return [s[0], s[1]] as Sec;
    });
    recipe.members.forEach((m, i) => (this.used[m.name] = `${this.members[i][0]} x ${this.members[i][1]}`));
  }
  private spec(name: string) {
    const s = this.recipe.params.find((p) => p.name === name);
    if (!s) throw new Error(`recipe ${this.recipe.name} reads unknown param ${name}`);
    return s;
  }
  private value(name: string): ParamValue | undefined {
    const s = this.spec(name);
    if (this.given[name] !== undefined) return this.given[name] as ParamValue;
    const d = typeof s.default === "function" ? s.default(this) : s.default;
    if (d !== undefined) this.assumed[name] = d;
    const why = d !== undefined && s.because ? s.because(this) : undefined;
    if (why) this.basis[name] = why;
    return d;
  }
  /** A size or count; refused in words when it's not a number or out of range. */
  num(name: string): number {
    const s = this.spec(name);
    const v = this.value(name);
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) return refuse(`${name} needs to be a number${s.kind === "mm" ? " in mm" : s.kind === "deg" ? " in degrees" : ""}.`);
    if (s.kind === "count" && !Number.isInteger(n)) return refuse(`${name} needs to be a whole number.`);
    if (s.min !== undefined && n < s.min) return refuse(`${name} needs to be at least ${s.min}${s.kind === "mm" ? " mm" : s.kind === "deg" ? "°" : ""}.`);
    if (s.max !== undefined && n > s.max) return refuse(`${name} can be at most ${s.max}${s.kind === "mm" ? " mm" : s.kind === "deg" ? "°" : ""}.`);
    if (s.kind === "mm" && n < 0) return refuse(`${name} can't be below zero.`);
    this.used[name] = n;
    return n;
  }
  /** A size that's only used when given (no default). */
  maybe(name: string): number | undefined {
    if (this.given[name] === undefined) return undefined;
    return this.num(name);
  }
  choice<T extends string>(name: string): T {
    const s = this.spec(name);
    const v = this.value(name);
    if (typeof v !== "string" || !s.choices!.includes(v)) return refuse(`${name} is one of: ${s.choices!.join(", ")}.`);
    this.used[name] = v;
    return v as T;
  }
  bool(name: string): boolean {
    const v = this.value(name);
    const b = v === true || v === "true" || v === "yes" ? true : v === false || v === "false" || v === "no" || v === undefined ? false : refuse(`${name} is true or false.`);
    this.used[name] = b;
    return b;
  }
  /** Was this one given (rather than assumed)? */
  has(name: string) {
    return this.given[name] !== undefined;
  }
}

/* ---------------- shape helpers ---------------- */

/** A box from its minimum corner to its maximum corner. */
export const span = (min: Vec3, max: Vec3): Solid => ({ type: "box", size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], at: min });

type P2 = [number, number];
const atFor = (plane: "xy" | "xz" | "yz", from: number): Vec3 => (plane === "xy" ? [0, 0, from] : plane === "xz" ? [0, from, 0] : [from, 0, 0]);

/** A prism in a plane, pushed from `from` through `depth`. */
export const prism = (plane: "xy" | "xz" | "yz", points: P2[], from: number, depth: number): Solid => ({ type: "prism", plane, points, depth, at: atFor(plane, from) });

/**
 * A cut taking away everything on one side of the line through p1 and p2 (drawn in a prism plane): `away` is any point
 * on the side to remove; reach is how far past the part it goes.
 */
export function sideCut(plane: "xy" | "xz" | "yz", p1: P2, p2: P2, away: P2, reach: number, from: number, depth: number): Solid {
  const l = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const t: P2 = [(p2[0] - p1[0]) / l, (p2[1] - p1[1]) / l];
  let n: P2 = [-t[1], t[0]];
  if ((away[0] - p1[0]) * n[0] + (away[1] - p1[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const a: P2 = [p1[0] - t[0] * reach, p1[1] - t[1] * reach];
  const b: P2 = [p2[0] + t[0] * reach, p2[1] + t[1] * reach];
  return prism(plane, [a, b, [b[0] + n[0] * reach, b[1] + n[1] * reach], [a[0] + n[0] * reach, a[1] + n[1] * reach]], from, depth);
}

/**
 * The whole joint turned a quarter turn about z (x becomes y, y becomes -x), for a corner joint built along +x and +y:
 * turned, its outside corner faces the usual three-quarter view, which shows the joint best.
 */
export function quarterTurn(made: Made): Made {
  const t = (p: Vec3): Vec3 => [-p[1], p[0], p[2]];
  return {
    ...made,
    parts: made.parts.map((p) => ({ ...p, rot: [0, 0, 90], at: t(p.at ?? [0, 0, 0]), ...(p.apart ? { apart: t(p.apart) } : {}) })),
    dims: made.dims?.map((d) => ({ ...d, a: t(d.a), b: t(d.b) })),
  };
}

export const dim = (a: Vec3, b: Vec3, o: Omit<Dim3, "a" | "b"> = {}): Dim3 => ({ a, b, ...o });
const r3 = (v: number) => Math.round(v * 1000) / 1000;
export const fmt = (v: number) => String(Math.round(v * 10) / 10);

/** Opens the joint by gap along each moving part's apart direction (its sizes go with it), and tidies the numbers. */
export function finish(made: Made, gap: number): Pick<ModelPayload, "parts" | "dims" | "note"> {
  const shift = new Map<string, Vec3>();
  const parts: ModelPart[] = made.parts.map(({ moves, ...p }) => {
    if (!moves || !gap || !p.apart) return p;
    const l = Math.hypot(...p.apart) || 1;
    const d: Vec3 = [(p.apart[0] / l) * gap, (p.apart[1] / l) * gap, (p.apart[2] / l) * gap];
    shift.set(p.id, d);
    const at = p.at ?? [0, 0, 0];
    return { ...p, at: [r3(at[0] + d[0]), r3(at[1] + d[1]), r3(at[2] + d[2])] };
  });
  const dims = (made.dims ?? []).map((x) => {
    const d = x.part ? shift.get(x.part) : undefined;
    return d ? { ...x, a: [x.a[0] + d[0], x.a[1] + d[1], x.a[2] + d[2]] as Vec3, b: [x.b[0] + d[0], x.b[1] + d[1], x.b[2] + d[2]] as Vec3 } : x;
  });
  return { parts, ...(dims.length ? { dims } : {}), ...(made.note ? { note: made.note } : {}) };
}
