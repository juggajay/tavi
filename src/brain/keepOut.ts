// Websites that ask robots or AI tools not to fetch their pages (Stage 20.3): the brain's web tool doesn't open them.
// Found while building Stage 14 and Stage 20, each with its evidence. The owner can still open any of them himself, and
// put a maker's guide on the shelf by hand (Guides\<Maker>\). Checked by the web guard (guards.ts) before WebFetch runs.

export const KEEP_OUT: { host: RegExp; who: string; why: string }[] = [
  { host: /(^|\.)abcb\.gov\.au$/i, who: "the ABCB (the NCC's own site)", why: "its robots file asks AI tools by name (Claude-User, ChatGPT-User and others) to keep out of the whole site (read 14 Nov 2026)" },
  { host: /(^|\.)pryda\.com\.au$/i, who: "Pryda", why: "its terms ban robots and automated downloads (Stage 14)" },
  { host: /(^|\.)mitek\.com\.au$/i, who: "MiTek", why: "its terms ban robots and automated downloads (Stage 14)" },
  { host: /(^|\.)strongtie\.com\.au$|(^|\.)strongtie\.co\.nz$/i, who: "Simpson Strong-Tie", why: "its terms ban robots and automated downloads (Stage 14)" },
  { host: /(^|\.)gainsboroughhardware\.com\.au$/i, who: "Gainsborough", why: "its terms ban robots and automated downloads (Stage 14)" },
  { host: /(^|\.)humedoors\.com\.au$/i, who: "Hume Doors", why: "its terms ban robots and automated downloads (Stage 14)" },
  { host: /(^|\.)research\.fs\.usda\.gov$/i, who: "the US Forest Service's research site", why: "its robots file tells every robot to keep out (read 14 Nov 2026)" },
];

/** Why the brain mustn't open this host, in words it can pass on, or null. */
export function keepOutReason(hostname: string): string | null {
  const k = KEEP_OUT.find((x) => x.host.test(hostname));
  return k
    ? `${k.who} asks robots and AI tools not to fetch its pages (${k.why}), so I don't open it. Don't look for another way round: say what's needed, and that the owner can open the page himself, or save the guide into the shelf's Guides folder for you to read.`
    : null;
}
