// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { fixtureMode, fixtureRoutines } from "../dev/fixtures";
import type { TeamBot } from "../types";
type FixtureRequest = (path: string, method: string, body?: unknown) => Promise<unknown>;
let preview: FixtureRequest | null = null;
export const setFixtureRequest = (request: FixtureRequest) => { preview = request; };
export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (fixtureMode && preview) return await preview(path, method, body) as T;
  const data = body as Record<string, any> | undefined;
  const botSettings = /^\/bots\/([a-z0-9-]+)$/.exec(path);
  if (method === "PATCH" && botSettings && typeof data?.computer === "boolean") {
    const { computer, ...settings } = data;
    const result = await fetchRequest<T>(path, method, settings);
    await setComputer(botSettings[1], computer); return result;
  }
  if (path === "/bots" && method === "POST" && data && !data.card && typeof data.role === "string") {
    const lines = String(data.soul ?? "").split("\n");
    const field = (label: string, fallback: string) => lines.find(s => s.startsWith(label + ": "))?.slice(label.length + 2) || fallback;
    const card = { version: 1, purpose: data.role, notFor: field("Not for", "Anything outside the job described here."),
      handsBack: field("What it hands back", "A clear answer for the owner to review."), example: null,
      given: "The owner's request and the approved about card.", servers: data.servers ?? ["show"], stopAndAsk: field("Stop and ask", "Before changing or sharing anything."),
      choice: data.primary, fallbacks: data.fallbacks ?? [], computer: false, privateInfo: "about-card",
      trials: [{ ask: "In one sentence, explain your job and when you must ask the owner. Do not use tools.", goodAnswer: data.role }] };
    const result = await fetchRequest<T & { passed?: boolean }>(path, method, { id: data.id, name: data.name, look: data.look, card });
    if (result.passed === false) throw new Error("Its first check needs attention. Ask the lead to review its job card.");
    if (data.computer) await setComputer(data.id, true);
    return result;
  }
  return fetchRequest<T>(path, method, body);
}
async function setComputer(bot: string, on: boolean) {
  const progress = document.createElement("p"); progress.role = "status"; progress.textContent = on ? "Setting up its screen…" : "Switching its computer off…";
  document.querySelector('[role="dialog"] form')?.append(progress);
  try {
    const path = `/bots/${encodeURIComponent(bot)}/computer`;
    let computer = await fetchRequest<{ state: string; why: string }>(path, "POST", { on });
    const end = Date.now() + 180000;
    while (on && computer.state !== "ready") {
      if (["error", "stopped"].includes(computer.state) || Date.now() > end) throw new Error(computer.why || "Its computer could not start.");
      await new Promise(resolve => setTimeout(resolve, 500));
      computer = await fetchRequest(path, "GET");
    }
  } finally { progress.remove(); }
}
async function fetchRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/hq${path}`, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new RequestError(response.status === 401 || response.status === 403 ? "That was refused. Check your PIN or this device's access." : "Couldn't reach the team. Please try again.", response.status);
  return data as T;
}
export async function oldRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (!response.ok) throw new Error("Couldn't open that just now.");
  return await response.json() as T;
}

export type PanelRoutine = { id: string; title: string; when: string; enabled: boolean; switchable: boolean };
type ScheduledRoutine = { id: string; title: string; when: string; status: string; builtin?: string | null; bot?: string };
export async function readPanelRoutines(bot: TeamBot): Promise<PanelRoutine[]> {
  const [settings, saved] = await Promise.allSettled([
    oldRequest<Record<string, unknown>>("/api/settings"),
    fixtureMode ? Promise.resolve(fixtureRoutines) : request<ScheduledRoutine[]>("/routines"),
  ]);
  const values = settings.status === "fulfilled" ? settings.value : {};
  const routines = saved.status === "fulfilled" && Array.isArray(saved.value) ? saved.value : [];
  if (settings.status === "rejected" && saved.status === "rejected") throw new Error("Couldn't read scheduled things.");
  const weekdays = Array.isArray(values.workdays) ? values.workdays as number[] : [1, 2, 3, 4, 5];
  const days = weekdays.length === 7 ? "Every day" : weekdays.join() === "1,2,3,4,5" ? "Weekdays" : weekdays.length ? weekdays.map(day => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ") : "Every day";
  const daily = bot.lead ? ([ ["brief_time", "Morning brief", "morning_brief"], ["lunch_time", "Midday check", "midday"], ["wrap_time", "Wrap-up", "wrap_up"] ]).flatMap(([key, title, builtin]) => {
    const existing = routines.find(r => r.builtin === builtin);
    if (existing || typeof values[key] !== "string") return [];
    return [{ id: key, title, when: `${days} at ${values[key]}`, enabled: true, switchable: false }];
  }) : [];
  return [...daily, ...routines.filter(r => r.bot === bot.id || (!r.bot && bot.lead)).map(r => ({ id: r.id, title: r.title, when: r.when, enabled: r.status === "active", switchable: true }))].sort((a, b) => {
    const rank = (r: PanelRoutine) => /morning/i.test(r.title) ? 0 : /midday/i.test(r.title) ? 1 : /wrap/i.test(r.title) ? 2 : 3;
    return rank(a) - rank(b);
  });
}
