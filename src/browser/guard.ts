// Hard rules for the browser, enforced in code before each action (the job's instructions say the same, but a page
// can talk a model into things; code can't be talked into anything):
// - Only a safe set of browser tools (no running scripts, no file uploads, no reading network traffic).
// - Never on a site this job may not use: checked before navigating AND before every action, because sites redirect.
// - Only on elements from the page as last read (a ref from the latest snapshot), so each one has its real name to check;
//   never a selector it can't put a name to (Stage 15.2: the tools' `target` was being missed, so only the AI's own
//   description of an element was being checked).
// - Never typing into password, card, security-code or one-time-code fields, and never typing a card number anywhere.
// - Anything that commits (place order, pay, book, send, submit, delete; and on checkout pages also confirm / complete /
//   finish, and continue on a payment step) only works after the user's go-ahead. A go-ahead is for this site only,
//   lasts 10 minutes, covers at most 3 checkout steps, and its final button only works if the page still shows the
//   total the user approved.
import { readFileSync } from "node:fs";
import type { HookCallbackMatcher, PostToolUseHookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { audit } from "../store/log.js";
import { navigationBlock } from "./sites.js";

export const SAFE_BROWSER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_handle_dialog",
  "browser_close",
].map((t) => `mcp__browser__${t}`);

// Buttons and links that commit something wherever they appear. Matched against the element's real name from the page.
const COMMITS = [
  /\bplace (my |your |the )?order\b/i,
  /^(submit|complete|confirm|finali[sz]e)( my| your| the)? (order|purchase|booking|payment|reservation|transfer)\b/i,
  /^(pay|pay now|pay \$.*|buy|buy now|purchase|checkout now|order now|book|book now|reserve|reserve now|send|send now|submit|delete|transfer|donate|subscribe|authori[sz]e|confirm and pay|confirm & pay)$/i,
  /^(agree|accept) (and|&) (pay|order|book|continue to payment)\b/i,
  /^proceed to pay(ment)?$/i,
  /\b(cancel (my |the )?(order|booking|subscription|membership)|delete (my )?account|close (my )?account)\b/i,
];
// Vaguer labels that commit when they're on a checkout-type page...
const VAGUE = /^(confirm|complete|finish|finali[sz]e|submit|done|agree|accept|i agree|authori[sz]e|yes|ok)\b/i;
// ...and "continue / next / proceed" when the page is the payment step.
const STEP = /^(continue|next|proceed)\b/i;
const CHECKOUT_PAGE = /(checkout|payment|\/pay\b|order|booking|confirm|review)/i;
const PAYMENT_STEP = /\b(card ending|payment method|pay(ing)? with|billing address|saved card|credit card|debit card|paypal|afterpay|order total|amount due)\b/i;

// Fields Tavi never types into, and text it never types anywhere.
const SECRET_FIELD =
  /pass(word|code|phrase)|\bpin\b|card ?(number|no\b)|credit card|debit card|name on card|\bcvv|\bcvc|\bcsc\b|security code|expir(y|ation)|one[- ]time|\botp\b|verification code|authenticat(ion|or) code|2fa|two[- ]factor|sms code|access code|\bbsb\b|account number|tax file|\btfn\b|medicare|passport|licen[cs]e number/i;

/** True if the text contains something that passes the card-number check (13-19 digits, Luhn). */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export const commits = (label: string) => COMMITS.some((re) => re.test(label.trim()));
export const secretField = (label: string) => SECRET_FIELD.test(label);

export type Grant = { origin: string; button: string; total: string | null; until: number; left: number };
/** What the job knows about the page (from the browser's own snapshots) and what the user has allowed. */
export type PageState = {
  url: string;
  page: string; // the latest snapshot text
  refs: Map<string, string>; // ref -> 'button "Place order"'
  grant: Grant | null;
  allowed: string[] | null; // origins this job may use (null = any public site)
  jobId: string;
};
export const newPageState = (jobId: string, allowed: string[] | null): PageState => ({ url: "", page: "", refs: new Map(), grant: null, allowed, jobId });

/** The user said yes: this site, this button, this total, for 10 minutes, at most 3 checkout steps. */
export function grantGoAhead(state: PageState, button: string, total: string | null) {
  state.grant = { origin: originOf(state.url), button, total, until: Date.now() + 10 * 60_000, left: 3 };
}

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
};

/** Pull the page URL and the element names out of a tool result (inline snapshot, or the snapshot file it points to). */
function learn(state: PageState, response: unknown) {
  const text = JSON.stringify(response ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  const url = /- Page URL: (\S+)/.exec(text)?.[1];
  if (url && url !== state.url) {
    state.url = url;
    const why = navigationBlock(url, state.allowed);
    if (why) audit("brain", "browser.redirected", state.jobId, { url: url.slice(0, 200), why });
  }
  let yaml = /```yaml\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
  const file = /\[Snapshot\]\(([^)]+\.yml)\)/.exec(text)?.[1];
  if (!yaml && file) {
    try {
      yaml = readFileSync(file, "utf8");
    } catch {
      /* keep the old map */
    }
  }
  if (!yaml) return;
  state.page = yaml;
  state.refs = new Map();
  for (const line of yaml.split("\n")) {
    // refs are e12, or f1e12 for something inside a frame on the page (Stage 15.2: the frame ones were missed before)
    const m = /-\s+(\w[\w-]*)\s+"([^"]*)"[^\n]*?\[ref=((?:f\d+)?e\d+)\]/.exec(line) ?? /-\s+(\w[\w-]*)[^\n]*?\[ref=((?:f\d+)?e\d+)\]:\s*(.+)$/.exec(line);
    if (!m) continue;
    if (REF.test(m[3] ?? "")) state.refs.set(m[3], `${m[1]} "${m[2]}"`);
    else state.refs.set(m[2], `${m[1]} "${m[3]}"`);
  }
}
const REF = /^(?:f\d+)?e\d+$/;
/**
 * The element a step acts on. The browser tools call it `target` (earlier versions `ref`); it can also be a CSS selector,
 * which the guard can't put a name to, so only refs from the latest snapshot are accepted (Stage 15.2).
 */
const targetOf = (a: Record<string, unknown>) => String(a.target ?? a.ref ?? "");
const ACTS_ON = new Set(["browser_click", "browser_type", "browser_fill_form", "browser_select_option", "browser_hover"]);

const allow = { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } };
const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
const nameOf = (real: string) => /"([^"]*)"/.exec(real)?.[1] ?? "";
const plain = (said: string) => said.replace(/^(the |a )/i, "").replace(/ (button|link|field|box|input|textbox)$/i, "");

type Verdict = { ok: true } | { ok: false; why: string };

/**
 * Does this button commit something here, and if so, may it be pressed now?
 * step: Enter or accepting a dialog on a checkout page (a step, not a named button).
 */
function checkCommit(state: PageState, label: string, step = false): Verdict | null {
  const checkout = CHECKOUT_PAGE.test(state.url);
  const definite = !step && commits(label);
  const vague = !definite && checkout && (step || VAGUE.test(label) || (STEP.test(label) && PAYMENT_STEP.test(state.page)));
  if (!definite && !vague) return null; // an ordinary button
  const g = state.grant;
  if (!g || g.left < 1 || Date.now() > g.until) return { ok: false, why: "needs the user's go-ahead" };
  if (originOf(state.url) !== g.origin) return { ok: false, why: "the go-ahead was for a different site" };
  const a = label.trim().toLowerCase();
  const b = g.button.trim().toLowerCase();
  const isApprovedButton = !!a && (a.includes(b) || b.includes(a));
  // A definite "Place order"/"Pay" must be the button the user approved; vaguer checkout steps may come before it.
  if (definite && !isApprovedButton) return { ok: false, why: `the go-ahead was for "${g.button}", not "${label}"` };
  if (isApprovedButton) {
    // The final button: the page must still show the total the user approved, and it ends the go-ahead.
    if (g.total && !state.page.includes(g.total)) return { ok: false, why: `the page no longer shows the approved total ${g.total}` };
    g.left = 0;
    return { ok: true };
  }
  g.left -= 1;
  return { ok: true };
}

export function browserHooks(state: PageState): { PreToolUse: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[] } {
  const held = (what: string, why: string) => {
    audit("brain", "browser.held", state.jobId, { button: what, url: state.url, why });
    return deny(
      `Blocked: "${what}" commits something and ${why}. Get to the review step, take a screenshot, then call ` +
        "request_go_ahead with the details, the total and the exact final button, and wait for the answer.",
    );
  };
  return {
    PreToolUse: [
      {
        matcher: "^mcp__browser__",
        onFailure: "block",
        hooks: [
          async (input) => {
            const { tool_name, tool_input } = input as PreToolUseHookInput;
            const a = (tool_input ?? {}) as Record<string, unknown>;
            if (!SAFE_BROWSER_TOOLS.includes(tool_name)) return deny("That browser tool isn't available to Tavi.");
            const short = tool_name.replace("mcp__browser__", "");

            if (short === "browser_navigate") {
              const why = navigationBlock(String(a.url ?? ""), state.allowed);
              if (why) {
                audit("brain", "browser.blocked", state.jobId, { url: String(a.url ?? "").slice(0, 200), why });
                return deny(why);
              }
              return allow;
            }
            // Sites redirect: before doing anything on a page, check it's somewhere this job may be.
            const passive = ["browser_navigate_back", "browser_snapshot", "browser_take_screenshot", "browser_tabs", "browser_close", "browser_wait_for", "browser_find"];
            if (state.url && !passive.includes(short)) {
              const why = navigationBlock(state.url, state.allowed);
              if (why) return deny(`The browser is now on ${state.url.slice(0, 80)}, which this job can't use (${why}). Go back or navigate to an allowed site.`);
            }

            // Only elements from the page as last read: a selector, or a ref from an older page, can't be checked by name.
            if (ACTS_ON.has(short)) {
              const targets = short === "browser_fill_form" ? ((a.fields as Record<string, unknown>[] | undefined) ?? []).map(targetOf) : [targetOf(a)];
              const unknown = targets.find((t) => !REF.test(t) || !state.refs.has(t));
              if (unknown !== undefined) {
                audit("brain", "browser.unknown_target", state.jobId, { target: unknown.slice(0, 80), url: state.url });
                return deny(`"${unknown.slice(0, 60)}" isn't an element from the latest snapshot. Take a browser_snapshot and use the ref it gives.`);
              }
            }

            // Typing: never into secret fields, and never a card number anywhere.
            if (short === "browser_type" || short === "browser_fill_form") {
              const fields =
                short === "browser_type"
                  ? [{ ref: targetOf(a), said: String(a.element ?? ""), value: String(a.text ?? "") }]
                  : ((a.fields as { ref?: string; target?: string; name?: string; value?: unknown }[] | undefined) ?? []).map((f) => ({ ref: targetOf(f), said: String(f.name ?? ""), value: String(f.value ?? "") }));
              for (const f of fields) {
                const real = state.refs.get(f.ref) ?? "";
                if (secretField(real) || secretField(f.said)) {
                  audit("brain", "browser.secret_blocked", state.jobId, { field: nameOf(real) || f.said, url: state.url });
                  return deny(`"${nameOf(real) || f.said}" is a password, card or code field. Tavi never fills those: finish with needs_user and say what's needed.`);
                }
                if (looksLikeCardNumber(f.value)) {
                  audit("brain", "browser.secret_blocked", state.jobId, { field: nameOf(real) || f.said, url: state.url, reason: "card number" });
                  return deny("That looks like a card number. Tavi never types card details.");
                }
              }
              if (short === "browser_type" && a.submit === true && CHECKOUT_PAGE.test(state.url)) {
                const v = checkCommit(state, "", true);
                if (v && !v.ok) return held("pressing Enter on a checkout page", v.why);
              }
              return allow;
            }

            if (short === "browser_click") {
              const real = state.refs.get(targetOf(a)) ?? "";
              const label = nameOf(real) || plain(String(a.element ?? ""));
              // Check both the page's own name for it and what the AI called it (it can't hide a button by renaming it).
              const v = checkCommit(state, label) ?? (nameOf(real) ? checkCommit(state, plain(String(a.element ?? ""))) : null);
              if (!v) return allow;
              if (!v.ok) return held(label, v.why);
              audit("brain", "browser.committed", state.jobId, { button: label, url: state.url });
              return allow;
            }

            const enterOrAccept =
              (short === "browser_press_key" && /^(Enter|NumpadEnter)$/i.test(String(a.key ?? ""))) || (short === "browser_handle_dialog" && a.accept === true);
            if (enterOrAccept && CHECKOUT_PAGE.test(state.url)) {
              const v = checkCommit(state, "", true);
              if (v && !v.ok) return held(short === "browser_handle_dialog" ? "accepting a confirmation dialog" : "pressing Enter on a checkout page", v.why);
            }
            return allow;
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "^mcp__browser__",
        hooks: [
          async (input) => {
            learn(state, (input as PostToolUseHookInput).tool_response);
            return {};
          },
        ],
      },
    ],
  };
}
