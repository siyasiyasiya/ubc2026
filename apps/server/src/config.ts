import path from "node:path";
import { fileURLToPath } from "node:url";
import { usdc, type SpendingLimit } from "@gta/core";

const here = path.dirname(fileURLToPath(import.meta.url));

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** MEMBER_NAMES="+18475551234=Tristan,+16105551234=Siya" */
function names(value: string | undefined): Record<string, string> {
  return Object.fromEntries(
    list(value).flatMap((pair) => {
      const [handle, name] = pair.split("=").map((s) => s.trim());
      return handle && name ? [[handle, name]] : [];
    }),
  );
}

const period = process.env.DEFAULT_LIMIT_PERIOD === "monthly" ? "monthly" : "weekly";

export const config = {
  imessageMode: process.env.IMESSAGE_MODE === "cloud" ? ("cloud" as const) : ("local" as const),
  allowedChatIds: list(process.env.ALLOWED_CHAT_IDS),
  names: names(process.env.MEMBER_NAMES),
  defaultLimit: {
    amount: usdc(Number(process.env.DEFAULT_LIMIT_USD ?? 200)),
    period,
  } satisfies SpendingLimit,
  stateFile: process.env.STATE_FILE ?? path.resolve(here, "../data/state.json"),
};
