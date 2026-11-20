import { savedValue } from "../../../src/shared/earlier";
// Adapted from Bot HQ (MIT), github.com/nickvasilescu/bot-hq
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startSelfUpdate } from "./lib/selfUpdate";
import "../shared/fonts.css";
import "../shared/tokens.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/chat.css";
import "./styles/cards.css";
import "./styles/details.css";
import "./styles/modals.css";
import "./styles/config.css";
import "./styles/viewer.css";
import "./styles/legacy.css";
import "./styles/hq.css";
const saved = savedValue(localStorage, "tavi-hq-theme") ?? "system";
document.documentElement.dataset.theme = saved === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : saved;
const media = matchMedia("(prefers-color-scheme: dark)");
media.addEventListener("change", event => { if ((savedValue(localStorage, "tavi-hq-theme") ?? "system") === "system") document.documentElement.dataset.theme = event.matches ? "dark" : "light"; });
// The installed Windows program has no title bar; Windows draws its three buttons over the top-right corner.
const overlay = (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay;
if (overlay?.visible) document.documentElement.classList.add("is-windowed");
startSelfUpdate();
createRoot(document.getElementById("root")!).render(<App />);
