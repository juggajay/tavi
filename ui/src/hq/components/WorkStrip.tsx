import { useEffect, useState } from "react";
import type { TeamBot, Live } from "../types";
import { WorkActions } from "./WorkActions";
import { presence } from "../lib/presence";
import { duration } from "./ActivityLine";
export function WorkStrip({ bot, live }: { bot: TeamBot; live?: Live }) {
  const [now, tick] = useState(Date.now());
  const work = (live?.work ?? []).filter(job => job.id !== presence(live).job);
  useEffect(() => { if (!work.length) return; const timer = setInterval(() => tick(Date.now()), 1000); return () => clearInterval(timer); }, [work.length]);
  if (!work.length) return null;
  return <div className="work-strips">{work.map(job => <section className="work-strip" key={job.id} aria-label={`${job.state === "queued" ? "Queued" : "Working on"} ${job.title}`}>
    <span className="work-strip-title" title={job.title}>{job.title}</span><span className="work-strip-meta">{duration(now - Date.parse(job.since))} · {job.steps} {job.steps === 1 ? "step" : "steps"}</span><WorkActions bot={bot} job={job} />
  </section>)}</div>;
}
