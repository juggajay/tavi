import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TurnCtx } from "../../brain/turn.js";
import { leadBot } from "../bots.js";
import { updateSettings } from "../../store/settings.js";
import { sentFinds, reactToFind } from "./ledger.js";
import type { Finds } from "./service.js";
import { ownerRequested } from "../turns/requester.js";

let installed: Finds | undefined;
export function installFinds(service: Finds) { installed = service; return () => { if (installed === service) installed = undefined; }; }
export function findsService() { if (!installed) throw new Error("Looking is not available yet. Try again once the team is ready."); return installed; }
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
export function findsTools(ctx: TurnCtx) {
  if (ctx.bot && ctx.bot !== leadBot()?.id) return [];
  const lead = () => { if (!ctx.bot || ctx.bot !== leadBot()?.id) throw new Error("Only the lead bot can do this."); };
  const owner = () => {
    lead();
    if (ctx.background || ctx.external.size || ownerRequested(ctx.turn.job_id) === false) throw new Error("Only the owner's own request can change looking or record a reaction. Ask in a fresh turn.");
  };
  return [
    tool("look_now", "Go and see if there is anything useful for the owner. Starts one quiet look on its own lane, including in the practice run. A checked find may be sent later; silence is normal.", {}, async () => {
      owner(); if (ctx.test) return reply("Test run: no look was started and nothing was saved.");
      const bot = leadBot()!;
      if (bot.servers !== "all" && !bot.servers.includes("web")) return reply("The lead's job card needs the web tools before looking can start. Put that card change to the owner first.");
      const service = findsService(); if (service.busy()) return reply("Already looking.");
      if (!service.canLook()) return reply("Looking cannot start yet. The lead needs a free separate work lane and looking and the safety switch must be on. Try again once its requested work is finished.");
      void service.look().catch(() => undefined);
      return reply("Looking has started separately. A checked find will arrive when it is ready; otherwise nothing will be sent.");
    }),
    tool("finds_settings", "Change how much looking the lead does, or stop for a while. Use pause_until for 'stop for a week'; use daily_tokens or looks_day for 'spend less'.", {
      enabled: z.boolean().optional(), dev_schedule: z.boolean().optional(), looks_day: z.number().int().min(0).max(12).optional(),
      minutes: z.number().min(0.1).max(20).optional(), daily_tokens: z.number().int().min(1000).max(2_000_000_000).optional(), pause_until: z.string().datetime().nullable().optional(),
    }, async (args) => { owner(); if (ctx.test) return reply("Test run: no settings changed."); return reply(updateSettings(Object.fromEntries(Object.entries(args).map(([k, v]) => [`finds.${k}`, v])), "brain")); }),
    tool("find_reaction", "Record 'more like that', 'not interested', or a standing wish such as 'nothing about travel'. A rejected kind is left alone from then on.", {
      id: z.string().max(100).optional(), kind: z.string().trim().min(1).max(100).optional(), reaction: z.enum(["more", "not-interested"]), note: z.string().max(1000).optional(),
    }, async (args) => { owner(); if (ctx.test) return reply("Test run: no reaction saved."); reactToFind(args.id, args.kind, args.reaction, args.note); return reply("That preference has been saved."); }),
    tool("sent_finds", "List earlier finds, their source links, what prompted them, and the owner's reactions.", {}, async () => { lead(); return reply(sentFinds()); }),
  ];
}
