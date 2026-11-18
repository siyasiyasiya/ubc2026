/**
 * Claude model wiring for the agent, via the Vercel AI SDK.
 *
 * Auth: the `@ai-sdk/anthropic` provider reads the `ANTHROPIC_API_KEY`
 * environment variable automatically — no key is passed in code. NOTE: a Claude
 * *subscription* (claude.ai / Claude Code login) does NOT work here; the
 * Anthropic API requires a real API key from console.anthropic.com.
 */

import { anthropic } from "@ai-sdk/anthropic";
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
  return anthropic(CLAUDE_MODEL_ID);
}
