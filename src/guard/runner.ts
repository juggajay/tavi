import { spawn as childSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { BOT_ID } from "../hq/contract.js";

export type Result = { code: number; out: string; err: string };
export type Handle = { pid: number; write(text: string): void; kill(): void; exited: Promise<number> };
export type Runner = {
  run(user: string, script: string, opts?: { stdin?: string; timeoutMs?: number; args?: string[] }): Promise<Result>;
  spawn(user: string, script: string, onLine: (line: string, stream: "out" | "err") => void, args?: string[]): Handle;
  terminate(): Promise<void>;
  spaceState(): Promise<"running" | "stopped" | "missing">;
  ownerUbuntuRunning?(): Promise<boolean>;
};

export class GuardError extends Error {
  constructor(public status: number, message: string, public lines?: string[]) { super(message); }
}
export function botUser(user: unknown): asserts user is string {
  if (typeof user !== "string" || !/^bot-[a-z0-9][a-z0-9-]{0,24}$/.test(user)) throw new GuardError(400, "Choose a bot name such as bot-pebble.");
}
export function profileId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !BOT_ID.test(id) || ["default", "root", "hermes"].includes(id)) throw new GuardError(400, "Choose a short bot name. That name may be reserved.");
}
export function linuxUser(user: string) {
  if (user !== "root" && user !== "lh-team") botUser(user);
}
// The safety switch only ever works on one Linux space: the bots' own. Its name is a setting so another PC can
// choose one, but it must be the first space's name or start with "tavi-", so a person's own Linux can never be named.
export const DISTRO_NAME = /^(?:lh-bots|tavi-[a-z0-9](?:[a-z0-9-]{0,32}[a-z0-9])?)$/;
export function distroName(name = process.env.LH_V3_DISTRO ?? "lh-bots") {
  if (typeof name !== "string" || !DISTRO_NAME.test(name)) throw new GuardError(400, "The bots' Linux space must be called lh-bots or a name starting with tavi-.");
  return name;
}

// Only these fixed scripts can be used by the guard. Values travel as separate arguments.
export const scripts = {
  fence: 'exec bash /opt/lh/fence.sh apply\n',
  screenBoot: 'exec bash /opt/lh/screen/boot.sh\n',
  screenProbe: 'exec bash /opt/lh/screen/probe.sh\n',
  screenPrepare: 'exec python3 /opt/lh/screen/prepare.py "$1"\n',
  screenKeyProbe: 'exec bash /opt/lh/screen/key-probe.sh "$1"\n',
  screen: 'exec bash /opt/lh/run-screen.sh "$1" "$2" "$3" "$4"\n',
  browser: 'exec bash /opt/lh/run-browser.sh "$1" "$2"\n',
  stopScreen: 'exec bash /opt/lh/screen/stop.sh "$1" screen\n',
  stopBrowser: 'exec bash /opt/lh/screen/stop.sh "$1" browser\n',
  // The space's boot script runs alongside the first command after a start, so wait for it to finish (found on the real space).
  boot: "set -eu\ntest -f /opt/lh/probe.sh\nfor attempt in {1..60}; do grep -q 'boot done' /var/log/lh-boot.log 2>/dev/null && break; sleep 0.5; done\ngrep -q 'boot done' /var/log/lh-boot.log\niptables -C OUTPUT -m owner --gid-owner lhbots -j LHBOTS\niptables -S LHBOTS | grep -q -- '-j REJECT'\n",
  makeTeam: "exec bash /opt/lh/make-team.sh\n",
  makeProfile: "exec bash /opt/lh/make-profile.sh \"$1\"\n",
  signOut: "set -eu\nexport HERMES_HOME=/srv/lh/team\ncd /srv/lh/team\ncase \"$1\" in openai-codex|anthropic) ;; *) exit 2;; esac\n# Ask the installed command which sign-out form it supports.\nhelp=$(/opt/hermes/.local/bin/hermes auth --help)\nif printf '%s' \"$help\" | grep -Eq '(^|[[:space:]])remove([[:space:]]|$)'; then\n  exec /opt/hermes/.local/bin/hermes auth remove \"$1\"\nfi\n# Try logout only if it offers a provider choice.\nhelp=$(/opt/hermes/.local/bin/hermes auth logout --help)\nprintf '%s' \"$help\" | grep -q -- '--provider'\nexec /opt/hermes/.local/bin/hermes auth logout --provider \"$1\"\n",
  make: 'exec bash /opt/lh/make-bot.sh "$1"\n',
  write: "set -eu\numask 077\ncd /srv/lh/team\ntest ! -L profiles\nif [ -n \"$1\" ]; then test ! -L \"profiles/$1\"; cd \"profiles/$1\"; fi\ntest ! -L \"$2\"\nrm -f -- \"$2\"\nexec sh -c 'cat > \"$1\"' sh \"$2\"\n",
  read: "set -eu\ncd /srv/lh/team\ntest ! -L profiles\nif [ -n \"$1\" ]; then test ! -L \"profiles/$1\"; cd \"profiles/$1\"; fi\ntest ! -L \"$2\"\nexec cat -- \"$2\"\n",
  gateway: "exec bash /opt/lh/run-gateway.sh\n",
  probe: "exec bash /opt/lh/probe.sh\n",
  freeze: 'exec bash /opt/lh/freeze.sh "$1"\n',
  route: 'exec bash /opt/lh/toolbox-route.sh "$1"\n',
  withdraw: "exec bash /opt/lh/withdraw.sh\n",
  stop: 'set -eu\npkill -KILL -u "$1" || test "$?" = 1\nfor attempt in {1..20}; do\n  pgrep -u "$1" >/dev/null || exit 0\n  sleep 0.1\ndone\nexit 1\n',
  stopAll: 'set -eu\nfailed=0\nwhile IFS=: read -r user _ uid _; do\n  case "$user" in lh-team|bot-*) if id -Gn "$user" | tr " " "\\n" | grep -qx lhbots; then\n    pkill -KILL -u "$uid" || { test "$?" = 1 || failed=1; }\n    for attempt in {1..20}; do pgrep -u "$uid" >/dev/null || break; sleep 0.1; done\n    pgrep -u "$uid" >/dev/null && failed=1\n  fi;; esac\ndone < /etc/passwd\nexit "$failed"\n',
  // Hermes holds its words back when it is not on a terminal, so the link and code never reached the screen (found on
  // the real space): PYTHONUNBUFFERED sends each line at once; NO_COLOR and TERM keep colour codes out of the text.
  signIn: "set -eu\nexport HERMES_HOME=/srv/lh/team HERMES_GATEWAY_LOCK_DIR=/srv/lh/team/locks PYTHONUNBUFFERED=1 NO_COLOR=1 TERM=dumb\ncd /srv/lh/team\ncase \"$1\" in\nopenai-codex) exec /opt/hermes/.local/bin/hermes auth add openai-codex --no-browser;;\nanthropic) exec /opt/hermes/.local/bin/hermes auth add anthropic --type oauth --no-browser;;\n*) exit 2;;\nesac\n",
  evidence: 'set -euo pipefail\nhome=$(getent passwd "$1" | cut -d: -f6)\nif [ "$1" = lh-team ]; then cd /srv/lh/team; else cd "$home/hermes"; fi\n# Keep either folder if the other is missing. Do not follow a folder link.\nset --\nfor folder in logs sessions profiles/*/logs profiles/*/sessions; do\n  if [ -d "$folder" ] && [ ! -L "$folder" ]; then set -- "$@" "$folder"; else echo "A folder was missing." >&2; fi\ndone\n[ "$#" -gt 0 ]\n# The archive is sent as text; it never includes sign-ins or settings.\ntar --ignore-case --exclude=auth.json --exclude=.env --exclude="*token*" --exclude="*oauth*" -czf - -- "$@" | base64 -w0\n',
  users: 'getent passwd | cut -d: -f1 | grep -E "^lh-team$|^bot-[a-z0-9][a-z0-9-]{0,30}$"\n',
} as const;

export function createRunner(): Runner {
  const distro = distroName();
  const env = { ...process.env, WSL_UTF8: "1" };
  function runWindows(args: string[], input: string, timeoutMs = 30_000): Promise<Result> {
    return new Promise((resolve) => {
      const child = childSpawn("wsl.exe", args, { env, windowsHide: true, stdio: "pipe" });
      let out = "", err = "", done = false;
      const finish = (code: number) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); };
      const timer = setTimeout(() => { child.kill(); finish(124); }, timeoutMs);
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { out += chunk; if (out.length > 48 * 1024 * 1024) { child.kill(); finish(125); } });
      child.stderr.on("data", (chunk: string) => { if (err.length < 64 * 1024) err += chunk; });
      child.on("error", () => finish(127));
      child.on("close", (code) => finish(code ?? 1));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
  async function listing() {
    const result = await runWindows(["-l", "-v"], "");
    if (result.code) throw new GuardError(503, "Could not check the Linux spaces.");
    return result.out.replace(/\0/g, "");
  }
  return {
    run(user, script, opts) {
      linuxUser(user);
      return runWindows(["-d", distro, "-u", user, "--", "bash", "-s", "--", ...(opts?.args ?? [])], script + (opts?.stdin ?? ""), opts?.timeoutMs);
    },
    spawn(user, script, onLine, args = []) {
      linuxUser(user);
      const child = childSpawn("wsl.exe", ["-d", distro, "-u", user, "--", "bash", "-s", "--", ...args], { env, windowsHide: true, stdio: "pipe" });
      for (const [stream, pipe] of [["out", child.stdout], ["err", child.stderr]] as const) {
        let pending = "", dropping = false;
        pipe.setEncoding("utf8");
        pipe.on("data", (part: string) => {
          if (dropping) {
            const end = part.indexOf("\n");
            if (end < 0) return;
            dropping = false; part = part.slice(end + 1);
          }
          pending += part;
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) { onLine(end > 16384 ? "[long line hidden]" : pending.slice(0, end).replace(/\r$/, ""), stream); pending = pending.slice(end + 1); }
          // Do not split a secret over two log lines when a process never sends a newline.
          if (pending.length > 16384) { onLine("[long line hidden]", stream); pending = ""; dropping = true; }
        });
        pipe.on("end", () => { if (pending) onLine(pending, stream); });
      }
      child.stdin.on("error", () => {});
      child.stdin.write(script);
      const exited = new Promise<number>((resolve) => { child.once("error", () => resolve(127)); child.once("close", (code) => resolve(code ?? 1)); });
      return { pid: child.pid ?? 0, write: (text) => { child.stdin.write(text); }, kill: () => { child.stdin.destroy(); child.kill(); }, exited };
    },
    async terminate() { const r = await runWindows(["--terminate", distro], ""); if (r.code) throw new GuardError(503, "Could not shut down the Linux space."); },
    async spaceState() {
      const line = (await listing()).split(/\r?\n/).find((line) => line.replace(/^\s*\*?\s*/, "").split(/\s+/)[0]?.toLowerCase() === distro);
      return !line ? "missing" : /\bRunning\b/i.test(line) ? "running" : "stopped";
    },
    async ownerUbuntuRunning() { return (await listing()).split(/\r?\n/).some((line) => /^\s*\*?\s*Ubuntu\s+Running\b/i.test(line)); },
  };
}

export type Session = { id: string; user: string; provider: string; handle: Handle; lines: string[]; ended: boolean; events: EventEmitter; cancel: () => void };
