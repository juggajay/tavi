// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useId } from "react";
import { shapes, colours } from "./shapes";
import type { TeamBot } from "../types";
import { Icon } from "../components/Icon";
import { ICONS } from "./library";
import { IconFace } from "./library/IconFace";

export type BotFaceProps = { shape?: string; colour?: string; size?: number; lead?: boolean; ring?: boolean };
export function BotFace(props: BotFaceProps) {
  return ICONS.some(icon => icon.id === props.shape) ? <IconFace {...props} icon={props.shape} /> : <ShapeFace {...props} />;
}
// Keep the existing callers using the same face choice.
export const BotAvatar = BotFace;

function ShapeFace({ shape = "pebble", colour = "orange", size = 36, lead = false, ring = false }: BotFaceProps) {
  const id = useId();
  const [base, tint] = Object.hasOwn(colours, colour) ? colours[colour as keyof typeof colours] : colours.orange;
  const eyeY = 50;
  return <span className="bot-avatar" style={{ width: size, height: size }}>
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs><radialGradient id={id} cx="30%" cy="22%" r="85%"><stop stopColor={tint} /><stop offset="1" stopColor={base} /></radialGradient></defs>
      <path data-shape={Object.hasOwn(shapes, shape) ? shape : "pebble"} d={Object.hasOwn(shapes, shape) ? shapes[shape as keyof typeof shapes] : shapes.pebble} fill={`url(#${id})`} stroke={ring ? "var(--ink)" : "none"} strokeWidth="3" />
      <ellipse cx="40" cy={eyeY} rx="3.4" ry="6.2" fill="#1A120C" /><ellipse cx="58" cy={eyeY} rx="3.4" ry="6.2" fill="#1A120C" />
      <circle cx="41" cy={eyeY - 3} r="1" fill="white" /><circle cx="59" cy={eyeY - 3} r="1" fill="white" />
    </svg>
    {lead && <span className="bot-avatar__star" style={{ width: size * .27, height: size * .27 }}><Icon name="star" size={size * .19} /></span>}
  </span>;
}
export const BotAvatarFor = ({ bot, size = 36 }: { bot: TeamBot; size?: number }) => <BotAvatar {...bot.look} size={size} lead={bot.lead} />;
