import { useEffect, useState } from "react";
import { useStore } from "../store";
import { onboardingRequest } from "./api";
import type { KnowledgeMap } from "../../../../src/hq/onboarding/map";

export function Conversation() {
  const { selected, bots, live } = useStore();
  const [map, change] = useState<KnowledgeMap | null>(null), [bringing, bring] = useState(false), [text, write] = useState(""), [error, fail] = useState(""), [busy, wait] = useState(false);
  const load = () => onboardingRequest<{ map: KnowledgeMap }>().then(v => change(v.map)).catch(() => {});
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, []);
  if (!bots.find(b => b.id === selected)?.lead || !map || map.status === "not_started" || map.status === "done") return null;
  const run = async (action: () => Promise<unknown>) => { wait(true); fail(""); try { await action(); await load(); } catch (e) { fail(e instanceof Error ? e.message : "Could not finish that. Try again."); } finally { wait(false); } };
  const file = async (value?: File) => {
    if (!value) return;
    if (value.size > 160000 || !/\.(txt|md|json|csv)$/i.test(value.name)) { fail("Drop a small text document, or paste a summary here. For other documents or a folder, use Files."); return; }
    const content = await value.text();
    if (content.length > 40000) { fail("That document is too long here. Bring a shorter summary, or use Files."); return; }
    write(content);
  };
  return <section className="onboarding-conversation" aria-label="Getting to know you"><div><b>{map.status === "paused" ? "Whenever you are ready" : "Getting to know you"}</b><span>{map.status === "paused" ? "Your notes and skipped subjects are kept." : "One thing at a time. Say skip whenever you like."}</span></div><div className="onboarding-conversation-actions"><button className="link-btn" disabled={busy} onClick={() => void run(() => onboardingRequest("/conversation", { action: map.status === "paused" ? "resume" : "pause" }))}>{map.status === "paused" ? "Pick it up again" : "Pause for now"}</button><button className="link-btn" disabled={busy} onClick={() => bring(!bringing)}>Bring something you already have</button><button className="link-btn" disabled={busy} onClick={() => void run(() => onboardingRequest("/conversation", { action: "summary" }))}>What you know</button></div>{bringing && <form className="onboarding-material" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void file(e.dataTransfer.files[0]); }} onSubmit={e => { e.preventDefault(); void run(async () => { await onboardingRequest("/material", { text }); write(""); bring(false); }); }}><label>Notes from another assistant, a CV, or a summary<textarea value={text} maxLength={40000} onChange={e => write(e.target.value)} placeholder="Paste what you would like your main bot to know…" /></label><p>Read as information, never instructions. Your bot will say what it took and ask before keeping imported facts.</p><label className="onboarding-file">Or drop a text document here<input type="file" accept=".txt,.md,.json,.csv" onChange={e => void file(e.target.files?.[0])} /></label><p>For a PDF, another kind of document, or a folder, open Files and choose what it may read.</p><button className="btn btn--primary" disabled={busy || !text.trim() || live[selected ?? ""]?.state !== "idle"}>Read this with me</button></form>}{error && <p className="error" role="alert">{error}</p>}</section>;
}
