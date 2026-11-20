// The one thing the desktop page may ask of Windows: "let the owner pick a folder". Nothing else is exposed.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lhDesktop", {
  /** Opens the Windows folder picker. Resolves with the chosen folder, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke("lh:pick-folder"),
});
