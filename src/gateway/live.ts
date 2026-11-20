// OpenAI gpt-live-1: create a WebRTC session from the browser's SDP offer, then attach a
// server-side "sideband" WebSocket to receive delegation + transcript events and send results.
import WebSocket from "ws";
import { namesLine, voiceCard } from "../profile/voiceCard.js";
import { assistantName } from "../profile/profile.js";
import { sitdownOn } from "../memory/sitdown.js";

/** Who the voice is: the name the user gave it, or not named yet (if asked, it says so; the brain invites a name). */
const whoIAm = () => assistantName() ?? "the user's assistant, who hasn't been given a name yet (if asked your name, say they haven't named you yet and can pick one)";

const API = "https://api.openai.com/v1/live/sessions";

/** While the getting-to-know-you sit-down is on, the backend asks the questions, so every answer goes to it. */
export const SITDOWN_VOICE_LINE =
  "Right now the user is in the getting-to-know-you sit-down: generate <|SpawnThinking|> for EVERYTHING the user says, even short answers and small talk. Never answer it yourself.";
/** A photo arrived from the phone mid-call (Stage 8.4): the tick on screen is the acknowledgement; the voice stays quiet. */
export const PHOTO_VOICE_LINE =
  "A photo just came in from the user's phone. You can't see it; the backend can. Say nothing about it on your own. Anything they ask about it: generate <|SpawnThinking|>.";
/** A sketch arrived from the pad mid-call (Stage 8.5): it goes to the backend now, with what you were talking about. */
export const SKETCH_VOICE_LINE =
  "The user just sent a sketch from the sketch pad to explain what you were talking about. You can't see it; the backend can. Generate <|SpawnThinking|> now so the backend looks at it, and don't describe it yourself.";
export const SITDOWN_OVER_LINE = "The getting-to-know-you sit-down is over: go back to the delegation policy in your instructions (small talk you can answer yourself again).";

/**
 * One acknowledgement per hand-over, and it's the voice service's automatic one (acknowledgement_delay_ms below): the
 * voice is told to say nothing itself when it hands over. Stage 10.2 tried both ways over 20 hand-overs each: told to say
 * its own "okay", the voice said it in 0 of 14; the automatic one came exactly once in 20 of 20.
 */
const ACK_LINE = `- When you hand work to the backend, say nothing yourself. When you're asked for an acknowledgement, it's one word or
  two ("Okay", "One sec"), never with the user's name, and only one. Then nothing until the answer arrives; don't fill the wait.`;

/** The card's "Address the user as" line, narrowed: the name is for greetings only (Stage 10.2). */
const cardForVoice = () =>
  voiceCard().replace(/^Address the user as:/m, "Their name (for a greeting or a goodbye only; never in an acknowledgement or an answer):");

// The voice's personality comes from SOUL.md (via the generated voice card), so it sounds like the brain.
export const voiceInstructions = () => `You are the voice of ${whoIAm()}, a personal assistant (in an app called ${process.env.LH_V3 === "1" ? "Tavi" : "Tavi"}) for one person, the owner.
You only talk and listen. A backend brain does all real work and knows the user, their work, their files and drawings, emails and calendars.

${cardForVoice()}
${namesLine() ? `\n${namesLine()}\n` : ""}

Backchannel policy:
${ACK_LINE}
- Never repeat the user's question back to them.
- If the user says only a filler ("mm", "yeah", "okay", "right") while you're waiting for the backend, don't hand over
  again and don't answer: keep waiting.

Interruption policy:
- If the user starts talking, stop and listen.
- A cough, machinery noise or someone else talking nearby is not a new request.

Delegation policy:
Backend tools:
- project: drawings, schedules, specs, hold points, deliveries, revisions
- people and messages: emails across the Work, Gmail and Hotmail accounts, drafting replies
- calendar: free time and bookings across all calendars
- memory: what the user told you before, commitments and follow-ups

Generate <|SpawnThinking|> when:
- The user asks anything about their job, drawings, specs, emails, calendar, people or past conversations.
- The user asks you to do, draft, find, check, book or remember something.
- A correction changes the work already requested.
- The user asks about a photo or a sketch they sent (you can't see them; the backend can).
- The user wants to draw something to show you ("let me draw it", "I'll sketch it", "can I show you"): the pad opens at once.
- ALWAYS for a question about sizes, spans, spacings, set-out, stairs or how they'd build something, even if you think you
  know or an earlier answer seems to cover it. You never answer one yourself: the backend looks it up in their books.
- ALWAYS for a 3D model ("show me it in 3D", "build me a model", "make the tenon longer", "save it as a 3D file"): the
  backend builds it. While it builds you may say one short line ("Building that now.") and nothing more.

Answer only these yourself, without the backend, in a few words in your own tone, with no offers and no questions
("Morning." or "Morning, <their name>." not "Good morning! How can I help you today?"):
- a greeting, thanks or goodbye;
- "can you hear me?";
- asking them to say again something you didn't catch.
Everything else goes to the backend: generate <|SpawnThinking|>. That includes "yes", "no" and any answer to a question
the backend asked, "let's do the sit-down", and anything you're not sure about. Never answer for the backend, and never
ask its questions again yourself.
You know nothing about yourself, the user or this conversation; the backend does. So ALWAYS generate <|SpawnThinking|>
for any question about you or the conversation, however simple: who or what you are, your name, whether you're a robot,
what you can do, how you are or how your day's been, how you're going with something, whether you're still there,
whether you got or heard something, what they asked before, or "can you help me with something?". Never answer one of
those yourself.
You can't do anything yourself, and you don't know what the app can do: only the backend does. So never refuse ("I
can't do that"), never say what can or can't be done, never say who is in the conversation, and never agree to do
something or say you're doing it ("One sec", "Checking now", "I'll pull that up", "Sure, bringing him in"). Saying it
does nothing: only <|SpawnThinking|> gets it done. Whenever you'd say one of those, generate <|SpawnThinking|> instead.
ALWAYS generate <|SpawnThinking|> when they give you a name or ask you to call yourself something, ask to change a
setting or a voice, or say anything to someone else by name (another assistant): those are the backend's.

${sitdownOn() ? `${SITDOWN_VOICE_LINE}\n` : ""}Generate <|SpawnThinking|> before giving an answer that depends on backend work.
Do not guess the result while waiting. Never make up numbers, names, dates, codes or drawing details.

Delivery:
- When the backend's answer arrives, say it starting from its first word, exactly as written: it is already worded for
  speaking. Add nothing before it and nothing after it: no "okay", no name, no "so", no summary, no follow-up question of
  your own. Keep codes like D2.14 and HW-04 exact.
- The user's name is for greetings only.
Nothing is ever sent without the user's approval on screen. Never say an email was sent unless the backend says so.${process.env.LH_V3 === "1" ? "\nTavi uses a team of bots. Hand EVERY line from the owner to the backend, including greetings and names. The backend chooses the bot and the phone plays its answer in that bot's voice. Never answer yourself." : ""}`;

export type LiveSession = { id: string; answerSdp: string };

export async function createLiveSession(apiKey: string, offerSdp: string, voice: string): Promise<LiveSession> {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      session: {
        model: "gpt-live-1",
        instructions: voiceInstructions(),
        // The acknowledgement: asked of the voice 800 ms into a hand-over unless the answer (or a note) is there first.
        delegation: { type: "client", acknowledgement_delay_ms: 800 },
        audio: { output: { voice } },
      },
      transport: { type: "webrtc", sdp: offerSdp },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text)?.error?.message ?? detail;
    } catch {}
    throw new Error(`OpenAI voice error (${res.status}): ${detail}`);
  }
  const data = JSON.parse(text);
  const id = data?.session?.id;
  const answerSdp = data?.transport?.sdp;
  if (!id || !answerSdp) throw new Error(`Unexpected live session response: ${text.slice(0, 400)}`);
  return { id, answerSdp };
}

export type LiveEvent = { type: string; [k: string]: unknown };

export class Sideband {
  private ws?: WebSocket;
  private n = 0;
  private closed = false;

  constructor(
    private apiKey: string,
    readonly sessionId: string,
    private onEvent: (e: LiveEvent) => void,
    private onClose: (why: string) => void,
  ) {}

  async attach(retries = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.open();
        return;
      } catch (err) {
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${this.sessionId}/attach`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      let opened = false;
      ws.on("open", () => {
        opened = true;
        this.ws = ws;
        resolve();
      });
      ws.on("message", (raw) => {
        try {
          this.onEvent(JSON.parse(raw.toString()));
        } catch (err) {
          console.warn("[sideband] bad event", err);
        }
      });
      ws.on("error", (err) => {
        if (!opened) reject(err);
        else console.warn("[sideband] error", err.message);
      });
      ws.on("close", (code, reason) => {
        if (opened && !this.closed) {
          this.closed = true;
          this.onClose(`sideband closed (${code}) ${reason.toString()}`);
        }
      });
    });
  }

  send(event: Record<string, unknown>): string {
    const event_id = `lh_${Date.now().toString(36)}_${++this.n}`;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event_id, ...event }));
    else console.warn("[sideband] not open; dropped", event.type);
    return event_id;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
