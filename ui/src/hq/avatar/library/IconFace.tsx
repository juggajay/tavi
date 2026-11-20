import React, { useId } from "react";
import { iconById } from "./index";
import type { BotIcon } from "./types";
import { faceSvg } from "../../../../../src/shared/faces/render";
import { LeadStar } from "../LeadStar";
export type IconFaceProps = { icon?: BotIcon | string; colour?: string; size?: number; lead?: boolean; ring?: boolean };
export function IconFace({ icon, colour = "orange", size = 36, lead = false, ring = false }: IconFaceProps) {
  const id = useId(), face = typeof icon === "object" && icon !== null ? icon : iconById(icon ?? "");
  const width = Number.isFinite(size) && size > 0 ? size : 36;
  return <span className="bot-icon-face bot-avatar" style={{ display: "inline-flex", position: "relative", flexShrink: 0, width, height: width }}>
    <span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: faceSvg(face.id, colour, id, width, ring, face) }} />
    {lead && <span className="bot-avatar__star" role="img" aria-label="Lead bot" style={{ width: width * .27, height: width * .27 }}><LeadStar size={width * .19} /></span>}
  </span>;
}
