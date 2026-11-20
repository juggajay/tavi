// A wall in code (Stage 21.2): the assistant never says or implies that something is structurally adequate, strong
// enough or certified. The rules say so; this catches it in the finished answer too, whatever the rules said. An answer
// that makes such a claim is sent back once to be said again without it (the gateway does that, like its "show it"
// nudge). The patterns are deliberately narrow: an affirmative claim about strength or adequacy, not a mention of one.
// "I can't say it's strong enough", "whether it's adequate is for an engineer" and "that's sound advice" pass.

/** Affirmative claims of adequacy, strength or certification. */
const CLAIMS: RegExp[] = [
  /\bstructurally (?:sound|adequate|fine|ok(?:ay)?|safe|good|right)\b/i,
  /\b(?:is|it's|its|that's|this is|they're|they are|it is|will be|would be|should be|it'll be|'ll be|be|are) (?:plenty |easily |more than |well )?(?:strong enough|sound(?! (?:advice|idea|plan|thinking|choice|approach|point|reason))|adequate|up to (?:the|that|its) (?:load|job|weight))\b/i,
  /\b(?:is|it's|that's|will be|would be|it'll be|'ll be|be) (?:perfectly |completely )?safe to (?:stand|walk|load|use|build|hang)\b/i,
  /\b(?:will|would|should|'ll|can|could) (?:easily |comfortably |happily )?(?:hold|carry|take|support|handle|bear) (?:the |that |its |a |your )?(?:load|weight|deck|roof|floor|span|people|downward force)\b/i,
  /\b(?:i(?:'ve| have)? (?:certified|certify)|is certified|engineer[- ]approved|signed off as (?:safe|sound|adequate))\b/i,
];
/** Words that make it not a claim when they come before it in the same sentence. */
const NOT = /\b(?:not|never|no|cannot|without|whether|if|unless|until|nobody|none|neither|nor|whatever|confirms?|confirmed|for an engineer|needs? an? engineer)\b|\w+n't\b|\bwhat\b.*\?/i;

/** The first claim of adequacy in an answer, as quoted words, or null. */
export function adequacyClaim(text: string): string | null {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const re of CLAIMS) {
      const m = re.exec(sentence);
      if (!m) continue;
      const before = sentence.slice(0, m.index);
      if (NOT.test(before) || /\b(?:not|never)\b/i.test(m[0])) continue;
      return sentence.trim();
    }
  }
  return null;
}

/** Sent back to the brain (not the user) when its answer makes such a claim: once, then the answer stands. */
export const RESAY = (claim: string) =>
  `(Tavi, not the user) Your answer says or implies that something is structurally adequate, strong enough or certified ("${claim.slice(0, 200)}"). ` +
  "That's a wall: you never claim it. Give the whole answer again without that claim: what it is and what it's designed for, and who confirms it's adequate (an engineer, the maker or the certifier). Don't mention this note.";

/** The last resort, if the answer said again still claims it: the claiming sentences come out, and the plain line goes in. */
export function withoutClaimSentences(text: string): string {
  const kept = text.split(/(?<=[.!?])\s+/).filter((s) => !adequacyClaim(s));
  return `${kept.join(" ")} Whether it's strong enough is for an engineer to confirm.`.trim();
}
