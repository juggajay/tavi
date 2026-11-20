// The round table in the desktop's Settings (Stage 17): Echo on or off, his name, his models, how many rounds "discuss
// it" runs, his voice, and "What does Echo know?": every prompt sent to him at the last round table, exactly as sent.
import { esc } from "./core";

export type Sent = { at: string; kind: "turn" | "review"; model: string; prompt: string };

const sec = (title: string) => `<h2 class="sec">${title}</h2>`;
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const VOICES = ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"];
const opts = (list: string[], v: string) => list.map((x) => `<option value="${x}"${x === v ? " selected" : ""}>${x}</option>`).join("");

export function tableSettingsHtml(s: Record<string, unknown>, sent: Sent[]) {
  const v = (k: string, d: string) => String(s[k] ?? d);
  const name = esc(v("guest.name", "Echo"));
  const on = s["guest.enabled"] !== false;
  const knows = sent.length
    ? sent.map((x, i) => `${i + 1}. ${x.kind === "review" ? "For his written review" : "For a turn at the table"} (${x.model}), ${new Date(x.at).toLocaleString("en-AU", { weekday: "short", hour: "numeric", minute: "2-digit" })}\n\n${x.prompt}`).join("\n\n————\n\n")
    : "Nothing sent yet. When you bring him in, it's shown here exactly as sent.";
  return `${sec("Round table")}<div class="panel">
      <div class="row"><div class="t"><b>${name}, a second opinion</b><span>Say "bring in ${name}" and a second assistant joins the conversation. He runs on your OpenAI plan through the Codex program on this PC, with no tools and none of your files.</span></div><button class="sw" type="button" role="switch" aria-checked="${on}" data-g="enabled" aria-label="Round table on"></button></div>
      <div class="row"><div class="t"><b>His name</b><span>What you call him. If you know a real ${name}, pick another.</span></div><div class="inline-edit"><input id="gName" value="${name}" style="font-family:var(--f-ui);width:120px" aria-label="His name"><button class="btn sm" type="button" data-g="name">Save</button></div></div>
      <div class="row"><div class="t"><b>Talking at the table</b><span>Quick, for the conversation.</span></div><div class="inline-edit"><input id="gModel" class="mono" value="${esc(v("guest.model", "gpt-6.1-terra"))}" style="width:150px" aria-label="Model"><select id="gEffort" aria-label="Thinking">${opts(EFFORTS, v("guest.effort", "low"))}</select><button class="btn sm" type="button" data-g="model">Save</button></div></div>
      <div class="row"><div class="t"><b>"Sleep on it" reviews</b><span>Slow and careful, in the background.</span></div><div class="inline-edit"><input id="gDeep" class="mono" value="${esc(v("guest.deep_model", "gpt-6-astra"))}" style="width:150px" aria-label="Model for reviews"><select id="gDeepEffort" aria-label="Thinking for reviews">${opts(EFFORTS, v("guest.deep_effort", "xhigh"))}</select><button class="btn sm" type="button" data-g="deep">Save</button></div></div>
      <div class="row"><div class="t"><b>"Discuss it"</b><span>Rounds of the two of them before Pebble sums up (at most four).</span></div><div class="inline-edit"><input type="number" min="1" max="4" id="gRounds" value="${esc(v("guest.rounds", "2"))}" style="width:60px" aria-label="Rounds"><button class="btn sm" type="button" data-g="rounds">Save</button></div></div>
      <div class="row"><div class="t"><b>His voice</b><span>Plainly not Pebble's. Speaking his lines uses the voice key, like Pebble's voice does.</span></div><div class="inline-edit"><select id="gVoice" aria-label="His voice">${opts(VOICES, v("guest.voice", "cedar"))}</select><button class="btn sm" type="button" data-g="voice">Save</button></div></div>
      <details class="more" id="gKnows"><summary>What does ${name} know?</summary><pre>${esc(knows)}</pre></details></div>`;
}

/** Its buttons; true when it was one of them. */
export async function tableSettingsClick(b: HTMLElement, save: (patch: Record<string, unknown>) => Promise<unknown>, s: Record<string, unknown>): Promise<boolean> {
  const k = b.dataset.g;
  if (!k) return false;
  const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value.trim();
  if (k === "enabled") await save({ "guest.enabled": s["guest.enabled"] === false });
  else if (k === "name") await save({ "guest.name": val("gName") });
  else if (k === "model") await save({ "guest.model": val("gModel"), "guest.effort": val("gEffort") });
  else if (k === "deep") await save({ "guest.deep_model": val("gDeep"), "guest.deep_effort": val("gDeepEffort") });
  else if (k === "rounds") await save({ "guest.rounds": Number(val("gRounds")) || 2 });
  else if (k === "voice") await save({ "guest.voice": val("gVoice") });
  return true;
}
