/**
 * @gta/agent — the LLM brain.
 *
 * SKELETON. Responsibilities once built:
 *   - Parse plain-language chat requests into structured intents
 *     ("we're out of paper towels" -> items; "dinner Friday?" -> pay_after).
 *   - Decide the SpendFlow and which store/PurchaseAdapter to use.
 *   - Read receipts via a ReceiptReader and compute splits.
 *   - Drive the core state machine, performing effects through the ports.
 *
 * DECISION NEEDED before this becomes real: LLM + agent framework.
 * Kept deliberately thin so the model/framework is swappable.
 */

import type { Request, SpendFlow } from "@gta/core";

const NOT_IMPLEMENTED = "not implemented: @gta/agent skeleton — LLM + framework undecided";

export interface ParsedIntent {
  flow: SpendFlow;
  items?: Array<{ name: string; quantity?: number }>;
  store?: string;
  /** Free-form notes the agent extracted (participants, timing, etc.). */
  notes?: string;
}

/** STUB. Turns a raw chat request into a structured intent. */
export async function parseRequest(_request: Request): Promise<ParsedIntent> {
  throw new Error(NOT_IMPLEMENTED);
}
