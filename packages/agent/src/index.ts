/**
 * @gta/agent — the LLM brain.
 *
 * Responsibilities:
 *   - Parse plain-language chat requests into structured intents
 *     ("we're out of paper towels" -> items; "dinner Friday?" -> pay_after).
 *   - Read receipt photos into structured `Receipt`s.
 *
 * Implemented with Claude (Claude Sonnet 5 by default) via the Vercel AI SDK
 * (`ai` + `@ai-sdk/anthropic`), using `generateObject` with Zod schemas for
 * typed structured output. The model is swappable via a single config constant
 * (`CLAUDE_MODEL_ID`) and injectable per call so tests can supply a mock.
 *
 * Auth: the Anthropic provider reads `ANTHROPIC_API_KEY` from the environment.
 * A Claude subscription (claude.ai login) does NOT work — an API key is required.
 */

export { CLAUDE_MODEL_ID, defaultModel } from "./model.js";
export {
  parseRequest,
  type ParsedIntent,
  type ParseRequestOptions,
} from "./parse-request.js";
export {
  ClaudeReceiptReader,
  type ClaudeReceiptReaderOptions,
} from "./receipt-reader.js";
