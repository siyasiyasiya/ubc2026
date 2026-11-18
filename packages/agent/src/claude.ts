import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const effortEnv = process.env.AGENT_EFFORT as Effort | undefined;

/** Group chat replies should feel instant, so the chat agent runs at low effort by default. */
export const CHAT_EFFORT: Effort = effortEnv && efforts.includes(effortEnv) ? effortEnv : "low";

/** If a request is declined by a safety classifier, the API retries it on a fallback model. */
export const FALLBACK: { betas: Anthropic.AnthropicBeta[]; fallbacks: "default" } = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

let client: Anthropic | undefined;

/** Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) on first use. */
export function claude(): Anthropic {
  client ??= new Anthropic();
  return client;
}
