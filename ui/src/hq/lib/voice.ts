// The existing voice call, with the chosen bot included when it starts.


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

export function createVoice(clientId: string, h: Handlers, bot: string) {
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  let pc: RTCPeerConnection | null = null,
    dc: RTCDataChannel | null = null,
    mic: MediaStream | null = null;
  let live: "off" | "connecting" | "on" = "off";
  let muted = false,
    brainBusy = false,
    soundOn = true,
    
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

  /** The call can hear once its link is really up. The answer from the server comes a second or two before that, and
   * words said in between were lost while the screen already showed it listening. Waits only while the link says it
   * is still connecting, and never more than four seconds. */
  function linkUp(conn: RTCPeerConnection, channel: RTCDataChannel) {
    if (channel.readyState !== "connecting") return Promise.resolve();
    return new Promise<void>((res) => {
      const t = setTimeout(res, 4000);
      const done = () => {
        clearTimeout(t);
        res();
      };
      channel.addEventListener("open", done);
      conn.addEventListener("connectionstatechange", () => {
        if (["failed", "closed"].includes(conn.connectionState)) done();
      });
    });
  }
  /** Two soft rising notes: the call is up and listening, so there is no need to say "hello" to find out. */
  function readyTone() {
    if (!soundOn || !audioCtx) return;
    try {
      const t = audioCtx.currentTime,
        osc = audioCtx.createOscillator(),
        gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.setValueAtTime(880, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.22);
    } catch {}
  }

  async function start() {
    if (live !== "off") return;
    live = "connecting";
    set("connecting");
    try {
      const began = performance.now();
      const micRequest = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      audioCtx = audioCtx || new AudioContext();
      audioCtx.resume().catch(() => {});
      const stream = await micRequest;
      if (live !== "connecting") { stream.getTracks().forEach(track => track.stop()); return; }
      mic = stream;
      const micMs = Math.round(performance.now() - began);
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
      if (live !== "connecting" || !pc) return;
      const iceMs = Math.round(performance.now() - began) - micMs;
      const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sdp: pc.localDescription!.sdp, client_id: clientId, bot, mic_ms: micMs, ice_ms: iceMs }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Voice session failed (${r.status})`);
      if (live !== "connecting" || !pc) return;
      await pc.setRemoteDescription({ type: "answer", sdp: data.transport.sdp });
      await linkUp(pc, dc);
      if (live !== "connecting" || !pc) return; // hung up while it was connecting
      live = "on";
      muted = false;
      lastActivity = now();
      set("listening");
      readyTone();
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
  const levelTimer = setInterval(() => {
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
  const visibleAgain = async () => {
    if (!document.hidden && live === "on" && !wake) {
      try {
        wake = (await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
      } catch {}
    }
  };
  document.addEventListener("visibilitychange", visibleAgain);

  return {
    destroy() { hangUp(); clearInterval(levelTimer); document.removeEventListener("visibilitychange", visibleAgain); void audioCtx?.close(); },
    get state() {
      return state;
    },
    get on() {
      return live !== "off";
    },
    get muted() {
      return muted;
    },
    
    get audioContext() {
      return audioCtx;
    },
    
    tap() {
      if (live === "off") return void start();
      if (live === "on") setMuted(!muted);
    },
    start,
    end: (message?: string) => hangUp(message),
    
    brainDone() {
      brainBusy = false;
      if (state === "thinking") set(muted ? "muted" : "listening");
    },
    setSound(on: boolean) {
      soundOn = on;
      applySound();
    },
    
    muteVoice(off: boolean) {
      voiceOff = off;
      applySound();
    },
    
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
