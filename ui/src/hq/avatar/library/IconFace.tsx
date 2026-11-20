import React, { useId } from "react";
import { colours } from "../shapes";
import { iconById } from "./index";
import type { BotIcon } from "./types";

export type IconFaceProps = {
  icon?: BotIcon | string;
  colour?: string;
  size?: number;
  lead?: boolean;
  ring?: boolean;
};

export function IconFace({ icon, colour = "orange", size = 36, lead = false, ring = false }: IconFaceProps) {
  const id = useId();
  const face = typeof icon === "object" && icon !== null ? icon : iconById(icon ?? "");
  const [base, tint] = Object.hasOwn(colours, colour) ? colours[colour as keyof typeof colours] : colours.orange;
  const width = Number.isFinite(size) && size > 0 ? size : 36;
  const { x, y, gap, r } = face.eyes;
  return <span className="bot-icon-face" style={{ display: "inline-flex", position: "relative", flexShrink: 0, width, height: width, verticalAlign: "middle" }}>
    <svg width={width} height={width} viewBox="0 0 100 100" aria-hidden="true" focusable="false" data-icon={face.id}>
      <defs>
        <radialGradient id={`${id}-colour`} cx="30%" cy="22%" r="85%"><stop stopColor={tint} /><stop offset="1" stopColor={base} /></radialGradient>
        <mask id={`${id}-holes`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style={{ maskType: "luminance" }}>
          <rect width="100" height="100" fill="white" />
          {face.cut?.map((d, i) => <path key={i} d={d} fill="black" />)}
        </mask>
        <clipPath id={`${id}-body`}><path d={face.body} /></clipPath>
      </defs>
      <g mask={`url(#${id}-holes)`}>
        <path data-body="" d={face.body} fill={`url(#${id}-colour)`} stroke={ring ? "var(--ink, #291f1a)" : "none"} strokeWidth="3" />
        <g clipPath={`url(#${id}-body)`}>
          {face.marks?.map((d, i) => <path data-mark="" key={i} d={d} fill={base} opacity="0.8" />)}
        </g>
      </g>
      {[x - gap / 2, x + gap / 2].map(cx => <circle data-eye="" key={cx} cx={cx} cy={y} r={r} fill="#1A120C" />)}
    </svg>
    {lead && <span role="img" aria-label="Lead bot" style={{ position: "absolute", right: -1, bottom: -1, width: width * .28, height: width * .28, borderRadius: "50%", background: "#F2B95D", display: "grid", placeItems: "center" }}>
      <svg width="75%" height="75%" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10 L8 14 L16 6" fill="none" stroke="#291f1a" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>}
  </span>;
}
