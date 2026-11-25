import type { Bot, Row, EngineChoice } from "../../../../src/hq/contract";
import type { JobCard } from "../../../../src/hq/cards";
import type { Item } from "../../../../src/shared/protocol";
import { esc } from "../items/describe";
import { face } from "./character";
import changes from "../../../../docs/v3/CHANGELOG.md?raw";

type TeamBot = Omit<Bot, "box">;
type Subscription = { provider: string; signedIn: boolean; limitedUntil?: string; usedBy: string[]; models?: { id: string; name?: string }[] };
type Hooks = {
  bots: () => TeamBot[]; rows: Map<string, Row[]>; engines: Map<string, { status?: string; why?: string }>; selected: () => string; fixture: () => typeof import("./fixtures") | undefined;
  body: HTMLElement; show: (title: string, mode: string) => void; close: () => void; error: (words: string) => void;
  request: (url: string, data?: unknown, method?: string) => Promise<any>;
  choose: (id: string) => void; conversation: () => void; fresh: (id: string) => Promise<void>;
  screen: (bot: TeamBot) => Promise<void>; roomPanel: () => void; safetyPanel: () => void; settings: () => void;
  openCard: (ref: string, kind: string) => Promise<void>; tell: (words: string) => void;
  open: (item: Item) => void;
  looks: (id: string) => void;
};
const company = (provider: string) => ({ anthropic: "Claude", "openai-codex": "OpenAI", "openai-api": "OpenAI · pay as you go", openrouter: "Other models" })[provider] ?? provider;
const path = (id: string) => `/api/hq/bots/${encodeURIComponent(id)}`;
const field = (name: string, label: string, value = "", required = true) => `<label>${label}<textarea name="${name}" ${required ? "required" : ""}>${esc(value)}</textarea></label>`;
const button = (key: string, text: string) => `<button class="team-card" data-go="${key}">${text}</button>`;

export function createLayers(h: Hooks) {
  const { body, request, show, error } = h;
  let ticket = 0;
  const askLabel = () => `Ask ${h.bots().find(b => b.lead)?.name ?? "the main bot"} to change this`;
  const bind = (actions: Record<string, () => void>) => body.querySelectorAll<HTMLButtonElement>("[data-go]").forEach(b => {
    const action = actions[b.dataset.go!]; b.onclick = action;
    let start: { x: number; y: number } | undefined;
    b.ontouchstart = e => { const p = e.touches[0]; start = { x: p.clientX, y: p.clientY }; };
    b.ontouchend = e => { const p = e.changedTouches[0]; if (start && Math.hypot(p.clientX - start.x, p.clientY - start.y) < 12) { e.preventDefault(); action?.(); } start = undefined; };
    b.ontouchcancel = () => { start = undefined; };
  });
  function more() {
    show("More", "more");
    body.innerHTML = [["team", "The team"], ["room", "Ask the team"], ["watch", "Watch a computer"], ["things", "Things and pins"], ["subscriptions", "Subscriptions"], ["safety", "Safety"], ["new", "What's new"], ["settings", "Settings"]].map(([key, title]) => button(key, title)).join("");
    bind({ team, room: h.roomPanel, watch, things: () => void things(), subscriptions: () => void subscriptions(), safety: h.safetyPanel, new: whatsNew, settings: h.settings });
  }
  function team() {
    if (h.bots().length === 1) { void botCard(h.bots()[0].id); return; }
    show("The team", "team-list");
    body.innerHTML = h.bots().map(b => button(b.id, `<span class="team-small-face">${face(b.look)}</span><b>${esc(b.name)}</b><small>${esc(b.role)}</small>`)).join("") + button("talk-add", "Add a bot by talking") + button("form-add", "Fill in a job card");
    const actions: Record<string, () => void> = { "talk-add": () => h.tell("Set up a new bot for…"), "form-add": () => void editCard() };
    for (const b of h.bots()) actions[b.id] = () => void botCard(b.id);
    bind(actions);
  }
  async function subscriptions() {
    show("Subscriptions", "subscriptions"); body.innerHTML = "<p>Checking subscriptions…</p>";
    try {
      const info = await options();
      if (!current("subscriptions")) return;
      body.innerHTML = `<p class="team-muted">Sign in to subscriptions on the PC.</p>` + info.map(s => `<article class="team-message"><h3>${esc(company(s.provider))}</h3><p>${s.signedIn ? "Signed in" : "Not signed in"}</p><p class="team-muted">Used by ${esc(h.bots().filter(b => b.primary.provider === s.provider || b.fallbacks.some(f => f.provider === s.provider)).map(b => b.name).join(", ") || "no bots yet")}</p>${s.limitedUntil ? `<p class="team-warning">Limit reached · Available again ${esc(new Date(s.limitedUntil).toLocaleString())}</p>` : `<p class="team-muted">No reset time reported.</p>`}${h.bots().filter(b => b.primary.provider === s.provider).flatMap(b => (h.rows.get(b.id) ?? []).filter(r => r.body.kind === "notice" && r.body.action === "sign_in").slice(-1).map(r => `<p class="team-muted">${esc(b.name)}: ${r.body.kind === "notice" ? esc(r.body.text) : ""}</p>`)).join("")}</article>`).join("");
    } catch (e) { if (current("subscriptions")) error((e as Error).message); }
  }
  function current(mode: string) { return !body.closest<HTMLElement>(".team-panel")?.hidden && body.closest<HTMLElement>(".team-panel")?.dataset.layer === mode; }
  // A sheet can close while its reply is on the way.
  function mark(mode: string) { body.closest<HTMLElement>(".team-panel")!.dataset.layer = mode; }
  async function options(): Promise<Subscription[]> {
    if (h.fixture()) return [
      { provider: "anthropic", signedIn: true, usedBy: ["pebble", "scout"], models: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-1" }] },
      { provider: "openai-codex", signedIn: true, usedBy: ["luna"], limitedUntil: new Date(Date.now() + 3600000).toISOString(), models: [{ id: "gpt-5" }] },
    ];
    const result = await request("/api/hq/subscriptions");
    if (!Array.isArray(result)) throw new Error("The subscription list isn't available. Try again in a moment.");
    return result;
  }
  async function botCard(id: string) {
    const b = h.bots().find(b => b.id === id); if (!b) return;
    show(b.name, "card"); mark("card"); const order = ++ticket;
    body.innerHTML = `<div class="team-card-face">${face(b.look)}</div><p>${esc(b.role)}</p><p class="team-muted">Subscription: ${esc(company(b.primary.provider))} · ${esc(b.primary.model)} · ${esc(b.primary.effort ?? "default")}</p>${button("talk", `Talk to ${esc(b.name)}`)}<div class="team-edit-host"></div>${button("job-card", "Read or change job card")}${button("look", "Change its look")}${button("engine", "Change engine")}${button("computer", b.computer ? "Switch off its computer" : "Give it its own computer")}${b.computer ? `<button class="team-still" aria-label="Watch ${esc(b.name)}'s computer"><img src="${esc(h.fixture()?.still ?? `${path(id)}/screen.png`)}" alt="${esc(b.name)}'s computer screen"><span>Watch computer · Live view</span></button>` : '<p class="team-muted">No computer. This bot helps in conversation.</p>'}${button("fresh", "New conversation")}${h.bots().length > 1 ? button("remove", "Remove bot") : button("talk-add", "Add a bot by talking") + button("form-add", "Fill in a job card")}`;
    bind({ talk: () => { h.choose(id); h.close(); }, "job-card": () => void editCard(b), look: () => h.looks(id), engine: () => void engine(b), computer: () => computer(b), fresh: () => void h.fresh(id), remove: () => remove(b), "talk-add": () => h.tell("Set up a new bot for…"), "form-add": () => void editCard() });
    body.querySelector<HTMLButtonElement>(".team-still")?.addEventListener("click", () => void h.screen(b));
    // Read the card now so its purpose is available even before editing.
    try {
      const value = h.fixture() ? null : await request(`${path(id)}/card`);
      const engine = h.engines.get(id) ?? (!h.fixture() ? await request(`${path(id)}/engine`) : null);
      if (order === ticket && current("card")) body.querySelector(".team-edit-host")!.innerHTML = `${value?.card ? `<p class="team-muted">Hands back: ${esc(value.card.handsBack)}</p>` : ""}${engine?.why ? `<p class="team-warning">${esc(engine.why)}</p>` : ""}`;
    } catch { /* The editable card explains a missing older card. */ }
  }
  async function engine(b: TeamBot) {
    show(`${b.name} · Engine`, "engine"); mark("engine"); const order = ++ticket; body.innerHTML = "<p>Reading model choices…</p>";
    try {
      const [subscriptions, info] = await Promise.all([options(), h.fixture() ? null : request(`${path(b.id)}/engine`)]); if (order !== ticket || !current("engine")) return;
      for (const s of subscriptions) if (!s.models?.length) s.models = info?.models?.[s.provider] ?? [];
      body.innerHTML = `<p class="team-muted">On the PC. Choose the change here, then ask your main bot to prepare it for your approval.</p><form class="team-form"><div data-choices></div><button type="button" data-add class="team-card">Add fallback</button><button class="team-primary">${esc(askLabel())}</button></form>`;
      const choices = body.querySelector<HTMLElement>("[data-choices]")!, values: (() => EngineChoice)[] = [];
      function append(choice: EngineChoice, index: number) {
        const box = document.createElement("fieldset"); choices.append(box); box.innerHTML = `<legend>${index ? `Fallback ${index}` : "First choice"}</legend><label>Subscription<select name="provider">${[...new Set(["anthropic", "openai-codex", choice.provider])].map(p => `<option value="${esc(p)}" ${p === choice.provider ? "selected" : ""}>${esc(company(p))}</option>`).join("")}</select></label><label>Model<select name="offered"></select></label><label data-other>Other model<input name="model" value="${esc(choice.model)}" required></label><label>Effort<select name="effort">${["", "minimal", "low", "medium", "high", "xhigh"].map(e => `<option ${e === (choice.effort ?? "") ? "selected" : ""} value="${e}">${e || "Default"}</option>`).join("")}</select></label>${index ? '<label><input type="checkbox" name="remove"> Remove this fallback</label>' : ""}`;
        const provider = box.querySelector<HTMLSelectElement>("[name=provider]")!, offered = box.querySelector<HTMLSelectElement>("[name=offered]")!, input = box.querySelector<HTMLInputElement>("[name=model]")!;
        function models() { const models = subscriptions.find(s => s.provider === provider.value)?.models ?? []; offered.innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("") + '<option value="__other">Other…</option>'; offered.value = models.some(m => m.id === input.value) ? input.value : "__other"; other(); }
        function other() { box.querySelector<HTMLElement>("[data-other]")!.hidden = offered.value !== "__other"; if (offered.value !== "__other") input.value = offered.value; }
        provider.onchange = models; offered.onchange = other; models();
        values.push(() => ({ provider: provider.value as EngineChoice["provider"], model: input.value.trim(), ...(box.querySelector<HTMLSelectElement>("[name=effort]")!.value ? { effort: box.querySelector<HTMLSelectElement>("[name=effort]")!.value as EngineChoice["effort"] } : {}) }));
      }
      [b.primary, ...b.fallbacks].forEach(append);
      body.querySelector<HTMLButtonElement>("[data-add]")!.onclick = () => append({ provider: "openai-codex", model: subscriptions.find(s => s.provider === "openai-codex")?.models?.[0]?.id ?? "" }, values.length);
      body.querySelector("form")!.onsubmit = e => { e.preventDefault(); const all = values.map(v => v()).filter((_, i) => !choices.children[i].querySelector<HTMLInputElement>("[name=remove]")?.checked); h.tell(`Change ${b.name}'s engine to ${all.map((c, i) => `${i ? "then " : ""}${company(c.provider)} · ${c.model} · ${c.effort ?? "default"}`).join("; ")}. Show me the proposed change for approval.`); };
    } catch (e) { if (current("engine")) error((e as Error).message); }
  }
  async function editCard(b?: TeamBot) {
    show(b ? `${b.name} · Job card` : "Add a bot · Job card", "edit-card"); mark("edit-card"); const order = ++ticket;
    body.innerHTML = "<p>Reading the job card…</p>";
    try {
      const value = b && !h.fixture() ? await request(`${path(b.id)}/card`) : null;
      const groups = h.fixture() ? [{ id: "show", name: "Show things" }, { id: "files", name: "Read files" }] : await request("/api/hq/tool-groups");
      if (order !== ticket || !current("edit-card")) return;
      const card: JobCard | null = value?.card ?? null;
      body.innerHTML = `${b && !card ? '<p class="team-muted">No saved job card yet. These are its current instructions; fill in the rest to prepare a change.</p>' : ""}<p class="team-muted">On the PC. Prepare the card here and ask your main bot to arrange approval and a trial.</p><form class="team-form">${!b ? '<label>Name<input name="name" required maxlength="60"></label>' : ""}${field("purpose", "What it is for", card?.purpose ?? b?.role)}${field("notFor", "What it is not for", card?.notFor ?? "Changing or sharing anything without my OK.")}${field("handsBack", "What it hands back", card?.handsBack)}${field("given", "What it is given", card?.given ?? b?.soul ?? "Only the information in my request.")}${field("stopAndAsk", "When it must stop and ask", card?.stopAndAsk ?? "Before changing or sharing anything.")}${field("example", "An accepted example", card?.example ?? "", false)}<fieldset><legend>What it may use</legend>${groups.map((g: { id: string; name: string }) => `<label class="team-check"><input type="checkbox" name="server" value="${esc(g.id)}" ${card?.servers.includes(g.id) ? "checked" : ""}>${esc(g.name)}</label>`).join("")}</fieldset><label>Private information<select name="privateInfo"><option value="none">None</option><option value="about-card">Approved about card only</option><option value="named">Named facts or files</option></select></label>${field("named", "Named facts or files, one per line", card?.named?.join("\n") ?? "", false)}${field("trial", "A trial question", card?.trials[0]?.ask)}${field("answer", "What a good answer looks like", card?.trials[0]?.goodAnswer)}<label class="team-check"><input name="computer" type="checkbox" ${(b?.computer ?? card?.computer) ? "checked" : ""}>Its own computer</label><p class="team-muted">The proposed card needs your approval and a trial before it goes live.</p><button class="team-primary">${esc(askLabel())}</button></form>`;
      body.querySelector<HTMLSelectElement>("[name=privateInfo]")!.value = card?.privateInfo ?? "none";
      body.querySelector("form")!.onsubmit = e => {
        e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); const text = (key: string) => String(form.get(key) ?? "").trim();
        const next: JobCard = { version: card?.version ?? 1, purpose: text("purpose"), notFor: text("notFor"), handsBack: text("handsBack"), given: text("given"), stopAndAsk: text("stopAndAsk"), example: text("example") || null, servers: form.getAll("server").map(String), privateInfo: text("privateInfo") as JobCard["privateInfo"], ...(text("privateInfo") === "named" ? { named: text("named").split("\n").filter(Boolean) } : {}), trials: [{ ask: text("trial"), goodAnswer: text("answer") }, ...(card?.trials.slice(1) ?? [])], choice: b?.primary ?? card?.choice ?? h.bots().find(b => b.lead)!.primary, fallbacks: b?.fallbacks ?? card?.fallbacks ?? [], computer: form.has("computer") };
        const name = b?.name ?? text("name"); const words = `${b ? "Update the job card for" : "Set up a new bot called"} ${name}.\nPurpose: ${next.purpose}\nNot for: ${next.notFor}\nHands back: ${next.handsBack}\nGiven: ${next.given}\nStop and ask: ${next.stopAndAsk}\nAccepted example: ${next.example ?? "None yet"}\nMay use: ${next.servers.join(", ") || "No tools"}\nPrivate information: ${next.privateInfo === "named" ? next.named?.join(", ") : next.privateInfo === "none" ? "None" : "Approved about card only"}\nComputer: ${next.computer ? "Yes" : "No"}\nTrial: ${text("trial")}\nGood answer: ${text("answer")}\nPlease show me the exact card for approval and run its trials.`;
        h.tell(words);
      };
    } catch (e) { if (current("edit-card")) error((e as Error).message); }
  }
  function computer(b: TeamBot) {
    show(`${b.name} · Computer`, "computer-choice");
    body.innerHTML = `<p>${b.computer ? "Switch off" : "Give"} ${esc(b.name)}${b.computer ? "'s computer? Its files are kept." : " its own computer? It can browse and run programs in its own space."}</p><p class="team-muted">On the PC. Your main bot can prepare the change for your approval.</p>${button("prepare", esc(askLabel()))}`;
    bind({ prepare: () => h.tell(`${b.computer ? "Switch off" : "Give"} ${b.name}${b.computer ? "'s computer" : " its own computer"}. Please put the computer change to me for approval.`) });
  }
  function remove(b: TeamBot) {
    show(`Remove ${b.name}`, "remove");
    body.innerHTML = `<p>Remove ${esc(b.name)} from the team? Its current work will stop.</p><p class="team-muted">On the PC. Your main bot can prepare the request.</p>${button("remove", esc(askLabel()))}`;
    bind({ remove: () => h.tell(`I want to remove ${b.name} from the team. Tell me what I need to do on the PC.`) });
  }
  function watch() {
    show("Watch a computer", "computers");
    body.innerHTML = `<p class="team-muted">Taking control stays on the PC.</p>` + (h.bots().filter(b => b.computer).map(b => button(b.id, esc(b.name))).join("") || '<p>No bot has a computer yet. Open its card in The team to request one.</p>');
    bind(Object.fromEntries(h.bots().map(b => [b.id, () => void h.screen(b)])));
  }
  async function things() {
    show("Things and pins", "things"); mark("things");
    body.innerHTML = `<label>Made by<select aria-label="Made by"><option value="">Every bot</option>${h.bots().map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></label><div data-things></div><h3>Pins</h3><div data-pins></div><section data-library></section>`;
    let catalog: Item[] = [];
    function paint() {
      const selected = body.querySelector<HTMLSelectElement>("select")!.value;
      const rowCards = [...h.rows.values()].flat().filter(r => r.body.kind === "card" && r.body.card === "item");
      const cards = [...rowCards, ...catalog.map((item): Row => ({ bot: rowCards.find(r => r.body.kind === "card" && r.body.ref === item.id)?.bot ?? "", generation: 0, rev: 0, seq: item.seq, ts: item.shown_at, kind: "card", body: { kind: "card", card: "item", ref: item.id, title: item.title } }))].filter(r => !selected || r.bot === selected).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts) || b.seq - a.seq);
      const seen = new Set<string>();
      body.querySelector("[data-things]")!.innerHTML = cards.map(r => { if (r.body.kind !== "card" || seen.has(r.body.ref)) return ""; seen.add(r.body.ref); return `<button class="team-card" data-item="${esc(r.body.ref)}"><small>${esc(h.bots().find(b => b.id === r.bot)?.name ?? "Earlier thing · bot not recorded")}</small>${esc(r.body.title)}</button>`; }).join("") || '<p class="team-muted">Nothing shown yet. Ask a bot to find an earlier thing.</p>';
      body.querySelectorAll<HTMLButtonElement>("[data-item]").forEach(b => b.onclick = () => void h.openCard(b.dataset.item!, "item"));
    }
    paint(); body.querySelector("select")!.onchange = paint;
    // Use the existing pins and their stored pages, including when there is no signal.
    const pins = document.getElementById("pins")!, host = body.querySelector<HTMLElement>("[data-pins]")!;
    host.innerHTML = pins.children.length ? [...pins.querySelectorAll<HTMLButtonElement>("button")].filter(b => !b.classList.contains("pin-x")).map((b, i) => `<button class="team-card" data-pin="${i}">${esc(b.getAttribute("aria-label") ?? b.textContent ?? "Open pin")}</button>`).join("") : '<p class="team-muted">No pins yet. Open a thing and tap Pin to keep it on the phone.</p>';
    host.querySelectorAll<HTMLButtonElement>("[data-pin]").forEach(b => b.onclick = () => { const pin = [...pins.querySelectorAll<HTMLButtonElement>("button")].filter(b => !b.classList.contains("pin-x"))[Number(b.dataset.pin)]; h.close(); pin?.click(); });
    try { await Promise.all([...(h.fixture() ? [] : h.bots().map(async b => { const value = await request(`${path(b.id)}/rows?after=0`); const existing = h.rows.get(b.id) ?? []; for (const row of value.rows as Row[]) if (!existing.some(r => r.generation > row.generation || r.generation === row.generation && r.seq === row.seq && r.rev >= row.rev)) { const old = existing.findIndex(r => r.generation === row.generation && r.seq === row.seq); if (old >= 0) existing[old] = row; else existing.push(row); } h.rows.set(b.id, existing.sort((a,b) => a.seq - b.seq)); })), (async () => { catalog = h.fixture() ? [h.fixture()!.plan] : (await request("/api/items?limit=200")).items; })()]); if (current("things")) paint(); }
    catch { if (current("things")) error("Some earlier things couldn't load. What is already here still opens."); }
    if (current("things")) void library(body.querySelector<HTMLElement>("[data-library]")!);
  }
  async function library(host: HTMLElement) {
    const lead = h.bots().find(b => b.lead)?.name ?? "the main bot";
    host.innerHTML = `<h3>File library</h3><p class="team-muted">On the PC. Ask your main bot to find a file and show it here.</p><form class="team-library-search"><input type="search" aria-label="Find a file" placeholder="What are you looking for?"><button>Ask ${esc(lead)}</button></form>`;
    host.querySelector("form")!.onsubmit = e => { e.preventDefault(); const query = host.querySelector("input")!.value.trim(); h.tell(query ? `Find my files about ${query} and show them here.` : "Show me the files the bots have made, newest first."); };
  }
  function whatsNew() {
    show("What's new", "new");
    body.innerHTML = changes.split("\n").filter(line => line.trim() && !/^# /.test(line)).map(line => line.startsWith("#") ? `<h3>${esc(line.replace(/^#+\s*/, ""))}</h3>` : `<p>${esc(line.replace(/^- /, "")).replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")}</p>`).join("");
  }
  return { more, botCard, team };
}
