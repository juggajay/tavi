// Makes a bot computer's wallpaper with made-up bots and checks it is strict XML: no attribute written twice on one
// element. The bots' Linux space draws the wallpaper with a strict reader, and one bad wallpaper stops a screen starting.
//   node --import tsx tests/unit/hq-desk-strict.test.ts
import "../isolate.ts";
const { wallpaper } = await import("../../src/hq/screens/desktop.js");
const { shapes, colours } = await import("../../src/shared/faces/shapes.js");
const { ICONS } = await import("../../src/shared/faces/icons.js");
let problems = 0;
for (const shape of [...Object.keys(shapes), ...ICONS.map((icon: { id: string }) => icon.id)]) for (const colour of Object.keys(colours)) for (const theme of ["dark", "light"] as const) {
  const svg = wallpaper({ id: "sample", name: "Sample", role: "Everyday ideas and plans", look: { shape, colour } } as never, 1440, 900, { theme });
  for (const tag of svg.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    const names = [...tag.matchAll(/\s([a-zA-Z_:][\w:.-]*)\s*=/g)].map(match => match[1]);
    const twice = names.filter((name, i) => names.indexOf(name) !== i);
    if (twice.length) { problems++; if (problems <= 5) console.log(`${shape}/${colour}/${theme}: "${twice.join(", ")}" written twice in ${tag.slice(0, 160)}`); }
  }
}
console.log(problems ? `${problems} problems` : "every wallpaper is strict XML");
process.exitCode = problems ? 1 : 0;
