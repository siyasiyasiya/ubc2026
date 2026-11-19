/**
 * The Face ID link the agent DMs a member. Two modes, chosen by the URL:
 *   ?g=<group>&t=<ticket>&c=<chat name>&n=<name>   join this chat's treasury (first time per chat)
 *   ?g=<group>&c=<chat name>                       change my limit for this chat
 *
 * Face ID creates (or unlocks) the member's Circle passkey wallet, then one gasless batched user
 * operation approves USDC for the GroupTreasury and joins / sets the limit. The page has no
 * backend: the agent's server sees the `Joined` event and matches the ticket to the member.
 */

import {
  toCircleSmartAccount,
  toModularTransport,
  toPasskeyTransport,
  toWebAuthnCredential,
  WebAuthnMode,
  ContractAddress,
  type WebAuthnCredential,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, isHex, maxUint256, parseUnits, type Hex } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { arcTestnet } from "viem/chains";
import { erc20Abi, treasuryAbi } from "./abi";

const clientKey = import.meta.env.VITE_CLIENT_KEY as string;
const clientUrl = (import.meta.env.VITE_CLIENT_URL as string) || "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
const treasury = import.meta.env.VITE_TREASURY_ADDRESS as Hex;
const usdc = ContractAddress.ArcTestnet_USDC as Hex;
const CREDENTIAL_KEY = "gta.passkey";

const params = new URLSearchParams(location.search);
const group = params.get("g") ?? "";
const ticket = params.get("t") ?? "";
const chatName = params.get("c") ?? "this chat";
const name = params.get("n") ?? "";
const joining = ticket !== "";
/** Top-up link from Kitty ("you're $12 short"): ?a=<account>&c=<chat name>. */
const topUpAccount = params.get("a") ?? "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const button = $<HTMLButtonElement>("go");
const status = $<HTMLParagraphElement>("status");

function show(text: string, kind: "info" | "error" | "done" = "info"): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function setup(): void {
  if (topUpAccount && !group) {
    $("title").textContent = "Add money";
    $("lede").textContent = "Top up your Kitty balance with Apple Pay or a debit card.";
    form.hidden = true;
    if (!isAddress(topUpAccount)) return show("This link is incomplete. Ask Kitty for a new one.", "error");
    void showFunding(topUpAccount as Hex);
    return;
  }
  $("title").textContent = joining ? `Join ${chatName}` : `Your limit for ${chatName}`;
  $("lede").textContent = joining
    ? `${name ? `Hi ${name}! ` : ""}Set the most ${chatName} can spend from you. It resets on its own, and only you can raise it.`
    : `Change the most ${chatName} can spend from you.`;
  button.textContent = joining ? "Join with Face ID" : "Save with Face ID";
  if (!isHex(group) || group.length !== 66 || (joining && (!isHex(ticket) || ticket.length !== 66))) {
    show("This link is incomplete. Ask Kitty in your chat for a new one.", "error");
    button.disabled = true;
  } else if (!clientKey || !treasury) {
    console.error("missing VITE_CLIENT_KEY or VITE_TREASURY_ADDRESS");
    show("Something's not set up on our end. Try again in a bit.", "error");
    button.disabled = true;
  }
}

/** Circle usernames: 5-50 chars of [A-Za-z0-9_@.:+-]. iOS shows it when saving the passkey. */
function passkeyUsername(): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_@.:+-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = [clean(name), clean(chatName)].filter(Boolean).join("-").slice(0, 38) || "Kitty";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * Unlocks this browser's saved passkey, or makes a new one. A first-time member registers
 * straight away: trying a login first and falling back would make Safari drop the tap that
 * allows the Face ID prompt. Returning members on a new device use "Used Kitty before?".
 */
async function passkey(returning: boolean): Promise<WebAuthnCredential> {
  const transport = toPasskeyTransport(clientUrl, clientKey);
  const saved = localStorage.getItem(CREDENTIAL_KEY);
  if (saved) return toWebAuthnCredential({ transport, mode: WebAuthnMode.Login, credentialId: saved });
  if (returning) return toWebAuthnCredential({ transport, mode: WebAuthnMode.Login });
  return toWebAuthnCredential({ transport, mode: WebAuthnMode.Register, username: passkeyUsername() });
}

async function submit(event: Event, returning = false): Promise<void> {
  event.preventDefault();
  const data = new FormData(form);
  const usd = String(data.get("amount") ?? "").trim();
  const period = data.get("period") === "monthly" ? 1 : 0;
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) return show("Enter an amount like 50 or 50.00.", "error");
  const limit = parseUnits(usd, 6); // USDC has 6 decimals; never a float

  button.disabled = true;
  try {
    show("Waiting for Face ID…");
    const credential = await passkey(returning);
    localStorage.setItem(CREDENTIAL_KEY, credential.id);

    const transport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createPublicClient({ chain: arcTestnet, transport });
    const account = await toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) });
    const bundler = createBundlerClient({ account, chain: arcTestnet, transport });

    const [member, allowance] = await Promise.all([
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "members", args: [group as Hex, account.address] }),
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, treasury] }),
    ]);
    const alreadyIn = member[0];

    const calls: { to: Hex; data: Hex }[] = [];
    // One approval covers every chat; the contract's per-chat limit is what caps each pull.
    if (allowance < maxUint256 / 2n) {
      calls.push({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [treasury, maxUint256] }) });
    }
    calls.push(
      joining && !alreadyIn
        ? { to: treasury, data: encodeFunctionData({ abi: treasuryAbi, functionName: "join", args: [group as Hex, limit, period, ticket as Hex] }) }
        : { to: treasury, data: encodeFunctionData({ abi: treasuryAbi, functionName: "setLimit", args: [group as Hex, limit, period] }) },
    );

    show("Saving…");
    const hash = await bundler.sendUserOperation({ calls, paymaster: true });
    const { receipt, success } = await bundler.waitForUserOperationReceipt({ hash });
    if (!success) throw new Error("The transaction didn't go through.");

    // Chain details are for debugging only; members never see them.
    console.info("account", account.address, "tx", receipt.transactionHash);
    const per = period === 1 ? "month" : "week";
    show(
      `${joining && !alreadyIn ? `You're in ${chatName}! ` : "Saved. "}Up to $${usd} a ${per}.\nYou can head back to Messages.`,
      "done",
    );
    form.hidden = true;
    void showFunding(account.address);
  } catch (err) {
    console.error(err);
    const message = (err as Error).message ?? String(err);
    show(
      /TicketUsed/.test(message)
        ? "This invite was already used. Ask Kitty in your chat for a new link."
        : /NotAllowedError|cancel/i.test(message)
          ? "Face ID was cancelled. Tap the button to try again."
          : "That didn't go through. Tap the button to try again.",
      "error",
    );
    button.disabled = false;
  }
}

const arc = createPublicClient({ chain: arcTestnet, transport: http() });

/** Dollars in the account. USDC is Arc's native currency, read here with 18 decimals. */
async function balance(address: Hex): Promise<bigint> {
  return arc.getBalance({ address });
}

function dollars(wei: bigint): string {
  return `$${Number(formatUnits(wei, 18)).toFixed(2)}`;
}

/**
 * Shows the balance and an "Add money" button. The Arc Onramp session is fetched up front so the
 * button can be a plain link: opening a window after an await gets blocked on iOS. The money goes
 * from Apple Pay / debit card straight to the member's own account; Kitty never holds it.
 */
async function showFunding(address: Hex): Promise<void> {
  const fund = $("fund");
  const balanceText = $("balance");
  const add = $<HTMLAnchorElement>("add");
  fund.hidden = false;

  let start = 0n;
  try {
    start = await balance(address);
    balanceText.textContent = `Balance: ${dollars(start)}`;
  } catch (err) {
    console.error(err);
  }

  try {
    const res = await fetch("/api/onramp-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const body = (await res.json()) as { widgetUrl?: string; error?: string };
    if (!res.ok || !body.widgetUrl) throw new Error(body.error ?? `HTTP ${res.status}`);
    add.href = body.widgetUrl;
    add.removeAttribute("aria-disabled");
  } catch (err) {
    console.error("onramp session", err);
    add.hidden = true;
    balanceText.textContent += " · Adding money isn't available right now.";
    return;
  }

  // Watch for the top-up to land; delivered amounts are net of provider fees.
  add.addEventListener("click", () => {
    balanceText.textContent = "Waiting for your top-up…";
    const timer = setInterval(async () => {
      try {
        const now = await balance(address);
        if (now > start) {
          clearInterval(timer);
          balanceText.textContent = `Added ${dollars(now - start)}. Balance: ${dollars(now)}`;
          balanceText.dataset.kind = "done";
        }
      } catch (err) {
        console.error(err);
      }
    }, 5000);
    setTimeout(() => clearInterval(timer), 15 * 60 * 1000);
  }, { once: true });
}

setup();
form.addEventListener("submit", (e) => void submit(e));
$("returning").addEventListener("click", (e) => void submit(e, true));
