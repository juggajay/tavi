import type { ClientMessage } from "../../../src/shared/protocol";
import type { Gateway } from "../shared/gateway";
import type { Animator } from "../shared/pebble/pebble";
import type { Voice } from "../shared/voice";
import type { Item, Approval } from "../../../src/shared/protocol";
import type { TeamPhone } from "../shared/team/phone";

let team: TeamPhone | undefined;
export const teamActive = () => !!team?.selected;
export const teamMore = () => { if (!team?.selected) return false; team.more(); return true; };
export const teamBusy = () => team?.busy ?? false;
export const teamPreviewApproval = (button: HTMLButtonElement) => team?.previewApproval(button) ?? false;
export const teamVoice = (kind: "heard" | "level" | "end", value: string | number) => team?.voice(kind, value);
export function teamSend(gateway: Gateway, message: ClientMessage) {
  if (team?.previewTyped(message)) return;
  gateway.send(message.type === "typed" && !("bot" in message) && team?.selected ? { ...message, bot: team.selected } as ClientMessage : message);
}
export function startTeam(gateway: Gateway, animator: Animator, voice: Voice, open: (item: Item) => void, approvals: Map<string, Approval>, line: (text: string) => void, say: (text: string) => void) {
  void import("./team-start").then(m => m.start({ gateway, animator, voice, open, approvals, line, say }, value => team = value));
}
