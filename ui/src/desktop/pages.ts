import { appName } from "../shared/app-name";
// The desktop's other pages (DESIGN §6.4–6.8): Activity, Memory, Connections, Files, Settings. Each renders from the
// gateway's own routes and re-renders when told something changed.
import { $, anim, api, esc, gw, IC, saveSettings, state, time, toast, when } from "./core";
import { Animator } from "../shared/pebble/pebble";
import * as Palette from "../shared/palette";
import type { Item } from "../../../src/shared/protocol";
import type { Page } from "./core";
import { renderFiles, type FilesNav } from "./files";
export { openFiles } from "./files";
type Nav = FilesNav;
import { tableSettingsClick, tableSettingsHtml, type Sent } from "./tableSettings";

export async function renderPage(p: Page, nav: Nav) {
  try {
    await RENDER[p](nav);
  } catch (err) {
    $(p).innerHTML = `<div class="dhead"><div><h1>${p[0].toUpperCase() + p.slice(1)}</h1><p class="err">Couldn't load this just now: ${esc(err instanceof Error ? err.message : String(err))}</p></div></div>`;
  }
}

const head = (title: string, sub: string, extra = "") => `<div class="dhead"><div><h1>${title}</h1><p>${sub}</p></div>${extra}</div>`;
const sec = (title: string, n?: number) => `<h2 class="sec">${title}${n !== undefined ? ` <span class="n">${n}</span>` : ""}</h2>`;

/* ---------- Activity (§6.4) ---------- */
type Entry = { id: string; kind: string; title: string; detail: string; at: string | null; state: string; actions: string[]; item_id?: string; schedule?: { kind: string; time?: string } };
type Activity = { now: Entry[]; waiting: Entry[]; scheduled: { routines: Entry[]; followups: Entry[]; controls: string }; finished: (Entry & { trace?: { summary: string } | null })[] };

async function activity(nav: Nav) {
  const a = await api<Activity>("/api/v2/activity", { method: "GET" });
  const tile = (k: string) => (k === "approval" ? IC.mail : k === "held" || k === "offer" ? IC.bell : IC.list);
  const waitRow = (w: Entry) => {
    const acts =
      w.kind === "approval"
        ? `<button class="btn quiet sm" type="button" data-act="later" data-id="${w.id}">Not now</button><button class="btn sm" type="button" data-act="review" data-id="${w.id}" data-item="${w.item_id ?? ""}">Review</button><button class="btn accent sm" type="button" data-act="send" data-id="${w.id}">${IC.send}Send</button>`
        : `<button class="btn quiet sm" type="button" data-act="${w.kind}-no" data-id="${w.id}">No</button><button class="btn accent sm" type="button" data-act="${w.kind}-yes" data-id="${w.id}">Yes</button>`;
    return `<div class="row ic"><span class="tile">${tile(w.kind)}</span><div class="t"><b>${esc(w.title)}</b><span>${esc(w.detail)}</span></div><div class="acts">${acts}</div></div>`;
  };
  const sched = (r: Entry) =>
    `<div class="row" style="grid-template-columns:minmax(0,1fr) 190px auto" data-rid="${r.id}"><div class="t"><b>${esc(r.title)}</b></div><span class="when">${esc(r.detail)}</span><span class="acts">${
      r.schedule?.time ? `<button class="btn quiet sm" type="button" data-act="rtime" data-id="${r.id}" data-time="${esc(r.schedule.time)}">Change</button>` : ""
    }<button class="btn quiet sm" type="button" data-act="rrun" data-id="${r.id}">Run now</button><button class="btn quiet sm" type="button" data-act="rdel" data-id="${r.id}">Delete</button><button class="sw" type="button" role="switch" aria-checked="${r.state === "on"}" aria-label="${esc(r.title)}" data-act="rtoggle" data-id="${r.id}"></button></span></div>`;
  const follow = (f: Entry) =>
    `<div class="row" style="grid-template-columns:minmax(0,1fr) 170px auto" data-fid="${f.id}"><div class="t"><b>${esc(f.title)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ""}</div><span class="when">${esc(when(f.at))}</span><span class="acts"><button class="btn quiet sm" type="button" data-act="fchange" data-id="${f.id}">Change</button><button class="btn quiet sm" type="button" data-act="fdone" data-id="${f.id}">Done</button><button class="btn quiet sm" type="button" data-act="fcancel" data-id="${f.id}">Cancel</button></span></div>`;
  $("activity").innerHTML = `${head("Activity", "What I'm doing, what's waiting on you, and what's coming up.")}
    ${sec("Doing now", a.now.length)}<div class="panel">${a.now.map((n) => `<div class="row ic"><span class="live"></span><div class="t"><b>${esc(n.title)}</b><span>${esc(n.detail)}${n.at ? ` · since ${time(n.at)}` : ""}</span></div><div class="acts">${n.kind === "browser" && n.state === "running" ? '<button class="btn sm" type="button" data-act="watch">Watch</button>' : ""}${n.actions.includes("stop") ? `<button class="btn quiet sm" type="button" data-act="stop" data-id="${esc(n.id)}">Stop</button>` : ""}</div></div>`).join("") || '<div class="empty">Nothing running right now.</div>'}</div>
    ${sec("Waiting on you", a.waiting.length)}<div class="panel">${a.waiting.map(waitRow).join("") || '<div class="row"><div class="t"><span>Nothing waiting. Nice.</span></div></div>'}</div>
    ${sec("Scheduled")}<h3 class="sub">Routines</h3><div class="panel">${a.scheduled.routines.map(sched).join("") || '<div class="empty">No routines yet. Ask for one, like "every morning tell me the weather for my day".</div>'}</div>
    <h3 class="sub">Follow-ups</h3><div class="panel">${a.scheduled.followups.map(follow).join("") || '<div class="empty">Nothing I\'m chasing for you.</div>'}</div>
    ${a.scheduled.controls ? `<p class="foot">${esc(a.scheduled.controls)}</p>` : ""}
    ${sec("Finished")}<div class="panel">${a.finished.map((f) => `<div class="row" style="grid-template-columns:minmax(0,1fr) auto"><div class="t"><b style="font-weight:400">${esc(f.title)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ""}</div><span class="when">${esc(when(f.at))}</span></div>`).join("") || '<div class="empty">Nothing yet.</div>'}</div>`;
  const root = $("activity");
  root.onclick = async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-act]");
    if (!b) return;
    const id = b.dataset.id!;
    const act = b.dataset.act!;
    try {
      if (act === "watch") return nav.openBrowser();
      if (act === "stop") {
        (b as HTMLButtonElement).disabled = true;
        await api(`/api/v2/jobs/${id}/cancel`, { json: {} });
        toast("Stopped.");
      } else if (act === "review") {
        const it = b.dataset.item ? await api<{ item: Item }>(`/api/items/${b.dataset.item}`, { method: "GET" }) : null;
        if (it) nav.openItem(it.item);
        else nav.go("conversation");
      } else if (act === "send" || act === "later") {
        const ap = state.approvals.get(id);
        if (!ap) return toast("That one isn't waiting any more.");
        gw.send({ type: "decide", id: ap.id, nonce: ap.nonce, decision: act === "send" ? "approve" : "reject" });
        if (act === "send") Palette.flash("done", 1000);
      } else if (act === "held-yes" || act === "held-no") await api(`/api/v2/memory/held/${id}`, { json: { accept: act === "held-yes" } });
      else if (act === "offer-yes" || act === "offer-no") await api(`/api/v2/offers/${id}`, { json: { accept: act === "offer-yes" } });
      else if (act === "rtoggle") {
        const on = b.getAttribute("aria-checked") !== "true";
        b.setAttribute("aria-checked", String(on));
        await api(`/api/v2/routines/${id}`, { json: { enabled: on } });
      } else if (act === "rtime") {
        const span = b.closest(".row")!.querySelector(".when")!;
        span.innerHTML = `<span class="inline-edit"><input type="time" value="${esc(b.dataset.time!.padStart(5, "0"))}" aria-label="New time"><button class="btn sm" type="button" data-act="rsave" data-id="${id}">Save</button></span>`;
        (span.querySelector("input") as HTMLInputElement).focus();
      } else if (act === "rsave") {
        const v = (b.parentElement!.querySelector("input") as HTMLInputElement).value;
        await api(`/api/v2/routines/${id}`, { json: { time: v } });
        void activity(nav);
      } else if (act === "rrun") {
        await api("/api/setup/routine", { json: { id, action: "run" } });
        toast("Running it now. You'll hear back when it's done.");
      } else if (act === "rdel") {
        const row = b.closest(".row")!;
        if (row.querySelector(".confirm")) return;
        row.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Delete this routine? It won't run again.</span><button class="btn sm danger" type="button" data-act="rdelYes" data-id="${id}">Delete</button><button class="btn quiet sm" type="button" data-act="no">Keep</button></div>`);
      } else if (act === "rdelYes") {
        await api("/api/setup/routine", { json: { id, action: "delete" } });
        void activity(nav);
      } else if (act === "no") {
        b.closest(".confirm")?.remove();
      } else if (act === "fchange") {
        const span = b.closest(".row")!.querySelector(".when")!;
        span.innerHTML = `<span class="inline-edit"><input type="datetime-local" aria-label="New time"><button class="btn sm" type="button" data-act="fsave" data-id="${id}">Save</button></span>`;
        (span.querySelector("input") as HTMLInputElement).focus();
      } else if (act === "fsave") {
        const v = (b.parentElement!.querySelector("input") as HTMLInputElement).value;
        if (!v) return;
        await api(`/api/v2/commitments/${id}`, { json: { due: new Date(v).toISOString() } });
        void activity(nav);
      } else if (act === "fdone" || act === "fcancel") {
        await api(`/api/v2/commitments/${id}`, { json: act === "fdone" ? { done: true } : { cancel: true } });
        void activity(nav);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
}

/* ---------- Memory (§6.5) ---------- */
type Mem = { id: string; text: string; group: string; source: string; editable: boolean };
/** Removed in the last 30 seconds: still shown struck through, with Undo, across refreshes. */
const undoable = new Map<string, { text: string; group: string; until: number }>();
async function memory() {
  // someone typing in an edit box: don't pull the page out from under them
  const editing = document.activeElement?.closest?.("#memory") && document.activeElement?.matches("input.ed");
  if (editing) return;
  const [{ groups }, pro] = await Promise.all([
    api<{ groups: Record<string, Mem[]> }>("/api/v2/memory", { method: "GET" }),
    api<{ days: { day: string; notes: string }[] }>("/api/setup/proactive", { method: "GET" }).catch(() => ({ days: [] })),
  ]);
  for (const [id, u] of undoable) if (u.until < Date.now()) undoable.delete(id);
  const gone = (id: string, u: { text: string }) => `<div class="row gone" data-mid="${esc(id)}"><div class="txt">${esc(u.text)}</div><div class="acts"><span style="font-size:12.5px;color:var(--ink-3)">Removed</span><button class="btn quiet sm" type="button" data-m="undo">Undo</button></div></div>`;
  const row = (m: Mem) =>
    `<div class="row" data-mid="${esc(m.id)}"><div class="txt">${esc(m.text)}${m.source === "learned" ? ' <span class="pill off" style="margin-left:6px">learned</span>' : ""}</div><div class="acts">${m.editable ? '<button class="btn quiet sm" type="button" data-m="edit">Edit</button><button class="btn quiet sm" type="button" data-m="remove">Remove</button>' : ""}</div></div>`;
  $("memory").innerHTML = `${head("Memory", "What I know about you, in plain words. Change anything that's wrong.")}
    <div class="mem">${Object.entries(groups)
      .map(([g, items]) => `${sec(g === "How I should behave" ? g : esc(g), items.length)}<div class="panel" data-group="${esc(g)}">${items.map(row).join("")}${[...undoable].filter(([, u]) => u.group === g).map(([id, u]) => gone(id, u)).join("")}<button class="addrow" type="button" data-m="add">${IC.plus}${g === "How I should behave" ? "Add a rule" : "Add something"}</button></div>`)
      .join("")}</div>
    ${pro.days.length ? `${sec("Recent days")}<div class="panel">${pro.days.map((d) => `<div class="row" style="grid-template-columns:110px minmax(0,1fr)"><span class="when">${esc(new Date(d.day + "T12:00:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }))}</span><div class="t"><span style="color:var(--ink-2)">${esc(d.notes)}</span></div></div>`).join("")}</div>` : ""}`;
  const root = $("memory");
  const put = async (method: string, path: string, json?: unknown) => {
    try {
      await api(path, json === undefined ? { method } : { method, json });
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  root.onclick = async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-m]");
    if (!b) return;
    const m = b.dataset.m!;
    const r = b.closest<HTMLElement>(".row");
    const id = r?.dataset.mid;
    if (m === "remove" && id) {
      const text = r!.querySelector(".txt")?.firstChild?.textContent ?? "";
      const group = r!.closest<HTMLElement>("[data-group]")!.dataset.group!;
      undoable.set(id, { text, group, until: Date.now() + 30_000 });
      if (!(await put("DELETE", `/api/v2/memory/${encodeURIComponent(id)}`))) return void undoable.delete(id);
      r!.classList.add("gone");
      r!.querySelector(".acts")!.innerHTML = '<span style="font-size:12.5px;color:var(--ink-3)">Removed</span><button class="btn quiet sm" type="button" data-m="undo">Undo</button>';
      setTimeout(() => r!.isConnected && r!.classList.contains("gone") && r!.remove(), 30_000);
    } else if (m === "undo" && id) {
      undoable.delete(id);
      if (await put("POST", `/api/v2/memory/${encodeURIComponent(id)}/restore`, {})) void memory();
    } else if (m === "edit" && r) {
      const txt = r.querySelector(".txt")!;
      const old = txt.firstChild?.textContent ?? "";
      txt.innerHTML = `<input class="ed" value="${esc(old)}" aria-label="Edit">`;
      r.querySelector(".acts")!.innerHTML = '<button class="btn sm" type="button" data-m="save">Save</button><button class="btn quiet sm" type="button" data-m="cancel">Cancel</button>';
      const inp = txt.querySelector("input")!;
      inp.focus();
      inp.select();
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") (r.querySelector('[data-m="save"]') as HTMLElement).click();
        if (ev.key === "Escape") (r.querySelector('[data-m="cancel"]') as HTMLElement).click();
      };
    } else if (m === "save" && r) {
      const v = r.querySelector("input")!.value.trim();
      const group = r.closest<HTMLElement>("[data-group]")!.dataset.group!;
      const ok = !v ? true : id ? await put("PATCH", `/api/v2/memory/${encodeURIComponent(id)}`, { text: v }) : await put("POST", "/api/v2/memory", { group, text: v });
      if (ok) void memory();
    } else if (m === "cancel") void memory();
    else if (m === "add") {
      b.insertAdjacentHTML("beforebegin", '<div class="row"><div class="txt"><input class="ed" aria-label="New"></div><div class="acts"><button class="btn sm" type="button" data-m="save">Save</button><button class="btn quiet sm" type="button" data-m="cancel">Cancel</button></div></div>');
      const inp = b.previousElementSibling!.querySelector("input")!;
      inp.focus();
      inp.onkeydown = (ev) => {
        if (ev.key === "Enter") (b.previousElementSibling!.querySelector('[data-m="save"]') as HTMLElement).click();
        if (ev.key === "Escape") void memory();
      };
    }
  };
}

/* ---------- Connections (§6.6) ---------- */
type Status = {
  phoneUrl: string | null;
  autostart: boolean;
  google: { configured: boolean };
  accounts: { id: string; label: string; address: string; status: string }[];
  claude: { connectors: { server: string; label: string; what: string; status: string; error?: string; permission: { read: boolean; write: boolean } }[]; connectUrl: string };
};
type Site = { origin: string; label: string; logged_in_at?: string | null; last_used_at?: string | null };
async function connections(nav: Nav) {
  const [s, b, pro] = await Promise.all([
    api<Status>("/api/setup/status", { method: "GET" }),
    api<{ sites: Site[] }>("/api/setup/browser", { method: "GET" }),
    api<{ pushDevices: number }>("/api/setup/proactive", { method: "GET" }),
  ]);
  const pill = (st: "ok" | "warn" | "off", text?: string) => (st === "ok" ? `<span class="pill ok"><i></i>${text ?? "Connected"}</span>` : st === "warn" ? `<span class="pill warn"><i></i>${text ?? "Sign in again"}</span>` : `<span class="pill off">${text ?? "Not connected"}</span>`);
  const ico = (label: string) => (/mail/i.test(label) ? IC.mail : /calendar/i.test(label) ? IC.cal : IC.folder);
  const connRows = s.claude.connectors.map((c) => {
    const st = c.status === "connected" ? "ok" : c.status === "needs-auth" || c.status === "failed" ? "warn" : "off";
    const perm = c.status === "connected" ? `<div class="seg" data-perm="${esc(c.server)}"><button type="button" data-p="read" aria-pressed="${c.permission.read && !c.permission.write}">Read only</button><button type="button" data-p="write" aria-pressed="${c.permission.write}">Read and change</button><button type="button" data-p="off" aria-pressed="${!c.permission.read}">Off</button></div>` : `<a class="btn sm" href="${esc(s.claude.connectUrl)}" target="_blank" rel="noopener">Connect</a>`;
    return `<div class="row ic"><span class="tile">${ico(c.label)}</span><div class="t"><b>${esc(c.label)}</b><span>Through your Claude account</span><span style="color:var(--ink-2);margin-top:2px">${esc(c.what)}${c.permission.write ? " Changes only after you OK them." : ""}</span></div><div class="acts">${pill(st)}${perm}</div></div>`;
  });
  const acctRows = s.accounts.map(
    (a) =>
      `<div class="row ic" data-acct="${esc(a.id)}"><span class="tile">${IC.mail}</span><div class="t"><b>${esc(a.label)}</b><span>${esc(a.address)}</span><span style="color:var(--ink-2);margin-top:2px">Reads and drafts. Sends only after you OK it.</span></div><div class="acts">${pill(a.status === "connected" ? "ok" : a.status === "needs_reconnect" ? "warn" : "off")}<button class="btn sm" type="button" data-c="disc">Disconnect</button></div></div>`,
  );
  const siteRows = b.sites.map((x) => {
    const st = x.logged_in_at ? "ok" : "warn";
    return `<div class="row ic" data-site="${esc(x.origin)}"><span class="tile">${IC.globe}</span><div class="t"><b>${esc(x.label)}</b><span>${esc(x.origin.replace(/^https?:\/\//, ""))}${x.last_used_at ? ` · used ${esc(when(x.last_used_at))}` : ""}</span><span style="color:var(--ink-2);margin-top:2px">Never orders, books or pays without you.</span></div><div class="acts">${pill(st, st === "ok" ? "Signed in" : "Sign in")}<button class="btn ${st === "warn" ? "accent " : ""}sm" type="button" data-c="login">Sign in</button><button class="btn quiet sm" type="button" data-c="siteRemove">Remove</button></div></div>`;
  });
  $("connections").innerHTML = `${head("Connections", "What I can reach, and what I'm allowed to do there.", '<button class="btn" type="button" data-c="check">Check again</button>')}
    ${sec("Accounts")}<div class="panel">${[...connRows, ...acctRows].join("")}${s.google.configured ? `<a class="addrow" href="/oauth/google/start">${IC.plus}Connect a Gmail account directly</a>` : ""}
      <details class="more"><summary>${s.google.configured ? "Change the" : "Set up"} direct Gmail sign-in (advanced)</summary><div style="padding:0 16px 14px"><p class="foot" style="margin-top:0">Only needed to connect Gmail without your Claude account. Paste the OAuth client from Google Cloud Console.</p><div class="inline-edit" style="flex-wrap:wrap"><input id="gcId" placeholder="Client ID" style="width:320px;font-family:var(--f-ui)"><input id="gcSecret" type="password" placeholder="Client secret" style="width:220px;font-family:var(--f-ui)" autocomplete="off"><button class="btn sm" type="button" data-c="gclient">Save</button></div></div></details></div>
    ${sec("Websites I sign in to")}<div class="panel">${siteRows.join("") || '<div class="empty">None yet.</div>'}
      <div class="row"><div class="t inline-edit"><input id="newSite" placeholder="Website, like example.com" aria-label="Website" style="width:320px;font-family:var(--f-ui)"><button class="btn sm" type="button" data-c="siteAdd">${IC.plus}Add</button></div><span></span></div></div>
    <p class="foot">When you sign in, the site opens beside the conversation and you type the password yourself, into the page. I never see or keep it.</p>
    ${b.sites.length ? `<div class="panel" style="margin-top:10px"><div class="row"><div class="t"><b>Forget every website sign-in</b><span>Signs me out of all of them. You can sign in again any time.</span></div><button class="btn sm danger" type="button" data-c="forgetAll">Forget all</button></div></div>` : ""}
    ${sec("Phone")}<div class="panel"><div class="row ic"><span class="tile">${IC.phone}</span><div class="t"><b>Your phone</b><span class="mono">${esc(s.phoneUrl ?? "No phone address yet (Tailscale isn't running on this PC)")}</span><span style="color:var(--ink-2);margin-top:2px">${pro.pushDevices ? `Alerts on for ${pro.pushDevices} ${pro.pushDevices === 1 ? "device" : "devices"}.` : "Alerts aren't on yet: press and hold Pebble on the phone, then Turn on alerts."}</span></div><div class="acts">${s.phoneUrl ? `<button class="btn sm" type="button" data-c="copy" data-v="${esc(s.phoneUrl)}">Copy</button>` : ""}<button class="btn sm" type="button" data-c="pushTest">Send a test alert</button></div></div></div>
    ${sec("This computer")}<div class="panel">
      <div class="row ic"><span class="tile">${IC.pc}</span><div class="t"><b>Start with Windows</b><span>${s.autostart ? "On: I start when you sign in to this PC." : `Off: start me from the ${appName()} shortcut.`}</span></div><div class="acts">${s.autostart ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>'}</div></div>
      <div class="row ic"><span class="tile">${IC.pc}</span><div class="t"><b>Restart ${appName()}</b><span>If something seems stuck. Takes about ten seconds.</span></div><div class="acts"><button class="btn sm" type="button" data-c="restart">Restart</button></div></div></div>`;
  const root = $("connections");
  root.onclick = async (e) => {
    const t = e.target as Element;
    const seg = t.closest<HTMLElement>("[data-p]");
    if (seg) {
      const server = seg.closest<HTMLElement>("[data-perm]")!.dataset.perm!;
      const p = seg.dataset.p;
      try {
        await api("/api/setup/connectors/permission", { json: { server, read: p !== "off", write: p === "write" } });
        void connections(nav);
      } catch (err) {
        toast(String((err as Error).message));
      }
      return;
    }
    const b = t.closest<HTMLElement>("[data-c]");
    if (!b) return;
    const row = b.closest<HTMLElement>(".row");
    const c = b.dataset.c!;
    try {
      if (c === "check") {
        b.textContent = "Checking";
        await api("/api/setup/connectors/check", { json: {} });
        void connections(nav);
      } else if (c === "disc" && row) {
        if (row.querySelector(".confirm")) return;
        row.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Disconnect ${esc(row.querySelector("b")!.textContent)}? I won't be able to use it until you connect it again.</span><button class="btn sm danger" type="button" data-c="discYes">Disconnect</button><button class="btn quiet sm" type="button" data-c="no">Keep</button></div>`);
      } else if (c === "discYes" && row) {
        await api("/api/setup/disconnect", { json: { id: row.dataset.acct } });
        void connections(nav);
      } else if (c === "no") b.closest(".confirm")?.remove();
      else if (c === "login" && row) {
        b.textContent = "Opening";
        await api("/api/v2/browser/signin", { json: { site: row.dataset.site } });
        nav.openBrowser();
        toast("Sign in on the right, then press Done. I can't see what you type.");
      } else if (c === "siteRemove" && row) {
        if (row.querySelector(".confirm")) return;
        row.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Remove ${esc(row.querySelector("b")!.textContent)} and forget its sign-in?</span><button class="btn sm danger" type="button" data-c="siteRemoveYes">Remove</button><button class="btn quiet sm" type="button" data-c="no">Keep</button></div>`);
      } else if (c === "siteRemoveYes" && row) {
        await api("/api/setup/browser/remove", { json: { origin: row.dataset.site } });
        void connections(nav);
      } else if (c === "siteAdd") {
        const v = ($("newSite") as HTMLInputElement).value.trim();
        if (!v) return;
        await api("/api/setup/browser/add", { json: { site: v } });
        void connections(nav);
      } else if (c === "forgetAll") {
        if (row?.querySelector(".confirm")) return;
        row?.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Forget every website sign-in?</span><button class="btn sm danger" type="button" data-c="forgetAllYes">Forget all</button><button class="btn quiet sm" type="button" data-c="no">Keep</button></div>`);
      } else if (c === "forgetAllYes") {
        await api("/api/setup/browser/forget-all", { json: {} });
        void connections(nav);
      } else if (c === "gclient") {
        await api("/api/setup/google-client", { json: { clientId: ($("gcId") as HTMLInputElement).value.trim(), clientSecret: ($("gcSecret") as HTMLInputElement).value.trim() } });
        toast("Saved. You can connect Gmail directly now.");
        void connections(nav);
      } else if (c === "copy") {
        await navigator.clipboard.writeText(b.dataset.v!).catch(() => undefined);
        toast("Copied. Open it on your phone in Safari.");
      } else if (c === "pushTest") {
        const r = await api<{ devices: number }>("/api/setup/push-test", { json: {} });
        toast(r.devices ? "Sent. It should arrive in a few seconds." : "No phone has alerts on yet.");
      } else if (c === "restart") {
        if (row?.querySelector(".confirm")) return;
        row?.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Restart now? Anything I'm in the middle of will stop.</span><button class="btn sm danger" type="button" data-c="restartYes">Restart</button><button class="btn quiet sm" type="button" data-c="no">Cancel</button></div>`);
      } else if (c === "restartYes") {
        await api("/api/setup/restart", { json: {} }).catch(() => undefined);
        toast("Restarting. Back in a few seconds.");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
}

/* ---------- Files (§6.7): the folders it reads ---------- */
type FolderSum = { id: string; path: string; label: string; kind: string; enabled: boolean; count: number; read: number; unread: number; pending: number; scanning: boolean; types: Record<string, number>; last_error: string | null };
type FileRow = { id: string; name: string; type: string; size: number | null; mtime: number | null; skipped_reason: string | null; project: string };
const open = new Set<string>();
const TYPE_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word", xlsx: "Excel", text: "Text", eml: "Email", image: "Photo", old: "Old format" };
const BADGE: Record<string, [string, string]> = { pdf: ["pdf", "PDF"], docx: ["doc", "DOCX"], xlsx: ["xls", "XLSX"], image: ["img", "IMG"], text: ["doc", "TXT"], eml: ["doc", "EML"], old: ["pdf", "OLD"] };
const size = (n: number | null) => (n == null ? "" : n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");
const picker = () => (window as unknown as { lhDesktop?: { pickFolder: () => Promise<string | null> } }).lhDesktop;

type ShelfBook = { id: string; name: string; title: string; shelf: string; pages: number; note: boolean; state: "waiting" | "reading" | "ready" | "failed"; error: string | null; kind?: "guide" | "design" | "code"; maker?: string | null };
/** The design references and the code (Stage 20.1): one line each, by title; an old book read by section says so. */
function designHtml(list: ShelfBook[]) {
  if (!list.length) return "";
  const rows = list
    .slice()
    .sort((a, b) => (a.kind === b.kind ? (a.title || a.name).localeCompare(b.title || b.name) : a.kind === "code" ? -1 : 1))
    .map((b) => {
      const unit = /\.(html?|txt)$/i.test(b.name) ? "sections" : "pages";
      const st = b.state === "ready" ? `${b.pages.toLocaleString("en-AU")} ${unit} · Ready` : b.state === "failed" ? b.error ?? "I couldn't read it." : "Reading…";
      return `<div class="row ic book" data-book="${esc(b.id)}"><span class="tile">${IC.doc}</span><div class="t"><b>${esc(b.title || b.name)}</b><span${b.state === "failed" ? ' class="err"' : ""}>${esc(`${b.kind === "code" ? "Building code · " : ""}${st}`)}</span></div></div>`;
    })
    .join("");
  return `${sec("Design references", list.length).replace("<h2 class=\"sec\">", "<h2 class=\"sec\" style=\"margin-top:28px\">")}<div class="panel shelf">${rows}</div>`;
}
/** The makers' guides (14.1): one line per maker, how many are ready, and any it couldn't read. */
function guidesHtml(guides: ShelfBook[]) {
  if (!guides.length) return "";
  const makers = new Map<string, ShelfBook[]>();
  for (const g of guides) makers.set(g.maker || "Maker not known", [...(makers.get(g.maker || "Maker not known") ?? []), g]);
  const rows = [...makers.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([maker, list]) => {
      const ready = list.filter((g) => g.state === "ready").length;
      const failed = list.filter((g) => g.state === "failed");
      const reading = list.length - ready - failed.length;
      const bits = [`${ready} of ${list.length} ready`, reading ? "reading…" : "", failed.length ? `couldn't read ${failed.map((f) => f.name).join(", ")}` : ""].filter(Boolean).join(" · ");
      return `<div class="row ic book" data-maker="${esc(maker)}"><span class="tile">${IC.doc}</span><div class="t"><b>${esc(maker)}</b><span${failed.length ? ' class="err"' : ""}>${esc(bits)}</span></div></div>`;
    })
    .join("");
  return `${sec("Makers' guides", guides.length).replace("<h2 class=\"sec\">", "<h2 class=\"sec\" style=\"margin-top:28px\">")}<div class="panel shelf">${rows}</div>`;
}
/** The reference books block (Stage 8): each book, whether it's ready, and Read again. Nothing on the phone. */
function shelfHtml(shelf: { dir: string; books: ShelfBook[] } | null) {
  if (!shelf) return "";
  const guides = shelf.books.filter((b) => b.kind === "guide");
  const design = shelf.books.filter((b) => (b.kind === "design" || b.kind === "code") && !b.note);
  shelf = { ...shelf, books: shelf.books.filter((b) => b.kind !== "guide" && b.kind !== "design" && b.kind !== "code") };
  const books = shelf.books.filter((b) => !b.note);
  const notes = shelf.books.filter((b) => b.note).length;
  const state = (b: ShelfBook) =>
    b.state === "ready" ? `<span>${b.pages.toLocaleString("en-AU")} pages · Ready</span>` : b.state === "failed" ? `<span class="err">${esc(b.error ?? "I couldn't read it.")}</span>` : `<span>Reading…</span>`;
  const top = `<div class="row ic book"><span class="tile">${IC.folder}</span><div class="t"><b>Reference folder</b><span class="mono" style="font-size:12px">${esc(shelf.dir)}</span><span>I only ever read these. Put another PDF in this folder and it becomes a book I can look things up in.${notes ? ` ${notes} shelf ${notes === 1 ? "note" : "notes"} beside them.` : ""}</span></div><div class="acts"><button class="btn quiet sm" type="button" data-f="shelf">Read again</button></div></div>`;
  const rows = books.map((b) => `<div class="row ic book" data-book="${esc(b.id)}"><span class="tile">${IC.doc}</span><div class="t"><b>${esc(b.name)}</b>${state(b)}</div></div>`).join("");
  return `${sec("Reference books", books.length).replace("<h2 class=\"sec\">", "<h2 class=\"sec\" style=\"margin-top:28px\">")}<div class="panel shelf">${top}${rows || '<div class="empty">No books yet. Put a PDF in the reference folder and press Read again.</div>'}</div>${guidesHtml(guides)}${designHtml(design)}`;
}

/** "Folders and books" in the Files page: the folders it reads and the reference shelf (the file viewer is files.ts). */
async function files() {
  const [{ folders }, shelf] = await Promise.all([
    api<{ folders: FolderSum[] }>("/api/v2/folders", { method: "GET" }),
    api<{ dir: string; books: ShelfBook[] }>("/api/v2/reference", { method: "GET" }).catch(() => null),
  ]);
  const lists = await Promise.all(folders.filter((f) => open.has(f.id)).map(async (f) => [f.id, (await api<{ files: FileRow[] }>(`/api/v2/folders/${f.id}/files?limit=300`, { method: "GET" })).files] as const));
  const filesOf = new Map(lists);
  const status = (f: FolderSum) => {
    if (!f.enabled) return `<span>Not reading this folder at the moment.</span>`;
    if (f.last_error) return `<span class="err">${esc(f.last_error)}</span>`;
    if (f.scanning || f.pending) return `<span>${f.count} files · reading, ${f.read} of ${f.count} done</span><div class="bar"><i style="width:${Math.round((f.read / Math.max(1, f.count)) * 100)}%"></i></div>`;
    if (!f.count) return `<span>Nothing in it yet.</span>`;
    if (f.unread) return `<span>${f.count} files · ${f.read} read, <span style="color:var(--warn)">${f.unread} I couldn't open</span></span>`;
    return `<span>${f.count} files, all read</span>`;
  };
  const row = (r: FileRow) => {
    const [cls, txt] = BADGE[r.type] ?? ["doc", r.type.toUpperCase()];
    return `<div class="frow"><span class="badge b-${cls}">${txt}</span><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><span class="sz">${size(r.size)}</span><span class="dt">${day(r.mtime)}</span><span class="rd${r.skipped_reason ? " no" : ""}" title="${esc(r.skipped_reason ?? "")}">${r.skipped_reason ? esc(r.skipped_reason) : "Read"}</span></div>`;
  };
  $("files").innerHTML = `${head("Folders and books", "Folders I'm allowed to read, and your reference shelf. I never change, move or delete your files.", `<button class="btn" type="button" data-f="add">${IC.plus}Add folder</button>`)}
    <div class="addbox" id="addBox"><label for="newPath">Folder on this PC</label><div class="r"><input id="newPath" placeholder="C:\\Users\\you\\OneDrive\\Projects\\Club weekend"><button class="btn accent" type="button" data-f="allow">Allow reading</button><button class="btn quiet" type="button" data-f="cancel">Cancel</button></div><p id="addMsg">I'll read everything in it, including subfolders, and keep it up to date.</p></div>
    <div class="panel">${
      folders
        .map(
          (f) => `<div class="row ic folder" data-folder="${esc(f.id)}" tabindex="0" role="button" aria-expanded="${open.has(f.id)}"><span class="tile">${IC.folder}</span><div class="t"><b>${esc(f.label)}</b><span class="mono" style="font-size:12px">${esc(f.path)}</span>${status(f)}<div class="ftypes">${Object.entries(f.types)
            .map(([t, n]) => `<span class="ft">${TYPE_LABEL[t] ?? t} <b>${n}</b></span>`)
            .join("")}</div></div><div class="acts"><button class="btn quiet sm" type="button" data-f="rescan">Read again</button>${f.kind === "linked" ? '<button class="btn quiet sm" type="button" data-f="remove">Remove</button>' : ""}<button class="sw" type="button" role="switch" aria-checked="${f.enabled}" aria-label="Read ${esc(f.label)}" data-f="toggle"></button>${IC.chev.replace("<svg", '<svg class="chev"')}</div></div>
      <div class="flist${open.has(f.id) ? " on" : ""}">${(filesOf.get(f.id) ?? []).map(row).join("") || '<div class="frow" style="color:var(--ink-3)"><span></span><span>Nothing here yet.</span></div>'}${(filesOf.get(f.id)?.length ?? 0) >= 300 ? `<div class="frow" style="color:var(--ink-3)"><span></span><span>and more</span></div>` : ""}</div>`,
        )
        .join("") || '<div class="empty">No folders yet. Add one to let me read your job files.</div>'
    }</div>${shelfHtml(shelf)}`;
  const root = $("files");
  const tryAdd = async (p: string) => {
    try {
      await api("/api/v2/folders", { json: { path: p } });
      toast("Added. I'm reading it now.");
      void files();
    } catch (err) {
      const m = $("addMsg");
      if (m) {
        m.textContent = err instanceof Error ? err.message : String(err);
        m.className = "err";
      } else toast(String((err as Error).message));
    }
  };
  root.onclick = async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-f]");
    const folderRow = (e.target as Element).closest<HTMLElement>("[data-folder]");
    try {
      if (b?.dataset.f === "add") {
        const pick = picker();
        if (pick) {
          const p = await pick.pickFolder();
          if (p) await tryAdd(p);
        } else {
          $("addBox").classList.add("on");
          $("newPath").focus();
        }
      } else if (b?.dataset.f === "cancel") $("addBox").classList.remove("on");
      else if (b?.dataset.f === "allow") await tryAdd(($("newPath") as HTMLInputElement).value);
      else if (b?.dataset.f === "shelf") {
        await api("/api/v2/reference/rescan", { json: {} });
        toast("Checking the reference folder.");
      }
      else if (b && folderRow) {
        e.stopPropagation();
        const id = folderRow.dataset.folder!;
        if (b.dataset.f === "rescan") {
          await api(`/api/v2/folders/${id}/rescan`, { json: {} });
          toast("Reading it again.");
        } else if (b.dataset.f === "toggle") {
          await api(`/api/v2/folders/${id}`, { method: "PATCH", json: { enabled: b.getAttribute("aria-checked") !== "true" } });
          void files();
        } else if (b.dataset.f === "remove") {
          if (folderRow.querySelector(".confirm")) return;
          folderRow.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Stop reading this folder? Your files aren't touched.</span><button class="btn sm danger" type="button" data-f="removeYes">Remove</button><button class="btn quiet sm" type="button" data-f="keep">Keep</button></div>`);
        } else if (b.dataset.f === "removeYes") {
          await api(`/api/v2/folders/${id}`, { method: "DELETE" });
          open.delete(id);
          void files();
        } else if (b.dataset.f === "keep") b.closest(".confirm")?.remove();
      } else if (folderRow) {
        const id = folderRow.dataset.folder!;
        if (open.has(id)) open.delete(id);
        else open.add(id);
        void files();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
  root.onkeydown = (e) => {
    const r = (e.target as Element).closest<HTMLElement>("[data-folder]");
    if (r && (e.key === "Enter" || e.key === " ") && e.target === r) {
      e.preventDefault();
      r.click();
    }
    if ((e.target as HTMLElement).id === "newPath" && e.key === "Enter") void tryAdd((e.target as HTMLInputElement).value);
  };
}

/* ---------- Settings (§6.8) ---------- */
type Profile = { soul: string; user: string; voiceCard: string; name: string | null; changes: { at?: string; created_at?: string; target: string; source: string; op?: string }[] };
type SetupStatus = { startedAt: string; phoneUrl?: string | null; voice: { ready: boolean; name: string; model: string; live: boolean }; brain: { model: string; subscription: boolean } };
let preview: Animator | null = null;

/* ---------- Siri on the iPhone (Stage 14.3): the Shortcut's address, its keys, and making one (shown once) ---------- */
type ShortcutKey = { name: string; made_at: string; last_used: string | null };
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
function siriHtml(url: string | null, keys: ShortcutKey[]) {
  const rows = keys
    .map(
      (k) =>
        `<div class="row" data-sc="${esc(k.name)}"><div class="t"><b>${esc(k.name)}</b><span>Key made ${esc(shortDay(k.made_at))}${k.last_used ? ` · last used ${esc(when(k.last_used))}` : " · not used yet"}</span></div><div class="acts"><button class="btn quiet sm" type="button" data-s="scRemove" data-n="${esc(k.name)}">Take away</button></div></div>`,
    )
    .join("");
  return `${sec("Siri on your iPhone")}<div class="panel">
      <div class="row"><div class="t"><b>Address for the Shortcut</b><span class="mono">${esc(url ?? "No phone address yet (Tailscale isn't running on this PC)")}</span><span>Every step is in the Siri guide, or ask: "how do I set up Siri?"</span></div><div class="acts">${url ? `<button class="btn sm" type="button" data-s="copy" data-v="${esc(url)}">Copy</button>` : ""}</div></div>
      ${rows}
      <div class="row"><div class="t"><b>Make a key</b><span>One for each phone. It's shown once, so have the Shortcut open.</span></div><div class="inline-edit"><input id="scName" value="${keys.length ? "" : "iphone"}" placeholder="iphone" style="font-family:var(--f-ui);width:120px" aria-label="Name for the phone"><button class="btn sm" type="button" data-s="scMake">Make a key</button></div></div>
      <div id="scKey"></div></div>`;
}
/** Settings buttons for Siri; true when it was one of them. */
async function siriClick(b: HTMLElement): Promise<boolean> {
  const k = b.dataset.s;
  if (k === "copy") {
    await navigator.clipboard?.writeText(b.dataset.v ?? "").catch(() => undefined);
    toast("Copied.");
    return true;
  }
  if (k === "scMake") {
    try {
      const r = await api<{ name: string; key: string }>("/api/v2/shortcuts", { json: { name: ($("scName") as HTMLInputElement).value.trim() || "iphone" } });
      $("scKey").innerHTML = `<div class="row sc-key"><div class="t"><b>Key for "${esc(r.name)}"</b><span class="mono" style="font-size:20px;letter-spacing:1px;color:var(--ink)">${esc(r.key)}</span><span>Shown once. Type it into the Shortcut's Key box now. Lost it? Make another: the old one stops working.</span></div><div class="acts"><button class="btn sm" type="button" data-s="copy" data-v="${esc(r.key)}">Copy</button></div></div>`;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    return true;
  }
  if (k === "scRemove") {
    const row = b.closest(".row");
    if (row && !row.querySelector(".confirm"))
      row.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Take this key away? That Shortcut stops working.</span><button class="btn sm danger" type="button" data-s="scRemoveYes" data-n="${esc(b.dataset.n ?? "")}">Take away</button><button class="btn quiet sm" type="button" data-s="scKeep">Keep</button></div>`);
    return true;
  }
  if (k === "scKeep") return (b.closest(".confirm")?.remove(), true);
  if (k === "scRemoveYes") {
    await api(`/api/v2/shortcuts/${encodeURIComponent(b.dataset.n ?? "")}`, { method: "DELETE" }).catch(() => undefined);
    toast("Key taken away.");
    void settings();
    return true;
  }
  return false;
}

/* ---------- the sites its browser is signed in to (Stage 15.2): sign out of one, or clear everything ---------- */
async function signedIn() {
  const el = $("bSites");
  if (!el) return;
  const r = await api<{ sites: { domain: string; cookies: number; saved: boolean }[] }>("/api/v2/browser/sites", { method: "GET" }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  if (!el.isConnected) return;
  if ("error" in r) return void (el.innerHTML = `<div class="empty">${esc(r.error)}</div>`);
  el.innerHTML =
    (r.sites
      .map(
        (s) =>
          `<div class="row ic" data-dom="${esc(s.domain)}"><span class="tile">${IC.globe}</span><div class="t"><b>${esc(s.domain)}</b><span>${s.saved ? "One of your saved sites" : "Left cookies in my browser"}</span></div><div class="acts"><button class="btn quiet sm" type="button" data-s="signout" data-d="${esc(s.domain)}">Sign out</button></div></div>`,
      )
      .join("") || '<div class="empty">Not signed in anywhere.</div>') +
    (r.sites.length ? '<div class="row"><div class="t"><b>Clear everything</b><span>Signs my browser out of every site and forgets what they stored.</span></div><div class="acts"><button class="btn sm danger" type="button" data-s="clearAll">Clear everything</button></div></div>' : "");
}
async function sitesClick(b: HTMLElement): Promise<boolean> {
  const k = b.dataset.s;
  const row = b.closest<HTMLElement>(".row");
  try {
    if (k === "signout" && row && !row.querySelector(".confirm"))
      row.insertAdjacentHTML("beforeend", `<div class="confirm"><span>Sign out of ${esc(b.dataset.d ?? "")}? Only that site.</span><button class="btn sm danger" type="button" data-s="signoutYes" data-d="${esc(b.dataset.d ?? "")}">Sign out</button><button class="btn quiet sm" type="button" data-s="sitesKeep">Keep</button></div>`);
    else if (k === "signoutYes") {
      (b as HTMLButtonElement).disabled = true;
      await api("/api/v2/browser/signout", { json: { domain: b.dataset.d } });
      toast(`Signed out of ${b.dataset.d}.`);
      void signedIn();
    } else if (k === "clearAll" && row && !row.querySelector(".confirm"))
      row.insertAdjacentHTML("beforeend", '<div class="confirm"><span>Sign out of every site?</span><button class="btn sm danger" type="button" data-s="clearAllYes">Clear everything</button><button class="btn quiet sm" type="button" data-s="sitesKeep">Keep</button></div>');
    else if (k === "clearAllYes") {
      (b as HTMLButtonElement).disabled = true;
      await api("/api/v2/browser/clear", { json: {} });
      toast("Signed out of everything.");
      void signedIn();
    } else if (k === "sitesKeep") b.closest(".confirm")?.remove();
    else return false;
  } catch (err) {
    (b as HTMLButtonElement).disabled = false;
    toast(err instanceof Error ? err.message : String(err));
  }
  return true;
}

async function settings() {
  const s = state.settings;
  const prof = await api<Profile>("/api/setup/profile", { method: "GET" });
  const health = await api<{ voice: string }>("/api/health", { method: "GET" });
  const st = await api<SetupStatus>("/api/setup/status", { method: "GET" });
  const log = await api<{ events: { ts: string; actor: string; event: string }[] }>("/api/setup/activity", { method: "GET" }).catch(() => ({ events: [] }));
  const keys = (await api<{ shortcuts: ShortcutKey[] }>("/api/v2/shortcuts", { method: "GET" }).catch(() => ({ shortcuts: [] as ShortcutKey[] }))).shortcuts;
  const sent = (await api<{ sent: Sent[] }>("/api/table/sent", { method: "GET" }).catch(() => ({ sent: [] as Sent[] }))).sent; // the round table (17)
  const mode = s["ui.pebble_colour_mode"] === "fixed" ? "fixed" : "day";
  const fixed = String(s["ui.pebble_fixed_colour"] ?? "blue");
  const now = Palette.colourFor(s);
  const today = Palette.DAYS[Palette.weekday(new Date(), String(s["time.zone"] ?? ""))];
  const theme = String(s["ui.theme"] ?? "system");
  const t = (k: string) => esc(String(s[k] ?? ""));
  $("settings").innerHTML = `${head("Settings", `How ${appName()} looks, sounds and behaves.`)}
    ${sec("Pebble's colour")}<div class="panel pcol">
      <div class="pprev"><span class="char-host" id="pebPrev"></span><div><b>${esc(now.name)}</b><span>${mode === "day" ? `${esc(today.day)}'s colour` : "Every day"}</span></div></div>
      <div class="popts">
        <label class="popt"><input type="radio" name="pmode" value="day" ${mode === "day" ? "checked" : ""}><span><b>Changes each day</b><small>A different colour for each day of the week.</small></span></label>
        <div class="sws">${[1, 2, 3, 4, 5, 6, 0]
          .map((i) => {
            const d = Palette.DAYS[i];
            const on = mode === "day" ? d === today : d.name.toLowerCase() === fixed;
            return `<button type="button" class="sw-c${on ? " on" : ""}" data-sw="${d.name.toLowerCase()}" aria-pressed="${on}" title="${mode === "day" ? `${d.day}: ${d.name}` : d.name}"><i style="background:radial-gradient(circle at 36% 28%, ${d.tint}, ${d.base} 75%)"></i><span>${mode === "day" ? d.short : d.name}</span></button>`;
          })
          .join("")}</div>
        <label class="popt"><input type="radio" name="pmode" value="fixed" ${mode === "fixed" ? "checked" : ""}><span><b>Always this colour</b><small>${mode === "fixed" ? "Pick a swatch above." : "Choose this, then pick a swatch."}</small></span></label>
      </div></div>
    ${sec("Its name")}<div class="panel"><div class="row"><div class="t"><b>What you call it</b><span>Or just tell it a new name.</span></div><div class="inline-edit"><input id="aname" value="${esc(prof.name ?? "")}" placeholder="No name yet" style="font-family:var(--f-ui);width:200px"><button class="btn sm" type="button" data-s="name">Save</button></div></div></div>
    ${sec("How hard it thinks")}<div class="panel popts" style="padding:6px 0">${(
      [
        ["fast", "Quick", "Fastest, lightest thinking. For when you want speed over depth."],
        ["balanced", "Balanced", "Thinks as hard as each thing needs. Quick things stay quick; things that matter get the time they need."],
        ["best", "Best", "Thinks hardest about everything. Slower, and uses more of your Claude plan."],
      ] as const
    )
      .map(
        ([v, n, d]) =>
          `<label class="popt"><input type="radio" name="bmode" value="${v}" ${(s["brain.mode"] ?? "balanced") === v ? "checked" : ""}><span><b>${n}${v === "balanced" ? ' <span class="pill ok" style="height:18px;margin-left:6px;vertical-align:1px">Recommended</span>' : ""}</b><small>${d}</small></span></label>`,
      )
      .join("")}
      <div class="row"><div class="t"><b>The most one job may take</b><span>When it takes something away to work on. If it gets there, it stops and tells you what it has and what's left.</span></div><div class="inline-edit"><input type="number" min="5" max="240" id="wmin" value="${t("work.max_minutes")}" style="width:70px" aria-label="Minutes"><span style="color:var(--ink-3)">minutes, up to US$</span><input type="number" min="0.5" max="100" step="0.5" id="wusd" value="${t("work.max_usd")}" style="width:70px" aria-label="US dollars of your plan"><button class="btn sm" type="button" data-s="work">Save</button></div></div></div>
    ${sec("Voice")}<div class="panel">
      <div class="row"><div class="t"><b>Voice</b><span>Used on your phone and when you press the mic here. Set in the assistant's configuration.</span></div><span class="when">${esc(health.voice)}</span></div>
      <div class="row"><div class="t"><b>Quiet hours</b><span>No alerts unless something's urgent. Leave both empty for none.</span></div><div class="inline-edit"><input type="time" id="qs" value="${t("quiet_start")}" aria-label="From"><span style="color:var(--ink-3)">to</span><input type="time" id="qe" value="${t("quiet_end")}" aria-label="To"><button class="btn sm" type="button" data-s="quiet">Save</button></div></div>
      <div class="row"><div class="t"><b>Alerts a day</b><span>0 means no limit. Urgent ones always come through.</span></div><div class="inline-edit"><input type="number" min="0" max="100" id="maxi" value="${t("max_interruptions")}" style="width:70px"><button class="btn sm" type="button" data-s="max">Save</button></div></div>
      <details class="more"><summary>What the voice is told</summary><pre>${esc(prof.voiceCard)}</pre></details></div>
    ${siriHtml(st.phoneUrl ? `${st.phoneUrl}/api/shortcut` : null, keys)}
    ${tableSettingsHtml(s, sent)}
    ${sec("Routines")}<div class="panel">
      ${[["brief_time", "Morning brief"], ["lunch_time", "Midday check"], ["wrap_time", "Wrap-up"]].map(([k, n]) => `<div class="row"><div class="t"><b>${n}</b></div><div class="inline-edit"><input type="time" data-time="${k}" value="${t(k)}" aria-label="${n}"><button class="btn sm" type="button" data-s="time" data-k="${k}">Save</button></div></div>`).join("")}</div>
    ${sec("Always asks first")}<div class="panel">${["Sending anything", "Paying for anything", "Deleting anything", "Changing its own personality"].map((n) => `<div class="row"><div class="t"><b>${n}</b><span>You get a Send or OK button first. This can't be turned off.</span></div><span class="pill off">Always</span></div>`).join("")}</div>
    ${sec("Sites I'm signed in to")}<div class="panel" id="bSites"><div class="empty">Looking…</div></div><p class="foot">From my browser's own cookies. Signing out of a site clears only that site; you can sign in again from Connections.</p>
    ${sec("Appearance")}<div class="panel"><div class="row"><div class="t"><b>Theme</b></div><div class="seg" id="themeSeg">${["system", "light", "dark"].map((v) => `<button type="button" data-t="${v}" aria-pressed="${v === theme}">${v === "system" ? "Match computer" : v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div></div>
      <div class="row"><div class="t"><b>Sound on the phone</b><span>Typed replies read out when there's no call on.</span></div><button class="sw" type="button" role="switch" aria-checked="${s["ui.sound"] !== false}" data-s="sound" aria-label="Sound on the phone"></button></div></div>
    ${sec("Personality (advanced)")}<div class="panel">
      <details class="more"><summary>Its personality (SOUL.md, yours)</summary><div style="padding:0 16px 14px"><textarea class="big" id="soulTxt">${esc(prof.soul)}</textarea><div class="dactions"><button class="btn sm" type="button" data-s="soul">Save</button><span class="note">Safety and sending rules live in the code; nothing here can loosen them.</span></div></div></details>
      <details class="more"><summary>About you (USER.md, it keeps this up to date)</summary><div style="padding:0 16px 14px"><textarea class="big" id="userTxt">${esc(prof.user)}</textarea><div class="dactions"><button class="btn sm" type="button" data-s="user">Save</button></div></div></details>
      <details class="more"><summary>How it's running</summary><pre>${esc(`Brain: ${st.brain.model}${st.brain.subscription ? " (your Claude subscription)" : ""}\nVoice: ${st.voice.model}, ${st.voice.name}${st.voice.ready ? "" : " (not set up: no OpenAI key)"}${st.voice.live ? ", in a call now" : ""}\nRunning since ${when(st.startedAt)}`)}</pre></details>
      <details class="more"><summary>Activity log</summary><pre>${esc(log.events.slice(0, 60).map((e) => `${when(e.ts)} · ${e.actor} · ${e.event}`).join("\n") || "Nothing yet.")}</pre></details>
      <details class="more"><summary>Recent changes</summary><pre>${esc(prof.changes.slice(0, 20).map((c) => `${when(c.created_at ?? c.at)} · ${c.target}${c.op ? ` ${c.op}` : ""} · ${c.source}`).join("\n") || "None yet.")}</pre></details></div>`;
  void signedIn();
  preview = preview ?? new Animator();
  preview.slots = [];
  preview.mount($("pebPrev"));
  preview.state = anim.state;
  const root = $("settings");
  root.onchange = (e) => {
    const r = e.target as HTMLInputElement;
    if (r.name === "bmode") return void saveSettings({ "brain.mode": r.value }).then(() => toast("Saved."));
    if (r.name === "pmode") void saveSettings(r.value === "fixed" ? { "ui.pebble_colour_mode": "fixed", "ui.pebble_fixed_colour": Palette.colourFor(s).name.toLowerCase(), "ui.colour_override": null } : { "ui.pebble_colour_mode": "daily", "ui.colour_override": null }).then(() => settings());
  };
  root.onclick = async (e) => {
    const sw = (e.target as Element).closest<HTMLElement>("[data-sw]");
    if (sw) {
      if (mode === "fixed") await saveSettings({ "ui.pebble_fixed_colour": sw.dataset.sw, "ui.colour_override": null });
      else await saveSettings({ "ui.pebble_colour_mode": "fixed", "ui.pebble_fixed_colour": sw.dataset.sw, "ui.colour_override": null });
      return void settings();
    }
    const th = (e.target as Element).closest<HTMLElement>("[data-t]");
    if (th) {
      await saveSettings({ "ui.theme": th.dataset.t });
      return void settings();
    }
    const g = (e.target as Element).closest<HTMLElement>("[data-g]"); // the round table's (17)
    if (g) {
      await tableSettingsClick(g, (p) => saveSettings(p as never), s);
      toast("Saved.");
      return void settings();
    }
    const b = (e.target as Element).closest<HTMLElement>("[data-s]");
    if (!b) return;
    if (await siriClick(b)) return;
    if (await sitesClick(b)) return;
    try {
      const k = b.dataset.s;
      if (k === "name") await api("/api/setup/profile/name", { json: { name: ($("aname") as HTMLInputElement).value.trim() } });
      else if (k === "quiet") await api("/api/setup/rules", { json: { quiet_start: ($("qs") as HTMLInputElement).value, quiet_end: ($("qe") as HTMLInputElement).value, max_interruptions: String(s.max_interruptions ?? 0) } });
      else if (k === "max") await saveSettings({ max_interruptions: Number(($("maxi") as HTMLInputElement).value) || 0 });
      else if (k === "work") await saveSettings({ "work.max_minutes": Math.round(Number(($("wmin") as HTMLInputElement).value) || 30), "work.max_usd": Number(($("wusd") as HTMLInputElement).value) || 6 });
      else if (k === "time") await saveSettings({ [b.dataset.k!]: (root.querySelector(`[data-time="${b.dataset.k}"]`) as HTMLInputElement).value });
      else if (k === "sound") await saveSettings({ "ui.sound": s["ui.sound"] === false });
      else if (k === "soul") await api("/api/setup/profile/soul", { json: { text: ($("soulTxt") as HTMLTextAreaElement).value } });
      else if (k === "user") await api("/api/setup/profile/user", { json: { text: ($("userTxt") as HTMLTextAreaElement).value } });
      toast("Saved.");
      if (k === "sound") void settings();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };
}

const RENDER: Record<Page, (nav: Nav) => Promise<void>> = { activity, memory: () => memory(), connections: (nav) => connections(nav), files: (nav) => renderFiles(nav, files), settings: () => settings() };
