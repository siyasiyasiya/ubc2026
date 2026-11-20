/**
 * The Face ID link the agent DMs a member. Two modes, chosen by the URL:
 *   ?g=<group>&t=<ticket>&c=<chat name>&n=<name>   join this chat's treasury (first time per chat)
 *   ?g=<group>&c=<chat name>[&l=<usd>&p=<period>]  change my limit for this chat (prefilled)
 *   ?g=<group>&c=<chat name>&r=<payee>&o=<name>    pay back a share that didn't go through
 *   ?a=<account>&c=<chat name>                     add money
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
import { createPublicClient, encodeFunctionData, formatUnits, http, isAddress, isHex, maxUint256, parseUnits, type Hex, type PublicClient } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { arcTestnet } from "viem/chains";
import { erc20Abi, treasuryAbi } from "./abi";
import { Dashboard } from "./dashboard";
import { chatsFromLink, rememberChats, showSnapshot } from "./snapshot";
import { subscriptionsFromLink } from "./subscriptions";

const clientKey = import.meta.env.VITE_CLIENT_KEY as string;
const clientUrl = (import.meta.env.VITE_CLIENT_URL as string) || "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";
const treasury = import.meta.env.VITE_TREASURY_ADDRESS as Hex;
const usdc = ContractAddress.ArcTestnet_USDC as Hex;
const CREDENTIAL_KEY = "kitty.passkey.v2";

const params = new URLSearchParams(location.search);
const group = params.get("g") ?? "";
const ticket = params.get("t") ?? "";
const chatName = params.get("c") ?? "this chat";
const name = params.get("n") ?? "";
const joining = ticket !== "";
/** Top-up link from Kitty ("you're $12 short"): ?a=<account>&c=<chat name>. */
const topUpAccount = params.get("a") ?? "";
/** Pay-back link: who the member owes (their account) and their name. */
const creditor = params.get("r") ?? "";
const creditorName = params.get("o") ?? "them";
/** Opened from the dashboard (to change a cap): type the amount, and come back to the dashboard after. */
const fromDashboard = params.get("from") === "v1";
/** Every chat this phone has seen a link for, newest names first. */
const chats = rememberChats(chatsFromLink(params));
/** Subscriptions from Kitty's link, or the last list this phone saw. */
const subscriptions = subscriptionsFromLink(params);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const button = $<HTMLButtonElement>("go");
const status = $<HTMLParagraphElement>("status");

function show(text: string, kind: "info" | "error" | "done" = "info"): void {
  status.textContent = text;
  status.dataset.kind = kind;
  // A finished step sends the member back to the chat, where Kitty picks it up.
  $("back").hidden = kind !== "done";
  // The setup text no longer applies once it's done; the check and message replace it.
  $("lede").hidden = kind === "done";
}

/** Quick-pick amounts and the Weekly / Monthly / One time control both write to the real form fields. */
function wireAmountPickers(): void {
  const amount = $<HTMLInputElement>("amount");
  const select = form.querySelector<HTMLSelectElement>("select")!;
  const chips = [...document.querySelectorAll<HTMLButtonElement>("#presets button")];
  const periods = [...document.querySelectorAll<HTMLButtonElement>("#periods button")];
  const sync = () => {
    for (const chip of chips) chip.setAttribute("aria-pressed", String(chip.dataset.usd === amount.value.trim()));
    for (const p of periods) p.setAttribute("aria-pressed", String(p.dataset.period === select.value));
    showCycle();
    labelButton();
  };
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      amount.value = chip.dataset.usd!;
      sync();
    });
  }
  for (const p of periods) {
    p.addEventListener("click", () => {
      select.value = p.dataset.period!;
      sync();
    });
  }
  amount.addEventListener("input", sync);
  sync();
}

/** "$80" big, "per week" smaller beside it. */
function showBigAmount(): void {
  const usd = $<HTMLInputElement>("amount").value.trim();
  const per = document.createElement("span");
  per.className = "per";
  per.textContent = ` ${perWords(form.querySelector<HTMLSelectElement>("select")!.value)}`;
  $("big").replaceChildren(`$${Number(usd).toLocaleString("en-US")}`, per);
}

function setup(): void {
  if (group) $("chat").textContent = chatName;
  if (creditor) return setupPayBack();
  if (params.get("v") === "1") return setupStatus();
  const amount = $<HTMLInputElement>("amount");
  const prefill = params.get("l");
  if (prefill && /^\d+(\.\d{1,2})?$/.test(prefill)) amount.value = prefill;
  const asked = params.get("p");
  if (asked === "monthly" || asked === "once") form.querySelector<HTMLSelectElement>("select")!.value = asked;
  // Typing replaces the amount rather than adding digits to it ("100" + "50" became $10,050).
  amount.addEventListener("focus", () => amount.select());
  wireAmountPickers();
  if (topUpAccount && !group) {
    $("title").textContent = "Add money";
    $("lede").textContent = "Top up your Kitty balance with Apple Pay or a debit card.";
    form.hidden = true;
    if (!isAddress(topUpAccount)) return show("This link is incomplete. Ask Kitty for a new one.", "error");
    void showFunding(topUpAccount as Hex);
    return;
  }
  $("title").textContent = joining ? `Join ${chatName}` : `Spending cap for ${chatName}`;
  // One tap: the amount was decided in the chat and came in the link, so there's nothing to type.
  oneTap = Boolean(prefill && /^\d+(\.\d{1,2})?$/.test(prefill)) && !fromDashboard;
  $("lede").textContent = joining
    ? `${name ? `Hi ${name}! ` : ""}Kitty only uses your money when the group 👍s something, and never more than this. Only you can raise it.`
    : `The most Kitty can ever take from you for ${chatName}. Only you can raise it.`;
  if (fromDashboard) {
    $("back").textContent = "Back to your kitties";
    ($("back") as HTMLAnchorElement).href = dashboardLink(`#kitty/${group}`);
  }
  if (oneTap) {
    $("summary").hidden = false;
    $("fields").hidden = true;
    showBigAmount();
    $("change").addEventListener("click", (e) => {
      e.preventDefault();
      oneTap = false;
      $("summary").hidden = true;
      $("fields").hidden = false;
      amount.focus();
      labelButton();
    });
  }
  $("how").hidden = !joining;
  labelButton();
  if (!isHex(group) || group.length !== 66 || (joining && (!isHex(ticket) || ticket.length !== 66))) {
    show("This link is incomplete. Ask Kitty in your chat for a new one.", "error");
    button.disabled = true;
  } else if (!clientKey || !treasury) {
    console.error("missing VITE_CLIENT_KEY or VITE_TREASURY_ADDRESS");
    show("Something's not set up on our end. Try again in a bit.", "error");
    button.disabled = true;
  }
}

let oneTap = false;

/** The cap's cycle: "per week", "per month", or "one time" (a trip or a single purchase). */
function perWords(period: string): string {
  return period === "monthly" ? "per month" : period === "once" ? "one time" : "per week";
}

/** Says whether the cap comes back, so a weekly cap isn't read as a one-off charge (or the reverse). */
function cycleNote(period: string): string {
  return period === "monthly"
    ? "Resets every month."
    : period === "once"
      ? "Doesn't reset. For one trip or purchase."
      : "Resets every week.";
}

function showCycle(): void {
  const note = cycleNote(form.querySelector<HTMLSelectElement>("select")!.value);
  $("cycle").textContent = note;
  $("cycle-typed").textContent = note;
}

/** "$80 cap" from the form, or "" while the amount isn't valid. The cycle is right above the button. */
function amountText(): string {
  const usd = $<HTMLInputElement>("amount").value.trim();
  return /^\d+(\.\d{1,2})?$/.test(usd) ? `$${Number(usd).toLocaleString("en-US")} cap` : "";
}

/** The button names the exact amount (unless it's shown big above), so a typo is visible before Face ID. */
function labelButton(): void {
  const shown = oneTap ? "" : amountText();
  const verb = joining ? "Join" : oneTap ? "Confirm" : "Save";
  // The button carries a Face ID glyph, so a long amount drops the words to stay on one line.
  button.textContent = shown ? `${verb} · ${shown}` : `${verb} with Face ID`;
}

/** An amount far above what the chat asked for (or over $1,000) needs a second tap. */
let confirmedUsd = "";
function looksOff(usd: string): boolean {
  const asked = Number(params.get("l") ?? "0");
  const value = Number(usd);
  return usd !== confirmedUsd && (value > 1000 || (asked > 0 && value > asked * 5));
}

/** Circle usernames: 5-50 chars of [A-Za-z0-9_@.:+-]. iOS shows it when saving the passkey. */
function passkeyUsername(): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_@.:+-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = [clean(name), clean(chatName)].filter(Boolean).join("-").slice(0, 38) || "Kitty";
  return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/**
 * Gets this member's passkey. A returning member's credential (its id and public key, neither
 * secret) is remembered on this device, so the only Face ID is the one that signs the change.
 * A first-time member registers straight away: trying a login first and falling back would make
 * Safari drop the tap that allows the prompt. "Used Kitty before?" logs in from a synced passkey.
 */
async function passkey(returning: boolean): Promise<WebAuthnCredential> {
  const transport = toPasskeyTransport(clientUrl, clientKey);
  const remembered = readCredential();
  if (remembered) return remembered;
  const legacyId = readLegacyId();
  const credential = legacyId
    ? await toWebAuthnCredential({ transport, mode: WebAuthnMode.Login, credentialId: legacyId })
    : returning
    ? await toWebAuthnCredential({ transport, mode: WebAuthnMode.Login })
    : await toWebAuthnCredential({ transport, mode: WebAuthnMode.Register, username: passkeyUsername() });
  saveCredential(credential);
  return credential;
}

function readCredential(): WebAuthnCredential | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(CREDENTIAL_KEY) ?? "null") as { id?: string; publicKey?: string } | null;
    if (saved?.id && saved.publicKey && isHex(saved.publicKey)) {
      return { id: saved.id, publicKey: saved.publicKey } as WebAuthnCredential;
    }
  } catch {
    // Older pages stored only the credential id, or storage is blocked: fall through to Face ID.
  }
  return undefined;
}

/** Pages before Nov 18 stored only the credential id; log in with it once rather than make a second account. */
function readLegacyId(): string | undefined {
  try {
    return localStorage.getItem("gta.passkey") ?? undefined;
  } catch {
    return undefined;
  }
}

function saveCredential(credential: WebAuthnCredential): void {
  try {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ id: credential.id, publicKey: credential.publicKey }));
  } catch {
    // Private browsing: the member just gets one extra Face ID next time.
  }
}

async function submit(event: Event, returning = false): Promise<void> {
  event.preventDefault();
  const data = new FormData(form);
  const usd = String(data.get("amount") ?? "").trim();
  // The contract's Period enum: Weekly, Monthly, Once.
  const periodName = String(data.get("period") ?? "weekly");
  const period = periodName === "monthly" ? 1 : periodName === "once" ? 2 : 0;
  if (!/^\d+(\.\d{1,2})?$/.test(usd)) return show("Enter an amount like 50 or 50.00.", "error");
  const limit = parseUnits(usd, 6); // USDC has 6 decimals; never a float
  if (looksOff(usd)) {
    confirmedUsd = usd;
    return show(`That's $${Number(usd).toLocaleString("en-US")} ${perWords(periodName)}. Tap again if that's right.`, "error");
  }

  button.disabled = true;
  try {
    show("Waiting for Face ID…");
    const credential = await passkey(returning);

    const transport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
    const client = createPublicClient({ chain: arcTestnet, transport });
    const account = await toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) });
    const bundler = createBundlerClient({ account, chain: arcTestnet, transport });

    const [member, allowance] = await Promise.all([
      client.readContract({ address: treasury, abi: treasuryAbi, functionName: "members", args: [group as Hex, account.address] }),
      client.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, treasury] }),
    ]);
    const alreadyIn = member[0];
    // An old invite reopened after joining must not quietly reset the limit to the link's amount
    // (it put Joey back to $200). Changing a limit only happens from a limit link.
    if (joining && alreadyIn) {
      form.hidden = true;
      show(`You're already in ${chatName}. To change your spending cap, ask Kitty in the chat.`, "done");
      void showFunding(account.address);
      return;
    }

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
    const per = perWords(periodName);
    show(
      `${joining && !alreadyIn ? `You're in ${chatName}! 🎉` : "Saved."}\nSpending cap: $${Number(usd).toLocaleString("en-US")} ${per}.\n${cycleNote(periodName)}`,
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

/** The dashboard, with every chat this phone knows (the contract only knows chats as hashes). */
function dashboardLink(hash = ""): string {
  const url = new URL(location.href);
  url.search = "";
  url.hash = hash;
  url.searchParams.set("v", "1");
  for (const c of chats) url.searchParams.append("k", `${c.group}:${c.name}`);
  return url.toString();
}

/**
 * "Your kitties" link (?v=1&k=<group>:<name>…): the dashboard. A phone that used Kitty
 * before remembers the passkey, so it opens with no prompt; otherwise one Face ID tap to sign in.
 */
function setupStatus(): void {
  $("title").textContent = "Your kitties";
  $("lede").textContent = "Your balance, every group chat you're in, and everything you've paid.";
  form.hidden = true;
  const see = $<HTMLButtonElement>("see");
  const open = async () => {
    see.disabled = true;
    try {
      show(readCredential() ? "Loading…" : "Waiting for Face ID…");
      const { account, client } = await connect(true);
      see.hidden = true;
      show("");
      $("lede").hidden = true;
      void showFunding(account.address, false);
      // `client` is typed for the Arc chain; the dashboard only needs reads, so the generic chain type is dropped.
      await new Dashboard({ client: client as unknown as PublicClient, treasury, account: account.address, chats, params, subscriptions }).start();
    } catch (err) {
      console.error(err);
      show("Couldn't sign in. Tap to try again.", "error");
      see.hidden = false;
    } finally {
      see.disabled = false;
    }
  };
  see.addEventListener("click", () => void open());
  // Local preview only (`pnpm dev`, ?v=1&as=<address>): renders any account's public chain data without
  // Face ID. Vite drops this branch from production builds.
  const previewAs = import.meta.env.DEV ? params.get("as") : null;
  if (previewAs && isAddress(previewAs)) {
    $("lede").hidden = true;
    void showFunding(previewAs as Hex, false);
    void new Dashboard({ client: arc as unknown as PublicClient, treasury, account: previewAs as Hex, chats, params, subscriptions }).start();
    return;
  }
  if (readCredential()) void open();
  else see.hidden = false;
}

/** Unlocks the member's Kitty account: their passkey, smart account, and a gasless bundler. */
async function connect(returning: boolean) {
  const credential = await passkey(returning);
  const transport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
  const client = createPublicClient({ chain: arcTestnet, transport });
  const account = await toCircleSmartAccount({ client, owner: toWebAuthnAccount({ credential }) });
  const bundler = createBundlerClient({ account, chain: arcTestnet, transport });
  return { client, account, bundler };
}

/**
 * Pay-back mode. First tap unlocks the account and shows what's owed (and "Add money" when the
 * balance is short); second tap pays it back from the member's own account with Face ID.
 */
function setupPayBack(): void {
  $("title").textContent = `Pay ${creditorName} back`;
  $("lede").textContent = `A share in ${chatName} didn't go through, so you owe ${creditorName}:`;
  form.hidden = true;
  const pay = $<HTMLButtonElement>("pay");
  const owedText = $("owed");
  $("payback").hidden = false;
  // The link says how much (for display); the tap reads what's really owed before paying.
  const shown = params.get("m");
  if (shown && /^\d+(\.\d{1,2})?$/.test(shown)) owedText.textContent = `$${shown}`;
  // The button's Face ID glyph says how; the words stay on one line.
  pay.textContent = `Pay ${creditorName} back`;
  if (!isAddress(creditor) || !clientKey || !treasury) {
    pay.disabled = true;
    return show("This link is incomplete. Ask Kitty in your chat for a new one.", "error");
  }

  let session: Awaited<ReturnType<typeof connect>> | undefined;
  pay.addEventListener("click", async () => {
    pay.disabled = true;
    try {
      // A remembered passkey needs no prompt here; the Face ID is for signing the payment below.
      session ??= await connect(true);
      const owed = await session.client.readContract({
        address: treasury,
        abi: treasuryAbi,
        functionName: "debts",
        args: [session.account.address, creditor as Hex],
      });
      if (owed === 0n) {
        owedText.textContent = "All square 🎉";
        pay.hidden = true;
        return show(`You don't owe ${creditorName} anything.`, "done");
      }
      owedText.textContent = `$${formatUnits(owed, 6)}`;
      // USDC is native on Arc (18 decimals); the debt is in 6-decimal USDC units.
      if ((await balance(session.account.address)) < owed * 10n ** 12n) {
        void showFunding(session.account.address);
        pay.textContent = "I added money · Pay with Face ID";
        return show("Your balance is short. Add money below, then tap again.", "error");
      }
      show("Waiting for Face ID…");
      const hash = await session.bundler.sendUserOperation({
        calls: [{ to: treasury, data: encodeFunctionData({ abi: treasuryAbi, functionName: "payDebt", args: [creditor as Hex, owed] }) }],
        paymaster: true,
      });
      show("Paying…");
      const { receipt, success } = await session.bundler.waitForUserOperationReceipt({ hash });
      if (!success) throw new Error("The transaction didn't go through.");
      console.info("paid back", receipt.transactionHash);
      owedText.textContent = "All square 🎉";
      pay.hidden = true;
      show(`Paid ${creditorName} back $${formatUnits(owed, 6)}. You can head back to Messages.`, "done");
    } catch (err) {
      console.error(err);
      const message = (err as Error).message ?? String(err);
      show(/NotAllowedError|cancel/i.test(message) ? "Face ID was cancelled. Tap to try again." : "That didn't go through. Tap to try again.", "error");
    } finally {
      pay.disabled = false;
    }
  });
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
async function showFunding(address: Hex, snapshot = true): Promise<void> {
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
  // Every chat the link lists, signed-in or not ("?a=" top-up links know the account too).
  // `arc` is typed for the Arc chain; the snapshot only needs readContract, so the generic chain type is dropped.
  if (snapshot) {
    showSnapshot(arc as unknown as Parameters<typeof showSnapshot>[0], treasury, address, chatsFromLink(params), start / 10n ** 12n).catch((err) => console.error("snapshot", err));
    // Everything else (history, other kitties, caps) is one tap away.
    const all = $<HTMLAnchorElement>("all");
    all.href = dashboardLink();
    all.hidden = false;
  }

  void offerTestMoney(address, balanceText, add);

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

/**
 * Testnet: "Add $20 test money" sends real test USDC on Arc from the team's faucet wallet
 * (/api/test-money), so the add-money step works end to end before Onramp is live. Only on links
 * with `test=1` (the team's own): members, and the demo, see the real Apple Pay / card flow.
 */
async function offerTestMoney(address: Hex, balanceText: HTMLElement, add: HTMLAnchorElement): Promise<void> {
  const test = $<HTMLAnchorElement>("test");
  if (params.get("test") !== "1") return;
  try {
    const res = await fetch("/api/test-money");
    if (!res.ok || !((await res.json()) as { on?: boolean }).on) return;
  } catch {
    return;
  }
  test.hidden = false;
  add.classList.add("soft");
  test.addEventListener("click", async (e) => {
    e.preventDefault();
    test.setAttribute("aria-disabled", "true");
    test.textContent = "Adding test money…";
    try {
      const res = await fetch("/api/test-money", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json()) as { added?: number; balance?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      balanceText.textContent = `Added $${body.added} of test money. Balance: $${body.balance?.toFixed(2)}`;
      balanceText.dataset.kind = "done";
    } catch (err) {
      balanceText.textContent = (err as Error).message;
      delete balanceText.dataset.kind;
    }
    // Tap again for more.
    test.textContent = "Add $20 test money";
    test.removeAttribute("aria-disabled");
  });
}

setup();
form.addEventListener("submit", (e) => void submit(e));
$("returning").addEventListener("click", (e) => void submit(e, true));
