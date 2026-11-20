import type { createTeamPhone, TeamPhone } from "../shared/team/phone";
import { setTeamName } from "../shared/app-name";

export function start(hooks: Omit<Parameters<typeof createTeamPhone>[0], "fixtures">, ready: (team: TeamPhone) => void) {
  const fixtures = new URLSearchParams(location.search).has("team-fixtures");
  let loading: Promise<TeamPhone> | undefined;
  const load = () => loading ??= import("../shared/team/phone").then(m => {
    const team = m.createTeamPhone({ ...hooks, fixtures }); ready(team); return team;
  });
  if (fixtures) { setTeamName(true); void load().then(t => t.preview()); return; }
  const refresh = () => {
    void fetch("/api/hq/state", { signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null).then(s => { setTeamName(s?.on === true); if (s?.on === true) return load().then(t => t.state(s)); }).catch(() => setTeamName(false));
    // The switch has its own route so a broken conversation cannot hide it.
    void fetch("/api/hq/safety", { signal: AbortSignal.timeout(4000) }).then(r => !r.ok && r.status !== 404 ? { guard: "down", safety: { level: "walled" } } : r.json()).then(s => { if (s && (s.level || s.safety)) return load().then(t => t.safety(s)); }).catch(() => {});
  };
  refresh(); hooks.gateway.on("hello", refresh); addEventListener("online", refresh);
}
