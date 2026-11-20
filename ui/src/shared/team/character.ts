import { faceSvg, faceEyes } from "../../../../src/shared/faces/render";
import type { Animator } from "../pebble/pebble";
import { shapes, colours } from "../../hq/avatar/shapes";
import { ICONS } from "../../hq/avatar/library";
import * as palette from "../palette";

export type Look = { shape: string; colour: string };
const iconOf = (look: Look) => ICONS.find(icon => icon.id === look.shape);
const shapeOf = (look: Look) => iconOf(look)?.body ?? (Object.hasOwn(shapes, look.shape) ? shapes[look.shape as keyof typeof shapes] : shapes.pebble);
const colourOf = (look: Look) => Object.hasOwn(colours, look.colour) ? colours[look.colour as keyof typeof colours] : colours.orange;
let serial = 0;
export function face(look: Look) { return faceSvg(look.shape, look.colour, "team-face-" + ++serial); }

// Keep each chosen outline while the eyes blink, look around and speak.
export function dress(animator: Animator) {
  let look: Look | null = null;
  const preparations: ((next: Look) => void)[] = [];
  const ns = "http://www.w3.org/2000/svg";
  for (const slot of animator.slots) {
    const update = slot.inst.update, svg = slot.inst.svg;
    const group = svg.querySelector("g")!;
    const body = group.querySelector("path")!, clip = svg.querySelector("clipPath path")!;
    const marks = document.createElementNS(ns, "g"); marks.dataset.marks = "";
    group.insertBefore(marks, group.querySelector(".c-peye"));
    const foot = document.createElementNS(ns, "path"); foot.dataset.foot = "";
    group.insertBefore(foot, marks);
    const footId = "team-foot-" + ++serial;
    const gradient = document.createElementNS(ns, "linearGradient");
    gradient.id = footId; gradient.setAttribute("x2", "0"); gradient.setAttribute("y2", "1");
    gradient.innerHTML = '<stop offset=".48" stop-color="#141218" stop-opacity="0"/><stop offset="1" stop-color="#141218" stop-opacity=".48"/>';
    svg.querySelector("defs")!.append(gradient);
    foot.setAttribute("fill", "url(#" + footId + ")");
    const light = svg.querySelector("radialGradient")!;
    light.setAttribute("cx", "28%"); light.setAttribute("cy", "12%"); light.setAttribute("r", "95%");
    const mid = document.createElementNS(ns, "stop"); mid.setAttribute("offset", ".48"); mid.setAttribute("style", "stop-color:var(--pebble-2)");
    light.insertBefore(mid, light.lastElementChild);
    const mask = document.createElementNS(ns, "mask"); mask.id = "team-cut-" + ++serial;
    mask.setAttribute("maskUnits", "userSpaceOnUse"); mask.setAttribute("x", "0"); mask.setAttribute("y", "0"); mask.setAttribute("width", "200"); mask.setAttribute("height", "220");
    svg.querySelector("defs")!.append(mask);
    slot.inst.update = p => {
      if (svg.closest(".team-on[data-team-state=stopped]")) p = { ...p, t: 0, bob: 0, breath: 0, tilt: 0, hop: 0, talk: 0, work: 0, blink: 0, gx: 0, gy: 0 };
      update(p);
      if (!look) return;
      const icon = iconOf(look);
      svg.dataset.face = icon?.id ?? (Object.hasOwn(shapes, look.shape) ? look.shape : "pebble");

      for (const path of [body, clip, foot]) {
        path.setAttribute("d", shapeOf(look));
        path.setAttribute("transform", "translate(20 26) scale(1.6)");
      }
      group.setAttribute("transform", `translate(0 ${p.bob * .6})`);
      const { x, y, gap, r } = icon?.eyes ?? faceEyes(look.shape);
      group.querySelectorAll<SVGRectElement>(".c-peye").forEach((eye, i) => {
        const cx = 20 + (x + (i ? gap / 2 : -gap / 2)) * 1.6 + p.gx * 5;
        const cy = 26 + y * 1.6 + p.gy * 4;
        eye.setAttribute("fill", "#FFF1DF");
        const width = r * 2.75, height = Math.max(1.2, width * 1.8 * p.eye * (1 - p.blink * .92) * (1 + p.talk * .15));
        eye.setAttribute("x", String(cx - width / 2)); eye.setAttribute("y", String(cy - height / 2));
        eye.setAttribute("width", String(width)); eye.setAttribute("height", String(height)); eye.setAttribute("rx", String(Math.min(width, height) / 2));
      });
    };
    const prepare = (next: Look) => {
      const icon = iconOf(next);
      marks.innerHTML = (icon?.marks ?? []).map(d => `<path d="${d}" fill="var(--pebble-2)" opacity="0.8"/>`).join("");
      marks.setAttribute("transform", "translate(20 26) scale(1.6)");
      marks.setAttribute("clip-path", `url(#${svg.querySelector("clipPath")!.id}-marks)`);
      let markClip = svg.querySelector("[data-mark-clip]");
      if (!markClip) { markClip = document.createElementNS(ns, "clipPath"); markClip.setAttribute("data-mark-clip", ""); markClip.id = svg.querySelector("clipPath")!.id + "-marks"; svg.querySelector("defs")!.append(markClip); }
      markClip.innerHTML = `<path d="${shapeOf(next)}"/>`;
      mask.innerHTML = `<rect width="200" height="220" fill="white"/>${(icon?.cut ?? []).map(d => `<path d="${d}" fill="black" transform="translate(20 26) scale(1.6)"/>`).join("")}`;
      group.setAttribute("mask", `url(#${mask.id})`);
      for (const detail of svg.querySelectorAll<SVGElement>("[data-detail],.c-white")) detail.style.display = "none";
      for (const path of [body, clip, foot]) path.removeAttribute("transform");

    };
    preparations.push(prepare);
  }
  function apply(next: Look) {
    look = next;
    const [base, tint] = colourOf(next); palette.setNow({ base, tint });
    animator.slots.forEach(slot => { slot.inst.svg.style.setProperty("--pebble-1", tint); slot.inst.svg.style.setProperty("--pebble-2", base); });
    preparations.forEach(prepare => prepare(next));
    animator.slots.forEach(slot => slot.inst.update(animator.P));
  }
  return apply;
}
