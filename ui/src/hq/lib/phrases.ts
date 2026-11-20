// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { useEffect, useState } from "react";
import type { Live, Row } from "../types";
import { presence } from "./presence";

export const isWaitingForYou = (live?: Live) => presence(live).waiting;
export const activityStatus = (live?: Live) => presence(live).status;
export function activityPhrase(live: Live | undefined, rows: Row[], tick: number) {
  const current = presence(live);
  if (current.waiting) return current.caption || "Waiting for your answer";
  if (current.state === "queued") return "Waiting to start";
  const relevant = current.state === "thinking" ? [] : [...rows].reverse().filter(row => row.body.kind === "step" && row.body.job === current.job);
  const step = (relevant.find(row => row.body.kind === "step" && row.body.state === "running") ?? relevant[0])?.body;
  const titleOnly = !!current.job && !live?.work?.find(job => job.id === current.job)?.doing?.trim();
  if (current.caption && !titleOnly && (step?.kind !== "step" || current.caption !== step.label)) return current.caption;
  const tool = step?.kind === "step" ? step.tool : "";
  const phrases = /web_search|search_web/.test(tool) ? ["Searching the web", "Looking for useful sources", "Checking the search results"]
    : /search|find|list_files/.test(tool) ? [step?.kind === "step" ? step.label : "Searching your files", "Looking for the right information", "Checking the search results"]
    : /read|open|look_at|extract/.test(tool) ? [step?.kind === "step" ? step.label : "Reading the details", "Looking through the details", "Reading carefully"]
    : /write|draft|create|save/.test(tool) ? [step?.kind === "step" ? step.label : "Working on the next part", "Working through the next part", "Taking it step by step"]
    : /browser|web/.test(tool) ? ["Looking through web pages", "Reading the sources", "Checking the details"]
    : current.state === "thinking" ? ["Thinking it through", "Considering the details", "Putting it together"]
    : [step?.kind === "step" ? step.label : "Working on it", "Working through the next part", "Taking it step by step"];
  const phrase = phrases[((tick % phrases.length) + phrases.length) % phrases.length];
  return titleOnly ? `${current.caption} · ${phrase}` : phrase;
}
export function usePresence(live?: Live, rows: Row[] = []) {
  const [now, tick] = useState(Date.now());
  const current = presence(live);
  useEffect(() => {
    if (!current.busy) return;
    tick(Date.now());
    const timer = setInterval(() => tick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [current.busy]);
  const since = current.since ? Date.parse(current.since) : now;
  return { ...current, now, caption: current.busy ? activityPhrase(live, rows, Math.floor((now - since) / 6000)) : "" };
}
