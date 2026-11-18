/**
 * parseRequest — turn a plain-language chat message into a structured
 * `ParsedIntent` using Claude via the Vercel AI SDK's `generateObject`.
 *
 *   "we're out of paper towels"  -> { flow: "pay_before", items: [...] }
 *   "dinner at Uchi Friday?"      -> { flow: "pay_after", store: "Uchi", ... }
 */

import type { Request, SpendFlow } from "@gta/core";
import { generateObject, type LanguageModelV1 } from "ai";
import { z } from "zod";

import { defaultModel } from "./model.js";

/** The structured intent the LLM extracts from a raw chat request. */
export interface ParsedIntent {
  flow: SpendFlow;
  items?: Array<{ name: string; quantity?: number }>;
  store?: string;
  /** Free-form notes the agent extracted (participants, timing, etc.). */
  notes?: string;
}

/**
 * Zod schema describing the structured output we want from Claude. `generateObject`
 * uses this both to constrain/decode the model's JSON and to type the result.
 */
const parsedIntentSchema = z.object({
  flow: z
    .enum(["pay_before", "pay_after"])
    .describe(
      "pay_before = the agent buys something now and splits the cost up front " +
        "(a shopping/supply request like 'we're out of paper towels'). " +
        "pay_after = people front money for a shared expense and settle later " +
        "(a plan like 'dinner at Uchi Friday?').",
    ),
  items: z
    .array(
      z.object({
        name: z.string().describe("The item to buy, e.g. 'paper towels'."),
        quantity: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many, if the message says so."),
      }),
    )
    .optional()
    .describe("Concrete items to purchase. Omit for pay_after plans with no item list."),
  store: z
    .string()
    .optional()
    .describe("The merchant / restaurant / store named or implied, if any."),
  notes: z
    .string()
    .optional()
    .describe(
      "Anything else useful the agent extracted: participants, timing, " +
        "budget, or clarifying context. Keep it short.",
    ),
});

const SYSTEM_PROMPT =
  "You are the brain of a group-treasury agent that lives in an iMessage group " +
  "chat and handles shared spending. Read one chat message and extract a " +
  "structured intent. Decide the spend flow: pay_before when the group wants " +
  "something bought now (supplies, groceries, an order) and the cost split up " +
  "front; pay_after when it's a shared outing/bill people will front and settle " +
  "later (dining out, tickets, a trip expense). Only include items you are " +
  "confident are being requested. Do not invent a store that wasn't mentioned.";

export interface ParseRequestOptions {
  /**
   * Inject a specific model instance (defaults to the configured Claude model).
   * Tests pass a mock here so no network call is made.
   */
  model?: LanguageModelV1;
}

/** Turn a raw chat request into a structured intent using Claude. */
export async function parseRequest(
  request: Request,
  options: ParseRequestOptions = {},
): Promise<ParsedIntent> {
  const model = options.model ?? defaultModel();

  const { object } = await generateObject({
    model,
    schema: parsedIntentSchema,
    schemaName: "ParsedIntent",
    schemaDescription: "A structured spend intent extracted from a chat message.",
    system: SYSTEM_PROMPT,
    prompt: `Chat message: ${JSON.stringify(request.text)}`,
  });

  return object;
}
