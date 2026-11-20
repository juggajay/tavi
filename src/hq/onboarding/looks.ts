// The existing picker sends its choice here. Keep the same names the picker uses.
import { shapes, colours } from "../../shared/faces/shapes.js";
import { ICONS } from "../../shared/faces/icons.js";
export const shapesAllowed = (shape: string, colour: string) => (Object.hasOwn(shapes, shape) || ICONS.some(i => i.id === shape)) && Object.hasOwn(colours, colour);
