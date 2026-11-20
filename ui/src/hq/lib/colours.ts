import type { CSSProperties } from "react";

const accents: Record<string, string> = {
  orange: "#A34313", blue: "#2F61C5", teal: "#086D70", slate: "#4F7191",
  pink: "#AD307E", sky: "#146D9F", plum: "#82409F", green: "#17783F",
};
export function botAccent(colour = "orange"): CSSProperties {
  const accent = Object.hasOwn(accents, colour) ? accents[colour] : accents.orange;
  return { "--bot-bubble": accent, "--bot-action": accent, "--bot-action-hover": `color-mix(in srgb, ${accent}, black 18%)`, "--bot-on-action": "#FFFFFF" } as CSSProperties;
}
