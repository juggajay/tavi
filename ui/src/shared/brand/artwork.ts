import { faceContent } from "../../../../src/shared/faces/render";
export const familyMembers = [
  { shape: "cobble", colour: "green", x: 64, y: 10, scale: 1.12 },
  { shape: "shard", colour: "blue", x: 151, y: 14, scale: 1.16 },
  { shape: "skimmer", colour: "plum", x: 10, y: 55, scale: 1.2 },
  { shape: "moon", colour: "yellow", x: 201, y: 61, scale: 1.13 },
  { shape: "pebble", colour: "orange", x: 97, y: 53, scale: 1.3 },
];
const svg = (box: string, content: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">${content}</svg>\n`;
export function mark(small = false, sticker = false) {
  const members = small ? [familyMembers[0], familyMembers[1], familyMembers[4]] : familyMembers;
  const content = members.map((m, i) => `<g transform="translate(${m.x} ${m.y}) scale(${m.scale})">${faceContent(m.shape, m.colour, "brand-" + i, sticker)}</g>`).join("");
  return svg(small ? "65 3 202 165" : "0 0 330 175", content);
}
export function wordmark(ink = "#F4E7D9", line = false) {
  return svg(line ? "0 0 270 132" : "0 0 270 100", `<g fill="${ink}"><path d="M17 7 Q7 7 7 17 Q7 27 17 27 L42 27 L42 82 Q42 93 53 93 Q64 93 64 82 L64 27 L88 27 Q98 27 98 17 Q98 7 88 7 Z"/><path fill-rule="evenodd" d="M99 35 C116 27 144 31 151 45 Q157 54 157 69 L157 83 Q157 94 147 94 Q138 94 137 87 C125 100 91 94 91 73 C91 52 117 49 136 55 C136 47 123 45 109 50 Q97 55 95 45 Q93 38 99 35 Z M136 69 C127 64 111 66 111 73 C111 82 135 82 136 72 Z"/><path d="M164 48 Q159 34 170 32 Q180 29 185 42 L200 73 L214 42 Q219 29 230 33 Q240 37 234 50 L213 85 Q209 94 200 94 Q191 94 187 85 Z"/><rect x="244" y="33" width="22" height="61" rx="11"/><circle cx="255" cy="13" r="12"/></g>${line ? `<text x="135" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="${ink}">Your own small team.</text>` : ""}`);
}
export function tile(small = false, off = false, maskable = false) {
  return svg("0 0 512 512", `<defs><linearGradient id="tile" x2=".3" y2="1"><stop stop-color="#32333D"/><stop offset="1" stop-color="#14151A"/></linearGradient></defs><rect width="512" height="512" rx="${maskable ? 0 : 110}" fill="url(#tile)"/><rect x="2" y="2" width="508" height="508" rx="${maskable ? 0 : 108}" fill="none" stroke="#77717F" stroke-opacity=".4" stroke-width="3"/><g${off ? ' style="filter:grayscale(1);opacity:.65"' : ""} transform="translate(${small ? 45 : maskable ? 99 : 38} ${small ? 90 : maskable ? 152 : 121}) scale(${small ? 2.1 : maskable ? .95 : 1.32})">${(small ? '<g transform="translate(-65 -3)">' + mark(small).replace(/<svg[^>]*>|<\/svg>/g, "") + "</g>" : mark(small)).replace(/<svg[^>]*>|<\/svg>/g, "")}</g>`);
}
export function banner(light = false) {
  const ink = light ? "#27252B" : "#F4E7D9";
  return svg("0 0 1440 600", `<rect width="1440" height="600" fill="${light ? "#F5EEE5" : "#17181D"}"/><g transform="translate(120 150) scale(1.7)">${mark().replace(/<svg[^>]*>|<\/svg>/g, "")}</g><g transform="translate(820 168) scale(1.45)">${wordmark(ink, true).replace(/<svg[^>]*>|<\/svg>/g, "")}</g>`);
}
