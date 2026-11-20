// A small calculator (Stage 8.3): a parser written for the job. Nothing here ever runs text as code (no eval, no
// Function): the expression is read character by character into numbers, operators and a fixed list of names.
//
//   numbers, + - * / ^ (power, right to left), brackets, and: sqrt abs round floor ceil min max pi,
//   sin cos tan in degrees, asin acos atan giving degrees.
//
// Limits: 300 characters, brackets and calls nested at most 20 deep. Bad input is a plain error naming the spot.

export const MAX_CHARS = 300;
export const MAX_DEPTH = 20;

export class CalcError extends Error {}

type Tok = { t: "num"; v: number; at: number } | { t: "name"; v: string; at: number } | { t: "op"; v: string; at: number } | { t: "end"; at: number };

const RAD = Math.PI / 180;
const FUNCS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  sqrt: { min: 1, max: 1, fn: (x) => Math.sqrt(x) },
  abs: { min: 1, max: 1, fn: (x) => Math.abs(x) },
  // round(x) to a whole number, round(x, n) to n decimal places
  round: { min: 1, max: 2, fn: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n },
  floor: { min: 1, max: 1, fn: (x) => Math.floor(x) },
  ceil: { min: 1, max: 1, fn: (x) => Math.ceil(x) },
  min: { min: 1, max: 50, fn: (...a) => Math.min(...a) },
  max: { min: 1, max: 50, fn: (...a) => Math.max(...a) },
  sin: { min: 1, max: 1, fn: (d) => Math.sin(d * RAD) },
  cos: { min: 1, max: 1, fn: (d) => Math.cos(d * RAD) },
  tan: { min: 1, max: 1, fn: (d) => Math.tan(d * RAD) },
  asin: { min: 1, max: 1, fn: (x) => Math.asin(x) / RAD },
  acos: { min: 1, max: 1, fn: (x) => Math.acos(x) / RAD },
  atan: { min: 1, max: 1, fn: (x) => Math.atan(x) / RAD },
};
const CONSTS: Record<string, number> = { pi: Math.PI };

const show = (src: string, at: number) => `at character ${at + 1} ("${src.slice(Math.max(0, at - 8), at)}▸${src.slice(at, at + 8)}")`;

function tokenise(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw new CalcError(`That number doesn't read right ${show(src, i)}.`);
      out.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      // a thousands comma inside a number ("3,600") is a mistake worth naming, not a second argument
      continue;
    }
    if (/[a-z]/i.test(c)) {
      const m = /^[a-z][a-z0-9_]*/i.exec(src.slice(i))!;
      const name = m[0].toLowerCase();
      if (!(name in FUNCS) && !(name in CONSTS)) throw new CalcError(`I don't know "${m[0]}" ${show(src, i)}. I know numbers, + - * / ^, brackets, and ${[...Object.keys(FUNCS), ...Object.keys(CONSTS)].join(", ")}.`);
      out.push({ t: "name", v: name, at: i });
      i += m[0].length;
      continue;
    }
    if ("+-*/^(),×÷".includes(c)) {
      out.push({ t: "op", v: c === "×" ? "*" : c === "÷" ? "/" : c, at: i });
      i++;
      continue;
    }
    throw new CalcError(`I can't use "${c}" ${show(src, i)}.`);
  }
  out.push({ t: "end", at: src.length });
  return out;
}

/** The value of an expression, or a CalcError saying where it went wrong. */
export function evaluate(src: string): number {
  if (typeof src !== "string" || !src.trim()) throw new CalcError("Give me something to work out.");
  if (src.length > MAX_CHARS) throw new CalcError(`That's over ${MAX_CHARS} characters; break it into steps.`);
  const toks = tokenise(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === "op" && (peek() as { v: string }).v === v;
  const deeper = (at: number) => {
    if (++depth > MAX_DEPTH) throw new CalcError(`Nested more than ${MAX_DEPTH} deep ${show(src, at)}; break it into steps.`);
  };

  function expr(): number {
    let v = term();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  function term(): number {
    let v = unary();
    while (isOp("*") || isOp("/")) {
      const op = (toks[p++] as { v: string }).v;
      const at = peek().at;
      const r = unary();
      if (op === "/" && r === 0) throw new CalcError(`Dividing by zero ${show(src, at)}.`);
      v = op === "*" ? v * r : v / r;
    }
    return v;
  }
  function unary(): number {
    if (isOp("-") || isOp("+")) {
      const op = (toks[p] as { v: string }).v;
      deeper(toks[p++].at);
      const v = unary();
      depth--;
      return op === "-" ? -v : v;
    }
    return power();
  }
  function power(): number {
    const base = primary();
    if (isOp("^")) {
      deeper(toks[p++].at);
      const e = unary(); // right to left: 2^3^2 is 2^9
      depth--;
      return base ** e;
    }
    return base;
  }
  function primary(): number {
    const tok = peek();
    if (tok.t === "num") {
      p++;
      return tok.v;
    }
    if (tok.t === "name") {
      p++;
      if (tok.v in CONSTS) {
        if (isOp("(")) throw new CalcError(`${tok.v} is a number, not something to call ${show(src, peek().at)}.`);
        return CONSTS[tok.v];
      }
      const f = FUNCS[tok.v];
      if (!isOp("(")) throw new CalcError(`${tok.v} needs brackets, like ${tok.v}(2) ${show(src, peek().at)}.`);
      deeper(toks[p++].at);
      const args: number[] = [];
      if (!isOp(")")) {
        args.push(expr());
        while (isOp(",")) {
          p++;
          args.push(expr());
        }
      }
      if (!isOp(")")) throw new CalcError(`A bracket isn't closed ${show(src, peek().at)}.`);
      p++;
      depth--;
      if (args.length < f.min || args.length > f.max) throw new CalcError(`${tok.v} takes ${f.min === f.max ? f.min : `${f.min} to ${f.max}`} ${f.max === 1 ? "number" : "numbers"} ${show(src, tok.at)}.`);
      return f.fn(...args);
    }
    if (tok.t === "op" && tok.v === "(") {
      deeper(tok.at);
      p++;
      const v = expr();
      if (!isOp(")")) throw new CalcError(`A bracket isn't closed ${show(src, peek().at)}.`);
      p++;
      depth--;
      return v;
    }
    if (tok.t === "end") throw new CalcError(`It stops before it's finished ${show(src, tok.at)}.`);
    throw new CalcError(`I didn't expect "${tok.v}" ${show(src, tok.at)}.`);
  }

  const v = expr();
  const rest = peek();
  if (rest.t !== "end") throw new CalcError(rest.t === "op" && rest.v === ")" ? `There's a closing bracket with no opening one ${show(src, rest.at)}.` : rest.t === "op" && rest.v === "," ? `A comma only goes between a function's numbers ${show(src, rest.at)} (write 3600, not 3,600).` : `I didn't expect that ${show(src, rest.at)}.`);
  if (!Number.isFinite(v)) throw new CalcError(Number.isNaN(v) ? "That has no answer (for example the square root of a negative number)." : "That comes out infinitely large.");
  return v;
}

/** A sensibly rounded figure: whole numbers stay whole; 10 and over to one decimal place; smaller to three. */
export function tidy(v: number): number {
  if (Number.isInteger(v)) return v;
  const r = Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

export function calculate(expression: string) {
  const exact = evaluate(expression);
  return { expression, exact, rounded: tidy(exact) };
}
