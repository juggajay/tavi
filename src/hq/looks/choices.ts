import { shapes, colours } from "../../shared/faces/shapes.js";
import { ICONS } from "../../shared/faces/icons.js";

export { colours };
export const lookChoices = [
  ...ICONS.map(icon => ({ id: icon.id, name: icon.name, label: "Icon" })),
  ...Object.keys(shapes).map(id => ({ id, name: id, label: "Shape" })),
];
const plain = (value: string) => value.toLowerCase().trim().replace(/[-_]/g, " ").replace(/\s+/g, " ");
const shapeWords: Record<string, string> = {
  round: "marble", circle: "marble", circular: "marble", "round one": "marble",
  square: "cobble", "square one": "cobble", tall: "lozenge", oval: "lozenge",
  triangle: "shard", triangular: "shard", cloud: "moon", "cloud one": "moon",
  flat: "skimmer", bean: "sliver", sweet: "sweet-counter/wrapped-sweet",
  book: "paper-parade/open-book", controller: "game-cupboard/gamepad", yeti: "odd-company/pocket-yeti",
};
export function shapeNamed(words: string): string | undefined {
  const name = plain(words).replace(/^(?:the |a |an )/, "");
  return lookChoices.find(choice => plain(choice.id) === name || plain(choice.name) === name)?.id
    ?? (Object.hasOwn(shapeWords, name) ? shapeWords[name] : undefined);
}
export function colourNamed(words: string): string | undefined {
  const name = plain(words);
  const aliases: Record<string, string> = { purple: "plum", grey: "slate", gray: "slate", "light blue": "sky" };
  const mapped = Object.hasOwn(aliases, name) ? aliases[name] : name;
  return Object.hasOwn(colours, mapped) ? mapped : undefined;
}
