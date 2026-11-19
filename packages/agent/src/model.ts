/**
 * Claude model wiring for the agent, via the Vercel AI SDK.
 *
 * Auth: the `@ai-sdk/anthropic` provider reads the `ANTHROPIC_API_KEY`
 * environment variable automatically — no key is passed in code. NOTE: a Claude
 * *subscription* (claude.ai / Claude Code login) does NOT work here; the
 * Anthropic API requires a real API key from console.anthropic.com.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV1 } from "ai";

/**
 * The single source of truth for which Claude model the agent talks to.
 * Swap this to `claude-opus-4-8` / `claude-haiku-4-5` to change tiers without
 * touching any call site.
 */
export const CLAUDE_MODEL_ID = "claude-sonnet-5";

/**
 * Lazily construct the default Claude model instance.
 *
 * Kept lazy so that merely importing this package (e.g. in a test that injects
 * its own mock model) never forces the Anthropic provider to resolve an API
 * key. The key is only read when a real request is actually made.
 */
export function defaultModel(): LanguageModelV1 {
  provider ??= createAnthropic({ fetch: withoutSamplingParams });
  return provider(CLAUDE_MODEL_ID);
}

let provider: ReturnType<typeof createAnthropic> | undefined;

/**
 * AI SDK v4 always sends `temperature: 0` (its own "TODO v5 remove default 0"), and current
 * Claude models (Sonnet 5, Opus 4.7 and later) reject `temperature`, `top_p` and `top_k` with a
 * 400. Strip them from the request body before it goes out.
 */
export const withoutSamplingParams: typeof fetch = async (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      delete body.temperature;
      delete body.top_p;
      delete body.top_k;
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Not JSON: send as-is.
    }
  }
  return fetch(input, init);
};
