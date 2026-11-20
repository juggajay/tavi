import { useState } from "react";
import type { TeamBot, Work } from "../types";
import { request } from "../lib/api";
import { reportError } from "../store";

export function WorkActions({ bot, job }: { bot: TeamBot; job: Work }) {
  const [busy, setBusy] = useState(false);
  const ask = async (words: string) => {
    setBusy(true);
    try { await request(`/bots/${encodeURIComponent(bot.id)}/messages`, "POST", { text: `${words}: ${job.title}` }); }
    catch (error) { reportError(error); } finally { setBusy(false); }
  };
  return <div className="work-actions" aria-label={`Actions for ${job.title}`}>
    {["How's it going", "Quick version", "Stop"].map(words => <button className="link-btn" disabled={busy} key={words} onClick={() => void ask(words === "Stop" ? "Stop this work" : words === "Quick version" ? "Just give me the quick version" : words)}>{words}</button>)}
  </div>;
}

