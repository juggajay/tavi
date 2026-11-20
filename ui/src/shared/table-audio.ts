// Saying the round table's lines on the device (Stage 17.3). The voice service gives one voice per call, so at a round
// table by voice the gateway makes each line into speech (Pebble in the call's voice, Tim in his own) and sends it here
// to be said, one at a time, after the one before (table_say). This plays it:
//   - streamed as it arrives (raw 24 kHz 16-bit mono) into the call's own Web Audio (started from the tap to talk, as an
//     iPhone requires), so it starts in a fraction of a second;
//   - never over anyone: it waits until the call's own voice and the owner have been quiet, and if the call's voice
//     starts while a line is playing, the line pauses (exactly where it was) until it's quiet again;
//   - the owner speaking stops it at once and drops anything waiting (a filler like "mm" doesn't, and nor does the line's
//     own words coming back through the speaker);
//   - it tells the gateway when a line has been said (table_played) or cut (table_cut).
import type { TableSay } from "./table-view";

type Hooks = {
  send: (m: Record<string, unknown>) => void;
  /** The call's own audio (null with no call: the screens' checks then get one of their own). */
  context: () => AudioContext | null;
  /** Who's being heard now (null: nobody), and how loud (0..1), for the characters. */
  onSpeaking?: (who: "pebble" | "guest" | null) => void;
  onLevel?: (who: "pebble" | "guest", level: number) => void;
  soundOn: () => boolean;
};

const RATE = 24000;
const FILLER = /^(mm+|hmm+|mhm|uh huh|uh|um|yeah|yep|right|okay|ok)[.!?]*$/i;
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
/** The microphone hearing the line being played, not the owner. */
export function echoOf(heard: string, said: string) {
  const h = words(heard).filter((w) => w.length > 2);
  if (h.length < 2) return false;
  const s = new Set(words(said));
  return h.filter((w) => s.has(w)).length / h.length >= 0.7;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One piece of a line's speech, and when (on the audio clock) it's due to play. */
type Piece = { buf: AudioBuffer; at: number; src: AudioBufferSourceNode | null };
type Playing = { say: TableSay; arrived: number; pieces: Piece[]; next: number; stop: boolean; paused: number | null; reader: ReadableStreamDefaultReader<Uint8Array> | null };

export function createTableAudio(h: Hooks) {
  let own: AudioContext | null = null;
  let out: { ctx: AudioContext; gain: GainNode; analyser: AnalyserNode; level: Float32Array<ArrayBuffer> } | null = null;
  const queue: { say: TableSay; arrived: number }[] = [];
  let cur: Playing | null = null;
  let liveLoudAt = 0;
  let ownerAt = 0;
  let raf = 0;
  /** For the checks: when each line was heard, and whether it was cut. */
  const played: { id: string; speaker: string; start: number; end: number; cut: boolean; paused: number }[] = [];

  /** The output: the call's audio if there is one (it's already running from the tap), else one of its own. */
  function output() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = h.context() ?? (own ??= new AC());
    if (!out || out.ctx !== ctx) {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(analyser);
      analyser.connect(ctx.destination);
      out = { ctx, gain, analyser, level: new Float32Array(analyser.fftSize) };
    }
    return out;
  }
  function meter() {
    if (raf) return;
    const loop = () => {
      raf = 0;
      if (!cur || !out) return;
      out.analyser.getFloatTimeDomainData(out.level);
      let sum = 0;
      for (let i = 0; i < out.level.length; i++) sum += out.level[i] * out.level[i];
      h.onLevel?.(cur.say.speaker, Math.sqrt(sum / out.level.length));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function start(p: Playing, piece: Piece, when: number, offset = 0) {
    const o = output();
    const src = o.ctx.createBufferSource();
    src.buffer = piece.buf;
    src.connect(o.gain);
    src.start(when, offset);
    piece.src = src;
  }

  function finish(p: Playing, how: "played" | "cut", first: number | null, waited: number) {
    if (cur !== p) return;
    cur = null;
    const rec = played.find((x) => x.id === p.say.id);
    if (rec) (rec.end = performance.now()), (rec.cut = how === "cut");
    h.onSpeaking?.(null);
    if (how === "played") h.send({ type: "table_played", id: p.say.id, ok: true, ...(first !== null ? { first_ms: Math.round(first) } : {}), waited_ms: Math.round(waited) });
    else h.send({ type: "table_cut", id: p.say.id });
    void pump();
  }

  async function play(item: { say: TableSay; arrived: number }) {
    const o = output();
    if (o.ctx.state === "suspended") await o.ctx.resume().catch(() => undefined);
    const p: Playing = { say: item.say, arrived: item.arrived, pieces: [], next: 0, stop: false, paused: null, reader: null };
    cur = p;
    const waited = performance.now() - item.arrived;
    o.gain.gain.value = h.soundOn() ? 1 : 0;
    let first: number | null = null;
    let carry: number | null = null;
    try {
      const r = await fetch(item.say.audio);
      if (!r.ok || !r.body) throw new Error(`audio ${r.status}`);
      p.reader = r.body.getReader();
      for (;;) {
        const { done, value } = await p.reader.read();
        if (p.stop) return;
        if (p.paused !== null && performance.now() - liveLoudAt > 500) resume(p);
        if (done) break;
        if (!value?.length) continue;
        // 16-bit samples: a byte left over from the last piece goes on the front of this one
        let bytes = value;
        if (carry !== null) {
          const b = new Uint8Array(value.length + 1);
          b[0] = carry;
          b.set(value, 1);
          bytes = b;
          carry = null;
        }
        if (bytes.length % 2) carry = bytes[bytes.length - 1];
        const n = bytes.length >> 1;
        if (!n) continue;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++) samples[i] = dv.getInt16(i * 2, true) / 32768;
        const buf = o.ctx.createBuffer(1, n, RATE);
        buf.copyToChannel(samples, 0);
        if (p.next < o.ctx.currentTime + 0.02) p.next = o.ctx.currentTime + 0.04;
        const piece: Piece = { buf, at: p.next, src: null };
        p.pieces.push(piece);
        p.next += buf.duration;
        if (p.paused === null) start(p, piece, piece.at); // while paused, it waits to be scheduled on the way back
        if (first === null) {
          first = performance.now() - item.arrived;
          played.push({ id: item.say.id, speaker: item.say.speaker, start: performance.now() + (piece.at - o.ctx.currentTime) * 1000, end: 0, cut: false, paused: 0 });
          h.onSpeaking?.(item.say.speaker);
          meter();
        }
      }
      // every piece is scheduled: wait until the last has been heard (longer if it paused for the call's voice). If the
      // sound never starts (no output, or the browser won't let it), the clock says when it would have finished.
      let wallEnd = performance.now() + Math.max(0, p.next - o.ctx.currentTime) * 1000 + 300;
      while (!p.stop && (p.paused !== null || o.ctx.currentTime < p.next)) {
        // quiet again for half a second (whether or not the call's level is still coming): carry on
        if (p.paused !== null && performance.now() - liveLoudAt > 500) resume(p);
        if (p.paused !== null) wallEnd = performance.now() + Math.max(0, p.next - p.paused) * 1000 + 300;
        else if (o.ctx.state !== "running" && performance.now() > wallEnd) break;
        await sleep(50);
      }
      if (!p.stop) finish(p, "played", first, waited);
    } catch (err) {
      console.warn("[table] couldn't play a line:", err);
      if (!p.stop) finish(p, "played", first, waited); // move on; the words are on screen
    }
  }

  /** The call's voice started over a line: stop it where it is (to the sample) and remember the spot. */
  function pause(p: Playing) {
    if (p.paused !== null || !out) return;
    p.paused = out.ctx.currentTime;
    for (const pc of p.pieces)
      try {
        pc.src?.stop();
      } catch {}
    const rec = played.find((x) => x.id === p.say.id);
    if (rec) rec.paused++;
    h.onSpeaking?.(null);
  }
  /** Quiet again: carry on from that spot. */
  function resume(p: Playing) {
    if (p.paused === null || !out) return;
    const shift = out.ctx.currentTime + 0.06 - p.paused;
    for (const pc of p.pieces) {
      const end = pc.at + pc.buf.duration;
      if (end <= p.paused) continue;
      const offset = Math.max(0, p.paused - pc.at);
      pc.at += shift; // its new place on the clock; the piece that was playing carries on from where it stopped
      start(p, pc, pc.at + offset, offset);
    }
    p.next += shift;
    p.paused = null;
    h.onSpeaking?.(p.say.speaker);
  }

  async function pump() {
    if (cur || !queue.length) return;
    const item = queue[0];
    // never over anyone: the call's own voice quiet for half a second, the owner for most of a second
    for (let i = 0; i < 300 && (performance.now() - liveLoudAt < 500 || performance.now() - ownerAt < 800); i++) await sleep(50);
    if (queue[0] !== item || cur) return;
    queue.shift();
    void play(item);
  }

  function stopCurrent() {
    const p = cur;
    if (!p) return;
    p.stop = true;
    for (const pc of p.pieces)
      try {
        pc.src?.stop();
      } catch {}
    void p.reader?.cancel().catch(() => undefined);
    finish(p, "cut", null, 0);
  }

  return {
    say(s: TableSay) {
      queue.push({ say: s, arrived: performance.now() });
      void pump();
    },
    /** Stop whatever is being said and drop what's waiting (each one reported as cut). */
    hush() {
      for (const q of queue.splice(0)) h.send({ type: "table_cut", id: q.say.id });
      stopCurrent();
    },
    /** What the owner is saying, as the call hears it: anything but a filler or the line's own echo stops the round table. */
    ownerHeard(text: string) {
      const t = text.trim();
      if (!t || FILLER.test(t)) return;
      if (cur && echoOf(t, cur.say.text)) return;
      ownerAt = performance.now();
      if (cur || queue.length) {
        for (const q of queue.splice(0)) h.send({ type: "table_cut", id: q.say.id });
        stopCurrent();
      }
    },
    /** The call's own voice's loudness: a line never plays over it (it pauses, then carries on from the same spot). */
    liveLevel(l: number) {
      const now = performance.now();
      if (l > 0.03) liveLoudAt = now;
      if (!cur || cur.stop) return;
      if (cur.paused === null && l > 0.03) pause(cur);
      else if (cur.paused !== null && now - liveLoudAt > 500) resume(cur);
    },
    /** One soft tick: Tim's thinking and nothing else is being said (not words, so it never sounds like an answer). */
    tick() {
      const ctx = h.context();
      if (cur || queue.length || !h.soundOn() || !ctx || ctx.state !== "running") return;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 1180;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
      osc.connect(g).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    },
    get busy() {
      return !!cur || queue.length > 0;
    },
    played,
  };
}
export type TableAudio = ReturnType<typeof createTableAudio>;
