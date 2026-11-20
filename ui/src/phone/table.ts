// The round table on the phone (Stage 17.3). While one is on, the stage changes: Pebble and Tim side by side, the one
// talking or thinking lit up, and under them the conversation as it's said, three speakers (You, Pebble, Tim), the newest
// at the bottom and the oldest fading away at the top. When it ends, the screen goes back to Pebble alone. Nothing of
// it shows unless a round table is on.
// By voice, its lines are said here (shared/table-audio.ts), Pebble in the call's own voice and Tim in his.
import "./table.css";
import type { Animator, PebbleState } from "../shared/pebble/pebble";
import type { Gateway } from "../shared/gateway";
import type { Day } from "../shared/palette";
import { esc } from "../shared/items/describe";
import { paintTim, TimAnimator } from "../shared/tim/tim";
import { createTableAudio } from "../shared/table-audio";
import { labelOf, nowSpeaking, timState, type TableSay, type TableState } from "../shared/table-view";

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createPhoneTable(o: {
  app: HTMLElement;
  stage: HTMLElement;
  anim: Animator;
  gw: Gateway;
  tapToTalk: () => void;
  soundOn: () => boolean;
  callOn: () => boolean;
  /** The call's own audio, started from the tap to talk (the round table's lines are played through it). */
  context: () => AudioContext | null;
  pebbleDay: () => Day;
  /** Pebble's state may have changed (the phone sets it from this and the call). */
  onPebble: () => void;
  /** It's over: back to Pebble alone, with the last thing said. */
  onEnd: (last: string | null) => void;
}) {
  const root = document.createElement("div");
  root.className = "tbl";
  root.id = "tbl";
  root.hidden = true;
  root.setAttribute("aria-label", "Round table");
  root.innerHTML = `
    <div class="tbl-top"><span class="tbl-tag"><i></i>Round table</span><button class="tbl-end" type="button" id="tblEnd">End</button></div>
    <div class="tbl-cast">
      <button class="tbl-seat peb" type="button" id="tblPeb" aria-label="Talk"><span class="char-host" id="charTable"></span><span class="tbl-name" id="tblPebName">Pebble</span></button>
      <div class="tbl-seat tim" id="tblTim"><span class="char-host" id="charTim"></span><span class="tbl-name" id="tblTimName">Tim</span></div>
    </div>
    <div class="tbl-log" id="tblLog" role="log" aria-live="polite"></div>`;
  o.stage.appendChild(root);
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
  const log = $("tblLog");
  o.anim.mount($("charTable"), () => root.hidden === true);
  const tim = new TimAnimator();
  tim.mount($("charTim"));

  let st: TableState | null = null;
  let lastLines: TableState["lines"] = [];
  let heard: "pebble" | "guest" | null = null; // what's being said by voice right now
  const shownAt = new Map<string, number>();
  let leaving: ReturnType<typeof setTimeout> | 0 = 0;
  let tickFor = "";
  let tickTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let pulse: ReturnType<typeof setInterval> | 0 = 0;

  const audio = createTableAudio({
    send: (m) => o.gw.send(m as never),
    context: o.context,
    soundOn: o.soundOn,
    onSpeaking: (who) => {
      heard = who;
      draw();
    },
    onLevel: (who, l) => {
      if (who === "guest") tim.level = l * 1.4;
      else o.anim.level = l * 1.4;
    },
  });

  $("tblEnd").addEventListener("click", () => o.gw.send({ type: "table_end" }));
  $("tblPeb").addEventListener("click", () => o.tapToTalk());

  const lineHtml = (l: TableState["lines"][number], s: TableState) =>
    `<div class="tl ${l.speaker === "owner" ? "you" : l.speaker === "pebble" ? "peb" : "tim"}${l.kind ? ` k-${l.kind}` : ""}" data-id="${esc(l.id)}"><b>${esc(labelOf(l, s))}</b><p>${esc(l.text)}</p></div>`;

  /** The conversation: new lines come in at the bottom; the brief first; the one thinking last. */
  function drawLog(s: TableState) {
    const want = s.lines.slice(-24);
    const ids = new Set(want.map((l) => l.id));
    for (const el of [...log.querySelectorAll<HTMLElement>(".tl[data-id]")]) if (!ids.has(el.dataset.id!)) el.remove();
    let brief = log.querySelector<HTMLElement>(".tl.brief");
    if (s.brief && !brief) {
      log.insertAdjacentHTML("afterbegin", `<div class="tl brief"><b>What ${esc(s.names.guest)} was told</b><p></p></div>`);
      brief = log.querySelector<HTMLElement>(".tl.brief");
    }
    if (brief) brief.querySelector("p")!.textContent = s.brief;
    const hadThink = log.querySelector(".tl.think");
    hadThink?.remove();
    let added = false;
    for (const l of want) {
      if (log.querySelector(`.tl[data-id="${CSS.escape(l.id)}"]`)) continue;
      shownAt.set(l.id, performance.now());
      log.insertAdjacentHTML("beforeend", lineHtml(l, s));
      const el = log.lastElementChild as HTMLElement;
      if (!reduce()) el.classList.add("new");
      added = true;
    }
    if (s.thinking) {
      const who = s.thinking === "guest" ? s.names.guest : s.names.pebble;
      log.insertAdjacentHTML("beforeend", `<div class="tl think ${s.thinking === "guest" ? "tim" : "peb"}${hadThink ? "" : " new"}"><b>${esc(who)}</b><p><span class="shimmer">Thinking</span></p></div>`);
      added ||= !hadThink;
    }
    // the newest in view as it comes in (unless he's scrolled back up to read)
    if (added && (log.scrollHeight - log.scrollTop - log.clientHeight < 160 || !log.dataset.read)) {
      autoAt = performance.now();
      log.scrollTop = log.scrollHeight;
    }
    fade();
  }
  /** The top fades only when there's more above. */
  const fade = () => log.classList.toggle("faded", log.scrollTop > 4);
  let autoAt = 0;
  log.addEventListener("scroll", () => {
    fade();
    if (performance.now() - autoAt < 800) return; // (its own smooth scroll to the newest, not him)
    // he's scrolled back up himself: leave him there until he's back near the bottom
    log.dataset.read = log.scrollHeight - log.scrollTop - log.clientHeight > 160 ? "1" : "";
  });

  /** Who's lit, what each character's doing, and the names under them. */
  function draw() {
    if (!st?.on) return;
    const speaking = nowSpeaking(st, heard, shownAt);
    root.dataset.speaking = speaking ?? "";
    root.dataset.thinking = st.thinking ?? "";
    tim.set(timState(st, speaking));
    for (const el of log.querySelectorAll<HTMLElement>(".tl[data-id]")) el.classList.toggle("now", el.dataset.id === st.lines.at(-1)?.id && !!speaking);
    o.onPebble();
    // typed: a line "speaks" for as long as it'd take to say it, then the characters settle
    if (speaking && !heard && !pulse) pulse = setInterval(() => (st && nowSpeaking(st, heard, shownAt) ? undefined : (clearInterval(pulse), (pulse = 0), draw())), 250);
  }

  function show(s: TableState) {
    if (leaving) clearTimeout(leaving);
    leaving = 0;
    const was = !root.hidden;
    paintTim(o.pebbleDay());
    $("tblPebName").textContent = s.names.pebble;
    $("tblTimName").textContent = s.names.guest;
    if (!was) {
      log.innerHTML = "";
      root.hidden = false;
      o.app.classList.add("table");
      void root.offsetWidth;
      root.classList.add("in");
      tim.wake();
    }
    drawLog(s);
    draw();
    // Tim thinking with nothing being said, by voice: one soft tick so the wait isn't dead air
    if (s.thinking === "guest" && o.callOn() && tickFor !== String(s.lines.length)) {
      tickFor = String(s.lines.length);
      if (tickTimer) clearTimeout(tickTimer);
      tickTimer = setTimeout(() => st?.thinking === "guest" && !audio.busy && !heard && audio.tick(), 1600);
    }
  }

  function hide() {
    if (root.hidden || leaving) return;
    const last = lastLines.at(-1);
    audio.hush();
    // the last line stays a moment, then it's Pebble alone again
    leaving = setTimeout(
      () => {
        leaving = 0;
        root.classList.remove("in");
        o.app.classList.add("untable");
        o.app.classList.remove("table");
        setTimeout(() => {
          o.app.classList.remove("untable");
          if (!st?.on) root.hidden = true;
        }, reduce() ? 0 : 640);
        o.onEnd(last && last.speaker !== "owner" ? last.text : null);
        o.onPebble();
      },
      reduce() ? 0 : 1200,
    );
  }

  function onTable(s: TableState) {
    if (s.on) {
      st = s;
      lastLines = s.lines;
      show(s);
    } else {
      st = null;
      tim.set("idle");
      hide();
    }
  }

  return {
    /** The round table's messages (the phone passes them on; this part is loaded when the first one comes). */
    message(m: { type: string }) {
      if (m.type === "table") onTable(m as unknown as TableState);
      else if (m.type === "table_say") audio.say(m as unknown as TableSay);
      else if (m.type === "table_hush") audio.hush();
    },
    get on() {
      return !!st?.on;
    },
    /** Pebble's state at the table (null: as the call has it). */
    pebbleState(): PebbleState | null {
      if (!st?.on) return null;
      const speaking = nowSpeaking(st, heard, shownAt);
      if (speaking === "pebble") return "speaking";
      if (st.thinking === "pebble") return "thinking";
      return null;
    },
    /** From the call: what the owner's saying (stops the round table's speech), and the call's own voice's loudness. */
    ownerHeard: (t: string) => audio.ownerHeard(t),
    /** True while the round table's speech owns Pebble's mouth (so the call's level doesn't). */
    liveLevel(l: number) {
      audio.liveLevel(l);
      return heard === "pebble";
    },
    /** For the checks. */
    audio,
    tim,
  };
}
export type PhoneTable = ReturnType<typeof createPhoneTable>;
