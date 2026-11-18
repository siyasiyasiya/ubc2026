import { describe, expect, it } from "vitest";
import { usdc } from "./money.js";
import { evenSplit } from "./split.js";
import {
  initialState,
  isTerminal,
  transition,
  type Effect,
  type RequestEvent,
  type RequestState,
} from "./state-machine.js";
import type { Cart, Receipt, Screenshot, Split } from "./types.js";

// --- fixtures ---------------------------------------------------------------

const MEMBERS = ["alice", "bob", "carol"];

function cart(total = usdc(30)): Cart {
  return {
    id: "cart_1",
    store: "test-store",
    lineItems: [{ name: "paper towels", quantity: 1, unitPrice: total }],
    subtotal: total,
    tax: usdc(0),
    shipping: usdc(0),
    total,
    checkout: { kind: "link_card" },
  };
}

function screenshot(): Screenshot {
  return { image: { uri: "file:///tmp/checkout.png" }, caption: "Checkout" };
}

function split(total = usdc(30), payee = "alice"): Split {
  return evenSplit({ total, participantIds: MEMBERS, payeeMemberId: payee });
}

function receipt(total = usdc(30)): Receipt {
  return { source: "agent_order", total, at: 1000 };
}

/** Drive a sequence of events, asserting none are invalid, returning the final result. */
function drive(start: RequestState, events: RequestEvent[]): { state: RequestState; effects: Effect[] } {
  let state = start;
  let effects: Effect[] = [];
  for (const ev of events) {
    const r = transition(state, ev);
    expect(r.error, `event ${ev.type} should be valid in ${state.name}`).toBeUndefined();
    state = r.state;
    effects = r.effects;
  }
  return { state, effects };
}

// --- pay-before -------------------------------------------------------------

describe("pay-before happy path", () => {
  it("runs draft → … → done and emits the right effects", () => {
    let state = initialState("pay_before");
    expect(state.name).toBe("draft");

    // build cart → preview_cart effect
    let r = transition(state, { type: "cart_built", cart: cart() });
    expect(r.state.name).toBe("cart_built");
    expect(r.effects[0]).toEqual({ type: "preview_cart", cart: cart() });
    state = r.state;

    // preview ready → awaiting_approval + post_preview effect
    r = transition(state, {
      type: "preview_ready",
      split: split(),
      screenshot: screenshot(),
      requiredApprovers: MEMBERS,
      deadline: 5000,
    });
    expect(r.state.name).toBe("awaiting_approval");
    expect(r.effects[0]?.type).toBe("post_preview");
    state = r.state;

    // two of three 👍 → still awaiting
    r = transition(state, { type: "reaction", memberId: "alice", emoji: "👍", added: true, at: 1 });
    expect(r.state.name).toBe("awaiting_approval");
    r = transition(r.state, { type: "reaction", memberId: "bob", emoji: "👍", added: true, at: 2 });
    expect(r.state.name).toBe("awaiting_approval");

    // third 👍 → approved + place_order effect
    r = transition(r.state, { type: "reaction", memberId: "carol", emoji: "👍", added: true, at: 3 });
    expect(r.state.name).toBe("approved");
    expect(r.effects[0]).toEqual({ type: "place_order", cart: cart() });

    // order placed → settling + pull_shares effect
    r = transition(r.state, { type: "order_placed", receipt: receipt() });
    expect(r.state.name).toBe("settling");
    expect(r.effects[0]?.type).toBe("pull_shares");

    // pull all three shares, settle
    const final = drive(r.state, [
      { type: "share_pulled", result: { memberId: "alice", amount: usdc(10), status: "pulled", txRef: "0x1" } },
      { type: "share_pulled", result: { memberId: "bob", amount: usdc(10), status: "pulled", txRef: "0x2" } },
      { type: "share_pulled", result: { memberId: "carol", amount: usdc(10), status: "pulled", txRef: "0x3" } },
      { type: "settle_complete", at: 9999 },
    ]);
    expect(final.state.name).toBe("done");
    if (final.state.name === "done") {
      expect(final.state.debts).toEqual([]);
      expect(final.state.pulls.length).toBe(3);
    }
  });
});

describe("pay-before approval timeout", () => {
  it("rejects when not everyone 👍 before the deadline", () => {
    const awaiting: RequestState = {
      name: "awaiting_approval",
      cart: cart(),
      split: split(),
      screenshot: screenshot(),
      approvals: [{ memberId: "alice", emoji: "👍", at: 1 }],
      requiredApprovers: MEMBERS,
      deadline: 5000,
    };
    const r = transition(awaiting, { type: "approval_timeout", at: 6000 });
    expect(r.state.name).toBe("rejected");
  });
});

describe("removing a 👍 un-approves", () => {
  it("does not advance until every required approver has an active 👍", () => {
    let state: RequestState = {
      name: "awaiting_approval",
      cart: cart(),
      split: split(),
      screenshot: screenshot(),
      approvals: [],
      requiredApprovers: MEMBERS, // alice, bob, carol
      deadline: 5000,
    };
    state = transition(state, { type: "reaction", memberId: "alice", emoji: "👍", added: true, at: 1 }).state;
    state = transition(state, { type: "reaction", memberId: "bob", emoji: "👍", added: true, at: 2 }).state;
    // bob takes it back
    state = transition(state, { type: "reaction", memberId: "bob", emoji: "👍", added: false, at: 3 }).state;
    expect(state.name).toBe("awaiting_approval");
    // carol 👍 — still not everyone, because bob is gone
    state = transition(state, { type: "reaction", memberId: "carol", emoji: "👍", added: true, at: 4 }).state;
    expect(state.name).toBe("awaiting_approval");
    // bob 👍 again → now everyone → approved
    const r = transition(state, { type: "reaction", memberId: "bob", emoji: "👍", added: true, at: 5 });
    expect(r.state.name).toBe("approved");
  });
});

describe("failed pull records a debt", () => {
  it("ends in done with a debt for the member whose pull failed", () => {
    const settling: RequestState = { name: "settling", receipt: receipt(), split: split(), pulls: [] };
    const final = drive(settling, [
      { type: "share_pulled", result: { memberId: "alice", amount: usdc(10), status: "pulled", txRef: "0x1" } },
      { type: "share_pulled", result: { memberId: "bob", amount: usdc(10), status: "failed", reason: "over limit" } },
      { type: "share_pulled", result: { memberId: "carol", amount: usdc(10), status: "pulled", txRef: "0x3" } },
      { type: "settle_complete", at: 9999 },
    ]);
    expect(final.state.name).toBe("done");
    if (final.state.name === "done") {
      expect(final.state.debts).toEqual([
        { memberId: "bob", amount: usdc(10), reason: "over limit", createdAt: 9999 },
      ]);
    }
  });
});

// --- pay-after --------------------------------------------------------------

describe("pay-after within estimate", () => {
  it("collects participants, reads receipt, settles without re-approval", () => {
    let state = initialState("pay_after");
    expect(state.name).toBe("collecting");

    state = drive(state, [
      { type: "participant_in", memberId: "alice" },
      { type: "participant_in", memberId: "bob" },
      { type: "participant_in", memberId: "bob" }, // idempotent
      { type: "participant_out", memberId: "bob" }, // bob backs out
      { type: "participant_in", memberId: "carol" },
      { type: "participants_locked", estimate: usdc(40) },
    ]).state;
    expect(state.name).toBe("awaiting_receipt");
    if (state.name === "awaiting_receipt") {
      expect(state.participants).toEqual(["alice", "carol"]);
    }

    const r = transition(state, {
      type: "receipt_read",
      receipt: receipt(usdc(42)),
      split: evenSplit({ total: usdc(42), participantIds: ["alice", "carol"], payeeMemberId: "alice" }),
      screenshot: screenshot(),
      tolerance: usdc(5),
      deadline: 7000,
    });
    // $42 is within $40 + $5 tolerance → straight to settling
    expect(r.state.name).toBe("settling");
    expect(r.effects[0]?.type).toBe("pull_shares");
  });
});

describe("pay-after over estimate", () => {
  it("asks for re-approval, then settles once everyone 👍", () => {
    const awaitingReceipt: RequestState = {
      name: "awaiting_receipt",
      participants: ["alice", "carol"],
      estimate: usdc(40),
    };
    const r = transition(awaitingReceipt, {
      type: "receipt_read",
      receipt: receipt(usdc(60)),
      split: evenSplit({ total: usdc(60), participantIds: ["alice", "carol"], payeeMemberId: "alice" }),
      screenshot: screenshot(),
      tolerance: usdc(5),
      deadline: 7000,
    });
    // $60 > $40 + $5 → re-approval needed
    expect(r.state.name).toBe("awaiting_approval");
    expect(r.effects.some((e) => e.type === "notify")).toBe(true);

    // both participants re-👍 → settling (receipt already known)
    let state = r.state;
    state = transition(state, { type: "reaction", memberId: "alice", emoji: "👍", added: true, at: 1 }).state;
    const done = transition(state, { type: "reaction", memberId: "carol", emoji: "👍", added: true, at: 2 });
    expect(done.state.name).toBe("settling");
    expect(done.effects[0]?.type).toBe("pull_shares");
  });
});

// --- controls ---------------------------------------------------------------

describe("cancel", () => {
  it("can cancel from a non-terminal state and is terminal after", () => {
    const r = transition(initialState("pay_before"), { type: "cancel", reason: "changed our minds" });
    expect(r.state.name).toBe("cancelled");
    expect(isTerminal(r.state)).toBe(true);
    // further events are invalid
    const after = transition(r.state, { type: "cart_built", cart: cart() });
    expect(after.error).toBeDefined();
  });
});
