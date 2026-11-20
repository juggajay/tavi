import { z } from "zod";
import { CARD_SERVERS, cardSchema } from "../cards/index.js";

// The card module is owned by another stage. Register the extra choice on its shared schema here.
const groups: string[] = CARD_SERVERS as unknown as string[];
if (!groups.includes("web")) groups.push("web");
cardSchema.shape.servers = z.array(z.enum(groups as [string, ...string[]])).max(groups.length) as typeof cardSchema.shape.servers;
