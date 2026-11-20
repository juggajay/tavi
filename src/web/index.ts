import { audit } from "../store/log.js";
import { getSettings } from "../store/settings.js";
import { noteOutsideRead, type TurnCtx } from "../brain/turn.js";
import { recordSource } from "../brain/sourceLedger.js";
import { guardClient } from "../hq/guardClient.js";
import { checkAddress, type Resolve } from "./addresses.js";
import { privateWords, privacyReason, type PrivateWords } from "./privacy.js";
import { claudeBackend, codexBackend, parseAnswer, type Backend, type Request, type Answer, type Page } from "./backends.js";

export type WebOptions = {
  backends?: { codex: Backend; claude: Backend }; first?: () => "codex" | "claude";
  known?: () => PrivateWords; resolve?: Resolve; level?: () => string; timeoutMs?: number;
};
let currentLevel = () => guardClient().level() as string;
export function installWebLevel(level: () => string) {
  const previous = currentLevel; currentLevel = level;
  return () => { if (currentLevel === level) currentLevel = previous; };
}
export function createWeb(o: WebOptions = {}) {
  const counts = new WeakMap<TurnCtx, number>();
  const busy = new WeakSet<TurnCtx>();
  const backends = o.backends ?? { codex: codexBackend(), claude: claudeBackend() };
  return async (ctx: TurnCtx, r: Request, parent?: AbortSignal, usedTokens?: (tokens: number) => void): Promise<Answer> => {
    const level = o.level ?? (() => currentLevel());
    if (level() !== "open") throw new Error("The safety switch has stopped web look-ups.");
    if (busy.has(ctx)) throw new Error("Wait for the current look-up to finish before starting another.");
    const count = counts.get(ctx) ?? 0;
    if (count >= 20) throw new Error("This turn has used twenty look-ups. Give what you have and ask for a fresh turn if more is needed.");
    const known = (o.known ?? privateWords)();
    const reason = r.kind === "search" ? privacyReason(`${r.query} ${r.recent ?? ""}`, known)
      : privacyReason(r.url, known, "address") ?? (r.about ? privacyReason(r.about, known) : null);
    if (reason) throw new Error(reason);
    busy.add(ctx); counts.set(ctx, count + 1);
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent?.addEventListener("abort", abort, { once: true }); if (parent?.aborted) abort();
    const timeout = setTimeout(abort, o.timeoutMs ?? 60000);
    const safety = setInterval(() => { if (level() !== "open") abort(); }, 100);
    const bounded = async <T>(promise: Promise<T>, signal = controller.signal) => {
      signal.throwIfAborted();
      let stop!: () => void;
      try { return await Promise.race([promise, new Promise<never>((_, reject) => { stop = () => reject(new Error("The look-up stopped or took too long. Try a narrower question later.")); signal.addEventListener("abort", stop, { once: true }); })]); }
      finally { signal.removeEventListener("abort", stop); }
    };
    try {
      if (r.kind === "read") await bounded(checkAddress(r.url, o.resolve));
      const first = o.first?.() ?? getSettings()["web.first"];
      let answer: Answer | undefined;
      let used = first;
      let timedOut = false;
      let why = ""; // for a page: the plain reason this PC could not read it
      // A page is always read by this PC first (the "codex" side reads it directly, with no model); the other is the fallback.
      const order = r.kind === "read" ? ["codex", "claude"] as const : [first, first === "codex" ? "claude" : "codex"] as const;
      for (const name of order) {
        used = name;
        const attempt = new AbortController();
        // The first try gets two thirds of the time; whatever is left goes to the fallback.
        const attemptTimer = setTimeout(() => attempt.abort(), Math.max(1, Math.floor((o.timeoutMs ?? 60000) * 2 / 3)));
        const signal = AbortSignal.any([controller.signal, attempt.signal]);
        try {
          signal.throwIfAborted();
          const candidate = parseAnswer(r, await bounded(backends[name](r, signal, known, ctx.test, usedTokens), signal));
          if ("results" in candidate) {
            // A result that fails a check is left out; one bad address does not lose the other nine.
            const kept = (await Promise.all(candidate.results.map(async (entry) => {
              if (privacyReason(entry.url, known, "address")) return null;
              try { await bounded(checkAddress(entry.url, o.resolve), signal); return entry; } catch { return null; }
            }))).filter((entry) => entry !== null);
            if (candidate.results.length && !kept.length) throw new Error("No result passed the checks.");
            answer = { results: kept };
          } else {
            const why = privacyReason(candidate.url, known, "address"); if (why) throw new Error(why);
            await bounded(checkAddress(candidate.url, o.resolve), signal);
            answer = candidate;
          }
          break;
        }
        catch (error) {
          if (r.kind === "read" && name === "codex" && error instanceof Error) why ||= error.message;
          if (controller.signal.aborted) throw new Error("The look-up took too long or was stopped. Try a narrower question later.");
          timedOut ||= attempt.signal.aborted;
        }
        finally { clearTimeout(attemptTimer); attempt.abort(); }
      }
      if (!answer) throw new Error(why && !timedOut ? why : timedOut ? "The look-up took too long. Try a narrower question later." : "Neither web service could return a checked answer. Check the sign-ins or try another public source later.");
      const entries = "results" in answer ? answer.results : [answer];
      if (level() !== "open" || controller.signal.aborted) throw new Error("The safety switch or time limit stopped this look-up.");
      noteOutsideRead(ctx, r.kind === "search" ? "WebSearch" : "WebFetch");
      if (ctx.test) ctx.turn.persist = false;
      // A search extract is a lead. Only a page actually read becomes a cited source.
      if (r.kind === "read") for (const entry of entries) recordSource(ctx.turn, { kind: "web", rung: null, what: entry.title, place: entry.url, ...(entry.date ? { date: entry.date } : {}), tool: "mcp__web__read" });
      if (!ctx.test) audit("brain", "web.lookup", ctx.turn.job_id, { backend: r.kind === "read" && used === "codex" ? "direct" : used, kind: r.kind });
      if ("text" in answer && answer.text.length > 16000) answer = { ...answer, text: answer.text.slice(0, 16000), cut: true } satisfies Page;
      return answer;
    } finally { clearTimeout(timeout); clearInterval(safety); parent?.removeEventListener("abort", abort); busy.delete(ctx); }
  };
}
export const lookupWeb = createWeb();
