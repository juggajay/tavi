let name = "Tavi";
export const appName = () => name;

export function setTeamName(on: boolean) {
  name = "Tavi";
  document.title = name;
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute("content", name);
  document.querySelector('link[rel="manifest"]')?.setAttribute("href", on ? "/app/manifest.v2.webmanifest" : "/app/manifest.legacy.webmanifest");
  document.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-startup-image"]').forEach(link => {
    link.href = link.href.replace(/splash-(?:legacy-)?(\d+)\.png$/, `splash-${on ? "" : "legacy-"}$1.png`);
  });
}

export async function findAppName() {
  try {
    const response = await fetch("/api/hq/state", { signal: AbortSignal.timeout(4000) });
    const state = response.ok ? await response.json() : null;
    setTeamName(state?.on === true);
  } catch { setTeamName(false); }
}
