/** Where a finger has been on the screen over the last moment, for how fast it was going when it let go (px/ms). Taken
 *  over the last 80 ms or so, not the last step alone: on a phone the last step is often a short one as the finger lifts,
 *  which made a quick flick look slow and the page didn't turn (12.0). */
export class Trail {
  private pts: { t: number; x: number; y: number }[] = [];
  start(x: number, y: number) {
    this.pts = [{ t: performance.now(), x, y }];
  }
  add(x: number, y: number) {
    const t = performance.now();
    this.pts.push({ t, x, y });
    while (this.pts.length > 2 && t - this.pts[0].t > 120) this.pts.shift();
  }
  /** The finger's speed; 0 once it has been still for a moment (it stopped, then lifted). */
  velocity(): { x: number; y: number } {
    const last = this.pts.at(-1);
    if (!last || performance.now() - last.t > 90) return { x: 0, y: 0 };
    let first = this.pts.find((p) => last.t - p.t <= 80) ?? last;
    if (first === last && this.pts.length > 1) first = this.pts[this.pts.length - 2];
    const dt = last.t - first.t;
    return dt < 4 ? { x: 0, y: 0 } : { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}
