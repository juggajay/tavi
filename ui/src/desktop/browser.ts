// The live view of the assistant's browser (Stage 15.2), in the desktop's right-hand pane: the page as a moving picture
// (the browser's own screencast, over the /browser socket), the site's real domain made obvious, what it's doing in
// plain words, and Stop, Take over and Hand back. While he has taken it over, his mouse, wheel and keys (and anything he
// pastes) go to the page through the socket and nowhere else: nothing here keeps or shows them.
import { api, esc, toast } from "./core";
import type { BrowserView } from "../../../src/shared/protocol";

const LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
const OPEN_LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.6-1.4"/></svg>';
const HAND = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10V4.5a1.25 1.25 0 0 1 2.5 0V9M9.5 8.5v-5a1.25 1.25 0 0 1 2.5 0v5M12 8.5v-3a1.25 1.25 0 0 1 2.5 0V11c0 3.5-2 6-5.5 6-2 0-3.2-.9-4.3-2.4L2.9 11.8a1.3 1.3 0 0 1 2-1.6L7 12"/></svg>';
const STOP = '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>';
const WARN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.6v.01"/></svg>';

export type LiveView = { destroy: () => void; resize: () => void; view: () => BrowserView | null };

/** Open the live view in the pane's body; the title goes in ttl. onOpenItem: "Review" a go-ahead it's waiting on. */
export function mountBrowser(body: HTMLElement, ttl: HTMLElement, o: { onReview: () => void }): LiveView {
  body.innerHTML = `<div class="bv">
    <div class="bv-bar"><div class="bv-addr" id="bvAddr"></div><div class="bv-acts" id="bvActs"></div></div>
    <div class="bv-line" id="bvLine"></div>
    <div class="bv-notes" id="bvNotes" hidden></div>
    <div class="bv-stage" id="bvStage"><canvas id="bvCanvas" tabindex="-1" aria-label="The browser's page"></canvas><div class="bv-empty" id="bvEmpty" hidden></div><div class="bv-hint" id="bvHint" hidden>Click the page to start typing</div></div>
  </div>`;
  const $ = (id: string) => body.querySelector<HTMLElement>(`#${id}`)!;
  const canvas = $("bvCanvas") as HTMLCanvasElement;
  const g = canvas.getContext("2d")!;
  let view: BrowserView | null = null;
  let last: { bmp: ImageBitmap; dw: number; dh: number } | null = null;
  let drawn = { x: 0, y: 0, w: 0, h: 0, dw: 1280, dh: 900 };
  let gone = false;
  const test = new URLSearchParams(location.search).has("test");
  const stats = { frames: 0, lastAt: 0, firstAt: 0 };
  if (test) (window as unknown as { __lhBrowser: unknown }).__lhBrowser = { stats, pixel: (x: number, y: number) => [...g.getImageData(Math.round(drawn.x + (x / drawn.dw) * drawn.w), Math.round(drawn.y + (y / drawn.dh) * drawn.h), 1, 1).data],
      // where a point on the page is on the screen (for clicking it)
      at: (x: number, y: number) => {
        const r = canvas.getBoundingClientRect();
        const dpr = devicePixelRatio || 1;
        return { x: r.left + (drawn.x + (x / drawn.dw) * drawn.w) / dpr, y: r.top + (drawn.y + (y / drawn.dh) * drawn.h) / dpr };
      },
    };

  /* ---------- the picture ---------- */
  function paint() {
    const stage = $("bvStage");
    const r = stage.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!last) return;
    // the page fitted into the stage, whole, never stretched
    const pad = 14 * dpr; // the page sits on the desk, like a drawing sheet
    const s = Math.min((canvas.width - 2 * pad) / last.dw, (canvas.height - 2 * pad) / last.dh);
    const w = last.dw * s,
      h = last.dh * s;
    const x = (canvas.width - w) / 2,
      y = (canvas.height - h) / 2;
    g.imageSmoothingQuality = "high";
    g.save();
    g.shadowColor = "rgba(12,15,17,.18)";
    g.shadowBlur = 22 * dpr;
    g.shadowOffsetY = 6 * dpr;
    g.fillStyle = "#fff";
    g.fillRect(x, y, w, h);
    g.restore();
    g.drawImage(last.bmp, x, y, w, h);
    drawn = { x, y, w, h, dw: last.dw, dh: last.dh }; // in the canvas's own (device) pixels
  }
  /** Where a point on the screen is on the page, in the page's own pixels (null outside the picture). */
  function toPage(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const px = (e.clientX - r.left) * dpr - drawn.x,
      py = (e.clientY - r.top) * dpr - drawn.y;
    if (!drawn.w || px < 0 || py < 0 || px > drawn.w || py > drawn.h) return null;
    return { x: (px / drawn.w) * drawn.dw, y: (py / drawn.h) * drawn.dh };
  }

  /* ---------- the socket ---------- */
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | 0 = 0;
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/browser`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = async (m) => {
      if (typeof m.data === "string") {
        const msg = JSON.parse(m.data) as { type: string; view: BrowserView };
        if (msg.type === "view") render(msg.view);
        return;
      }
      // only the newest picture matters: one that arrives while another is being drawn waits, and is replaced by any newer
      waiting = m.data as ArrayBuffer;
      if (!drawing) void drawNext();
    };
    ws.onclose = () => {
      if (!gone) retry = setTimeout(connect, 1000);
    };
  }
  let waiting: ArrayBuffer | null = null;
  let drawing = false;
  async function drawNext() {
    drawing = true;
    while (waiting && !gone) {
      const buf = waiting;
      waiting = null;
      const len = new DataView(buf).getUint16(0);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 2, len))) as { dw: number; dh: number; at: number };
      const bmp = await createImageBitmap(new Blob([new Uint8Array(buf, 2 + len)], { type: "image/jpeg" })).catch(() => null);
      if (!bmp) continue;
      if (gone || view?.open === false) {
        bmp.close(); // a last picture arriving after it closed
        continue;
      }
      last?.bmp.close();
      last = { bmp, dw: head.dw || bmp.width, dh: head.dh || bmp.height };
      stats.frames++;
      stats.lastAt = Date.now();
      stats.firstAt ||= stats.lastAt;
      paint();
    }
    drawing = false;
  }
  const send = (e: Record<string, unknown>) => ws?.readyState === WebSocket.OPEN && view?.takeover === "on" && ws.send(JSON.stringify({ type: "input", e }));

  /* ---------- what's around the picture ---------- */
  function render(v: BrowserView) {
    const was = view;
    view = v;
    ttl.innerHTML = `<b>Browser</b><span>${esc(v.open ? v.summary : "Not doing anything")}</span>`;
    const path = (() => {
      try {
        const u = new URL(v.url);
        return `${u.pathname === "/" ? "" : u.pathname}${u.search}`;
      } catch {
        return "";
      }
    })();
    $("bvAddr").innerHTML = v.open && v.domain ? `<span class="bv-lock${v.secure ? "" : " open"}" title="${v.secure ? "A secure connection" : "Not a secure connection"}">${v.secure ? LOCK : OPEN_LOCK}</span><b>${esc(v.domain)}</b><span class="bv-path">${esc(path)}</span>` : `<span class="bv-path">${v.open ? "Starting…" : ""}</span>`;
    $("bvAddr").title = v.url;
    body.querySelector<HTMLElement>(".bv-bar")!.hidden = !v.open;
    const acts: string[] = [];
    if (v.open) {
      if (v.takeover === "on") acts.push(`<button class="btn accent sm" type="button" data-bv="back">${v.mode === "owner" ? "Done" : "Hand back"}</button>`);
      else if (v.takeover === "pending") acts.push('<button class="btn sm" type="button" disabled>Handing over…</button>');
      else acts.push(`<button class="btn ${v.asking ? "accent " : ""}sm" type="button" data-bv="take">${HAND}Take over</button>`);
      acts.push(`<button class="btn sm danger" type="button" data-bv="stop" title="Stop it now">${STOP}Stop</button>`);
    }
    $("bvActs").innerHTML = acts.join("");
    const line = $("bvLine");
    line.className = "bv-line";
    if (!v.open) line.innerHTML = "";
    else if (v.takeover === "on") {
      line.classList.add("drive");
      line.innerHTML = `<b>You're driving.</b><span>The assistant can't see this.${v.mode === "owner" ? " Sign in, then press Done." : " Hand back when you're finished."}</span>`;
    } else if (v.asking) {
      line.classList.add("ask");
      line.innerHTML = `<b>It needs you:</b><span>${esc(v.asking)}. Press Take over and do it here.</span>`;
    } else if (v.approval) {
      line.classList.add("ok");
      line.innerHTML = `<b>Waiting for your go-ahead:</b><span>${esc(v.approval)}</span><button class="btn sm" type="button" data-bv="review">Review</button>`;
    } else line.innerHTML = `<i class="live"></i><span>${esc(v.doing || "Working")}</span>`;
    const notes = $("bvNotes");
    notes.hidden = !v.notes.length;
    notes.innerHTML = (v.open ? "" : `<small>From the last job, ${esc(v.summary)}:</small>`) + v.notes.map((n) => `<div>${WARN}<span>${esc(n)}</span></div>`).join("");
    const empty = $("bvEmpty");
    empty.hidden = v.open;
    empty.innerHTML = "<b>The browser isn't doing anything right now.</b><span>When I'm working on a website, you can watch here, take over, or stop me.</span>";
    canvas.classList.toggle("driving", v.takeover === "on");
    canvas.tabIndex = v.takeover === "on" ? 0 : -1;
    $("bvHint").hidden = v.takeover !== "on" || document.activeElement === canvas;
    if (!v.open && last) {
      last.bmp.close();
      last = null;
      paint();
    }
    if (v.takeover === "on" && was?.takeover !== "on") canvas.focus({ preventScroll: true });
  }
  body.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-bv]");
    if (!b) return;
    const a = b.dataset.bv;
    try {
      if (a === "review") return o.onReview();
      (b as HTMLButtonElement).disabled = true;
      if (a === "stop") {
        await api("/api/v2/browser/stop", { json: {} });
        toast("Stopped.");
      } else if (a === "take") await api("/api/v2/browser/takeover", { json: {} });
      else if (a === "back") await api("/api/v2/browser/handback", { json: {} });
    } catch (err) {
      (b as HTMLButtonElement).disabled = false;
      toast(err instanceof Error ? err.message : String(err));
    }
  });

  /* ---------- his hands, while he has it ---------- */
  const mods = (e: MouseEvent | KeyboardEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BUTTON = ["left", "middle", "right"] as const;
  let moveQueued: { x: number; y: number; buttons: number; mods: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (view?.takeover !== "on") return;
    const p = toPage(e);
    canvas.focus({ preventScroll: true });
    $("bvHint").hidden = true;
    if (!p) return;
    canvas.setPointerCapture(e.pointerId);
    send({ t: "mouse", kind: "down", ...p, button: BUTTON[e.button] ?? "left", buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
    e.preventDefault();
  });
  canvas.addEventListener("pointerup", (e) => {
    if (view?.takeover !== "on") return;
    const p = toPage(e);
    if (p) send({ t: "mouse", kind: "up", ...p, button: BUTTON[e.button] ?? "left", buttons: e.buttons, clicks: e.detail || 1, mods: mods(e) });
  });
  canvas.addEventListener("pointermove", (e) => {
    if (view?.takeover !== "on") return;
    const p = toPage(e);
    if (!p) return;
    const was = moveQueued;
    moveQueued = { ...p, buttons: e.buttons, mods: mods(e) };
    if (!was)
      requestAnimationFrame(() => {
        if (moveQueued) send({ t: "mouse", kind: "move", ...moveQueued });
        moveQueued = null;
      });
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (view?.takeover !== "on") return;
      const p = toPage(e);
      if (!p) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      send({ t: "wheel", ...p, dx: e.deltaX * k, dy: e.deltaY * k, mods: mods(e) });
    },
    { passive: false },
  );
  canvas.addEventListener("contextmenu", (e) => view?.takeover === "on" && e.preventDefault());
  const key = (kind: "down" | "up") => (e: KeyboardEvent) => {
    if (view?.takeover !== "on") return;
    e.stopPropagation(); // Esc and the shortcuts are the page's while he's driving
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // the paste event sends the text
    if (e.shiftKey && e.key === "Insert") return;
    e.preventDefault();
    const text = e.key.length === 1 ? e.key : e.key === "Enter" ? "\r" : "";
    send({ t: "key", kind, key: e.key, code: e.code, keyCode: e.keyCode, text, mods: mods(e), repeat: e.repeat });
  };
  canvas.addEventListener("keydown", key("down"));
  canvas.addEventListener("keyup", key("up"));
  canvas.addEventListener("paste", (e) => {
    if (view?.takeover !== "on") return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) send({ t: "text", text });
  });
  canvas.addEventListener("focus", () => ($("bvHint").hidden = true));
  canvas.addEventListener("blur", () => ($("bvHint").hidden = view?.takeover !== "on"));

  const ro = new ResizeObserver(() => paint());
  ro.observe($("bvStage"));
  connect();
  return {
    destroy() {
      gone = true;
      if (retry) clearTimeout(retry);
      ro.disconnect();
      ws?.close();
      last?.bmp.close();
      last = null;
    },
    resize: paint,
    view: () => view,
  };
}
