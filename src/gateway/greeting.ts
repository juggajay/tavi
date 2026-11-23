// A bare hello on a call ("hello", "hey, are you there?", "can you hear me?") is answered at once, without a bot's turn.
// On a team call the voice hands every line to the bots, so a hello used to wait five to eight seconds for a full turn
// and came back as a long reply: about ten seconds before the owner could ask what they opened the call for. Only a
// line that is nothing but a greeting counts; a greeting with anything else in it ("hello, how did the search go?")
// or another bot's name goes to the bots as before.

const HI = "(?:hello|hi|hey|hiya|yo|g'?day|good day)(?: there)?";
const THERE = "(?:(?:are )?you (?:still )?(?:there|here)|(?:is )?any(?:one|body) there|can you hear me(?: now| okay| ok)?|do you hear me)";
const TIME = "(?:good )?(?:morning|afternoon|evening)";
const TEST = "test(?:ing)?(?: test(?:ing)?)*(?: one two(?: three)?)?";
const BARE = new RegExp(`^(?:${HI}(?: ${HI})*)?(?: ?(?:${THERE}|${TIME}|${TEST}))?$`);
const TIME_OF_DAY = /\b(morning|afternoon|evening)$/;

/** The words alone: lower case, no punctuation, single spaces. */
function plain(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What to say back if the line is only a greeting (the name of the bot on the call may be in it), or null if it is
 * anything more. "Good morning" gets "Morning." back; every other hello gets "I'm here."
 */
export function bareGreeting(text: string, botName?: string): string | null {
  let said = plain(text);
  if (!said) return null;
  const name = botName ? plain(botName) : "";
  if (name) {
    if (said === name) return "I'm here.";
    // the name may come first, last or in the middle ("hey Mira, are you there?")
    said = ` ${said} `.split(` ${name} `).join(" ").replace(/\s+/g, " ").trim();
  }
  if (!said || !BARE.test(said)) return null;
  const time = TIME_OF_DAY.exec(said)?.[1];
  return time ? `${time[0].toUpperCase()}${time.slice(1)}.` : "I'm here.";
}
