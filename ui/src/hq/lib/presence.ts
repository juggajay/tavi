import type { Live } from "../types";

export function presence(live?: Live) {
  const work = live?.work?.find(job => job.state !== "queued");
  const waiting = live?.state === "waiting_for_owner";
  const chat = waiting || live?.state === "thinking" || live?.state === "working";
  const queued = live?.state === "queued" || !!live?.queued || !!live?.work?.length;
  const state = chat ? live!.state : work ? "working" : queued ? "queued" : "idle";
  return {
    busy: state !== "idle", state, waiting,
    status: waiting ? "Needs you" : state === "thinking" ? "Thinking" : state === "working" ? "Working" : state === "queued" ? "Queued" : "Ready",
    caption: chat ? live!.doing?.trim() || "" : work ? work.doing?.trim() || work.title : queued ? "Waiting to start" : "",
    since: chat ? waiting ? live!.waitingSince ?? live!.since : live!.since : work?.since ?? (queued ? live?.work?.[0]?.since ?? live?.since : null),
    steps: chat ? live!.steps : work?.steps ?? 0,
    job: chat ? undefined : work?.id ?? live?.work?.[0]?.id,
  };
}
