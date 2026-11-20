import { colours } from "../../../shared/faces/shapes.js";


export const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function palette(colour: string) {
  return Object.hasOwn(colours, colour) ? colours[colour as keyof typeof colours] : colours.orange;
}
export function wash(colour: string, dark: boolean): [string, string] {
  const [base, tint] = palette(colour);
  const mix = (a: string, b: string, amount: number) => "#" + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * amount + parseInt(b.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, "0")).join("");
  return dark ? ["#17181D", mix(base, "#202127", .14)] : ["#F5EEE5", mix(tint, "#F5EEE5", .65)];
}
export { faceDrawing as drawing } from "../../../shared/faces/render.js";
import { faceSvg } from "../../../shared/faces/render.js";
/** One face, at the size asked for. Never re-size it by rewriting its opening tag: an attribute written twice is not
 * valid XML, and the bots' Linux space refuses a wallpaper like that (found on the real space: no screen could start). */
export function face(shape: string, colour: string, id = "face", size = 100) {
  return faceSvg(shape, colour, id, size).replace(' xmlns="http://www.w3.org/2000/svg"', "");
}
