/**
 * "Your kitties": every group chat this person is in, read straight from the contract.
 *
 * The page has no backend and the contract only knows each chat as a hash, so Kitty's links carry
 * the list: repeated `k=<group id>:<chat name>` params (not secret). The page adds the link's own
 * chat (`g` + `c`). For each one it reads the limit, what's left this period, and when it resets.
 */

import { formatUnits, isHex, type Hex, type PublicClient } from "viem";
import { treasuryAbi } from "./abi";

export interface ChatRef {
  group: Hex;
  name: string;
}

/** The chats a link lists, plus the link's own chat, without duplicates. */
export function chatsFromLink(params: URLSearchParams): ChatRef[] {
  const out = new Map<string, ChatRef>();
  const add = (group: string, name: string) => {
    if (isHex(group) && group.length === 66 && !out.has(group.toLowerCase())) out.set(group.toLowerCase(), { group, name: name || "a group chat" });
  };
  const g = params.get("g");
  if (g) add(g, params.get("c") ?? "");
  for (const entry of params.getAll("k")) {
    const i = entry.indexOf(":");
    if (i > 0) add(entry.slice(0, i), entry.slice(i + 1));
  }
  return [...out.values()];
}

const NAMES_KEY = "kitty.chats.v1";

/**
 * Chat names seen in earlier links, so the dashboard can name a kitty whose link isn't the one
 * open now (the contract only knows each chat as a hash). Names aren't secret.
 */
export function rememberChats(chats: ChatRef[]): ChatRef[] {
  const known = new Map<string, ChatRef>();
  try {
    const saved = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "[]") as ChatRef[];
    for (const c of saved) if (isHex(c.group) && typeof c.name === "string") known.set(c.group.toLowerCase(), c);
  } catch {
    // Storage blocked or garbled: the link's own chats still work.
  }
  // The link is newer than what's saved: a renamed chat shows its new name.
  for (const c of chats) if (c.name !== "a group chat" || !known.has(c.group.toLowerCase())) known.set(c.group.toLowerCase(), c);
  const all = [...known.values()];
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(all));
  } catch {
    // Private browsing: names last for this visit only.
  }
  return all;
}

export interface ChatStatus {
  chat: ChatRef;
  active: boolean;
  period: number;
  limit: bigint;
  left: bigint;
  resetsAt: bigint;
}

const usd = (v: bigint) => {
  const n = Number(formatUnits(v, 6));
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
};

/** "resets in 3 days", "resets in 5 hours", or "never refills" for a one-time (trip) limit. */
export function resetText(period: number, resetsAt: bigint, now = Date.now()): string {
  if (period === 2 || resetsAt === 0n) return "never refills";
  const ms = Number(resetsAt) * 1000 - now;
  if (ms <= 0) return "resets now";
  const days = Math.ceil(ms / 86_400_000);
  if (ms >= 86_400_000) return `resets in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return `resets in ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Each chat's limit, what's left this period, and when it resets, read from the contract. */
export function readStatuses(client: PublicClient, treasury: Hex, account: Hex, chats: ChatRef[]): Promise<ChatStatus[]> {
  return Promise.all(
    chats.map(async (chat): Promise<ChatStatus> => {
      const [member, left, resetsAt] = await Promise.all([
        client.readContract({ address: treasury, abi: treasuryAbi, functionName: "members", args: [chat.group, account] }),
        client.readContract({ address: treasury, abi: treasuryAbi, functionName: "remaining", args: [chat.group, account] }),
        client.readContract({ address: treasury, abi: treasuryAbi, functionName: "resetsAt", args: [chat.group, account] }),
      ]);
      return { chat, active: member[0], period: member[1], limit: member[2], left, resetsAt };
    }),
  );
}

/** "a week", "a month", or "one time". */
export const perText = (period: number) => (period === 0 ? "a week" : period === 1 ? "a month" : "one time");

/** Fills `#kitties` with one row per chat. `balance` is in 6-decimal USDC units. */
export async function showSnapshot(client: PublicClient, treasury: Hex, account: Hex, chats: ChatRef[], balance?: bigint): Promise<void> {
  const box = document.getElementById("kitties");
  const list = document.getElementById("kitty-list");
  const note = document.getElementById("kitty-note");
  if (!box || !list || !note || chats.length === 0) return;

  const statuses = await readStatuses(client, treasury, account, chats);

  list.replaceChildren(
    ...statuses.map((s) => {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      title.textContent = s.chat.name;
      const detail = document.createElement("span");
      if (!s.active) detail.textContent = "not in this one";
      else {
        detail.textContent = `${usd(s.left)} left of ${usd(s.limit)} ${perText(s.period)} · ${resetText(s.period, s.resetsAt)}`;
      }
      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("i");
      const pct = s.active && s.limit > 0n ? Number((s.left * 100n) / s.limit) : 0;
      fill.style.width = `${pct}%`;
      bar.append(fill);
      row.append(title, detail, bar);
      return row;
    }),
  );

  const canTake = statuses.filter((s) => s.active).reduce((sum, s) => sum + s.left, 0n);
  note.textContent =
    balance !== undefined && canTake > balance
      ? `Your chats can take up to ${usd(canTake)} right now and you have ${usd(balance)}. Add money so your shares go through.`
      : "";
  box.hidden = false;
}
