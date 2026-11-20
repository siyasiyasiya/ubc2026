/**
 * Save a card Kitty pays stores with (Crossmint). Two ways in, both with Crossmint's client key and
 * a short-lived user JWT Kitty signed in the hash:
 *   - a member's private link from Kitty (`b` = Kitty's iMessage address, `n` = their name): their
 *     own card. The page has no backend, so "Send to Kitty" opens Messages with the card id typed
 *     out; Kitty saves it from their thread (the id alone can't charge anything).
 *   - the operator's link (`pnpm --filter @gta/server crossmint card`): the bot's default card, which
 *     goes into CROSSMINT_PAYMENT_METHOD_ID.
 * Card details go straight into Crossmint's iframe; this page only ever sees the paymentMethodId.
 */
import {
  CrossmintPaymentMethodManagement,
  CrossmintProvider,
  type CrossmintPaymentMethodManagementRef,
} from "@crossmint/client-sdk-react-ui";
import { Component, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const params = new URLSearchParams(location.hash.slice(1));
const apiKey = params.get("k") ?? "";
const jwt = params.get("t") ?? "";
/** Kitty's iMessage address: set on a member's own link. */
const bot = params.get("b") ?? "";
const name = params.get("n") ?? "";

/** iOS takes `&body=` after the address; the text is what Kitty's server looks for. */
export function sendToKittyHref(address: string, id: string, label: string): string {
  return `sms:${address}&body=${encodeURIComponent(`my kitty card: ${id} (${label})`)}`;
}

type Saved = { id: string; label: string };

function CardForm() {
  const ref = useRef<CrossmintPaymentMethodManagementRef>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Saved | null>(null);

  async function save() {
    if (!ref.current) return;
    setBusy(true);
    setError("");
    const result = await ref.current.submit();
    setBusy(false);
    if (result.status === "saved" || result.status === "selected") {
      const pm = result.paymentMethod;
      const label = pm.type === "card" ? `${pm.card.brand} ending ${pm.card.last4}` : "Bank account";
      setSaved({ id: pm.paymentMethodId, label });
    } else if (result.status !== "superseded") {
      setError(result.message);
    }
  }

  if (saved && bot) {
    return (
      <>
        <h1>Card saved</h1>
        <p className="ok">{saved.label}</p>
        <p>One more tap: send it to Kitty so your buys go on this card.</p>
        <a className="send" href={sendToKittyHref(bot, saved.id, saved.label)}>
          Send to Kitty
        </a>
      </>
    );
  }

  if (saved) {
    return (
      <>
        <h1>Card saved</h1>
        <p className="ok">{saved.label}</p>
        <p>
          Put this in <b>apps/server/.env</b> as CROSSMINT_PAYMENT_METHOD_ID:
          <code>{saved.id}</code>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>{bot ? `${name ? `${name}, your` : "Your"} card` : "Kitty's card"}</h1>
      <p>
        {bot
          ? "When Kitty buys something for your group and you're the one paying, it goes on this card, only after everyone 👍s. Card details go straight to Crossmint, never Kitty."
          : "The card Kitty pays stores with once the group 👍s an order. Card details go straight to Crossmint."}
      </p>
      <div className="form">
        <CrossmintPaymentMethodManagement ref={ref} jwt={jwt} allowedModes={["new", "existing"]} />
      </div>
      {error && <p className="bad">{error}</p>}
      <button disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save card"}
      </button>
    </>
  );
}

/** Crossmint's provider throws on a bad or revoked key; show that instead of a blank page. */
class Boundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(err: Error) {
    return { error: err.message };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <>
        <h1>Couldn't open the card form</h1>
        <p className="bad">{this.state.error}</p>
        <p>Check CROSSMINT_CLIENT_API_KEY (a production client key), then print a new link.</p>
      </>
    );
  }
}

function App() {
  if (!apiKey || !jwt) {
    return (
      <>
        <h1>Link expired</h1>
        <p>
          Open this page from the link <b>pnpm --filter @gta/server crossmint card</b> prints.
        </p>
      </>
    );
  }
  return (
    <Boundary>
      <CrossmintProvider apiKey={apiKey}>
        <CardForm />
      </CrossmintProvider>
    </Boundary>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
