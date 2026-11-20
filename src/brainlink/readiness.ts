// The Brain's readiness check (/api/doctor) in plain words (Stage 16.1). Reported, never fixed: the fixes are its own
// (its Settings page shows them), and the assistant has no way to run them. Names and email addresses in its git check
// are left out.
import type { Doctor } from "./client.js";

const PLAIN: Record<string, (detail: string) => string> = {
  git: () => "it can't save to its records: git isn't installed on this PC",
  "git-identity": () => "it can't save to its records yet: git doesn't know your name and email",
  claude: () => "it can't think: there's no Claude login or API key on this PC",
  python: () => "it can't run its measuring scripts: Python isn't installed",
  "pack-python": (d) => `some of its measuring tools are missing (${d.replace(/^missing:\s*/i, "")})`,
  tesseract: () => "it can't read scanned drawings on this PC yet: the OCR program (Tesseract) is missing",
  standards: () => "it hasn't got the AS 1684.2 span tables, so it will flag member sizes for you to confirm instead of sizing them",
};

export type Readiness = { ready: boolean; full: boolean; say: string; gaps: string[]; billing: string | null };

export function plainReadiness(d: Doctor): Readiness {
  const missing = d.checks.filter((c) => !c.ok);
  const blocking = missing.filter((c) => c.required).map((c) => (PLAIN[c.id] ?? (() => `${c.label} isn't ready`))(c.detail));
  const gaps = missing.filter((c) => !c.required).map((c) => (PLAIN[c.id] ?? (() => `${c.label} isn't ready`))(c.detail));
  const claude = d.checks.find((c) => c.id === "claude");
  // Its doctor says which way it pays: a saved API key bills his Anthropic Console account, not his subscription.
  const billing = claude?.ok ? (/^\s*api key saved/i.test(claude.detail) ? "It's using a saved API key, so its jobs bill your Anthropic Console account." : "It's using your Claude login on this PC.") : null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let say: string;
  if (blocking.length) say = `It can't run jobs on this PC yet: ${blocking.join("; ")}.`;
  else if (gaps.length) say = `It's ready to run jobs, with ${gaps.length === 1 ? "one gap" : "some gaps"}: ${gaps.join("; ")}.`;
  else say = "It's ready to run jobs: everything it checks is there.";
  return { ready: d.ok, full: d.ok && !gaps.length, say: cap(say), gaps, billing };
}
