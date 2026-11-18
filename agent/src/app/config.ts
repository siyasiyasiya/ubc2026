import path from "node:path";
import { fileURLToPath } from "node:url";
import { usdToUnits } from "../core/money.js";
import type { Handle } from "../core/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** MEMBER_NAMES="+18475551234=Tristan,+16105551234=Siya" */
function names(value: string | undefined): Record<Handle, string> {
  return Object.fromEntries(
    list(value).flatMap((pair) => {
      const [handle, name] = pair.split("=").map((s) => s.trim());
      return handle && name ? [[handle, name]] : [];
    }),
  );
}

export const config = {
  imessageMode: process.env.IMESSAGE_MODE === "cloud" ? ("cloud" as const) : ("local" as const),
  allowedSpaceIds: new Set(list(process.env.ALLOWED_SPACE_IDS)),
  memberNames: names(process.env.MEMBER_NAMES),
  defaultWeeklyLimit: usdToUnits(Number(process.env.DEFAULT_WEEKLY_LIMIT_USD ?? 200)),
  stateFile: process.env.STATE_FILE ?? path.resolve(here, "../../data/state.json"),
};
