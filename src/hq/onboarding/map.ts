import { getSetting, setSetting } from "../../store/proactive.js";
import { userLines } from "../../profile/profile.js";

export const AREAS = {
  identity: "Who you are", days: "Your days", goals: "What matters now", people: "People around you",
  tools: "Tools and services", places: "Places in your life", style: "How you like to talk",
  help: "What you would like help with", boundaries: "Your boundaries", finds: "Useful things to hear about",
  hours: "Hours and time zone",
} as const;
export type Area = keyof typeof AREAS;
export type Coverage = "unknown" | "some" | "enough" | "skipped";
export type KnowledgeMap = { status: "not_started" | "active" | "paused" | "done"; areas: Record<Area, { coverage: Coverage }>; updated: string | null };
export const MAP_KEY = "hq.onboarding.map";
export function emptyMap(): KnowledgeMap {
  return { status: "not_started", areas: Object.fromEntries(Object.keys(AREAS).map(k => [k, { coverage: "unknown" }])) as KnowledgeMap["areas"], updated: null };
}
export function readMap(): KnowledgeMap {
  const map = emptyMap();
  const saved = getSetting(MAP_KEY);
  if (saved) {
    try {
      const value = JSON.parse(saved);
      if (["not_started", "active", "paused", "done"].includes(value.status)) map.status = value.status;
      for (const key of Object.keys(AREAS) as Area[]) if (["unknown", "some", "enough", "skipped"].includes(value.areas?.[key]?.coverage)) map.areas[key] = { coverage: value.areas[key].coverage };
      map.updated = typeof value.updated === "string" ? value.updated : null;
    } catch { /* An unreadable map starts with the gaps. */ }
  } else {
    const sections: Partial<Record<Area, string>> = { identity: "Basics", days: "Work", people: "People", places: "Life", style: "How to talk to them", help: "Follow-ups" };
    try { const lines = userLines(); for (const [area, section] of Object.entries(sections)) if (lines.some(l => l.section === section)) map.areas[area as Area].coverage = "some"; } catch { /* There may be no profile yet. */ }
  }
  return map;
}
export function writeMap(map: KnowledgeMap) { map.updated = new Date().toISOString(); setSetting(MAP_KEY, JSON.stringify(map)); return map; }
export function changeMap(map: KnowledgeMap, change: { status?: KnowledgeMap["status"]; area?: Area; coverage?: Coverage; reopen?: boolean }) {
  const next = structuredClone(map);
  if (change.status) next.status = change.status;
  if (change.area && change.coverage) {
    if (next.areas[change.area].coverage === "skipped" && change.coverage !== "skipped" && !change.reopen) throw new Error("That subject was skipped. Leave it alone unless the person brings it up again.");
    next.areas[change.area] = { coverage: change.coverage };
  }
  return next;
}
export function gaps(map = readMap()): Area[] {
  return (Object.keys(AREAS) as Area[]).filter(k => ["unknown", "some"].includes(map.areas[k].coverage)).sort((a, b) => Number(map.areas[a].coverage === "some") - Number(map.areas[b].coverage === "some"));
}
export function mapWords(map = readMap()) {
  return `First conversation: ${map.status}.\n` + (Object.keys(AREAS) as Area[]).map(k => `${k}: ${AREAS[k]} — ${map.areas[k].coverage}`).join("\n");
}
