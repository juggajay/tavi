import { fixtureItems } from "./fixtures";
export const legacySettings: Record<string, unknown> = { "ui.theme": "light", "ui.sound": false, "time.zone": "Australia/Sydney", "brief_time": "07:00", "lunch_time": "12:00", "wrap_time": "16:00", "quiet_start": "18:00", "quiet_end": "07:00", "guest.name": "Tim" };
let installed = false;
// The old pages keep their own code. In a preview, their requests see only made-up records.
export function installLegacyFixtures() {
  if (installed) return;
  installed = true;
  const original = window.fetch.bind(window);
  const NativeSocket = window.WebSocket;
  const PreviewSocket = function (url: string | URL, protocols?: string | string[]) {
    if (new URL(String(url), location.href).pathname !== "/ws") return new NativeSocket(url, protocols);
    const socket = { readyState: 0, onclose: null as ((event: CloseEvent) => void) | null, send() {}, close() { socket.readyState = 3; queueMicrotask(() => socket.onclose?.(new CloseEvent("close"))); } };
    return socket;
  };
  Object.assign(PreviewSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = PreviewSocket as unknown as typeof WebSocket;
  const memory = [{ id: "preview-memory", text: "Keep weekends free for trips and friends.", group: "Preferences", source: "owner", editable: true }];
  const labels: Record<string, string> = { sheet: "Drawing sheet", shopdrawing: "Drawing set", model: "3D model", sketch: "Sketch", reference: "Guide page", doc: "File", note: "Guide", list: "List", table: "Table", image: "Picture", legacy: "Earlier notes" };
  const entries = fixtureItems.filter(item => item.kind !== "draft").map(item => ({ id: item.id, group: "drawings", name: item.title, kind: labels[item.kind] ?? item.kind, job: "Weekend ideas", at: item.created_at, size: null, viewer: item.kind, file: false }));
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin || !/^\/(api|oauth)(\/|$)/.test(url.pathname)) return original(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: Record<string, any> = {};
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { /* Leave a blank preview request. */ }
    const path = url.pathname;
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/api/settings") { if (method !== "GET") Object.assign(legacySettings, body); return reply(legacySettings); }
    if (path === "/api/v2/memory") {
      if (method === "POST") memory.push({ id: `preview-memory-${memory.length}`, text: String(body.text), group: String(body.group), source: "owner", editable: true });
      const groups: Record<string, typeof memory> = {};
      for (const row of memory) (groups[row.group] ??= []).push(row);
      return reply({ groups });
    }
    if (path.startsWith("/api/v2/memory/")) {
      const index = memory.findIndex(row => row.id === path.split("/")[4]);
      if (index >= 0 && method === "PATCH") memory[index].text = String(body.text);
      if (index >= 0 && method === "DELETE") memory.splice(index, 1);
      return reply({ ok: true });
    }
    if (path === "/api/v2/activity") return reply({ now: [], waiting: [], scheduled: { routines: [], followups: [], controls: "Nothing scheduled in this preview." }, finished: [{ id: "preview-check", kind: "job", title: "Weekend dates checked", detail: "Saturday and Sunday are free.", at: new Date().toISOString(), state: "done", actions: [] }] });
    if (path === "/api/setup/proactive") return reply({ days: [{ day: "2026-11-18", notes: "Weekend plan drafted. Ask Ruvo about Saturday." }] });
    if (path === "/api/setup/profile") return reply({ name: "Pebble", soul: "Help with the job. Ask before changing anything.", user: "Nemi is planning a weekend away.", voiceCard: "Use plain words. Ask before sending anything.", changes: [] });
    if (path === "/api/health") return reply({ voice: "Ready" });
    if (path === "/api/setup/status") return reply({ startedAt: new Date().toISOString(), phoneUrl: null, voice: { ready: true, name: "Cedar", model: "Voice", live: false }, brain: { model: "Claude", subscription: true } });
    if (path === "/api/setup/activity") return reply({ events: [] });
    if (path === "/api/v2/shortcuts") return reply({ shortcuts: [] });
    if (path === "/api/table/sent") return reply({ sent: [] });
    if (path === "/api/v2/browser/sites") return reply({ sites: [] });
    if (path === "/api/v2/everything") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const matching = entries.filter(entry => entry.name.toLowerCase().includes(q));
      return reply({ groups: [{ id: "drawings", label: "Weekend ideas", count: entries.length }], jobs: [{ job: "Weekend ideas", count: entries.length }], total: matching.length, sort: "name", dir: "asc", entries: matching });
    }
    if (path.startsWith("/api/v2/everything/")) {
      const id = decodeURIComponent(path.split("/")[4]), item = fixtureItems.find(item => item.id === id);
      if (item) return reply({ entry: entries.find(entry => entry.id === id), item });
    }
    if (path === "/api/v2/folders") return reply({ folders: [] });
    if (path === "/api/v2/reference") return reply({ dir: "Preview shelf", books: [] });
    if (path === "/api/pins") return reply({ pins: [] });
    if (method !== "GET") return reply({ ok: true });
    return reply({ error: "This part isn't included in the preview." }, 503);
  };
}
