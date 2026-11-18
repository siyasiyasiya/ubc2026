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
import { createPublicClient, encodeFunctionData, isHex, maxUint256, parseUnits, type Hex } from "viem";
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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const button = $<HTMLButtonElement>("go");
const status = $<HTMLParagraphElement>("status");

function show(text: string, kind: "info" | "error" | "done" = "info"): void {
  status.textContent = text;
  status.dataset.kind = kind;
}

function setup(): void {
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

/** Unlocks the passkey this browser used before, or creates a new one. */
async function passkey(): Promise<WebAuthnCredential> {
  const transport = toPasskeyTransport(clientUrl, clientKey);
  const saved = localStorage.getItem(CREDENTIAL_KEY);
  if (saved) {
    return toWebAuthnCredential({ transport, mode: WebAuthnMode.Login, credentialId: saved });
  }
  try {
    // A passkey synced from another device (iCloud Keychain) logs straight in.
    return await toWebAuthnCredential({ transport, mode: WebAuthnMode.Login });
  } catch {
    // Shown by iOS when saving the passkey, so keep it human.
    const username = `${name || "Kitty"} (${chatName}) ${crypto.randomUUID().slice(0, 4)}`;
    return toWebAuthnCredential({ transport, mode: WebAuthnMode.Register, username });
  }
}

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const data = new FormData(form);
  const usd = String(data.get("amount") ?? "").trim();
  const period = data.get("period") === "monthly" ? 1 : 0;
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) return show("Enter an amount like 50 or 50.00.", "error");
  const limit = parseUnits(usd, 6); // USDC has 6 decimals; never a float

  button.disabled = true;
  try {
    show("Waiting for Face ID…");
    const credential = await passkey();
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

setup();
form.addEventListener("submit", (e) => void submit(e));
