// Live voice: OpenAI gpt-live-1 over WebRTC, the session made by the gateway (POST /api/session). Ported from the
// original phone page (web/index.html "live voice") with the same behaviour:
//   - the microphone is asked for first, inside the tap, before any other await (an iPhone rule)
//   - the data channel carries session.input_transcript.delta (what was heard), session.output_transcript.delta
//     (what it says), session.delegation.created (the brain is on it), session.closed, error
//   - speaking is detected from the reply audio level (above 0.03), back to listening 0.7 s after it goes quiet
//   - tapping again mutes and unmutes (session.input_audio.mute / unmute and the mic track)
//   - it hangs up after 120 s with nothing happening (unless the brain is busy), and on a failed or closed connection
//   - hanging up sends session.close, closes the connection, stops the mic, and tells the gateway (/api/session/close)
// New: the session is started with this app's client id, so voice turns are tagged with this device.
// Stage 18.1: while a round table is on, the call's own voice is muted here (muteVoice); the table's lines are played by
// the app. The voice service has no way to switch its voice off from the server, and its guide says required silence is
// for the app's own playback to enforce.

export type VoiceState = "off" | "connecting" | "listening" | "muted" | "thinking" | "speaking";
type Handlers = {
  onState: (s: VoiceState) => void;
  onHeard: (text: string) => void;
  onSaid: (text: string) => void;
  onLevel?: (level: number) => void;
  onEnded: (message?: string) => void;
};

const IDLE_HANGUP_S = 120;
const now = () => performance.now() / 1000;

export function createVoice(clientId: string, h: Handlers) {
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  let pc: RTCPeerConnection | null = null,
    dc: RTCDataChannel | null = null,
    mic: MediaStream | null = null;
  let live: "off" | "connecting" | "on" = "off";
  let muted = false,
    brainBusy = false,
    soundOn = true,
    /** The call's own voice is silenced (Stage 18.1): a round table is on and its lines are played by the app, so the
     * call's voice is never heard there, its words aren't shown and its sound doesn't move Pebble's mouth. */
    voiceOff = false;
  const applySound = () => {
    remoteAudio.muted = !soundOn || voiceOff;
  };
  let audioCtx: AudioContext | null = null,
    analyser: AnalyserNode | null = null,
    buf: Float32Array<ArrayBuffer> | null = null;
  let lastVoice = 0,
    lastActivity = 0,
    state: VoiceState = "off";
  let userLine = "",
    userAt = 0,
    botLine = "",
    botAt = 0;
  let wake: { release: () => Promise<void> } | null = null;

  const set = (s: VoiceState) => {
    if (state === s) return;
    state = s;
    h.onState(s);
  };

  function hookAnalyser(stream: MediaStream) {
    try {
      audioCtx = audioCtx || new AudioContext();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      buf = new Float32Array(analyser.fftSize);
      src.connect(analyser);
    } catch (e) {
      console.warn("analyser unavailable", e);
    }
  }
  function readLevel() {
    if (!analyser || !buf) return 0;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
  function waitIce(conn: RTCPeerConnection) {
    if (conn.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((res) => {
      const t = setTimeout(res, 2500);
      conn.addEventListener("icegatheringstatechange", () => {
        if (conn.iceGatheringState === "complete") {
          clearTimeout(t);
          res();
        }
      });
    });
  }
  function sendLive(evt: Record<string, unknown>) {
    if (dc?.readyState === "open") dc.send(JSON.stringify({ event_id: `c_${Date.now().toString(36)}`, ...evt }));
  }

  async function start() {
    if (live !== "off") return;
    live = "connecting";
    set("connecting");
    try {
      // iPhone: ask for the mic first, inside the tap, before any other await.
      const micRequest = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      audioCtx = audioCtx || new AudioContext();
      audioCtx.resume().catch(() => {});
      mic = await micRequest;
      pc = new RTCPeerConnection();
      pc.addEventListener("track", (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        remoteAudio.srcObject = stream;
        applySound();
        remoteAudio.play().catch(() => {});
        hookAnalyser(stream);
      });
      for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
      dc = pc.createDataChannel("oai-events");
      dc.addEventListener("message", (ev) => {
        try {
          onLive(JSON.parse(ev.data));
        } catch {}
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc && ["failed", "closed"].includes(pc.connectionState)) hangUp("Lost the voice connection. Tap me to reconnect.");
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIce(pc);
      const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: pc.localDescription!.sdp, client_id: clientId }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Voice session failed (${r.status})`);
      await pc.setRemoteDescription({ type: "answer", sdp: data.transport.sdp });
      live = "on";
      muted = false;
      lastActivity = now();
      set("listening");
      try {
        wake = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen") ?? null;
      } catch {}
    } catch (err) {
      console.warn(err);
      const e = err as Error;
      hangUp(e.name === "NotAllowedError" ? "I can't hear you. Check the microphone is allowed: Settings, then your browser, then Microphone." : e.message || "Could not start the voice.");
    }
  }

  function hangUp(message?: string) {
    try {
      if (dc?.readyState === "open") dc.send(JSON.stringify({ type: "session.close", event_id: "close" }));
    } catch {}
    try {
      pc?.close();
    } catch {}
    mic?.getTracks().forEach((t) => t.stop());
    remoteAudio.srcObject = null;
    pc = dc = mic = null;
    analyser = null;
    h.onLevel?.(0);
    if (live !== "off") fetch("/api/session/close", { method: "POST" }).catch(() => {});
    live = "off";
    wake?.release().catch(() => {});
    wake = null;
    set("off");
    h.onEnded(message);
  }

  function setMuted(m: boolean) {
    muted = m;
    sendLive({ type: m ? "session.input_audio.mute" : "session.input_audio.unmute" });
    mic?.getAudioTracks().forEach((t) => {
      t.enabled = !m;
    });
    if (state !== "thinking" && state !== "speaking") set(m ? "muted" : "listening");
  }

  function onLive(e: { type: string; delta?: string; reason?: string }) {
    const t = now();
    if (e.type === "session.input_transcript.delta") {
      lastActivity = t;
      if (t - userAt > 1.5) userLine = "";
      userLine += e.delta || "";
      userAt = t;
      h.onHeard(userLine.trim());
    } else if (e.type === "session.output_transcript.delta") {
      lastActivity = t;
      if (t - botAt > 1.5) botLine = "";
      botLine += e.delta || "";
      botAt = t;
      if (!voiceOff) h.onSaid(botLine.trim());
    } else if (e.type === "session.delegation.created") {
      brainBusy = true;
      set("thinking");
    } else if (e.type === "session.closed") {
      hangUp(e.reason === "expired" ? "Session timed out. Tap me to start again." : undefined);
    } else if (e.type === "error") {
      console.warn("live error", e);
    }
  }

  // Speaking detection, mouth level and idle hang-up
  setInterval(() => {
    if (live !== "on") return;
    const lvl = voiceOff ? 0 : readLevel();
    h.onLevel?.(lvl);
    const t = now();
    if (lvl > 0.03) {
      lastVoice = t;
      lastActivity = t;
      if (state !== "speaking") set("speaking");
    } else if (state === "speaking" && t - lastVoice > 0.7) {
      set(brainBusy ? "thinking" : muted ? "muted" : "listening");
    }
    if (!brainBusy && t - lastActivity > IDLE_HANGUP_S) hangUp("Hung up to save credit. Tap me to start again.");
  }, 80);

  // A locked phone or a hidden tab: the wake lock is dropped by the browser; take it again when back.
  document.addEventListener("visibilitychange", async () => {
    if (!document.hidden && live === "on" && !wake) {
      try {
        wake = (await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
      } catch {}
    }
  });

  return {
    get state() {
      return state;
    },
    get on() {
      return live !== "off";
    },
    get muted() {
      return muted;
    },
    /** The call's sound, started from the tap (Stage 17.3: the round table's lines are played through it). */
    get audioContext() {
      return audioCtx;
    },
    /** Tap: start the call, or mute/unmute during one. */
    tap() {
      if (live === "off") return void start();
      if (live === "on") setMuted(!muted);
    },
    start,
    end: (message?: string) => hangUp(message),
    /** The brain finished (or failed) a turn the voice handed it. */
    brainDone() {
      brainBusy = false;
      if (state === "thinking") set(muted ? "muted" : "listening");
    },
    setSound(on: boolean) {
      soundOn = on;
      applySound();
    },
    /** A round table is on (true) or over (false): the call's own voice is muted on this device meanwhile (Stage 18.1). */
    muteVoice(off: boolean) {
      voiceOff = off;
      applySound();
    },
    /** For the checks: is the call's own sound muted on this device (a round table, or the sound off)? */
    get voiceMuted() {
      return remoteAudio.muted;
    },
  };
}
export type Voice = ReturnType<typeof createVoice>;

/* ---------- the phone's own voice, for typed replies when no call is on (as the original page did) ---------- */
let ttsVoice: SpeechSynthesisVoice | null = null;
const synth = typeof speechSynthesis !== "undefined" ? speechSynthesis : null;
function pickVoice() {
  if (!synth) return;
  const vs = synth.getVoices().filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
  const score = (v: SpeechSynthesisVoice) => (v.lang === "en-AU" ? 40 : v.lang.startsWith("en-GB") ? 25 : 10) + (/natural|online|neural/i.test(v.name) ? 20 : 0);
  ttsVoice = vs.sort((a, b) => score(b) - score(a))[0] || null;
}
if (synth) {
  pickVoice();
  synth.addEventListener?.("voiceschanged", pickVoice);
}
/** Say it with the device's voice; resolves when done (or after a time limit). */
export function speakLocal(text: string, soundOn: boolean): Promise<void> {
  return new Promise((resolve) => {
    const est = Math.max(1300, text.split(/\s+/).length * 340);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (soundOn && synth) {
      try {
        const u = new SpeechSynthesisUtterance(text);
        if (ttsVoice) u.voice = ttsVoice;
        u.rate = 1.03;
        u.onend = finish;
        u.onerror = finish;
        synth.cancel();
        synth.speak(u);
        setTimeout(finish, est + 4000);
      } catch {
        setTimeout(finish, est);
      }
    } else setTimeout(finish, est);
  });
}
export const stopLocal = () => synth?.cancel();
