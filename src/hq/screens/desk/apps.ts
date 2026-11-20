export type DeskApp = { id: string; name: string; command: string[]; icon: string };
export const BASIC_APPS: DeskApp[] = [
  { id: "browser", name: "Browser", command: ["/opt/lh/screen/open-browser.sh"], icon: "web-browser" },
  { id: "terminal", name: "Terminal", command: ["/usr/bin/xterm"], icon: "utilities-terminal" },
];
export const APP_ICONS = ["web-browser", "utilities-terminal", "system-file-manager", "accessories-text-editor", "x-office-document", "x-office-spreadsheet", "x-office-presentation", "application-pdf", "image-x-generic"];
export function readApps(value: unknown): DeskApp[] {
  try {
    const items = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(items) || !items.length || items.length > 24) return BASIC_APPS;
    const ids = new Set<string>();
    for (const app of items) {
      if (!app || !/^[a-z][a-z0-9-]{0,31}$/.test(app.id) || ids.has(app.id) ||
        typeof app.name !== "string" || !app.name.trim() || app.name.length > 60 ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(app.icon) || !Array.isArray(app.command) || !app.command.length ||
        app.command.length > 8 || !app.command.every((arg: unknown) => typeof arg === "string" && arg.length <= 256 && !/[\x00-\x1f]/.test(arg)) ||
        !/^\/usr\/bin\/[a-zA-Z0-9._+-]+$/.test(app.command[0]) && app.command[0] !== "/opt/lh/screen/open-browser.sh") return BASIC_APPS;
      ids.add(app.id);
    }
    return items;
  } catch { return BASIC_APPS; }
}

// Simple program signs, drawn here. Desktop launchers use the system's matching icons.
export function appIcon(icon: string): string {
  const paths: Record<string, string> = {
    "web-browser": '<circle cx="16" cy="16" r="11"/><path d="M5 16h22M16 5c8 7 8 15 0 22-8-7-8-15 0-22Z"/>',
    "utilities-terminal": '<rect x="4" y="6" width="24" height="20" rx="4"/><path d="m9 12 4 4-4 4m8 0h6"/>',
    "system-file-manager": '<path d="M4 10V7h9l3 4h12v15H4Zm0 3h24"/>',
    "accessories-text-editor": '<path d="M8 4h12l5 5v19H8ZM12 13h9m-9 5h9m-9 5h6"/>',
    "x-office-document": '<path d="M8 4h12l5 5v19H8ZM12 14h9m-9 5h9m-9 5h6"/>',
    "x-office-spreadsheet": '<rect x="5" y="5" width="22" height="22" rx="2"/><path d="M5 12h22M5 19h22M13 5v22m7-22v22"/>',
    "x-office-presentation": '<path d="M4 5h24v17H4Zm16 17v6m-6 0 6-4 6 4M9 16l5-5 4 3 5-5"/>',
    "application-pdf": '<path d="M8 4h12l5 5v19H8ZM12 21l5-10 4 10m-9-3h9"/>',
    "image-x-generic": '<rect x="4" y="5" width="24" height="22" rx="3"/><circle cx="11" cy="12" r="2"/><path d="m5 24 8-8 5 5 4-6 6 9"/>',
    link: '<path d="m13 10 3-3a7 7 0 0 1 10 10l-4 4M19 22l-3 3A7 7 0 0 1 6 15l4-4m1 10 10-10"/>',
  };
  return `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[icon] ?? paths["accessories-text-editor"]}</svg>`;
}
