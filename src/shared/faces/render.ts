import { shapes, colours } from "./shapes.js";
import { ICONS } from "./icons.js";
import type { BotIcon } from "./types.js";
export const eyeColour = "#FFF1DF";
export function faceDrawing(shape: string) {
  return ICONS.find(icon => icon.id === shape)?.body ?? (Object.hasOwn(shapes, shape) ? shapes[shape as keyof typeof shapes] : shapes.pebble);
}
export function faceEyes(shape: string) {
  return ICONS.find(icon => icon.id === shape)?.eyes ?? { x: 50, y: shape === "skimmer" ? 65 : shape === "moon" ? 64 : 56, gap: 16, r: 3.3 };
}
// Each caller supplies its own id so a row of faces can share one document.
export function faceContent(shape: string, colour: string, id: string, ring = false, custom?: BotIcon) {
  id = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const icon = custom ?? ICONS.find(icon => icon.id === shape);
  const body = icon?.body ?? faceDrawing(shape), eyes = icon?.eyes ?? faceEyes(shape);
  const [base, tint] = Object.hasOwn(colours, colour) ? colours[colour as keyof typeof colours] : colours.orange;
  return `<defs><radialGradient id="${id}" cx="28%" cy="12%" r="95%"><stop stop-color="${tint}"/><stop offset=".48" stop-color="${base}"/><stop offset="1" stop-color="${base}"/></radialGradient><linearGradient id="${id}-foot" x2="0" y2="1"><stop offset=".48" stop-color="#141218" stop-opacity="0"/><stop offset="1" stop-color="#141218" stop-opacity=".48"/></linearGradient><clipPath id="${id}-clip"><path d="${body}"/></clipPath><mask id="${id}-holes" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="white"/>${(icon?.cut ?? []).map(d => `<path d="${d}" fill="black"/>`).join("")}</mask></defs><g mask="url(#${id}-holes)"><path data-body="" data-shape="${Object.hasOwn(shapes, shape) ? shape : "pebble"}" d="${body}" fill="url(#${id})" stroke="${ring ? eyeColour : "none"}" stroke-width="3"/><path d="${body}" fill="url(#${id}-foot)"/><g clip-path="url(#${id}-clip)">${(icon?.marks ?? []).map(d => `<path data-mark="" d="${d}" fill="${base}" opacity=".8"/>`).join("")}</g></g>${[eyes.x - eyes.gap / 2, eyes.x + eyes.gap / 2].map(cx => `<circle data-eye="" cx="${cx}" cy="${eyes.y}" r="${eyes.r}" transform="translate(${cx} ${eyes.y}) scale(.86 1.55) translate(${-cx} ${-eyes.y})" fill="${eyeColour}"/>`).join("")}`;
}
export function faceSvg(shape: string, colour: string, id = "face", size = 100, ring = false, custom?: BotIcon) {
  const icon = custom ?? ICONS.find(icon => icon.id === shape);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" data-face="${icon?.id ?? (Object.hasOwn(shapes, shape) ? shape : "pebble")}"${icon ? ` data-icon="${icon.id}"` : ""}>${faceContent(shape, colour, id, ring, custom)}</svg>`;
}
