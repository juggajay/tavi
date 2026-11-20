import { savedFolder } from "../shared/savedFolder.js";
// Connectors from the user's own Claude account (claude.ai → Settings → Connectors): Gmail, Google Calendar, Google Drive,
// and whatever else they've added there. No Google Cloud project: the user signs in on claude.ai once, and the Claude login
// this app already runs on carries it.
// The user decides per connector in Setup: Read (look things up) and Write (make changes). Write never means "on its own":
// every change goes through the broker. The brain asks with request_action, the user taps Approve on the phone, and
// runConnectorCall makes exactly that call. Only the user can change these permissions; the brain has no tool for it.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  query,
  type HookCallbackMatcher,
  type McpServerStatus,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { db } from "../store/db.js";
import { audit } from "../store/log.js";

export const CONNECT_URL = "https://claude.ai/settings/connectors";

/** Working folder for every Claude process Tavi starts. Claude Code remembers per-project choices (like which
 * claude.ai connectors are switched off), keyed by the git root, so the brain's folder must sit outside this repo or the
 * user's own Claude Code sessions here would pick up its choices. */
export const BRAIN_CWD = process.env.LH_BRAIN_CWD
  ? path.resolve(process.env.LH_BRAIN_CWD) // dev and tests use their own, so they never share the live brain's state
  : savedFolder(process.env.LOCALAPPDATA ?? homedir(), "brain");
mkdirSync(BRAIN_CWD, { recursive: true });

/** Descriptions and starting permissions for the ones Tavi expects. Any other connector on the account is listed too, off. */
const KNOWN: Record<string, { what: string; read: boolean; write: boolean }> = {
  "claude.ai Gmail": { what: "Your email", read: true, write: false },
  "claude.ai Google Calendar": { what: "Your calendar: what's on, free time, invites", read: true, write: false },
  "claude.ai Google Drive": { what: "Files in your Drive", read: true, write: false },
};

/** Environment for any Claude process that should see the connectors. Tool search off: the brain has no ToolSearch tool,
 * so connector tools must be loaded up front rather than deferred. */
export const connectorEnv = (): Record<string, string | undefined> => ({ ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "true", ENABLE_TOOL_SEARCH: "false" });

/* ---------------- permissions (the user's choice, per connector) ---------------- */

export type Permission = { read: boolean; write: boolean };
const PERM_KEY = "connector_permissions";

function allPermissions(): Record<string, Permission> {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PERM_KEY) as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as Record<string, Permission>) : {};
  } catch {
    return {};
  }
}
export function permissionsFor(server: string): Permission {
  const p = allPermissions()[server] ?? KNOWN[server] ?? { read: false, write: false };
  return { read: !!p.read || !!p.write, write: !!p.write }; // writing means it can also look (e.g. find an address to send to)
}
/** Only called from the PC app (a person clicking), never from the brain. */
export function setPermission(server: string, p: Permission) {
  const next = { read: p.read || p.write, write: p.write };
  const all = { ...allPermissions(), [server]: next };
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(PERM_KEY, JSON.stringify(all));
  audit("user", "connector.permission", null, { connector: labelOf(server), read: next.read, write: next.write });
  return next;
}
export const wantsLoaded = (server: string) => {
  const p = permissionsFor(server);
  return p.read || p.write;
};

/* ---------------- what the CLI reports ---------------- */

export type ConnectorTool = { name: string; description: string; readOnly: boolean; destructive: boolean; kind: "read" | "draft" | "write" };
export type ConnectorState = {
  server: string;
  label: string;
  what: string;
  status: McpServerStatus["status"] | "unknown";
  error?: string;
  permission: Permission;
  tools: ConnectorTool[];
};

const labelOf = (server: string) => server.replace(/^claude\.ai /, "");
/** "claude.ai Google Calendar" → "mcp__claude_ai_Google_Calendar__" (how the CLI names that server's tools). */
const prefixOf = (server: string) => `mcp__claude_ai_${labelOf(server).replace(/[^A-Za-z0-9]/g, "_")}__`;
/** "mcp__claude_ai_Google_Calendar__list_events" → "claude.ai Google Calendar" (the server name the CLI reports). */
export function serverOf(fullName: string): string | undefined {
  return [...servers.map((s) => s.server), ...Object.keys(KNOWN)].find((name) => fullName.startsWith(prefixOf(name)));
}

let servers: { server: string; status: ConnectorState["status"]; error?: string; tools: Omit<ConnectorTool, "kind">[] }[] = Object.keys(KNOWN).map((server) => ({
  server,
  status: "unknown",
  tools: [],
}));
let checkedAt: string | null = null;

/** Called by the brain whenever it reads the CLI's MCP status. Every claude.ai connector on the account is tracked. */
export function recordConnectorStatus(list: McpServerStatus[]) {
  const before = JSON.stringify(servers.map((s) => [s.server, s.status, s.tools.length]));
  const names = [...new Set([...Object.keys(KNOWN), ...list.filter((s) => s.source === "claudeai").map((s) => s.name)])];
  servers = names.map((server) => {
    const s = list.find((x) => x.name === server);
    return {
      server,
      status: s?.status ?? "unknown",
      error: s?.error,
      tools: (s?.tools ?? []).map((t) => ({
        name: `${prefixOf(server)}${t.name}`,
        description: (t.description ?? "").slice(0, 300),
        readOnly: !!t.annotations?.readOnly,
        destructive: !!t.annotations?.destructive,
      })),
    };
  });
  checkedAt = new Date().toISOString();
  const after = JSON.stringify(servers.map((s) => [s.server, s.status, s.tools.length]));
  if (before !== after) audit("system", "connectors.status", null, { connectors: servers.map((s) => ({ name: labelOf(s.server), status: s.status, tools: s.tools.length })) });
}

export function connectorStates() {
  const connectors: ConnectorState[] = servers.map((s) => ({
    server: s.server,
    label: labelOf(s.server),
    what: KNOWN[s.server]?.what ?? "A connector on your Claude account",
    status: s.status,
    error: s.error,
    permission: permissionsFor(s.server),
    tools: s.tools.map((t) => ({ ...t, kind: classifyTool(t.name) })),
  }));
  // The expected ones first, then the rest by name.
  connectors.sort((a, b) => Number(!KNOWN[a.server]) - Number(!KNOWN[b.server]) || a.label.localeCompare(b.label));
  return { checkedAt, connectors, connectUrl: CONNECT_URL };
}
export const connectorTool = (fullName: string) => servers.flatMap((s) => s.tools).find((t) => t.name === fullName);
export const isConnectorTool = (fullName: string) => fullName.startsWith("mcp__claude_ai_") && !!serverOf(fullName);
export const connectorLabel = (fullName: string) => {
  const s = serverOf(fullName);
  return s ? labelOf(s) : "that connector";
};

/**
 * What kind of thing a connector tool does:
 * - "read": the server marks it read-only, or (if unannotated) the name says it only looks
 * - "draft": saves a draft in the user's own account; nothing leaves it
 * - "write": everything else. Needs Write permission AND the user's tap every time.
 */
export function classifyTool(fullName: string): "read" | "draft" | "write" {
  const short = fullName.replace(/^mcp__\w+?__/, "");
  const t = connectorTool(fullName);
  if (/send|delete|trash|remove|share|permission|move|respond|reply|forward|update|modify|create_event|insert/i.test(short) && !/draft/i.test(short)) return "write";
  if (t?.readOnly) return "read";
  if (/draft/i.test(short) && !/send|delete/i.test(short)) return "draft";
  if (!t?.destructive && /^(get|list|search|read|find|query|fetch|lookup|describe|download|export)/i.test(short)) return "read";
  return "write";
}

/** For the brain's Context: what it may do with each connector right now. */
export function connectorSummary(): string {
  const parts = connectorStates()
    .connectors.filter((c) => c.status !== "unknown" && (KNOWN[c.server] || c.permission.read))
    .map((c) => {
      if (c.status !== "connected" && c.status !== "disabled") return `${c.label}: not connected`;
      if (!c.permission.read) return `${c.label}: off`;
      return `${c.label}: ${c.permission.write ? "read and write (every change needs the user's tap)" : "read only"}`;
    });
  return parts.join("; ");
}

const allow = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });

/**
 * The only gate for connector tools (they are not in allowedTools, so nothing runs without this hook saying so):
 * - read: allowed if the user gave Read
 * - draft: allowed if the user gave Write (a draft stays in their account)
 * - write: never runs here. With Write it's sent to request_action for the user's tap; without, refused.
 */
export const CONNECTOR_GUARDS: HookCallbackMatcher[] = [
  {
    matcher: "^mcp__claude_ai_",
    onFailure: "block",
    hooks: [
      async (input) => {
        const { tool_name, tool_input } = input as PreToolUseHookInput;
        const server = serverOf(tool_name);
        if (!server) return deny("That connector isn't available to Tavi.");
        const label = labelOf(server);
        const p = permissionsFor(server);
        const kind = classifyTool(tool_name);
        const allowed = kind === "read" ? p.read : kind === "draft" ? p.write : false;
        audit("brain", allowed ? `connector.${kind}` : kind === "write" && p.write ? "connector.write_held" : "connector.denied", null, {
          tool: tool_name,
          input: clip(tool_input),
        });
        if (allowed) return allow;
        if (kind !== "write" || !p.write) {
          const has = p.read ? "read-only" : "no";
          return deny(
            `The user has given Tavi ${has} access to ${label}. Tell them; they can change it in Tavi Setup → ` +
              `Connections on their PC. Don't try another way.`,
          );
        }
        return deny(
          "This changes something outside the PC, so it needs the user's tap. Call request_action with this exact tool name and input, " +
            "plus a one-line summary for the user, then tell them it's on their screen for approval.",
        );
      },
    ],
  },
];

const clip = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 600 ? `${s.slice(0, 600)}…` : JSON.parse(s);
};

/** Deterministic JSON (keys sorted at every level), so an approval binds to the exact input. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
export const inputHash = (tool: string, input: unknown) => createHash("sha256").update(`${tool}\n${stableJson(input)}`).digest("hex");

/** The connector refused before acting (bad input, no access): definitely nothing happened. */
export class ConnectorRefused extends Error {}

/**
 * Make exactly one approved connector call in its own short-lived Claude process. A hook refuses any tool or input other than
 * the approved one, so the model can only press the button it was given. Returns the tool's raw result text.
 */
export async function runConnectorCall(tool: string, input: unknown): Promise<{ result: string }> {
  const want = inputHash(tool, input);
  let called = false;
  let response: unknown;
  let errored = false;
  // claude.ai connectors connect a few seconds after the process starts: hold the instruction until this one is up.
  let release!: (go: boolean) => void;
  const ready = new Promise<boolean>((r) => (release = r));
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    if (!(await ready)) return;
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content:
          `Call the tool ${tool} exactly once with exactly this JSON input, unchanged:\n${JSON.stringify(input)}\n` +
          "Then reply with the single word DONE. Do not call any other tool.",
      },
    } as SDKUserMessage;
  }
  const q = query({
    prompt: prompt(),
    options: {
      model: process.env.BACKGROUND_MODEL || "claude-haiku-5-5",
      effort: "low",
      settingSources: [],
      tools: [],
      allowedTools: [tool],
      permissionMode: "dontAsk",
      maxTurns: 3,
      persistSession: false,
      cwd: BRAIN_CWD,
      env: connectorEnv(),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (h) => {
                const { tool_name, tool_input } = h as PreToolUseHookInput;
                if (tool_name !== tool || inputHash(tool_name, tool_input) !== want || called) return deny("Only the approved call, once.");
                called = true;
                return allow;
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (h) => {
                const p = h as PostToolUseHookInput;
                if (p.tool_name === tool) response = p.tool_response;
                return {};
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async (h) => {
                const p = h as PostToolUseFailureHookInput;
                if (p.tool_name === tool) (errored = true), (response = p.error);
                return {};
              },
            ],
          },
        ],
      },
    },
  });
  const server = serverOf(tool);
  void (async () => {
    for (let i = 0; i < 40; i++) {
      const s = await q.mcpServerStatus().catch(() => []);
      const st = s.find((x) => x.name === server)?.status;
      if (st === "connected") return release(true);
      // Switched on in Setup since this folder last saw it: enable it here too (only ever for a connector the user allows).
      if (st === "disabled" && server && wantsLoaded(server)) await q.toggleMcpServer(server, true).catch(() => undefined);
      else if (st === "needs-auth" || st === "failed" || st === "disabled") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    release(false);
    q.interrupt().catch(() => undefined);
  })();
  for await (const m of q) if (m.type === "result") break;
  if (!(await ready)) throw new ConnectorRefused(`${server ?? "that connector"} isn't connected`);
  const text = typeof response === "string" ? response : JSON.stringify(response ?? null);
  if (!called) throw new ConnectorRefused("the call was never made");
  if ((response as { isError?: boolean } | undefined)?.isError) errored = true;
  if (errored) {
    // A refusal (bad input, no access) means nothing happened. A timeout or server error might have acted: unknown, never retried.
    if (/time ?out|timed out|ECONN|network|socket|\b5\d\d\b|unavailable/i.test(text)) throw new Error(`no clear answer: ${text.slice(0, 200)}`);
    throw new ConnectorRefused(text.slice(0, 300));
  }
  if (response === undefined) throw new Error("the call was made but no result came back");
  return { result: text };
}
