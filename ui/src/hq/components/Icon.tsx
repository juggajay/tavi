import { Ellipsis, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Plus, Search, PanelLeft, X, Mic, Square, Shield, Pause, Unplug, Power, Folder, Pin, Brain, Bell, Settings, Users, Monitor, Star, GripVertical, Check, Lightbulb, RotateCcw, Maximize, ZoomIn, ZoomOut, FileText, Pencil, PhoneOff } from "lucide-react";
import type { CSSProperties } from "react";
const icons = { more: Ellipsis, arrow_up: ArrowUp, arrow_down: ArrowDown, chev_right: ChevronRight, chev_down: ChevronDown, plus: Plus, search: Search, sidebar: PanelLeft, close: X, mic: Mic, stop: Square, shield: Shield, pause: Pause, wall: Unplug, kill: Power, folder: Folder, pin: Pin, brain: Brain, bell: Bell, settings: Settings, users: Users, monitor: Monitor, star: Star, grip: GripVertical, check: Check, idea: Lightbulb, fresh: RotateCcw, full: Maximize, zoom_in: ZoomIn, zoom_out: ZoomOut, file: FileText, edit: Pencil, hangup: PhoneOff };
export function Icon({ name, size = 16, opacity, className, style }: { name: keyof typeof icons; size?: number; opacity?: number; className?: string; style?: CSSProperties }) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.6} aria-hidden="true" className={className} style={{ opacity, ...style }} />;
}
