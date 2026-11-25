import { z } from "zod";
import "./registerWeb.js";
import { siteTools } from "../../brain/demoTools.js";
import { mailTools } from "../../brain/mailTools.js";
import { memoryTools } from "../../brain/memoryTools.js";
import { drawingTools } from "../../brain/drawingTools.js";
import { actionTools } from "../../brain/actionTools.js";
import { showTools } from "../../brain/showTools.js";
import { fileTools } from "../../brain/fileTools.js";
import { referenceTools } from "../../brain/referenceTools.js";
import { calcTools } from "../../brain/calcTools.js";
import { modelTools } from "../../brain/modelTools.js";
import { shopTools } from "../../brain/shopTools.js";
import { computerTools } from "../../brain/computerTools.js";
import { brainLinkTools } from "../../brainlink/tools.js";
import { newTurnCtx, type TurnCtx } from "../../brain/turn.js";
import { teamTools } from "../team/index.js";
import { webTools } from "./web.js";
import { findsTools } from "../finds/tools.js";
import { lookTools } from "./looks.js";

const factories = {
  site: siteTools,
  mail: mailTools,
  memory: memoryTools,
  drawings: drawingTools,
  actions: actionTools,
  show: showTools,
  files: fileTools,
  reference: referenceTools,
  calc: calcTools,
  model: modelTools,
  shop: shopTools,
  computers: computerTools,
  brainlink: brainLinkTools,
  team: (ctx: TurnCtx) => [...teamTools(ctx), ...findsTools(ctx), ...lookTools(ctx)],
  web: webTools,
};

export const ALL_SERVERS = Object.freeze(Object.keys(factories));
export type ServerName = keyof typeof factories;
export type ToolboxTool = ReturnType<typeof calcTools>[number];
const cache = new WeakMap<TurnCtx, Map<string, ToolboxTool[]>>();

export function toolsFor(ctx: TurnCtx, server: string): ToolboxTool[] {
  if (!Object.hasOwn(factories, server)) return [];
  let servers = cache.get(ctx);
  if (!servers) cache.set(ctx, (servers = new Map()));
  let tools = servers.get(server);
  if (!tools) servers.set(server, (tools = factories[server as ServerName](ctx)));
  return tools;
}

// Listing tools does not need a live request. These handlers are never called.
const listingCtx = newTurnCtx();
listingCtx.test = true;
listingCtx.turn.persist = false;
export const listedTools = (server: string, bot?: string) => {
  if (server !== "team" || !bot) return toolsFor(listingCtx, server);
  const ctx = newTurnCtx(); ctx.bot = bot; ctx.test = true; ctx.turn.persist = false;
  return [...teamTools(ctx), ...findsTools(ctx), ...lookTools(ctx)];
};
export const toolNames = (server: string): string[] => listedTools(server).map((t) => t.name);

/** Some tools give a list of fields; others already wrap their fields in an object. */
export function argumentSchema(shape: z.ZodRawShape | z.ZodObject): z.ZodObject {
  return shape instanceof z.ZodObject ? shape : z.object(shape);
}

export function describeTool(tool: ToolboxTool) {
  const { $schema: _schema, ...inputSchema } = z.toJSONSchema(argumentSchema(tool.inputSchema));
  return { name: tool.name, description: tool.description, inputSchema };
}
