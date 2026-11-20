// Dev-only page: Pebble at each size, in each state, colour and moment, and the sheet viewer on a real sheet.
// Open /app/gallery.html on the dev gateway.
import "../shared/base.css";
import { Animator, type PebbleState } from "../shared/pebble/pebble";
import * as Palette from "../shared/palette";
import { SheetViewer } from "../shared/sheet-viewer/viewer";
import type { Item } from "../../../src/shared/protocol";
import { SketchView } from "../shared/items/sketch";
import { SAMPLE_SKETCHES } from "../../../src/shared/sketches";
import { modelView } from "../shared/items/model";
import { SAMPLE_MODELS } from "../../../src/shared/model3d/samples";

const root = document.createElement("main");
root.style.cssText = "padding:24px;display:grid;gap:28px;font:15px/1.4 var(--f-ui)";
document.body.appendChild(root);
const section = (title: string) => {
  const s = document.createElement("section");
  s.innerHTML = `<h2 style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:0 0 12px">${title}</h2>`;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:20px;align-items:end";
  s.appendChild(row);
  root.appendChild(s);
  return row;
};

// One animator per state so each copy can show a different state.
const states: PebbleState[] = ["idle", "listening", "thinking", "speaking"];
const sizes = section("States (stage size 220)");
for (const st of states) {
  const a = new Animator();
  const host = document.createElement("figure");
  host.style.cssText = "margin:0;width:220px;text-align:center";
  host.innerHTML = `<div style="width:220px;aspect-ratio:200/186"></div><figcaption style="color:var(--ink-3)">${st}</figcaption>`;
  sizes.appendChild(host);
  a.mount(host.firstElementChild!);
  a.set(st);
}
const small = section("Sizes: strip 50, sidebar 62");
for (const px of [50, 62]) {
  const a = new Animator();
  const d = document.createElement("div");
  d.style.cssText = `width:${px}px;height:${px}px`;
  small.appendChild(d);
  a.mount(d);
}

const colours = section("Weekday colours and moments (tap one)");
for (const d of Palette.DAYS) {
  const b = document.createElement("button");
  b.textContent = `${d.short} ${d.name}`;
  b.style.cssText = `padding:8px 12px;border-radius:999px;border:0;color:#fff;background:${d.base};font:inherit`;
  b.onclick = () => Palette.blendTo(d, 600);
  colours.appendChild(b);
}
for (const m of ["ok", "done", "error"] as const) {
  const b = document.createElement("button");
  b.textContent = m === "ok" ? "Needs your OK (hold)" : m;
  b.style.cssText = "padding:8px 12px;border-radius:999px;border:1px solid var(--line-2);background:var(--raised);color:var(--ink);font:inherit";
  b.onclick = () => (m === "ok" ? Palette.hold(Palette.currentMood() === "ok" ? null : "ok") : Palette.flash(m));
  colours.appendChild(b);
}
const work = new Animator();
const wd = document.createElement("div");
wd.style.cssText = "width:120px;aspect-ratio:200/186";
colours.appendChild(wd);
work.mount(wd);
work.working = true;

const report = section("Contrast (DESIGN §3.6)");
report.innerHTML = `<pre style="font:12.5px var(--f-mono);margin:0">${Palette.report()
  .map((r) => `${r.day} ${r.name.padEnd(7)} ring/white ${r.ringWhite.toFixed(2)}  ring/paper-dark ${r.ringPaperDark.toFixed(2)}  button light ${r.btnL.toFixed(2)}  button dark ${r.btnD.toFixed(2)}  text light ${r.inkL.toFixed(2)}  text dark ${r.inkD.toFixed(2)}`)
  .join("\n")}</pre>`;

// The viewer on the newest sheet shown (ask the fake brain "show me door 7" first).
const viewerRow = section("Sheet viewer");
fetch("/api/items?scope=recent&limit=100")
  .then((r) => r.json())
  .then(({ items }: { items: Item[] }) => {
    const sheet = items.find((i) => i.kind === "sheet");
    if (!sheet || sheet.kind !== "sheet") return void (viewerRow.textContent = 'No sheet shown yet. Ask the dev gateway "show me door 7" first.');
    const host = document.createElement("div");
    host.style.cssText = "width:390px;height:560px;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px var(--line)";
    viewerRow.appendChild(host);
    const v = new SheetViewer(host, sheet.payload);
    v.setMarks(sheet.payload.marks);
    v.show({ view: sheet.payload.view }, false);
    (window as unknown as { __viewer: SheetViewer }).__viewer = v;
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:grid;gap:8px";
    for (const [label, fn] of [
      ["Zoom out", () => v.zoomOut()],
      ["Zoom in", () => v.zoomIn()],
      ["Focus first ring", () => sheet.payload.marks[0] && v.focus(sheet.payload.marks[0].box, sheet.payload.marks[0])],
      ["Opened view", () => v.show({ view: sheet.payload.view })],
    ] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      buttons.appendChild(b);
    }
    viewerRow.appendChild(buttons);
  });

// Sketches the assistant draws (Stage 8.5): the two examples at phone size, to check by eye in light and dark.
const sketches = section("Sketches at phone size (390 × 600)");
for (const s of SAMPLE_SKETCHES) {
  const fig = document.createElement("figure");
  fig.style.cssText = "margin:0;text-align:center";
  const host = document.createElement("div");
  host.className = "gallery-sketch";
  host.style.cssText = "width:390px;height:600px;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px var(--line)";
  fig.appendChild(host);
  const cap = document.createElement("figcaption");
  cap.style.cssText = "color:var(--ink-3);margin-top:6px";
  cap.textContent = s.title;
  fig.appendChild(cap);
  sketches.appendChild(fig);
  new SketchView(host, { shapes: [...s.payload.shapes], note: s.payload.note });
}

// 3D models (Stage 9.4): the four examples at phone size, to check by eye together and pulled apart, light and dark.
const models = section("3D models at phone size (390 × 640)");
for (const m of SAMPLE_MODELS) {
  const fig = document.createElement("figure");
  fig.style.cssText = "margin:0;text-align:center";
  const host = document.createElement("div");
  host.className = "gallery-model";
  host.style.cssText = "width:390px;height:640px;border-radius:14px;overflow:hidden;box-shadow:0 0 0 1px var(--line)";
  fig.appendChild(host);
  const cap = document.createElement("figcaption");
  cap.style.cssText = "color:var(--ink-3);margin-top:6px";
  cap.textContent = m.title;
  fig.appendChild(cap);
  models.appendChild(fig);
  modelView(host, `gallery-${m.title}`, m.payload, { title: m.title, phone: true });
}
