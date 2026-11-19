/**
 * Save the card Kitty pays stores with (Crossmint). Opened from a link the server prints
 * (`pnpm --filter @gta/server crossmint card`): the hash carries Crossmint's client key and a
 * short-lived user JWT Kitty signed. Card details go straight into Crossmint's iframe; this page
 * only ever sees the resulting paymentMethodId, which goes into CROSSMINT_PAYMENT_METHOD_ID.
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
      <h1>Kitty's card</h1>
      <p>The card Kitty pays stores with once the group 👍s an order. Card details go straight to Crossmint.</p>
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
