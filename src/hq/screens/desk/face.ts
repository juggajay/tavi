import { shapes, colours } from "../../../shared/faces/shapes.js";
import { ICONS } from "../../../shared/faces/icons.js";

export const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function palette(colour: string) {
  return Object.hasOwn(colours, colour) ? colours[colour as keyof typeof colours] : colours.orange;
}
export function wash(colour: string, dark: boolean): [string, string] {
  const [base, tint] = palette(colour);
  const mix = (a: string, b: string, amount: number) => "#" + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * amount + parseInt(b.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, "0")).join("");
  return dark ? ["#171D28", mix(base, "#252B3A", .14)] : ["#FAFCFF", mix(tint, "#FAFCFF", .65)];
}
export function drawing(shape: string) {
  return ICONS.find(icon => icon.id === shape)?.body ?? (Object.hasOwn(shapes, shape) ? shapes[shape as keyof typeof shapes] : shapes.pebble);
}
export function face(shape: string, colour: string, id = "face"): string {
  const [base, tint] = palette(colour), icon = ICONS.find(icon => icon.id === shape);
  const eyes = icon ? [icon.eyes.x - icon.eyes.gap / 2, icon.eyes.x + icon.eyes.gap / 2].map(cx => `<circle cx="${cx}" cy="${icon.eyes.y}" r="${icon.eyes.r}" fill="#1A120C"/>`).join("") :
    '<ellipse cx="40" cy="50" rx="3.4" ry="6.2" fill="#1A120C"/><ellipse cx="58" cy="50" rx="3.4" ry="6.2" fill="#1A120C"/><circle cx="41" cy="47" r="1" fill="white"/><circle cx="59" cy="47" r="1" fill="white"/>';
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><defs><radialGradient id="${id}-colour" cx="30%" cy="22%" r="85%"><stop stop-color="${tint}"/><stop offset="1" stop-color="${base}"/></radialGradient><clipPath id="${id}-clip"><path d="${drawing(shape)}"/></clipPath><mask id="${id}-holes"><rect width="100" height="100" fill="white"/>${(icon?.cut ?? []).map(d => `<path d="${d}" fill="black"/>`).join("")}</mask></defs><g mask="url(#${id}-holes)"><path d="${drawing(shape)}" fill="url(#${id}-colour)"/><g clip-path="url(#${id}-clip)">${(icon?.marks ?? []).map(d => `<path d="${d}" fill="${base}" opacity="0.8"/>`).join("")}</g></g>${eyes}</svg>`;
}
