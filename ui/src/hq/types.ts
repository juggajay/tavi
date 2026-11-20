import type { Bot } from "../../../src/hq/contract";
export type { Row, EngineChoice, SafetyLevel, Effort, Provider } from "../../../src/hq/contract";
export type Work = NonNullable<import("../../../src/hq/contract").Live["work"]>[number];
export type Live = import("../../../src/hq/contract").Live & { work?: Work[] };
export type Usage = { today?: number | { input: number; output: number }; week?: number | { input: number; output: number } };
export type Model = { id: string; name: string };
export type Subscription = { provider: import("../../../src/hq/contract").Provider; name: string; signedIn: boolean; limitedUntil?: string | null; usedBy: string[]; usage?: Usage; models?: Model[] };
export type ToolGroup = { id: string; name: string; description: string };
export type SavedJobCard = import("../../../src/hq/cards/index").JobCard;
export type TeamBot = Omit<Bot, "box"> & { card?: SavedJobCard | null };
export type Safety = {
  level: import("../../../src/hq/contract").SafetyLevel;
  until: string | null;
  since?: string;
  changedAt?: string;
  pinSet: boolean;
  ownerUbuntuRunning?: boolean;
};
export type EngineInfo = {
  status: "ready" | "starting" | "stopped" | "not_signed_in" | "error";
  why?: string;
  primary: import("../../../src/hq/contract").EngineChoice;
  fallbacks: import("../../../src/hq/contract").EngineChoice[];
  signedIn?: Record<string, boolean>;
  models?: Partial<Record<import("../../../src/hq/contract").Provider, Model[]>>;
  usage?: { today?: number | { input: number; output: number }; week?: number | { input: number; output: number } };
  limits?: { message?: string; resetsAt?: string | null } | null;
};
export type HqState = { on: boolean; bots: TeamBot[]; live: Live[]; safety: Safety; guard: "up" | "down" };
