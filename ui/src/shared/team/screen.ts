// A computer on the phone is always watch-only. Zoom and pan stay on this device.
export async function watch(host: HTMLElement, bot: string, picture: string | undefined, status: (text: string) => void) {
  const content = document.createElement("div"); content.className = "team-screen-content"; host.append(content);
  let disposed = false, rfb: import("@novnc/novnc").default | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
  const points = new Map<number, { x: number; y: number }>();
  let scale = 1, x = 0, y = 0, lastX = 0, lastY = 0, lastDistance = 0;
  const geometry = () => {
    const values = [...points.values()];
    return { x: values.reduce((n,p) => n+p.x, 0)/values.length, y: values.reduce((n,p) => n+p.y, 0)/values.length, distance: values.length > 1 ? Math.hypot(values[0].x-values[1].x, values[0].y-values[1].y) : 0 };
  };
  const reset = () => { if (!points.size) return; const g = geometry(); lastX = g.x; lastY = g.y; lastDistance = g.distance; };
  host.onpointerdown = e => { points.set(e.pointerId, { x: e.clientX, y: e.clientY }); host.setPointerCapture(e.pointerId); reset(); };
  host.onpointermove = e => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = geometry(), oldScale = scale, rect = host.getBoundingClientRect();
    if (g.distance && lastDistance) scale = Math.max(1, Math.min(5, scale * g.distance / lastDistance));
    const factor = scale / oldScale;
    x = g.x - rect.left - (lastX - rect.left - x) * factor;
    y = g.y - rect.top - (lastY - rect.top - y) * factor;
    x = Math.max(rect.width * (1 - scale), Math.min(0, x)); y = Math.max(rect.height * (1 - scale), Math.min(0, y));
    content.style.transform = `translate(${x}px,${y}px) scale(${scale})`; host.dataset.zoom = scale.toFixed(2); reset();
  };
  host.onpointerup = host.onpointercancel = e => { points.delete(e.pointerId); reset(); };
  const resize = () => { scale = 1; x = y = 0; content.style.transform = ""; host.dataset.zoom = "1"; };
  addEventListener("resize", resize);
  if (picture) { const image = document.createElement("img"); image.src = picture; image.alt = "Preview of the bot's computer"; content.append(image); status("Preview · Watch only"); }
  else {
    const again = () => { if (!disposed) timer = setTimeout(() => void connect(), Math.min(10000, 500 * 2 ** failures++)); };
    const connect = async () => {
      try {
      const response = await fetch(`/api/hq/bots/${encodeURIComponent(bot)}/computer`, { credentials: "same-origin" });
      if (disposed) return;
      if (!response.ok) { status("The screen isn't available just now."); again(); return; }
      const computer = await response.json(); if (disposed) return;
      if (!computer.has) { status("This bot has no computer."); return; }
      if (computer.state !== "ready") { status(computer.why || "Setting up its screen…"); again(); return; }
      const { default: RFB } = await import("@novnc/novnc"); if (disposed) return;
      content.replaceChildren();
      const options = { shared: true, wsProtocols: ["binary"] };
      rfb = new RFB(content, `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/hq/bots/${encodeURIComponent(bot)}/screen?mode=watch`, options);
      rfb.viewOnly = true; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = false;
      rfb.addEventListener("connect", () => { if (!disposed) { failures = 0; status("Live · Watch only"); } });
      rfb.addEventListener("disconnect", () => { if (!disposed) { status("Connecting to the screen again…"); again(); } });
      rfb.addEventListener("securityfailure", () => status("The computer refused this screen connection."));
      } catch { if (!disposed) { status("The screen isn't available just now. Trying again…"); again(); } }
    };
    void connect();
  }
  return () => { disposed = true; clearTimeout(timer); rfb?.disconnect(); removeEventListener("resize", resize); host.onpointerdown = host.onpointermove = host.onpointerup = host.onpointercancel = null; host.replaceChildren(); };
}
