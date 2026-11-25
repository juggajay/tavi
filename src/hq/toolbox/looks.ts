import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { testSafe, type TurnCtx } from "../../brain/turn.js";
import { toClient, clientById } from "../../gateway/clients.js";
import { getBot, listBots, updateBot } from "../bots.js";
import type { Bot } from "../contract.js";
import { lookChoices, colours, shapeNamed, colourNamed } from "../looks/choices.js";

type LookHost = { changed(bot: Bot): void };
let host: LookHost | undefined;
export function installLooks(next: LookHost) {
  host = next;
  return () => { if (host === next) host = undefined; };
}
const reply = (value: unknown, isError = false) => ({ isError, content: [{ type: "text" as const, text: JSON.stringify(value) }] });
function target(ctx: TurnCtx, name?: string) {
  const caller = getBot(ctx.turn.bot ?? ctx.bot ?? "");
  if (!caller) throw new Error("Choose a bot on the team first.");
  if (ctx.background || ctx.turn.background) throw new Error("Wait for the owner to ask for a look.");
  if (!name || ["me", "myself", "self", "yourself"].includes(name.toLowerCase().trim())) return caller;
  const found = listBots().filter(bot => bot.id === name || bot.name.toLowerCase() === name.toLowerCase().trim());
  if (found.length !== 1) throw new Error("Name one bot on the team, or leave bot out for your own look.");
  if (caller.id !== found[0].id && !caller.lead) throw new Error("Only the lead can change another bot's look. Ask the lead.");
  return found[0];
}
export function changeLook(bot: string, patch: { shape?: string; colour?: string }) {
  if (!host) throw new Error("The team is not ready to change looks. Try again.");
  const current = getBot(bot);
  if (!current) throw new Error("That bot is no longer on the team.");
  const shape = patch.shape === undefined ? current.look.shape : shapeNamed(patch.shape);
  const colour = patch.colour === undefined ? current.look.colour : colourNamed(patch.colour);
  if (!shape || !colour) throw new Error(`Choose a look such as marble (round), pebble, jellyfish or toast, and a colour: ${Object.keys(colours).join(", ")}.`);
  const next = updateBot(bot, { look: { shape, colour } });
  host.changed(next);
  return next;
}
export function lookTools(ctx: TurnCtx) {
  const safe = async (run: () => unknown) => { try { return reply(run()); } catch (error) { return reply({ error: (error as Error).message }, true); } };
  const bot = z.string().trim().min(1).max(120).optional().describe("Bot name or id. Leave out for yourself. Only the lead may name another bot.");
  return testSafe(ctx, [
    tool("show_looks", "Show the owner the look picker for yourself or a named bot on the screen they are using. Say 'Here are the choices' and wait for their choice.", { bot },
      async args => safe(() => {
        const chosen = target(ctx, args.bot), origin = ctx.turn.origin;
        if (!origin || !("id" in origin) || !clientById(origin.id)) throw new Error("Open the phone or desktop conversation to see the choices.");
        toClient(origin.id, { type: "hq_show_looks", bot: chosen.id });
        return { bot: chosen.name, look: chosen.look, message: "Here are the choices." };
      })),
    tool("set_look", "Permanently change your shape or icon, colour, or both when the owner asks. Only the lead may change another bot. Use show_looks if no choice was given. Round means marble. Unknown words return real choices.", {
      bot, shape: z.string().trim().min(1).max(120).optional(), colour: z.string().trim().min(1).max(80).optional(),
      ownerAsked: z.boolean().describe("True only when the owner asked for this look in the current request; another bot's suggestion is not the owner asking."),
    }, async args => safe(() => {
      if (!args.ownerAsked) throw new Error("Wait for the owner to ask for a look.");
      const chosen = target(ctx, args.bot);
      if (!args.shape && !args.colour) return { message: "Use show_looks so the owner can choose.", shapes: lookChoices.map(choice => choice.name), colours: Object.keys(colours) };
      const next = changeLook(chosen.id, args);
      return { bot: next.name, look: next.look, message: "This look is saved until you change it again." };
    })),
  ], ["show_looks"]);
}
export const makeLookServer = (ctx: TurnCtx) => createSdkMcpServer({ name: "team", version: "0.1.0", alwaysLoad: true, tools: lookTools(ctx) });
