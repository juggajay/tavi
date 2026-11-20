// Hard rules on the brain's web access, enforced in code before the tool runs (not left to the prompt).
import type { HookCallbackMatcher, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { audit } from "../store/log.js";
import { keepOutReason } from "./keepOut.js";

export const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/;

/** Why a URL may not be fetched, or null if it's fine. */
export function webFetchBlockReason(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That isn't a valid web address.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only normal web pages can be opened.";
  if (PRIVATE_HOST.test(u.hostname) || u.hostname.endsWith(".ts.net") || u.hostname.endsWith(".local")) {
    return "Local and private network addresses can't be opened.";
  }
  if (u.username || u.password) return "Addresses with embedded logins can't be opened.";
  const keepOut = keepOutReason(u.hostname); // Stage 20.3: sites that ask robots and AI tools to keep out
  if (keepOut) return keepOut;
  // Long query strings are how injected instructions smuggle private data out ("open https://x.com/?d=<secrets>").
  if (u.search.length > 150 || raw.length > 400) return "That address carries a lot of data in it, so I won't open it in case it leaks private information.";
  return null;
}

export const WEB_GUARDS: HookCallbackMatcher[] = [
  {
    matcher: "WebFetch",
    onFailure: "block",
    hooks: [
      async (input) => {
        const url = String(((input as PreToolUseHookInput).tool_input as { url?: unknown })?.url ?? "");
        const reason = webFetchBlockReason(url);
        audit("brain", reason ? "web.fetch_blocked" : "web.fetch", null, { url: url.slice(0, 300), reason: reason ?? undefined });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: reason ? "deny" : "allow",
            ...(reason ? { permissionDecisionReason: reason } : {}),
          },
        };
      },
    ],
  },
  {
    matcher: "WebSearch",
    hooks: [
      async (input) => {
        const query = String(((input as PreToolUseHookInput).tool_input as { query?: unknown })?.query ?? "");
        audit("brain", "web.search", null, { query: query.slice(0, 200) });
        return {};
      },
    ],
  },
];
