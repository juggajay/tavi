import React, { useId, useEffect } from "react";
import type { TeamBot } from "../types";
import { LeadStar } from "./LeadStar";
import { faceSvg } from "../../../../src/shared/faces/render";
export type BotFaceProps = { shape?: string; colour?: string; size?: number; lead?: boolean; ring?: boolean };
export function BotFace({ shape = "pebble", colour = "orange", size = 36, lead = false, ring = false }: BotFaceProps) {
  useEffect(() => { void import("../../shared/brand/browser"); }, []);
  const id = useId(), width = Number.isFinite(size) && size > 0 ? size : 36;
  return <span className="bot-avatar" style={{ width, height: width }}>
    <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: faceSvg(shape, colour, id, width, ring) }} />
    {lead && <span className="bot-avatar__star" role="img" aria-label="Lead bot" style={{ width: width * .27, height: width * .27 }}><LeadStar size={width * .19} /></span>}
  </span>;
}
export const BotAvatar = BotFace;
export const BotAvatarFor = ({ bot, size = 36 }: { bot: TeamBot; size?: number }) => <BotAvatar {...bot.look} size={size} lead={bot.lead} />;
