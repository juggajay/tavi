// The round table's guest (Stage 17.1): one per round table. Its first turn starts a Codex conversation; later turns
// resume it, so each turn only needs what was said since. One turn at a time, a hard time limit on each, an empty working
// folder of its own, and everything sent and received written to the audit log ("what does Tim know?" reads it back).
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../store/db.js";
import { audit } from "../store/log.js";
import { getSettings } from "../store/settings.js";
import { archiveCodex, failLine, runCodex, type CodexFail, type CodexResult, type Effort } from "./codex.js";

export type GuestReply = { ok: true; text: string; ms: number } | { ok: false; why: CodexFail | "busy" | "off"; line: string; ms: number };
export type Sent = { at: string; kind: "turn" | "review"; prompt: string };

/** Everything the guest needs from settings, read when it's brought in. */
export function guestConfig() {
  const s = getSettings();
  return {
    enabled: s["guest.enabled"],
    name: s["guest.name"],
    model: s["guest.model"],
    effort: s["guest.effort"] as Effort,
    deepModel: s["guest.deep_model"],
    deepEffort: s["guest.deep_effort"] as Effort,
    rounds: s["guest.rounds"],
    timeoutMs: s["guest.timeout_s"] * 1000,
    voice: s["guest.voice"],
  };
}

type Run = typeof runCodex;

export class Guest {
  readonly dir: string;
  session: string | null = null;
  private inFlight = false;
  private deepInFlight = false;
  /** Everything sent to it this round table, in order. */
  readonly sent: Sent[] = [];
  /** Every Codex conversation this round table started (to archive at the end). */
  private sessions = new Set<string>();

  constructor(
    readonly tableId: string,
    readonly cfg = guestConfig(),
    private run: Run = runCodex,
  ) {
    // An empty folder made for this round table, under the data folder; nothing is ever put in it.
    this.dir = path.join(DATA_DIR, "guest", tableId.replace(/[^\w-]/g, ""));
    mkdirSync(this.dir, { recursive: true });
  }

  get busy() {
    return this.inFlight;
  }

  private note(r: CodexResult) {
    if (r.session) this.sessions.add(r.session);
  }

  private send(prompt: string, signal?: AbortSignal) {
    this.sent.push({ at: new Date().toISOString(), kind: "turn", prompt });
    audit("guest", "sent", this.tableId, { session: this.session, model: this.cfg.model, effort: this.cfg.effort, prompt });
    return this.run({ prompt, model: this.cfg.model, effort: this.cfg.effort, session: this.session, cwd: this.dir, timeoutMs: this.cfg.timeoutMs, signal });
  }

  /** One live turn. build(fresh) writes the prompt: fresh when there's no conversation yet to resume (the whole table),
   * otherwise only what's new. Refused (never queued) while another turn is still running. signal: the owner cut in. */
  async turn(build: (fresh: boolean) => string, signal?: AbortSignal): Promise<GuestReply> {
    if (!this.cfg.enabled) return { ok: false, why: "off", line: `${this.cfg.name} is switched off in Settings.`, ms: 0 };
    if (this.inFlight) return { ok: false, why: "busy", line: `${this.cfg.name} is still on the last one.`, ms: 0 };
    this.inFlight = true;
    try {
      let r = await this.send(build(!this.session), signal);
      this.note(r);
      // A conversation that can't be resumed (gone from his Codex history): once more, from the start, with the whole table.
      if (!r.ok && r.why === "failed" && this.session && !signal?.aborted && /session|thread|conversation|not found|no such/i.test(r.detail)) {
        audit("guest", "lost_session", this.tableId, { session: this.session, detail: r.detail });
        this.session = null;
        r = await this.send(build(true), signal);
        this.note(r);
      }
      if (r.ok) {
        this.session = r.session;
        audit("guest", "said", this.tableId, { session: r.session, ms: r.ms, text: r.text, usage: r.usage });
        return { ok: true, text: r.text, ms: r.ms };
      }
      if (r.session && !this.session && r.why !== "tool") this.session = r.session;
      audit("guest", "failed", this.tableId, { why: r.why, detail: r.detail, ms: r.ms, session: r.session });
      return { ok: false, why: r.why, line: failLine(r.why, this.cfg.name), ms: r.ms };
    } finally {
      this.inFlight = false;
    }
  }

  /** A "sleep on it" review: a fresh conversation on the careful model, in the background (its own lane: one at a time). */
  async review(prompt: string, timeoutMs = 15 * 60_000): Promise<GuestReply> {
    if (!this.cfg.enabled) return { ok: false, why: "off", line: `${this.cfg.name} is switched off in Settings.`, ms: 0 };
    if (this.deepInFlight) return { ok: false, why: "busy", line: `${this.cfg.name} is still reviewing the last one.`, ms: 0 };
    this.deepInFlight = true;
    try {
      this.sent.push({ at: new Date().toISOString(), kind: "review", prompt });
      audit("guest", "sent", this.tableId, { review: true, model: this.cfg.deepModel, effort: this.cfg.deepEffort, prompt });
      const r = await this.run({ prompt, model: this.cfg.deepModel, effort: this.cfg.deepEffort, session: null, cwd: this.dir, timeoutMs });
      this.note(r);
      if (r.ok) {
        audit("guest", "said", this.tableId, { review: true, session: r.session, ms: r.ms, text: r.text, usage: r.usage });
        return { ok: true, text: r.text, ms: r.ms };
      }
      audit("guest", "failed", this.tableId, { review: true, why: r.why, detail: r.detail, ms: r.ms });
      return { ok: false, why: r.why, line: r.why === "timeout" ? `${this.cfg.name} ran out of time on the review.` : failLine(r.why, this.cfg.name), ms: r.ms };
    } finally {
      this.deepInFlight = false;
    }
  }

  /** The round table is over: its Codex conversations are archived (kept, not deleted) and its empty folder goes. */
  async close(opts: { keepForReview?: boolean } = {}) {
    if (opts.keepForReview && this.deepInFlight) return; // the review closes it when it's done
    for (const s of this.sessions) {
      const ok = await archiveCodex(s);
      audit("guest", "archived", this.tableId, { session: s, ok });
    }
    this.sessions.clear();
    try {
      if (!readdirSync(this.dir).length) rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  }
}
