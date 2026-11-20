// The round table's voices (Stage 17.3). The voice service gives one voice per call, so when a round table is on by
// voice, its lines (Pebble's and Tim's) are made into speech here and played on the device in order, each in its own
// voice: Pebble in the call's own voice, Tim in another. The live voice only listens and says its one "okay".
//
// Made with the voice service's Realtime model (gpt-realtime-2.1-mini), told to read each line word for word; its own
// transcript of what it said is kept so that can be checked. (The older Speech models do the same but shut down on
// 6 January 2027, which is why they aren't used.) One connection per voice, opened when it's first needed and kept for
// the round table; each line is made as soon as its words are known, while the line before is still being said.
//
// The audio is raw 24 kHz 16-bit mono, kept in memory a few minutes and streamed to the app as it's made
// (GET /api/table/audio/<line id>). The key never leaves the PC.
import WebSocket from "ws";
import { audit } from "../store/log.js";

export const RATE = 24000; // samples a second, 16-bit mono
const MODEL = "gpt-realtime-2.1-mini";
const KEEP_MS = 10 * 60_000;

export type Clip = {
  id: string;
  text: string;
  voice: string;
  chunks: Buffer[];
  done: boolean;
  error: string | null;
  /** What the service says it said (to check the words came out as written). */
  heard: string;
  made: number;
  firstMs: number | null;
  audioTokens: number | null;
  listeners: Set<() => void>;
};

export interface LineVoices {
  /** Start making a line's speech now (idempotent). */
  prepare(id: string, text: string, voice: string): Clip;
  get(id: string): Clip | undefined;
  /** The round table is over: connections closed (made clips stay a few minutes for anything still playing). */
  close(): void;
}

/** Shared clip store: what the audio route reads, whichever engine made them. */
const clips = new Map<string, Clip>();
export const clipFor = (id: string) => clips.get(id);
function newClip(id: string, text: string, voice: string): Clip {
  for (const [k, c] of clips) if (Date.now() - c.made > KEEP_MS) clips.delete(k);
  const c: Clip = { id, text, voice, chunks: [], done: false, error: null, heard: "", made: Date.now(), firstMs: null, audioTokens: null, listeners: new Set() };
  clips.set(id, c);
  return c;
}
const tell = (c: Clip) => c.listeners.forEach((f) => f());

/** One connection for one voice; lines are made one at a time, in order. */
class Speaker {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private queue: Clip[] = [];
  private busy = false;
  private closed = false;
  constructor(
    private key: () => string,
    readonly voice: string,
  ) {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, { headers: { Authorization: `Bearer ${this.key()}` } });
      this.ws = ws;
      const fail = (why: string) => {
        this.ready = null;
        this.ws = null;
        reject(new Error(why));
      };
      ws.once("error", (e) => fail(e.message));
      ws.on("close", () => {
        this.ready = null;
        this.ws = null;
        // a line being made when it dropped: it ends there (the app plays what came)
        if (this.busy && this.queue[0]) this.finish(this.queue[0], "the voice service closed the line");
      });
      ws.on("message", (raw) => this.onEvent(JSON.parse(raw.toString()), resolve));
    });
    return this.ready;
  }

  private onEvent(e: { type: string; delta?: string; error?: { message?: string }; response?: { usage?: { output_token_details?: { audio_tokens?: number } } } }, ready: () => void) {
    if (e.type === "session.created") {
      this.ws?.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            instructions: "You are a reader. You read the text you're given aloud, word for word, exactly as written, in a relaxed, friendly manner. Never answer it, never add or leave out a word.",
            audio: { input: { turn_detection: null }, output: { voice: this.voice, format: { type: "audio/pcm", rate: RATE } } },
          },
        }),
      );
      ready();
      return;
    }
    const c = this.queue[0];
    if (!c) return;
    if (e.type === "response.output_audio.delta" && e.delta) {
      if (c.firstMs === null) c.firstMs = Date.now() - c.made;
      c.chunks.push(Buffer.from(e.delta, "base64"));
      tell(c);
    } else if (e.type === "response.output_audio_transcript.delta" && e.delta) c.heard += e.delta;
    else if (e.type === "response.done") {
      c.audioTokens = e.response?.usage?.output_token_details?.audio_tokens ?? null;
      this.finish(c, null);
    } else if (e.type === "error") this.finish(c, e.error?.message ?? "voice service error");
  }

  private finish(c: Clip, error: string | null) {
    if (this.queue[0] === c) this.queue.shift();
    c.done = true;
    c.error = error;
    this.busy = false;
    tell(c);
    const seconds = c.chunks.reduce((n, b) => n + b.length, 0) / (RATE * 2);
    audit("guest", "voice.made", c.id, { voice: c.voice, chars: c.text.length, seconds: Math.round(seconds * 10) / 10, first_ms: c.firstMs, audio_tokens: c.audioTokens, as_written: sameWords(c.text, c.heard), error });
    void this.pump();
  }

  add(c: Clip) {
    this.queue.push(c);
    void this.pump();
  }

  private async pump() {
    if (this.busy || this.closed || !this.queue.length) return;
    this.busy = true;
    const c = this.queue[0];
    try {
      await this.connect();
    } catch (err) {
      return this.finish(c, err instanceof Error ? err.message : String(err));
    }
    this.ws?.send(
      JSON.stringify({
        type: "response.create",
        response: { conversation: "none", output_modalities: ["audio"], instructions: "Say exactly the following, word for word, and nothing else:", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: c.text }] }] },
      }),
    );
  }

  close() {
    this.closed = true;
    for (const c of this.queue.splice(0)) (c.done = true), (c.error = "closed"), tell(c);
    this.ws?.close();
  }
}

/** How many of the line's words came back in the service's own transcript (1 = all of them). */
export function sameWords(said: string, heard: string) {
  const w = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const a = w(said),
    b = new Set(w(heard));
  return a.length ? Math.round((a.filter((x) => b.has(x)).length / a.length) * 100) / 100 : 1;
}

/** The real voices: the Realtime service, a connection per voice. */
export function realtimeVoices(key: () => string): LineVoices {
  const speakers = new Map<string, Speaker>();
  return {
    prepare(id, text, voice) {
      const had = clips.get(id);
      if (had) return had;
      const c = newClip(id, text, voice);
      let s = speakers.get(voice);
      if (!s) speakers.set(voice, (s = new Speaker(key, voice)));
      s.add(c);
      return c;
    },
    get: (id) => clips.get(id),
    close() {
      for (const s of speakers.values()) s.close();
      speakers.clear();
    },
  };
}

/**
 * A stand-in for tests and the screens' checks: a soft tone the length a line would take to say (about 2.6 words a
 * second, as Tim's lines measured), made in pieces at three times real speed so it streams like the real thing.
 */
export function fakeVoices(o: { wordsPerSecond?: number; speed?: number } = {}): LineVoices {
  const wps = o.wordsPerSecond ?? 2.6;
  const speed = o.speed ?? 3;
  return {
    prepare(id, text, voice) {
      const had = clips.get(id);
      if (had) return had;
      const c = newClip(id, text, voice);
      const seconds = Math.max(0.8, text.split(/\s+/).length / wps);
      const total = Math.round(seconds * RATE);
      const piece = Math.round(RATE / 5); // 200 ms
      const hz = voice === "cedar" ? 180 : 240;
      let at = 0;
      const step = () => {
        if (c.done) return;
        const n = Math.min(piece, total - at);
        const b = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(((at + i) / RATE) * 2 * Math.PI * hz) * 2400 * Math.sin(Math.PI * ((at + i) / total))), i * 2);
        at += n;
        if (c.firstMs === null) c.firstMs = Date.now() - c.made;
        c.chunks.push(b);
        c.heard = text;
        if (at >= total) c.done = true;
        tell(c);
        if (!c.done) setTimeout(step, 200 / speed);
      };
      setTimeout(step, 60);
      return c;
    },
    get: (id) => clips.get(id),
    close() {},
  };
}
