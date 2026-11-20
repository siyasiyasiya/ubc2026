/**
 * The dashboard ("Your kitties", ?v=1): balance and add money, every kitty with its cap, one
 * kitty's purchases and cap history, and the member's own activity across all of them.
 *
 * Views are hash routes so the phone's back gesture works: "" (kitties), "#activity", and
 * "#kitty/<group id>". Changing a cap opens the existing cap page (one Face ID tap) and comes back.
 */

import type { Hex, PublicClient } from "viem";
import { treasuryAbi } from "./abi";
import { cachedHistory, loadHistory, type Entry, type History, type Kitty, type Purchase } from "./history";
import { perText, readStatuses, resetText, type ChatRef, type ChatStatus } from "./snapshot";

export interface DashboardDeps {
  client: PublicClient;
  treasury: Hex;
  account: Hex;
  /** Chats known from links (this one and earlier ones on this phone). */
  chats: ChatRef[];
  /** The page's own URL params, carried into the links this view makes. */
  params: URLSearchParams;
}

/** Whole cents from 6-decimal USDC, rounded half up, as "$1,234.50" (or "$12" when `short` and whole). */
export function money(units: bigint, short = false): string {
  const negative = units < 0n;
  const cents = ((negative ? -units : units) + 5_000n) / 10_000n;
  const dollars = (cents / 100n).toLocaleString("en-US");
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${short && rest === "00" ? dollars : `${dollars}.${rest}`}`;
}

/** "12.5" -> "12.50", whole dollars as "12": the plain amount the page's own links carry (`l=`, `m=`). */
export function plain(units: bigint): string {
  return money(units, true).replace(/[$,]/g, "");
}

/** "Today 3:04 PM", "Yesterday 9:10 AM", "Mon 2:00 PM", or "Nov 3". */
export function when(seconds: number, now = Date.now()): string {
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const per = (period?: number) => (period === 1 ? "per month" : period === 2 ? "one time" : "per week");

/** Why a share didn't move, in words a member gets. */
function missedWhy(reason?: string): string {
  return reason === "over limit" ? "it was over your cap" : "your balance was short";
}

/** The title, detail line, and amount for one activity entry. `name` turns a group id into its chat name. */
export function describe(e: Entry, name: (group?: Hex) => string): { title: string; detail: string; amount: string; tone: "in" | "out" | "owe" | "" } {
  const chat = e.group ? name(e.group) : "";
  const amount = e.amount === undefined ? "" : `${e.amount > 0n ? "+" : ""}${money(e.amount)}`;
  switch (e.kind) {
    case "added":
      return { title: "Added money", detail: "To your Kitty balance", amount, tone: "in" };
    case "sent":
      return { title: "Sent", detail: "From your Kitty balance", amount, tone: "out" };
    case "share":
      return { title: "Your share", detail: chat, amount, tone: "out" };
    case "got":
      return { title: "Paid to you", detail: chat || "A member paid you back", amount, tone: "in" };
    case "repaid":
      return { title: "Paid back a missed share", detail: "From your Kitty balance", amount, tone: "out" };
    case "owe":
      return { title: "Missed share", detail: `${chat ? `${chat} · ` : ""}${missedWhy(e.reason)}`, amount: `${money(e.amount ?? 0n)} owed`, tone: "owe" };
    case "joined":
      return { title: `Joined ${chat}`, detail: `Cap ${money(e.limit ?? 0n, true)} ${per(e.period)}`, amount: "", tone: "" };
    case "limit":
      return {
        title: e.byKitty ? "Kitty lowered your cap" : "Changed your cap",
        detail: `${chat ? `${chat} · ` : ""}${money(e.limit ?? 0n, true)} ${per(e.period)}`,
        amount: "",
        tone: "",
      };
    case "left":
      return { title: e.byKitty ? `Removed from ${chat}` : `Left ${chat}`, detail: "", amount: "", tone: "" };
  }
}

/** One purchase in a kitty: what happened, and this member's part of it. */
export function describePurchase(p: Purchase, account: string): { title: string; detail: string; amount: string; tone: "in" | "out" | "owe" | "" } {
  const status =
    p.status === "cancelled"
      ? "Cancelled"
      : p.status === "waiting"
        ? `Waiting for 👍s`
        : p.owed > 0n
          ? p.pulled === 0n
            ? "No shares went through"
            : `${money(p.owed)} still owed`
          : "Paid";
  const payee = p.payee.toLowerCase() === account.toLowerCase() ? " · paid to you" : "";
  const detail = `${money(p.total)} total · ${status}${payee}`;
  if (p.mine && !p.mine.ok) return { title: "Purchase", detail, amount: `${money(p.mine.amount)} owed`, tone: "owe" };
  if (p.mine) return { title: "Purchase", detail, amount: `-${money(p.mine.amount)}`, tone: "out" };
  if (p.toMe > 0n) return { title: "Purchase", detail, amount: `+${money(p.toMe)}`, tone: "in" };
  return { title: "Purchase", detail, amount: "", tone: "" };
}

/** Names that only mean "a chat we couldn't name" (older links and pages used these). */
export function isPlaceholder(name: string): boolean {
  return /^(|group|a group chat|this chat)$/i.test(name.trim());
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** One row of a feed: title and detail on the left, amount on the right. */
function row(item: { title: string; detail: string; amount: string; tone: string }, time: number): HTMLLIElement {
  const li = el("li");
  const text = el("div");
  text.append(el("strong", undefined, item.title), el("span", undefined, [item.detail, when(time)].filter(Boolean).join(" · ")));
  li.append(text);
  if (item.amount) {
    const amount = el("b", "amt", item.amount);
    if (item.tone) amount.dataset.tone = item.tone;
    li.append(amount);
  }
  return li;
}

function empty(list: HTMLElement, text: string): void {
  list.replaceChildren(el("li", "empty", text));
}

export class Dashboard {
  private history?: History;
  private statuses: ChatStatus[] = [];
  private chats: ChatRef[];
  private failed = false;

  constructor(private readonly deps: DashboardDeps) {
    this.chats = deps.chats;
    // Show what this phone loaded last time straight away; the fresh copy replaces it.
    this.history = cachedHistory(deps.treasury, deps.account);
  }

  /** Shows the dashboard and loads everything. Safe to call again to refresh. */
  async start(): Promise<void> {
    $("dash").hidden = false;
    document.querySelector("main")?.classList.add("wide");
    // The balance and add-money buttons sit at the top of the home view.
    $("dash-home").prepend($("fund"));
    for (const tab of document.querySelectorAll<HTMLButtonElement>("#dash-tabs button")) {
      tab.addEventListener("click", () => {
        location.hash = tab.dataset.tab === "activity" ? "activity" : "";
      });
    }
    $("k-back").addEventListener("click", (e) => {
      e.preventDefault();
      if (history.length > 1 && location.hash.startsWith("#kitty/")) history.back();
      else location.hash = "";
    });
    $("dash-retry").addEventListener("click", () => void this.load());
    addEventListener("hashchange", () => this.render());
    this.render();
    await this.load();
  }

  private async load(): Promise<void> {
    const { client, treasury, account } = this.deps;
    this.failed = false;
    $("dash-error").hidden = true;
    this.render();
    // Limits come from the contract (always current); history comes from the explorer, which can lag or fail.
    const [history] = await Promise.allSettled([
      loadHistory(treasury, account),
      (async () => {
        this.statuses = await readStatuses(client, treasury, account, this.chats);
        this.render();
      })(),
    ]);
    if (history.status === "fulfilled") {
      this.history = history.value;
      // Kitties this wallet joined that no link named yet.
      const known = new Set(this.chats.map((c) => c.group.toLowerCase()));
      const extra = history.value.joined.filter((g) => !known.has(g.toLowerCase())).map((group) => ({ group, name: "" }));
      if (extra.length) {
        this.chats = [...this.chats, ...extra];
        this.statuses = [...this.statuses, ...(await readStatuses(client, treasury, account, extra).catch(() => []))];
      }
      await this.loadDebts();
    } else {
      console.error("history", history.reason);
      // With an older copy on screen, say it may be out of date rather than blanking it.
      this.failed = !this.history;
      $("dash-error").firstChild!.textContent = this.history ? "Showing your last saved history. " : "Couldn't load your history. ";
      $("dash-error").hidden = false;
    }
    this.render();
  }

  /** What this member still owes from shares that didn't go through, per person owed. */
  private debts: { creditor: Hex; owed: bigint; group?: Hex }[] = [];
  private async loadDebts(): Promise<void> {
    const missed = new Map<string, Hex | undefined>();
    for (const k of this.history?.kitties.values() ?? []) {
      for (const p of k.purchases) if (p.mine && !p.mine.ok) missed.set(p.payee.toLowerCase(), p.group);
    }
    const { client, treasury, account } = this.deps;
    const rows = await Promise.all(
      [...missed].map(async ([creditor, group]) => ({
        creditor: creditor as Hex,
        group,
        owed: await client.readContract({ address: treasury, abi: treasuryAbi, functionName: "debts", args: [account, creditor as Hex] }).catch(() => 0n),
      })),
    );
    this.debts = rows.filter((r) => r.owed > 0n);
  }

  private name = (group?: Hex): string => {
    if (!group) return "";
    const known = this.chats.find((c) => c.group.toLowerCase() === group.toLowerCase())?.name;
    if (known && !isPlaceholder(known)) return known;
    // No link has named it on this phone: say who's in it, as far as the chain knows.
    const members = this.history?.kitties.get(group.toLowerCase())?.members ?? 0;
    return members > 1 ? `Group chat · ${members} people` : "Group chat";
  };

  private render(): void {
    const route = location.hash.replace(/^#/, "");
    const kittyId = route.startsWith("kitty/") ? route.slice(6) : "";
    const tab = route === "activity" ? "activity" : "kitties";
    $("dash-home").hidden = Boolean(kittyId);
    // The kitty view has its own heading and back link.
    $("title").hidden = Boolean(kittyId);
    if (!kittyId) $("chat").textContent = "";
    $("dash-kitty").hidden = !kittyId;
    for (const t of document.querySelectorAll<HTMLButtonElement>("#dash-tabs button")) t.setAttribute("aria-pressed", String(t.dataset.tab === tab));
    $("tab-kitties").hidden = tab !== "kitties";
    $("tab-activity").hidden = tab !== "activity";
    this.renderDebts();
    if (kittyId) this.renderKitty(kittyId as Hex);
    else if (tab === "activity") this.renderActivity();
    else this.renderKitties();
  }

  private renderDebts(): void {
    const box = $("dash-owe");
    box.replaceChildren(
      ...this.debts.map((d) => {
        const p = el("p");
        const name = d.group ? this.name(d.group) : "";
        p.append(`You owe ${money(d.owed)}${name ? ` in ${name}` : ""} from a share that didn't go through. `);
        const link = el("a", undefined, "Pay it back");
        link.href = this.link({ ...(d.group ? { g: d.group, c: name } : {}), r: d.creditor, o: "the group", m: plain(d.owed) });
        p.append(link);
        return p;
      }),
    );
    box.hidden = this.debts.length === 0;
  }

  private renderKitties(): void {
    const list = $("dash-kitties");
    if (this.statuses.length === 0) {
      if (this.chats.length === 0 && (this.history || this.failed)) {
        return empty(list, "You're not in any kitties yet. Ask Kitty in a group chat to start one.");
      }
      return empty(list, "Loading your kitties…");
    }
    // Active kitties first, the ones you left after.
    const sorted = [...this.statuses].sort((a, b) => Number(b.active) - Number(a.active));
    list.replaceChildren(
      ...sorted.map((s) => {
        const li = el("li");
        const a = el("a", "kitty");
        a.href = `#kitty/${s.chat.group}`;
        const top = el("div", "top");
        top.append(el("strong", undefined, this.name(s.chat.group)));
        const k = this.history?.kitties.get(s.chat.group.toLowerCase());
        if (k) top.append(el("span", "count", `${k.purchases.filter((p) => p.status !== "cancelled").length} purchases`));
        const detail = el("span", undefined, s.active ? `${money(s.left, true)} left of ${money(s.limit, true)} ${perText(s.period)} · ${resetText(s.period, s.resetsAt)}` : "You're not in this one anymore");
        a.append(top, detail, this.bar(s));
        if (!s.active) a.classList.add("off");
        li.append(a);
        return li;
      }),
    );
  }

  private bar(s: ChatStatus): HTMLElement {
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${s.active && s.limit > 0n ? Number((s.left * 100n) / s.limit) : 0}%`;
    bar.append(fill);
    return bar;
  }

  private renderActivity(): void {
    const list = $("dash-activity");
    if (!this.history) return empty(list, this.failed ? "Couldn't load your activity." : "Loading your activity…");
    if (this.history.activity.length === 0) return empty(list, "Nothing yet. Money you add and shares you pay show up here.");
    list.replaceChildren(...this.history.activity.map((e) => row(describe(e, this.name), e.at)));
    if (this.history.partial) list.prepend(el("li", "empty", "Money you added couldn't load right now. Shares and caps are all here."));
  }

  private renderKitty(group: Hex): void {
    const name = this.name(group);
    $("k-name").textContent = name;
    $("chat").textContent = name;
    const status = this.statuses.find((s) => s.chat.group.toLowerCase() === group.toLowerCase());
    const k: Kitty | undefined = this.history?.kitties.get(group.toLowerCase());

    // The cap card: what's left, when it refills, and the way to change it.
    const card = $("k-cap");
    if (!status) card.replaceChildren(el("p", "muted", "Loading your cap…"));
    else if (!status.active) card.replaceChildren(el("p", "muted", "You're not in this kitty anymore. Ask Kitty in the chat to rejoin."));
    else {
      const big = el("p", "big", money(status.left, true));
      big.append(el("span", "per", ` left of ${money(status.limit, true)}`));
      const change = el("a", "button", "Change spending cap");
      change.href = this.link({ g: group, c: name, l: plain(status.limit), p: ["weekly", "monthly", "once"][status.period] ?? "weekly", from: "v1" });
      card.replaceChildren(el("small", undefined, `Your cap · ${per(status.period)}`), big, el("p", "muted", resetText(status.period, status.resetsAt)), this.bar(status), change);
    }

    const stats = $("k-stats");
    if (k) {
      const done = k.purchases.filter((p) => p.status === "paid");
      const mine = k.purchases.reduce((sum, p) => sum + (p.mine?.ok ? p.mine.amount : 0n), 0n);
      stats.replaceChildren(...[
        [String(k.members), k.members === 1 ? "member" : "members"],
        [money(k.spent, true), "group spent"],
        [money(mine, true), "your shares"],
        [String(done.length), done.length === 1 ? "purchase" : "purchases"],
      ].map(([value, label]) => {
        const box = el("div");
        box.append(el("b", undefined, value), el("span", undefined, label));
        return box;
      }));
      stats.hidden = false;
    } else stats.hidden = true;

    const list = $("k-purchases");
    if (!this.history) empty(list, this.failed ? "Couldn't load purchases." : "Loading purchases…");
    else if (!k || k.purchases.length === 0) empty(list, "No purchases yet. Ask Kitty in the chat to buy something.");
    else list.replaceChildren(...k.purchases.map((p) => row(describePurchase(p, this.deps.account), p.at)));

    // This member's own history here: joining and cap changes.
    const mineList = $("k-mine");
    const mine = this.history?.activity.filter((e) => e.group?.toLowerCase() === group.toLowerCase() && ["joined", "limit", "left"].includes(e.kind)) ?? [];
    mineList.replaceChildren(...mine.map((e) => row(describe(e, this.name), e.at)));
    $("k-mine-box").hidden = mine.length === 0;
  }

  /** A link to another mode of this page, keeping the chat list so it can come back here. */
  private link(extra: Record<string, string>): string {
    const url = new URL(location.href);
    url.hash = "";
    url.search = "";
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
    for (const c of this.chats) if (c.group.toLowerCase() !== extra.g?.toLowerCase()) url.searchParams.append("k", `${c.group}:${c.name}`);
    return url.toString();
  }
}
