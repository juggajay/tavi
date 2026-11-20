import { botUser, GuardError } from "./runner.js";

export type ScreenPorts = { user: string; display: number; vncPort: number; cdpPort: number; width: number; height: number };
export function screenPorts(user: unknown, value: unknown): ScreenPorts {
  botUser(user);
  if (!value || typeof value !== "object") throw new GuardError(400, "Send the screen's numbers.");
  const v = value as Record<string, unknown>;
  const display = v.display, width = v.width ?? 1440, height = v.height ?? 900;
  if (!Number.isInteger(display) || Number(display) < 1 || Number(display) > 99 ||
    v.vncPort !== 5910 + Number(display) || v.cdpPort !== 9210 + Number(display) ||
    !Number.isInteger(width) || Number(width) < 320 || Number(width) > 3840 ||
    !Number.isInteger(height) || Number(height) < 200 || Number(height) > 2160)
    throw new GuardError(400, "Choose a screen number from 1 to 99 and a screen size from 320 by 200 to 3840 by 2160.");
  return { user, display: Number(display), vncPort: Number(v.vncPort), cdpPort: Number(v.cdpPort), width: Number(width), height: Number(height) };
}
export function fenceInput(bots: ScreenPorts[]): string {
  return [...bots].sort((a, b) => a.user.localeCompare(b.user)).map((b) => `${b.user} ${b.vncPort} ${b.cdpPort}\n`).join("");
}
// RETURN leaves the older rules in charge of access to the PC and the internet.
export function fenceRules(bots: ScreenPorts[]): string[] {
  return [
    "-A LHFENCE -o lo -p tcp -m owner --uid-owner lh-team --dport 2222 -j RETURN",
    ...[...bots].sort((a, b) => a.user.localeCompare(b.user)).flatMap((b) => [
      `-A LHFENCE -o lo -p tcp -m owner --uid-owner lh-team --dport ${b.cdpPort} -j RETURN`,
      `-A LHFENCE -o lo -p tcp -m owner --uid-owner ${b.user} --dport ${b.vncPort} -j RETURN`,
    ]),
    ...["tcp", "udp"].flatMap((p) => ["2222", "5910:6009", "8650:8749", "9210:9309"].map((range) =>
      `-A LHFENCE -o lo -p ${p} -m owner --gid-owner lhbots --suppl-groups --dport ${range} -j REJECT`)),
  ];
}
