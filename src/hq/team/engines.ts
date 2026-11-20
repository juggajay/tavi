import { z } from "zod";
import type { EngineChoice } from "../contract.js";

export type EngineOptions = { company: "Claude" | "OpenAI"; provider: "anthropic" | "openai-codex"; signedIn: boolean; models: string[] };
export const effortWords = ["minimal", "low", "medium", "high", "xhigh"] as const;
export const engineSettings = z.object({
  bot: z.string().trim().min(1), company: z.enum(["Claude", "OpenAI"]),
  model: z.string().trim().min(1).max(120), effort: z.string(),
  fallbacks: z.array(z.object({ company: z.enum(["Claude", "OpenAI"]), model: z.string().trim().min(1).max(120), effort: z.string() }).strict()).max(10).optional(),
}).strict();
export type EngineSettings = z.infer<typeof engineSettings>;

export function matchChoice(input: Omit<EngineSettings, "bot" | "fallbacks">, options: EngineOptions[]): EngineChoice {
  if (!effortWords.includes(input.effort as typeof effortWords[number])) throw new Error(`Choose an effort: ${effortWords.join(", ")}.`);
  const subscription = options.find((s) => s.company === input.company);
  const tidy = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = tidy(input.model);
  const models = subscription?.models ?? [];
  const exact = models.find((m) => m.toLowerCase() === input.model.toLowerCase());
  const matches = exact ? [exact] : models.filter((m) => name && tidy(m).includes(name));
  if (!matches.length) throw new Error(`No known ${input.company} model matches "${input.model}". Known models: ${models.join(", ") || "none available; check the team's engine"}.`);
  if (matches.length > 1) throw new Error(`That model name matches more than one: ${matches.join(", ")}. Choose one of these.`);
  return { provider: subscription!.provider, model: matches[0], effort: input.effort as EngineChoice["effort"] };
}

// Read names from the gateway's model options. Never guess a model which it did not offer.
export function readEngineOptions(value: unknown): EngineOptions[] {
  const data = value as { providers?: { slug?: string; id?: string; provider?: string; authenticated?: boolean; models?: unknown[] }[]; models?: unknown[] | Record<string, unknown[]> };
  return ([{ company: "Claude", provider: "anthropic" }, { company: "OpenAI", provider: "openai-codex" }] as const).map((s) => {
    const provider = data.providers?.find((p) => (p.slug ?? p.id ?? p.provider) === s.provider);
    const all = Array.isArray(data.models) ? data.models.filter((m) => typeof m === "object" && m && (m as { provider?: string }).provider === s.provider)
      : data.models?.[s.provider] ?? [];
    const models = [...(provider?.models ?? []), ...all].flatMap((m) => {
      const name = typeof m === "string" ? m : m && typeof m === "object" ? ((m as { id?: string; model?: string; name?: string }).id ?? (m as { model?: string }).model ?? (m as { name?: string }).name) : undefined;
      return typeof name === "string" && name.trim() ? [name] : [];
    });
    return { ...s, signedIn: provider?.authenticated === true, models: [...new Set(models)] };
  });
}
