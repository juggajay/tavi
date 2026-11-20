// The round table on the desktop (Stage 17.3). The conversation is the thread it always is: Pebble's lines and Tim's
// lines at the table are marked with who said them, and a line marks where it started and where it ended. While one is
// on, Tim sits under Pebble in the sidebar, lit when he speaks or thinks, with an End button; when it ends he goes.
// Typed, it works the same as by voice; by voice (from the PC's mic) its lines are said here too.
import "./table.css";
import type { Animator, PebbleState } from "../shared/pebble/pebble";
import type { Gateway } from "../shared/gateway";
import type { Day } from "../shared/palette";
import { paintTim, TimAnimator } from "../shared/tim/tim";
import { createTableAudio } from "../shared/table-audio";
import { nowSpeaking, timState, type TableSay, type TableState } from "../shared/table-view";

type Line = { id: number; role: string; channel: string; text: string; at: string };

export function createDesktopTable(o: {
  gw: Gateway;
  anim: Animator;
  esc: (s: string) => string;
  time: (iso: string) => string;
  soundOn: () => boolean;
  /** The call's own audio, started from the mic button (the round table's lines are played through it). */
  context: () => AudioContext | null;
  pebbleDay: () => Day;
  /** The thread and Pebble's state need drawing again (a line, thinking, the end). */
  onChange: () => void;
}) {
  const who = document.querySelector(".side .who")!;
  who.insertAdjacentHTML(
    "afterend",
    `<div class="who guest" id="whoTim" hidden><span class="char-host" id="charTim"></span><div><b id="timName">Tim</b><small id="timState"><i></i>At the table</small></div><button class="tbl-end-d" type="button" id="tblEndD" title="End the round table">End</button></div>`,
  );
  const box = document.getElementById("whoTim")!;
  const tim = new TimAnimator();
  tim.mount(document.getElementById("charTim")!);
  let st: TableState | null = null;
  let names = { guest: "Tim", pebble: "Pebble" };
  let heard: "pebble" | "guest" | null = null;
  const shownAt = new Map<string, number>();
  let pulse: ReturnType<typeof setInterval> | 0 = 0;

  const audio = createTableAudio({
    send: (m) => o.gw.send(m as never),
    context: o.context,
    soundOn: o.soundOn,
    onSpeaking: (w) => ((heard = w), draw()),
    onLevel: (w, l) => (w === "guest" ? (tim.level = l * 1.4) : (o.anim.level = l * 1.4)),
  });
  o.gw.on("table_say", (m) => audio.say(m as unknown as TableSay));
  o.gw.on("table_hush", () => audio.hush());
  document.getElementById("tblEndD")!.addEventListener("click", () => o.gw.send({ type: "table_end" }));

  function draw() {
    if (!st?.on) return;
    const speaking = nowSpeaking(st, heard, shownAt);
    const s = timState(st, speaking);
    tim.set(s);
    box.dataset.on = s;
    document.getElementById("timState")!.innerHTML = `<i></i>${s === "speaking" ? "Talking" : s === "thinking" ? "Thinking" : "At the table"}`;
    if (speaking && !heard && !pulse) pulse = setInterval(() => (st && nowSpeaking(st, heard, shownAt) ? undefined : (clearInterval(pulse), (pulse = 0), draw())), 250);
    o.onChange();
  }

  o.gw.on("table", (m) => {
    const s = m as unknown as TableState;
    if (s.on) {
      const first = !st?.on;
      st = s;
      names = s.names;
      for (const l of s.lines) if (!shownAt.has(l.id)) shownAt.set(l.id, performance.now());
      if (first) {
        paintTim(o.pebbleDay());
        document.getElementById("timName")!.textContent = s.names.guest;
        box.hidden = false;
        void box.offsetWidth;
        box.classList.add("in");
        tim.wake();
      }
      draw();
    } else {
      st = null;
      audio.hush();
      box.classList.remove("in");
      setTimeout(() => !st && (box.hidden = true), 400);
      o.onChange();
    }
  });

  return {
    get on() {
      return !!st?.on;
    },
    /** A line of the thread said at a round table, drawn with who said it; null for any other line. */
    lineHtml(l: Line): string | null {
      if (l.channel !== "table" || (l.role !== "assistant" && l.role !== "guest")) return null;
      const g = l.role === "guest";
      const name = g ? names.guest : names.pebble;
      const started = !g && /^\p{L}+'s here\b/u.test(l.text);
      const ended = !g && (/^Thanks, \p{L}+\. Just me again\.$/u.test(l.text) || /^I've let \p{L}+ go;/u.test(l.text));
      const text = l.text
        .split(/\n{2,}/)
        .map((p) => `<p>${o.esc(p)}</p>`)
        .join("");
      return `${started ? `<div class="dayline tl-div">Round table with ${o.esc(names.guest)}</div>` : ""}<div class="msg tline ${g ? "tim" : "peb"}" data-line="${l.id}"><div class="tl-who"><span class="tl-dot"></span>${o.esc(name)}<small>${o.time(l.at)}</small></div>${text}</div>${ended ? `<div class="dayline tl-div">Round table over</div>` : ""}`;
    },
    /** The one thinking at the table, at the foot of the thread. */
    thinkingHtml(): string {
      if (!st?.on || !st.thinking) return "";
      const g = st.thinking === "guest";
      return `<div class="msg tline ${g ? "tim" : "peb"} tl-think"><div class="tl-who"><span class="tl-dot"></span>${o.esc(g ? st.names.guest : st.names.pebble)}</div><span class="shimmer">Thinking</span></div>`;
    },
    /** Pebble's state at the table (null: as everything else has it). */
    pebbleState(): PebbleState | null {
      if (!st?.on) return null;
      const speaking = nowSpeaking(st, heard, shownAt);
      return speaking === "pebble" ? "speaking" : st.thinking === "pebble" ? "thinking" : null;
    },
    ownerHeard: (t: string) => audio.ownerHeard(t),
    liveLevel(l: number) {
      audio.liveLevel(l);
      return heard === "pebble";
    },
    audio,
    tim,
  };
}
export type DesktopTable = ReturnType<typeof createDesktopTable>;
