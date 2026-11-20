// A 3D model on screen (Stage 9.4). Only this small part is in the app from the start; the viewer (three.js) is fetched
// the first time a model is opened, and never before, so the phone's first load doesn't grow. Until it's ready it says
// "Building the model…". Kept short on purpose: every byte here is in the phone's first load.
import type { ModelPayload, SurfaceCommand } from "../../../../src/shared/protocol";
import type { ViewState } from "../sheet-viewer/viewer";
import type { CamState, Viewer3D, ViewerOpts } from "../model3d-viewer/viewer";

export type ModelView = {
  cx: number;
  cy: number;
  readonly zoomPct: number;
  getView(): ViewState;
  setView(v: ViewState): void;
  zoomIn(): void;
  zoomOut(): void;
  zoomBy(f: number): void;
  focus(): void;
  setMarks(): void;
  destroy(): void;
  /** Pulled apart and sizes showing, for the gateway. */
  state(): { apart: boolean; sizes: boolean };
  /** Where it's being looked at from, so a changed model can open the same way. */
  camera(): CamState | undefined;
  /** A view command from the fast path, or a request for pictures or a file. */
  handle(cmd: SurfaceCommand): Promise<unknown>;
};

export function modelView(host: HTMLElement, itemId: string, payload: ModelPayload, opts: ViewerOpts = {}): ModelView {
  host.classList.add("sv-host");
  host.style.position = "relative";
  host.innerHTML = '<div class="sv-missing">Building the model…</div>'; // the sheet viewer's quiet message style
  let v: Viewer3D | null = null,
    dead = false;
  const ready = import("../model3d-viewer/viewer").then(
    (m) => (dead ? null : (v = m.open(host, payload, opts))),
    () => ((host.firstChild!.textContent = "I couldn't load the 3D viewer."), null),
  );
  const later =
    <K extends "zoomIn" | "zoomOut" | "zoomBy" | "setView">(k: K) =>
    (...a: Parameters<Viewer3D[K]>) =>
      void ready.then((x) => (x?.[k] as (...p: unknown[]) => void)?.(...a));
  return {
    cx: 0,
    cy: 0,
    get zoomPct() {
      return v?.zoomPct ?? 100;
    },
    getView: () => v?.getView() ?? { s: 1, cx: 0, cy: 0 },
    setView: later("setView"),
    zoomIn: later("zoomIn"),
    zoomOut: later("zoomOut"),
    zoomBy: later("zoomBy"),
    focus() {},
    setMarks() {},
    destroy: () => ((dead = true), v?.destroy()),
    state: () => ({ apart: !!v?.apartOn, sizes: !!v?.sizesOn }),
    camera: () => v?.cameraState(),
    handle: (cmd) => ready.then((x) => x?.handle(cmd, itemId)),
  };
}
