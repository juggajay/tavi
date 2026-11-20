// The 3D model viewer (Stage 9.4), loaded the first time a model is opened and never before: three.js, soft studio
// light from three's RoomEnvironment, one key light with a soft shadow on a floor that only catches shadows, timber
// drawn with its grain, thin edge lines, and the sizes as an overlay that always faces you at a readable size. One finger
// turns it, two pinch and pan, with a glide; double-tap fits it back. Two controls: Pull apart and Sizes. It draws only
// when something changes, at most once a screen frame, and softens a little while moving if that's what it takes to stay
// smooth (9.8). It also draws pictures for the assistant (look_at_model) and makes files (save_model).
import "./viewer.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildModel, type BuiltModel } from "../../../../src/shared/model3d/build";
import type { Dim3, ModelOp, ModelPayload, ModelShot, ModelSide, SurfaceCommand } from "../../../../src/shared/protocol";
import type { ViewState } from "../sheet-viewer/viewer";
import { TextureCache, materialsFor } from "./textures";

export const MODEL_FOOT = "Model only. Check every size before you make it.";

/** The viewer in a host, or null with a plain line in its place when this screen can't do 3D (no WebGL). */
export function open(host: HTMLElement, payload: ModelPayload, opts: ViewerOpts = {}): Viewer3D | null {
  try {
    return new Viewer3D(host, payload, opts);
  } catch {
    host.innerHTML = '<p class="m3-cant">This screen can\'t show 3D.</p>';
    return null;
  }
}
export type CamState = { pos: [number, number, number]; target: [number, number, number] };
export type ViewerOpts = { title?: string; camera?: CamState; onView?: () => void; onState?: () => void; phone?: boolean };

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const V = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);
/** Where the camera sits for each view, from the model's centre (z up; front is -y). */
const DIRS: Record<"hero" | ModelSide, [number, number, number]> = {
  hero: [0.53, -0.74, 0.42],
  top: [0, -0.002, 1],
  underneath: [0, -0.002, -1],
  front: [0, -1, 0.0],
  back: [0, 1, 0.0],
  side: [1, 0, 0.0],
};
const ICON_APART =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="7" width="6" height="6" rx="1"/><rect x="11.5" y="7" width="6" height="6" rx="1"/><path d="M8.5 4.5 6 2.5M11.5 4.5 14 2.5M8.5 15.5 6 17.5M11.5 15.5l2.5 2"/></svg>';
const ICON_SIZES = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 13h14M3 10.5v5M17 10.5v5M6 13v-1.5M9 13v-2.5M12 13v-1.5M15 13v-2.5"/></svg>';

type PartView = { group: THREE.Group; mesh: THREE.Mesh; apart: THREE.Vector3; id: string; name: string };
/** Frame times while it moves: the average of the last few frames, and the whole movement's for the meter. */
type Motion = { n: number; sum: number; worst: number; last: number; recent: number[] };
/** Slower than this on average over the last RECENT frames while moving (about 45 a second): draw it softer. */
const SLOW_MS = 22,
  RECENT = 8;

export class Viewer3D {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private overlay: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private tex: TextureCache;
  private env: THREE.Texture;
  private model = new THREE.Group();
  private parts: PartView[] = [];
  private built: BuiltModel;
  private dims: Dim3[];
  private key: THREE.DirectionalLight;
  private floor: THREE.Mesh;
  private ro: ResizeObserver;
  private raf = 0;
  private dead = false;
  private interacting = false;
  private apartT = 0;
  private apartAnim: { from: number; to: number; start: number } | null = null;
  private camAnim: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number; dur: number } | null = null;
  private fitDist = 1;
  private lastTap = 0;
  apartOn = false;
  sizesOn = false;
  private viewName = "hero";
  private btnApart: HTMLButtonElement;
  private btnSizes: HTMLButtonElement;
  private disposables: { dispose(): void }[] = [];
  /* Smooth turning. It draws once per screen frame while something moves and not at all otherwise. While it moves it
     times its frames; if they're slow it draws a little softer (fewer pixels), and as a last resort leaves the shadow
     out, until it's smooth. The level it settles on is kept for the rest of this viewing so it doesn't hunt. When it
     stops it draws once at full sharpness with everything on, and writes the movement's frame times to data-ms. */
  private sharp: number[];
  private level = 0;
  private plainMoving = false;
  private motion: Motion | null = null;
  private chained = false;
  private overlayOn = false;
  private ovScale = 1;
  private css: { ink: string; bg: string; family: string } | null = null;

  constructor(
    host: HTMLElement,
    readonly payload: ModelPayload,
    private opts: ViewerOpts = {},
  ) {
    this.root = host;
    host.classList.add("m3");
    host.dataset.ready = "0";
    host.dataset.parts = String(payload.parts.length);
    host.dataset.apart = "0";
    host.dataset.sizes = "0";
    host.innerHTML = `<div class="m3-stage"><div class="m3-bar"><button class="m3-btn" type="button" data-act="apart" aria-pressed="false">${ICON_APART}<span>Pull apart</span></button><button class="m3-btn" type="button" data-act="sizes" aria-pressed="false">${ICON_SIZES}<span>Sizes</span></button></div></div><div class="m3-foot"></div>`;
    this.stage = host.querySelector(".m3-stage") as HTMLElement;
    const foot = host.querySelector(".m3-foot") as HTMLElement;
    if (payload.note) {
      const n = document.createElement("p");
      n.className = "m3-note";
      n.textContent = payload.note;
      foot.appendChild(n);
    }
    const fixed = document.createElement("p");
    fixed.className = "m3-fixed";
    fixed.textContent = MODEL_FOOT;
    foot.appendChild(fixed);
    this.btnApart = host.querySelector('[data-act="apart"]') as HTMLButtonElement;
    this.btnSizes = host.querySelector('[data-act="sizes"]') as HTMLButtonElement;
    this.btnApart.onclick = () => this.setApart(!this.apartOn);
    this.btnSizes.onclick = () => this.setSizes(!this.sizesOn);

    // Throws when this screen can't do WebGL; the stub shows a plain line instead.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    const full = Math.min(2, devicePixelRatio || 1);
    this.sharp = [...new Set([full, 1.5, 1.25, 1].filter((r) => r <= full))];
    this.renderer.setPixelRatio(full);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // The light and the model stay put while the camera turns: the shadow is drawn again only when parts move.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setClearColor(0x000000, 0);
    const canvas = this.renderer.domElement;
    canvas.className = "m3-gl";
    this.stage.prepend(canvas);
    this.overlay = document.createElement("canvas");
    this.overlay.className = "m3-dims";
    this.overlay.style.visibility = "hidden";
    canvas.after(this.overlay);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.env = pmrem.fromScene(room, 0.04).texture;
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (m.geometry.dispose(), (m.material as THREE.Material).dispose());
    });
    pmrem.dispose();
    this.scene.environment = this.env;
    this.scene.environmentIntensity = 0.75;
    this.tex = new TextureCache(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));

    // The model: one group per part (its mesh and its edge lines), so pulling apart moves both.
    this.built = buildModel(payload, { mesh: true });
    this.dims = payload.dims ?? [];
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a140e, transparent: true, opacity: 0.32 });
    this.disposables.push(edgeMat);
    this.built.parts.forEach((p, i) => {
      if (!p.mesh) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(p.mesh.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(p.mesh.normals, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(p.mesh.uvs, 2));
      for (const gr of p.mesh.groups) g.addGroup(gr.start, gr.count, gr.mat);
      g.computeBoundingSphere();
      const tint = 0.93 + 0.1 * (((i * 7919 + p.id.length * 31) % 17) / 16);
      const mats = materialsFor(p.material, tint, this.tex);
      const mesh = new THREE.Mesh(g, mats);
      mesh.name = p.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const group = new THREE.Group();
      group.name = p.name;
      group.add(mesh);
      if (p.edges?.length) {
        const eg = new THREE.BufferGeometry();
        eg.setAttribute("position", new THREE.BufferAttribute(p.edges, 3));
        const lines = new THREE.LineSegments(eg, edgeMat);
        lines.name = `${p.name} edges`;
        group.add(lines);
        this.disposables.push(eg);
      }
      this.disposables.push(g, ...new Set(mats));
      this.model.add(group);
      this.parts.push({ group, mesh, apart: V(p.apart), id: p.id, name: p.name });
    });
    this.scene.add(this.model);

    // Light: the room for soft fill and reflections, one key light for shape and a soft shadow on the floor.
    const all = this.built.bboxApart.min[0] <= this.built.bboxApart.max[0] ? this.unionBox() : new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const size = all.getSize(new THREE.Vector3());
    const centre = all.getCenter(new THREE.Vector3());
    const R = Math.max(size.x, size.y, size.z, 1);
    this.key = new THREE.DirectionalLight(0xfff8ee, 1.75);
    this.key.position.copy(centre).add(new THREE.Vector3(-0.5, -0.62, 1.9).multiplyScalar(R * 1.6));
    this.key.target.position.copy(centre);
    this.key.castShadow = true;
    const sm = opts.phone ? 1024 : 2048;
    this.key.shadow.mapSize.set(sm, sm);
    const sc = this.key.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -R * 1.1;
    sc.right = sc.top = R * 1.1;
    sc.near = R * 0.2;
    sc.far = R * 5;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = R * 0.0015;
    this.key.shadow.radius = 6;
    this.scene.add(this.key, this.key.target);
    this.renderer.shadowMap.needsUpdate = true; // drawn with the first frame
    const fill = new THREE.HemisphereLight(0xfff6ea, 0x8a8478, 0.25);
    fill.position.set(0, 0, 1);
    this.scene.add(fill);
    const floorGeo = new THREE.PlaneGeometry(R * 12, R * 12);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.17, color: 0x1b1611 });
    this.floor = new THREE.Mesh(floorGeo, floorMat);
    this.floor.position.set(centre.x, centre.y, all.min.z - R * 0.002);
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.disposables.push(floorGeo, floorMat);

    this.camera = new THREE.PerspectiveCamera(30, 1, R * 0.01, R * 40);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener("change", () => this.request());
    this.controls.addEventListener("start", () => {
      this.interacting = true;
      this.moved = true;
      this.camAnim = null;
      if (this.viewName !== "free") (this.viewName = "free"), (this.root.dataset.view = "free");
      this.request();
    });
    this.controls.addEventListener("end", () => {
      this.interacting = false;
      this.request();
      opts.onView?.();
    });
    canvas.addEventListener("pointerdown", (e) => this.tap(e));
    canvas.addEventListener("dblclick", () => this.reset());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.resize(true);
    if (opts.camera) this.setCameraState(opts.camera);
    else {
      this.place(this.fit("hero", false, this.aspect()), false);
      this.root.dataset.view = "hero";
    }
    this.draw();
    this.root.dataset.ready = "1";
    opts.onState?.();
  }

  /* ---------- size and fit ---------- */
  private aspect() {
    const r = this.stage.getBoundingClientRect();
    return r.width && r.height ? r.width / r.height : 1;
  }
  private resize(first = false) {
    if (this.dead) return;
    // its laid-out size, not its size on screen: a page still growing in as it opens would leave it slightly soft
    const w = Math.max(1, this.stage.clientWidth),
      h = Math.max(1, this.stage.clientHeight);
    this.renderer.setSize(w, h, false);
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.ovScale = this.overlay.width / w;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // until they've moved it themselves, a named view stays fitted to the screen as it settles or turns
    if (!first && !this.moved && !this.camAnim && this.viewName !== "turned") this.place(this.fit(this.viewName === "kept" || this.viewName === "free" ? this.camera.position.clone().sub(this.controls.target) : (this.viewName as ModelSide | "hero"), this.apartOn, w / h), false);
    if (!first) this.request();
  }
  private moved = false;
  private refitIfOut() {
    if (!this.inView(this.apartT)) this.place(this.fit(this.camera.position.clone().sub(this.controls.target), this.apartOn, this.aspect()), true);
  }
  /** The box the parts take up at a given amount pulled apart (0 together, 1 apart), and the sizes too while they show. */
  private boxAt(t: number, sizes = this.sizesOn) {
    const b = new THREE.Box3();
    this.built.parts.forEach((p, i) => {
      if (!p.mesh) return;
      const d = this.parts[i]?.apart ?? V(p.apart);
      b.expandByPoint(V(p.bbox.min).addScaledVector(d, t));
      b.expandByPoint(V(p.bbox.max).addScaledVector(d, t));
    });
    if (sizes)
      for (const dm of this.dims) {
        if (dm.show && (dm.show === "apart") !== t > 0.5) continue;
        const d = (dm.part && this.parts.find((p) => p.id === dm.part)?.apart) || new THREE.Vector3();
        b.expandByPoint(V(dm.a).addScaledVector(d, t));
        b.expandByPoint(V(dm.b).addScaledVector(d, t));
      }
    return b;
  }
  private unionBox() {
    return this.boxAt(0, false).union(this.boxAt(1, false));
  }
  /** A camera place looking at the model from a direction, as close as it can be with everything in view and a margin. */
  private fit(dir: "hero" | ModelSide | THREE.Vector3, apart: boolean, aspect: number, margin = 0.84) {
    const box = this.boxAt(apart ? 1 : 0);
    const target = box.getCenter(new THREE.Vector3());
    const d = dir instanceof THREE.Vector3 ? dir.clone().normalize() : V(DIRS[dir]).normalize();
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const cam = this.camera.clone();
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    const fits = (dist: number) => {
      cam.position.copy(target).addScaledVector(d, dist);
      cam.up.set(0, 0, 1);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      return corners.every((c) => {
        const p = c.clone().project(cam);
        return p.z < 1 && Math.abs(p.x) <= margin && Math.abs(p.y) <= margin;
      });
    };
    const R = box.getSize(new THREE.Vector3()).length() || 1;
    let lo = R * 0.05,
      hi = R * 12;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return { pos: target.clone().addScaledVector(d, hi), target, dist: hi };
  }
  private place(f: { pos: THREE.Vector3; target: THREE.Vector3; dist?: number }, glide: boolean) {
    if (f.dist) {
      this.fitDist = f.dist;
      this.controls.minDistance = f.dist * 0.12;
      this.controls.maxDistance = f.dist * 4;
    }
    if (!glide || reduce()) {
      this.camAnim = null;
      this.camera.position.copy(f.pos);
      this.controls.target.copy(f.target);
      this.camera.lookAt(f.target);
      this.controls.update();
      this.request();
      return;
    }
    this.camAnim = { p0: this.camera.position.clone(), p1: f.pos.clone(), t0: this.controls.target.clone(), t1: f.target.clone(), start: performance.now(), dur: 520 };
    this.request();
  }
  /** Whether the model, at a given amount apart, is wholly in view from where the camera is now. */
  private inView(t: number) {
    const box = this.boxAt(t);
    this.camera.updateMatrixWorld(true);
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(this.camera);
      if (p.z >= 1 || Math.abs(p.x) > 0.88 || Math.abs(p.y) > 0.88) return false;
    }
    return true;
  }

  /* ---------- the two controls and the view commands ---------- */
  setApart(on: boolean, animate = true) {
    if (on === this.apartOn && !this.apartAnim) return;
    this.apartOn = on;
    this.root.dataset.apart = on ? "1" : "0";
    this.btnApart.setAttribute("aria-pressed", String(on));
    this.btnApart.querySelector("span")!.textContent = on ? "Put together" : "Pull apart";
    if (!animate || reduce()) {
      this.apartAnim = null;
      this.apartT = on ? 1 : 0;
      this.applyApart();
    } else this.apartAnim = { from: this.apartT, to: on ? 1 : 0, start: performance.now() };
    // pulled apart it takes more room: move back so it all stays in view
    if (on && !this.inView(1)) this.place(this.fit(this.camera.position.clone().sub(this.controls.target), true, this.aspect()), animate);
    this.request();
    this.opts.onState?.();
  }
  setSizes(on: boolean) {
    this.sizesOn = on;
    // the sizes sit outside the parts: move back if they'd run off the screen
    if (on && !this.apartAnim) this.refitIfOut();
    this.root.dataset.sizes = on ? "1" : "0";
    this.btnSizes.setAttribute("aria-pressed", String(on));
    this.request();
    this.opts.onState?.();
  }
  look(side: ModelSide | "hero") {
    this.moved = false;
    this.viewName = side;
    this.root.dataset.view = side;
    this.place(this.fit(side, this.apartOn, this.aspect()), true);
  }
  turn() {
    const off = this.camera.position.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    this.viewName = "turned";
    this.root.dataset.view = "turned";
    this.place({ pos: this.controls.target.clone().add(off), target: this.controls.target.clone() }, true);
  }
  reset() {
    this.look("hero");
  }
  command(op: ModelOp, side?: ModelSide) {
    if (op === "apart") this.setApart(true);
    else if (op === "together") this.setApart(false);
    else if (op === "sizes") this.setSizes(true);
    else if (op === "no_sizes") this.setSizes(false);
    else if (op === "look" && side) this.look(side);
    else if (op === "turn") this.turn();
    else if (op === "reset") this.reset();
  }

  /* ---------- the same names as the sheet viewer, so the apps treat it alike ---------- */
  get zoomPct() {
    return Math.round((this.fitDist / Math.max(1e-6, this.camera.position.distanceTo(this.controls.target))) * 100);
  }
  get cx() {
    return this.controls.target.x;
  }
  get cy() {
    return this.controls.target.y;
  }
  getView(): ViewState {
    return { s: this.zoomPct / 100, cx: this.cx, cy: this.cy };
  }
  setView(v: ViewState) {
    if (v.s > 0) this.zoomTo(this.fitDist / v.s);
  }
  private zoomTo(dist: number) {
    const off = this.camera.position.clone().sub(this.controls.target).setLength(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, dist)));
    this.place({ pos: this.controls.target.clone().add(off), target: this.controls.target.clone() }, true);
  }
  zoomBy(f: number) {
    this.zoomTo(this.camera.position.distanceTo(this.controls.target) / f);
  }
  zoomIn() {
    this.zoomBy(1.6);
  }
  zoomOut() {
    this.place(this.fit(this.camera.position.clone().sub(this.controls.target), this.apartOn, this.aspect()), true);
  }
  cameraState(): CamState {
    const p = this.camera.position,
      t = this.controls.target;
    return { pos: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }
  setCameraState(s: CamState) {
    const fit = this.fit("hero", false, this.aspect());
    this.fitDist = fit.dist;
    this.controls.minDistance = fit.dist * 0.12;
    this.controls.maxDistance = fit.dist * 4;
    this.viewName = "kept";
    this.root.dataset.view = "kept";
    this.place({ pos: V(s.pos), target: V(s.target) }, false);
  }

  /* ---------- drawing, only when something changes, at most once a frame ---------- */
  private request() {
    if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this.frame);
  }
  private frame = (t: number) => {
    this.raf = 0;
    if (this.dead) return;
    const chained = this.chained;
    this.chained = false;
    const now = performance.now();
    let busy = false;
    if (this.apartAnim) {
      const k = Math.min(1, (now - this.apartAnim.start) / 500);
      this.apartT = this.apartAnim.from + (this.apartAnim.to - this.apartAnim.from) * ease(k);
      this.applyApart();
      if (k >= 1) {
        this.apartAnim = null;
        if (this.sizesOn && !this.camAnim) this.refitIfOut(); // the sizes may sit further out once it's apart
      } else busy = true;
    }
    if (this.camAnim) {
      const a = this.camAnim;
      const k = Math.min(1, (now - a.start) / a.dur);
      const e = ease(k);
      this.camera.position.lerpVectors(a.p0, a.p1, e);
      this.controls.target.lerpVectors(a.t0, a.t1, e);
      if (k >= 1) this.camAnim = null;
      else busy = true;
    }
    // (a change the controls report asks for the next frame itself, so this never asks twice)
    if (this.controls.update()) busy = true;
    if (busy) {
      // moving: draw at the moving sharpness, and ask for the next frame
      this.moving(t, chained);
      this.draw();
      this.chained = true;
      this.request();
      return;
    }
    if (this.interacting) return void this.draw(); // a finger on it, held still: as it is, nothing more until it moves
    // at rest: one frame at full sharpness with everything on; where it's looked at from, for the tests
    this.still();
    this.draw();
    const c = this.camera.position.clone().sub(this.controls.target).normalize();
    this.root.dataset.cam = `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}`;
    this.opts.onView?.();
  };
  /** One more frame of a movement: time it (only frames that follow straight on from the last), and soften if slow. */
  private moving(t: number, chained: boolean) {
    const m = this.motion;
    if (!m) {
      this.motion = { n: 0, sum: 0, worst: 0, last: t, recent: [] };
      this.quality(true);
      return;
    }
    const dt = t - m.last;
    m.last = t;
    if (!chained) return; // after a pause (a finger held still), not a frame time
    m.n++;
    m.sum += dt;
    m.worst = Math.max(m.worst, dt);
    m.recent.push(dt);
    if (m.recent.length > RECENT) m.recent.shift();
    if (m.recent.length < RECENT || m.recent.reduce((a, b) => a + b, 0) / RECENT <= SLOW_MS) return;
    if (this.level < this.sharp.length - 1) this.level++;
    else if (!this.plainMoving) this.plainMoving = true;
    else return;
    m.recent.length = 0; // judge the new level on its own frames
    this.quality(true);
  }
  /** The movement is over: its frame times for the meter, and everything back to full. */
  private still() {
    const m = this.motion;
    this.css = null; // the colours are read again at rest (the day's colour, light or dark)
    if (!m) return;
    this.motion = null;
    if (m.n) {
      this.root.dataset.ms = `${(m.sum / m.n).toFixed(1)},${m.worst.toFixed(1)}`;
      this.root.dataset.sharp = `${this.sharp[this.level]}${this.plainMoving ? ",no-shadow" : ""}`;
    }
    this.quality(false);
  }
  /** Sharpness and shadow for moving (the level it has settled on) or at rest (full). */
  private quality(moving: boolean) {
    const pr = moving ? this.sharp[this.level] : this.sharp[0];
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);
    // the shadow left out without changing any shader: the floor that catches it hidden, the parts not looking it up
    const plain = moving && this.plainMoving;
    if (this.floor.visible === plain) {
      this.floor.visible = !plain;
      for (const p of this.parts) p.mesh.receiveShadow = !plain;
    }
  }
  private applyApart() {
    for (const p of this.parts) p.group.position.copy(p.apart).multiplyScalar(this.apartT);
    this.renderer.shadowMap.needsUpdate = true;
  }
  private draw() {
    this.renderer.render(this.scene, this.camera);
    // the sizes: drawn each frame only while they're on; cleared and hidden once when they go off
    if (!this.sizesOn && !this.overlayOn) return;
    const ctx = this.overlay.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.overlayOn !== this.sizesOn) {
      this.overlayOn = this.sizesOn;
      this.overlay.style.visibility = this.sizesOn ? "visible" : "hidden";
    }
    if (this.sizesOn) {
      const k = this.ovScale;
      ctx.scale(k, k);
      this.drawDims(ctx, this.overlay.width / k, this.overlay.height / k, 1, this.camera, this.styles());
    }
  }
  /** The colours and font for the sizes, read once and kept while it moves. */
  private styles() {
    if (!this.css) {
      const css = getComputedStyle(this.root);
      this.css = {
        ink: css.getPropertyValue("--accent-ink").trim() || "#B64C14",
        bg: css.getPropertyValue("--bg").trim() || "#F3F4F2",
        family: css.getPropertyValue("--f-ui").trim() || "system-ui",
      };
    }
    return this.css;
  }
  private tap(e: PointerEvent) {
    if (e.pointerType !== "touch") return;
    const now = performance.now();
    if (now - this.lastTap < 300) {
      this.lastTap = 0;
      this.reset();
    } else this.lastTap = now;
  }

  /* ---------- the sizes: a thin line with ticks and a label that faces you, kept clear of each other ---------- */
  private dimsVisible() {
    const apart = this.apartT > 0.5;
    return this.dims.filter((d) => !d.show || (d.show === "apart" ? apart : !apart));
  }
  private drawDims(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number, cam: THREE.PerspectiveCamera, st: { ink: string; bg: string; family: string }) {
    const { ink, bg } = st;
    const font = `600 ${12.5 * scale}px ${st.family}`;
    cam.updateMatrixWorld(true);
    const toScreen = (p: THREE.Vector3) => {
      const q = p.clone().project(cam);
      return q.z < 1 ? { x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h } : null;
    };
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const hits = (r: (typeof placed)[number]) => placed.some((p) => r.x0 < p.x1 && p.x0 < r.x1 && r.y0 < p.y1 && p.y0 < r.y1);
    ctx.font = font;
    ctx.lineCap = "round";
    const lines: { a: { x: number; y: number }; b: { x: number; y: number }; text: string; nx: number; ny: number }[] = [];
    for (const d of this.dimsVisible()) {
      const off = new THREE.Vector3();
      if (d.part) {
        const p = this.parts.find((x) => x.id === d.part);
        if (p) off.copy(p.apart).multiplyScalar(this.apartT);
      }
      const A = V(d.a).add(off),
        B = V(d.b).add(off);
      const a = toScreen(A),
        b = toScreen(B);
      if (!a || !b) continue;
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 6 * scale) continue; // seen end-on: nothing to show
      const text = d.text ?? String(Math.round(A.distanceTo(B)));
      lines.push({ a, b, text, nx: -(b.y - a.y) / L, ny: (b.x - a.x) / L });
    }
    // lines and ticks first, then labels on top, longest first so the overall sizes win a tight spot
    ctx.strokeStyle = ink;
    for (const l of lines) {
      ctx.lineWidth = 1.25 * scale;
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
      ctx.lineWidth = 1.6 * scale;
      const t = 5 * scale;
      for (const p of [l.a, l.b]) {
        ctx.beginPath();
        ctx.moveTo(p.x - l.nx * t, p.y - l.ny * t);
        ctx.lineTo(p.x + l.nx * t, p.y + l.ny * t);
        ctx.stroke();
      }
    }
    lines.sort((p, q) => Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) - Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y));
    for (const l of lines) {
      const tw = ctx.measureText(l.text).width + 10 * scale,
        th = 18 * scale;
      const mx = (l.a.x + l.b.x) / 2,
        my = (l.a.y + l.b.y) / 2;
      let spot: (typeof placed)[number] | null = null;
      for (const k of [0, 1, -1, 2, -2, 3, -3]) {
        for (const s of [0, 0.3, -0.3]) {
          const cx = mx + l.nx * k * (th * 0.9) + (l.b.x - l.a.x) * s * 0.5,
            cy = my + l.ny * k * (th * 0.9) + (l.b.y - l.a.y) * s * 0.5;
          const r = { x0: cx - tw / 2, y0: cy - th / 2, x1: cx + tw / 2, y1: cy + th / 2 };
          if (r.x0 < 2 || r.y0 < 2 || r.x1 > w - 2 || r.y1 > h - 2) continue;
          if (!hits(r)) {
            spot = r;
            break;
          }
        }
        if (spot) break;
      }
      if (!spot) continue; // nowhere clear: the line shows, the label waits for a closer look
      placed.push(spot);
      ctx.fillStyle = bg;
      ctx.globalAlpha = 0.9;
      const rr = th / 2;
      ctx.beginPath();
      ctx.roundRect(spot.x0, spot.y0, spot.x1 - spot.x0, th, rr);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(l.text, (spot.x0 + spot.x1) / 2, (spot.y0 + spot.y1) / 2 + 0.5 * scale);
    }
  }

  /* ---------- pictures and files ---------- */
  /** The background the app shows, painted onto a picture's canvas (pictures aren't see-through). */
  private paintBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const css = getComputedStyle(this.root);
    const top = css.getPropertyValue("--raised").trim() || "#ffffff",
      bot = css.getPropertyValue("--bg").trim() || "#f3f4f2";
    const g = ctx.createRadialGradient(w / 2, h * 0.38, 0, w / 2, h * 0.38, Math.max(w, h) * 0.85);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
  /** Draw one picture at w × h: a named shot (hero, apart, top...), or the view as it is now. */
  private shoot(w: number, h: number, shot: ModelShot | null, sizes: boolean): HTMLCanvasElement {
    const moving = !!this.motion; // a picture always has everything on, even if it's asked for mid-turn
    if (moving) this.quality(false);
    const saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), t: this.apartT, aspect: this.camera.aspect, pr: this.renderer.getPixelRatio(), size: this.renderer.getSize(new THREE.Vector2()) };
    const cam = this.camera;
    if (shot) {
      this.apartT = shot === "apart" ? 1 : 0;
      this.applyApart();
      const f = this.fit(shot === "apart" || shot === "hero" ? "hero" : shot, shot === "apart", w / h, 0.86);
      cam.position.copy(f.pos);
      cam.up.set(0, 0, 1);
      cam.lookAt(f.target);
    }
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.renderer.render(this.scene, cam);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d")!;
    this.paintBackground(ctx, w, h);
    ctx.drawImage(this.renderer.domElement, 0, 0, w, h);
    const sizesWas = this.sizesOn;
    this.css = null;
    if (sizes && this.dims.length) this.drawDims(ctx, w, h, Math.max(1, Math.min(w, h) / 560), cam, this.styles());
    this.sizesOn = sizesWas;
    // put everything back as it was on screen
    this.renderer.setPixelRatio(saved.pr);
    this.renderer.setSize(saved.size.x, saved.size.y, false);
    cam.aspect = saved.aspect;
    cam.updateProjectionMatrix();
    cam.position.copy(saved.pos);
    this.controls.target.copy(saved.target);
    cam.lookAt(saved.target);
    this.apartT = saved.t;
    this.applyApart();
    if (moving) this.quality(true);
    this.draw();
    return out;
  }
  private blob(c: HTMLCanvasElement, type = "image/png") {
    return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), type));
  }
  /** Pictures for the assistant, 1024 px square, sizes shown when the model has them. */
  async pictures(views: ModelShot[]): Promise<Blob[]> {
    const out: Blob[] = [];
    for (const v of views) out.push(await this.blob(this.shoot(1024, 1024, v, true)));
    return out;
  }
  /** The view on screen as a picture to keep: twice the screen's size, at most 2048 on its long side. */
  async picture(): Promise<Blob> {
    const r = this.stage.getBoundingClientRect();
    const k = Math.min(2048 / Math.max(r.width, r.height, 1), 2);
    return this.blob(this.shoot(Math.round(r.width * k), Math.round(r.height * k), null, this.sizesOn));
  }
  /** The model put together, its meshes only, for a 3D file. glb: metres and y up, as glTF wants; stl: millimetres, z up. */
  private exportRoot(gltf: boolean) {
    const root = new THREE.Group();
    root.name = this.opts.title ?? "Model";
    const holder = new THREE.Group();
    if (gltf) {
      holder.rotation.x = -Math.PI / 2;
      holder.scale.setScalar(0.001);
    }
    root.add(holder);
    for (const p of this.parts) {
      const mesh = p.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
      if (!mesh) continue;
      const m = new THREE.Mesh(mesh.geometry, mesh.material);
      m.name = p.name;
      holder.add(m);
    }
    root.updateMatrixWorld(true);
    return root;
  }
  async glb(): Promise<Blob> {
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    const out = (await new GLTFExporter().parseAsync(this.exportRoot(true), { binary: true })) as ArrayBuffer;
    return new Blob([out], { type: "model/gltf-binary" });
  }
  async stl(): Promise<Blob> {
    const { STLExporter } = await import("three/addons/exporters/STLExporter.js");
    const dv = new STLExporter().parse(this.exportRoot(false), { binary: true }) as DataView;
    return new Blob([new Uint8Array(dv.buffer as ArrayBuffer, dv.byteOffset, dv.byteLength)], { type: "model/stl" });
  }

  /** A request from the gateway for this model: pictures for the assistant, or a file to keep. */
  async handle(cmd: SurfaceCommand, itemId: string) {
    if (cmd.cmd === "model") return this.command(cmd.op, cmd.side);
    if (cmd.cmd === "model_pictures") {
      const pics = await this.pictures(cmd.views);
      await Promise.all(
        pics.map((b, n) => fetch(`/api/v2/model/${encodeURIComponent(itemId)}/pictures?req=${encodeURIComponent(cmd.req)}&n=${n}&view=${cmd.views[n]}`, { method: "POST", headers: { "Content-Type": "image/png" }, body: b })),
      );
      return;
    }
    if (cmd.cmd === "model_save") {
      const blob = cmd.as === "glb" ? await this.glb() : cmd.as === "stl" ? await this.stl() : await this.picture();
      const format = cmd.as === "picture" ? "png" : cmd.as;
      const r = await fetch(`/api/v2/upload?as=model&item=${encodeURIComponent(itemId)}&format=${format}&req=${encodeURIComponent(cmd.req)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob }).catch(() => null);
      const saved = r?.ok ? ((await r.json()) as { name: string }) : null;
      if (saved) this.offer(blob, saved.name);
    }
  }
  /** After saving: a copy for the owner too. The phone's share sheet (it needs a tap), or the PC's own Save as. */
  private offer(blob: Blob, name: string) {
    this.root.querySelector(".m3-offer")?.remove();
    const b = document.createElement("button");
    b.type = "button";
    b.className = "m3-offer";
    const file = new File([blob], name, { type: blob.type });
    const canShare = !!navigator.canShare?.({ files: [file] });
    b.textContent = canShare ? `Saved. Tap to share ${name}` : `Saved. Save a copy of ${name}`;
    b.onclick = async () => {
      b.remove();
      if (canShare) await navigator.share({ files: [file] }).catch(() => undefined);
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      }
    };
    this.stage.appendChild(b);
    setTimeout(() => b.remove(), 12_000);
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const d of this.disposables) d.dispose();
    this.tex.dispose();
    this.env.dispose();
    this.key.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.overlay.remove();
    this.root.dataset.ready = "0";
  }
}
