import { DAYS } from "../shared/palette";
import type { Settings } from "../../../src/shared/protocol";
import type { Voice } from "../shared/voice";

// The options sheet is only needed after a long press.
export function quickHtml(settings: Settings, onCall: boolean, alerts: boolean) {
  const sound = settings["ui.sound"] !== false;
  const mode = settings["ui.pebble_colour_mode"] === "fixed" ? String(settings["ui.pebble_fixed_colour"]) : "daily";
  const override = settings["ui.colour_override"] as { colour: string; until: string } | null;
  const active = override && new Date(override.until) > new Date() ? override.colour : mode;
  return `${onCall ? '<button class="quick-row end" type="button" data-q="end">End call</button>' : ""}
    <button class="quick-row" type="button" data-q="sound">Sound<span class="v">${sound ? "On" : "Off"}</span></button>
    ${alerts ? '<button class="quick-row" type="button" data-q="alerts">Turn on alerts</button>' : ""}
    <div class="quick-label">Pebble's colour</div><div class="swatches">
    <button class="swatch-daily" type="button" data-colour="daily" aria-pressed="${active === "daily"}">Changes each day</button>
    ${[1,2,3,4,5,6,0].map(i => DAYS[i]).map(d => `<button class="swatch" type="button" data-colour="${d.name.toLowerCase()}" aria-label="${d.name}" aria-pressed="${active === d.name.toLowerCase()}" style="background:${d.base}"></button>`).join("")}</div>`;
}

const bound = new WeakSet<HTMLElement>();
export function bindQuick(body: HTMLElement, h: { settings: () => Settings; voice: Voice; close: () => void; save: (patch: Settings) => Promise<void>; alerts: () => Promise<void>; refresh: () => void }) {
  if (bound.has(body)) return;
  bound.add(body);
  body.addEventListener("click", async e => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button"); if (!b) return;
    if (b.dataset.q === "end") { h.voice.end("Bye for now. Tap me when you need me."); h.close(); }
    else if (b.dataset.q === "sound") { await h.save({ "ui.sound": h.settings()["ui.sound"] === false }); h.refresh(); }
    else if (b.dataset.q === "alerts") { await h.alerts(); h.close(); }
    else if (b.dataset.colour) {
      const colour = b.dataset.colour;
      await h.save(colour === "daily" ? { "ui.pebble_colour_mode": "daily", "ui.colour_override": null } : { "ui.pebble_colour_mode": "fixed", "ui.pebble_fixed_colour": colour, "ui.colour_override": null });
      h.refresh();
    }
  });
}
