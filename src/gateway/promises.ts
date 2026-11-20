// What the voice says by itself that it has no business saying (Stage 18.2), and what the owner says that always goes to
// the brain. The voice model only talks and listens: it can't do anything, and it doesn't know what the app can do. When
// it answers by itself with a promise of work ("One sec", "Checking now", "Sure, bringing him in"), a refusal ("I can't do
// that") or a claim about who's here or what can be done ("You're speaking with me…"), and no hand-over came for those
// words, the gateway sends them to the brain itself. The lists are short and tested against the recorded calls of 13 and
// 14 November (tests/unit/promises.test.ts).
//
// No imports and only plain type annotations, so scripts/voice-trace.mjs loads this same file (Node strips the types)
// and counts exactly what the gateway acts on.

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\[[^\][]{0,16}\]?/g, " ") // transcribed noises: "[sniff]", "[chuckle", "[clear throat]"
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const esc = (s: string) => s.replace(/[^a-z0-9']/g, "");

/** Promises of work: something will be checked, fetched, shown or done. */
const PROMISE: RegExp[] = [
  // "One sec.", "Just a moment." (not "take a sec", said back to "give me a sec")
  /(?<!\b(take|take your|took|taking|need|needs|give|have|got|in) )\b(one|a|just a) (sec|second|moment|mo|tick|minute)\b/,
  /\bon it\b/, // "On it."
  // "Let me check that.", "I'll pull that up.", "I'll take that and set it up."
  /\b(let me|lemme|i'll|i will|i'm going to|i'm gonna|gonna) (just )?(check|look|have a look|find|pull|bring|get|grab|put|set|sort|do|make|send|draft|book|open|show|add|start|end|close|try|take|work|ring|call)\b/,
  // "Checking now.", "Checking that now.", "bringing him in", "ending it now", "pulling it up"
  /\b(checking|looking|pulling|bringing|getting|grabbing|putting|finding|setting|sorting|working|ending|starting|opening|sending|drafting|booking|making|adding|building)( (it|that|this|them|him|her|those|the \w+))?( (up|in|on|over|out|now|for you|into it))+\b/,
  /^(checking|looking|pulling|bringing|getting)\b/, // "Checking."
];

/** Refusals, and claims about what can be done or who's in the conversation: the brain's to say, never the voice's. */
const CLAIM = (guest: string): RegExp[] => [
  // "I can't do that", "I'm not able to", "I don't have the ability" (not "I can't hear you": asking him to say it again
  // is the voice's own job)
  /\b(i|we) (can't|cannot|can not|couldn't|won't be able to|don't have (the|any) (ability|way|access|tools?|option)|have no way)\b(?! (quite )?(hear|catch|make out|understand|follow))/,
  /\b(i'm|i am|we're|we are) (not able|unable)\b/,
  /\bi don't have (a|any) name\b/,
  /\b(you're|you are|you) (speaking|talking) (with|to) (me|us|the|your|an?|leading)\b/, // "You're speaking with me in Tavi"
  /\bit's (just )?(you and me|me and you|just me)\b/,
  new RegExp(`\\bi'm (not )?(${esc(guest) || "echo"}|a robot|an ai|a bot|a person|human|real|your (tavi|assistant))\\b`), // "Yes. I'm Echo."
  /\b(he|she)('ll| will| can| can't| cannot| won't| doesn't| does)( \w+){0,2} (talk|speak|hear|answer|reply|join)\b/, // "He'll talk back in his own voice"
];

/** The voice answered by itself with a refusal or a claim about abilities ("claim"), or a promise of work ("promise"). */
export function overreach(voiceText: string, guest = "Tim"): "promise" | "claim" | null {
  const t = norm(voiceText);
  if (!t) return null;
  if (CLAIM(norm(guest)).some((r) => r.test(t))) return "claim";
  if (PROMISE.some((r) => r.test(t))) return "promise";
  return null;
}

/** What the owner said that always goes to the brain, whatever the voice does with it: naming the assistant, changing a
 * setting, or anything said to another assistant by name (the round table's guest). */
export function mustGo(ownerText: string, guest = "Tim"): "naming" | "setting" | "by name" | null {
  const t = norm(ownerText);
  if (!t) return null;
  if (/\b(call yourself|your name|name you|rename you|new name|be called)\b|\b(can i|i'll|i will|let me|i'm going to|i'm gonna|we'll|i wanna|i want to) call you (?!back\b|later\b|tomorrow\b|in\b|when\b|after\b|soon\b|tonight\b|on\b)\w/.test(t))
    return "naming";
  if (/\b(change|switch|swap|set|turn|make) (the |your |his |her |its |my |that |\w+'s )?(voice|voices|setting|settings|accent|speed|volume)\b|\b(male|female|man's|woman's|different|deeper|other) voice\b|\bhow hard (it|you) thinks?\b|\bin (the )?settings\b/.test(t))
    return "setting";
  const g = esc(norm(guest));
  if (g && new RegExp(`(^|\\b(hey|hi|oi|ok|okay|so|and|right|yo) )${g}\\b|\\b${g}$`).test(t)) return "by name";
  return null;
}

/** Only a filler or a noise: never a request ("mm", "yeah", "[sniff]", "uh"). */
export function noise(ownerText: string) {
  const t = norm(ownerText);
  return !t || /^((mm+|hmm+|mhm|uh+|um+|er+|ah+|oh+|uh huh|yeah|yep|yes|right|okay|ok|sure|cool|so|and|alright) ?)+$/.test(t);
}

/** For the brain, when the voice had already answered by itself and the gateway sent his words on: what it said may be a
 * promise nobody was keeping, a wrong refusal or a wrong claim, and the brain corrects it rather than repeating it. */
export const voiceSaidNote = (said: string) =>
  `(Tavi, not the user) Before this reached you, the voice answered it by itself and didn't pass it on: "${said.replace(/\s+/g, " ").slice(0, 300)}". The voice can't do anything and doesn't know what you can do. If it promised something, do it now. If it refused, explained what can or can't be done, or said who's in the conversation, and that was wrong, correct it in a sentence without repeating it. Then answer.`;

/** The voice's line is the rest of an answer it was given, carrying on after a noise from him ("[sniff" … "you do. Last
 * night I put…"): most of its words are in that answer. */
export function continues(voiceText: string, answer: string) {
  const w = norm(voiceText).split(" ").filter((x) => x.length > 2);
  if (!w.length || !answer) return false;
  const a = new Set(norm(answer).split(" "));
  return w.filter((x) => a.has(x)).length / w.length >= 0.7;
}
