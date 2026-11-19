/**
 * @gta/agent — the LLM brain (Claude, via the Anthropic SDK tool runner).
 *
 * - `runTurn`: reads the group chat and decides what to say and which action to take. It can only
 *   ask the app to propose a split, set the sender's own limit, or cancel a request. It never moves
 *   money; the app and the core state machine decide that.
 * - `ClaudeReceiptReader`: the core `ReceiptReader` port, reading receipt photos with vision.
 *
 * Needs ANTHROPIC_API_KEY. Model: CLAUDE_MODEL (default claude-sonnet-5), effort: AGENT_EFFORT
 * (default low, so replies feel instant).
 */

export { NO_REPLY, runTurn, type TreasuryActions, type TurnInput } from "./brain.js";
export { CHAT_EFFORT, MODEL } from "./claude.js";
export { ClaudeReceiptReader, NotAReceiptError } from "./receipt.js";
