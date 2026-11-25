import { lookChoices, colours } from "../../../../src/hq/looks/choices";
import { face, type Look } from "./character";
import { esc } from "../items/describe";
import "./looks.css";

export function phoneLooks(host: HTMLElement, name: string, initial: Look, save: (look: Look) => Promise<void>, close: () => void) {
  let look = { ...initial }, busy = false;
  host.innerHTML = `<div class="team-looks"><div class="team-look-preview"></div><p class="team-muted">Each choice is saved until you change it again.</p><fieldset><legend>Colour</legend><div class="team-look-colours">${Object.entries(colours).map(([id, [base]]) => `<button type="button" data-colour="${id}" aria-label="Colour ${id}" style="--look-colour:${base}"><span aria-hidden="true">✓</span></button>`).join("")}</div></fieldset><fieldset><legend>Shape or icon</legend><div class="team-look-grid">${lookChoices.map(choice => `<button type="button" data-shape="${choice.id}" aria-label="${choice.label} ${esc(choice.name)}">${face({ shape: choice.id, colour: look.colour })}<span>${esc(choice.name)}</span></button>`).join("")}</div></fieldset><p class="team-look-status" role="status" aria-live="polite"></p><button type="button" class="team-primary" data-done>Done</button></div>`;
  const root = host.querySelector<HTMLElement>(".team-looks")!;
  const status = root.querySelector<HTMLElement>(".team-look-status")!;
  function paint() {
    root.querySelector(".team-look-preview")!.innerHTML = `${face(look)}<div><b>${esc(name)}</b><span>${esc(lookChoices.find(choice => choice.id === look.shape)?.name ?? look.shape)} · ${esc(look.colour)}</span></div>`;
    root.querySelectorAll<HTMLButtonElement>("button[data-colour]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.colour === look.colour)));
    root.querySelectorAll<HTMLButtonElement>("button[data-shape]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.shape === look.shape));
      button.querySelector("svg")!.outerHTML = face({ shape: button.dataset.shape!, colour: look.colour });
    });
  }
  async function choose(patch: Partial<Look>) {
    if (busy) return;
    const before = look; look = { ...look, ...patch }; busy = true; paint();
    root.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = true);
    status.textContent = "Saving your choice…";
    try { await save({ ...look }); status.textContent = "Look saved."; }
    catch { look = before; paint(); status.textContent = "Couldn't save that look. Try again."; }
    finally { busy = false; root.querySelectorAll<HTMLButtonElement>("button").forEach(button => button.disabled = false); }
  }
  root.querySelectorAll<HTMLButtonElement>("button[data-shape]").forEach(button => button.onclick = () => void choose({ shape: button.dataset.shape! }));
  root.querySelectorAll<HTMLButtonElement>("button[data-colour]").forEach(button => button.onclick = () => void choose({ colour: button.dataset.colour! }));
  root.querySelector<HTMLButtonElement>("[data-done]")!.onclick = close;
  paint();
  return { update(next: Look) { if (!busy) { look = { ...next }; paint(); } } };
}
