// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useState } from "react";
import type { Live, Row, TeamBot } from "../../types";
import { openItem, useStore } from "../../store";
import { Icon } from "../Icon";

type Step = Extract<Row["body"], { kind: "step" }>;
type Task = { id: string; title: string; state: "working" | "waiting" | "queued" | "done" | "failed"; since: string; end?: string; count: number; steps: Step[] };
const elapsed = (start: string, end: string | number) => {
  const seconds = Math.max(0, Math.floor(((typeof end === "number" ? end : Date.parse(end)) - Date.parse(start)) / 1000)) || 0;
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};
export function conversationTasks(rows: Row[], live?: Live): Task[] {
  const groups = new Map<string, Task>();
  let owner: Row | undefined;
  for (const row of rows) {
    const body = row.body;
    if (body.kind === "message" && body.from === "owner") owner = row;
    if (body.kind !== "step") continue;
    const id = body.job ?? `chat-${owner?.seq ?? 0}`;
    let task = groups.get(id);
    if (!task) {
      task = { id, title: body.jobTitle || (owner?.body.kind === "message" ? owner.body.text.slice(0, 120) : "Work in this conversation"), state: "done", since: body.jobSince ?? row.ts, count: 0, steps: [] };
      groups.set(id, task);
    }
    task.steps.push(body); task.count++; task.end = body.jobEndedAt ?? row.ts;
  }
  for (const job of live?.work ?? []) {
    const task = groups.get(job.id) ?? { id: job.id, title: job.title, since: job.since, count: 0, steps: [] };
    groups.set(job.id, { ...task, title: job.title, since: job.since, state: job.state === "queued" ? "queued" : "working", count: Math.max(task.count, job.steps), end: undefined });
  }
  if (live && ["thinking", "working", "waiting_for_owner"].includes(live.state)) {
    const id = `chat-${owner?.seq ?? 0}`, task = groups.get(id);
    groups.set(id, { id, title: owner?.body.kind === "message" ? owner.body.text.slice(0, 120) : live.doing || "Current conversation", since: live.since ?? task?.since ?? new Date().toISOString(), count: Math.max(task?.count ?? 0, live.steps), steps: task?.steps ?? [], state: live.state === "waiting_for_owner" ? "waiting" : "working" });
  }
  if (live?.queued) groups.set("waiting-messages", { id: "waiting-messages", title: `${live.queued} ${live.queued === 1 ? "message" : "messages"} waiting`, state: "queued", since: live.since ?? "", count: 0, steps: [] });
  return [...groups.values()].sort((a, b) => {
    const order = (t: Task) => t.state === "working" || t.state === "waiting" ? 0 : t.state === "queued" ? 1 : 2;
    return order(a) - order(b) || Date.parse(b.since) - Date.parse(a.since);
  });
}
export function Tasks({ bot }: { bot: TeamBot }) {
  const rows = useStore(s => s.transcripts[bot.id]?.rows), live = useStore(s => s.live[bot.id]);
  const [now, tick] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => tick(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const tasks = conversationTasks(rows ?? [], live);
  return <div className="details__sections"><section aria-label="Tasks"><div className="section-label">Tasks</div><div className="panel-card task-list task-list--compact">{tasks.length ? tasks.map(task => <details className={`details-task is-${task.state}`} key={task.id}><summary className={`task-row is-${task.state}`}><span className={`task-row__check is-${task.state}`}>{task.state === "done" ? <Icon name="check" size={16} /> : <span className="task-row__ring" />}</span><span className="task-row__text"><span className="task-row__title">{task.title}</span><span className="task-row__meta">{task.state === "queued" ? "Waiting to start" : `${task.state === "working" ? "Working for" : task.state === "waiting" ? "Needs you ·" : task.state === "failed" ? "Didn't finish ·" : "Took"} ${elapsed(task.since, task.end ?? now)} · ${task.count} ${task.count === 1 ? "step" : "steps"}`}</span></span><Icon name="chev_down" size={12} opacity={0.5} /></summary><div className="details-task__steps">{task.steps.length ? task.steps.map(step => <div className="details-step" key={step.id}><i className={`details-step__dot is-${step.state}`} /><span>{step.label}</span><small>{step.state === "ok" ? "Done" : step.state === "failed" ? "Didn't finish" : task.state === "working" || task.state === "waiting" ? "Working" : "Stopped"}</small></div>) : <p className="panel-empty">No steps recorded yet.</p>}</div></details>) : <p className="panel-empty">No tasks yet. Ask {bot.name} in chat.</p>}</div></section></div>;
}
export function Library({ bot }: { bot: TeamBot }) {
  const rows = useStore(s => s.transcripts[bot.id]?.rows), items = useStore(s => s.items);
  const seen = new Set<string>();
  const entries = [...(rows ?? [])].reverse().flatMap(row => {
    if (row.body.kind !== "card" || row.body.card !== "item" || seen.has(row.body.ref)) return [];
    seen.add(row.body.ref); return [{ card: row.body, at: row.ts }];
  });
  const kinds: Record<string, string> = { sheet: "Drawing", shopdrawing: "Drawing set", model: "3D model", page: "Page", doc: "File", sketch: "Sketch", image: "Picture", table: "Table", note: "Note" };
  return <div className="details__sections"><section aria-label="Library"><div className="section-label">Files</div><div className="panel-card">{entries.length ? entries.map(({ card, at }) => <div className="lib-row" key={card.ref}><button className="lib-row__main" onClick={() => void openItem(card.ref)} title={`Open ${card.title}`}><span className="lib-row__icon"><Icon name="file" size={16} opacity={0.6} /></span><span className="panel-row__text"><span className="panel-row__title">{card.title}</span><span className="panel-row__meta">{kinds[items[card.ref]?.kind] ?? "Item"} · {new Date(at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span></span><span className="lib-row__open"><Icon name="chev_right" size={12} opacity={0.5} /></span></button></div>) : <p className="panel-empty panel-empty--center">Things {bot.name} makes appear here.</p>}</div></section></div>;
}
