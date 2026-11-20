import icon from "./icon-small.svg";
// The browser tab uses the compact drawing, including pages without a manifest.
if (typeof document !== "undefined") {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement("link");
  link.rel = "icon"; link.type = "image/svg+xml"; link.href = icon;
  if (!link.isConnected) document.head.append(link);
}
