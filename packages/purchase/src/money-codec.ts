/**
 * Money codec: convert between Crossmint's decimal-string money (e.g. "12.49"
 * USD) and core's branded micro-USDC `Usdc` (6-decimal bigint).
 *
 * Crossmint quotes amounts as decimal strings with a currency. We NEVER route
 * these through JS floats — parsing is done with string + bigint arithmetic so
 * no cent is ever lost to float dust.
 */

import { micros, type Usdc } from "@gta/core";

/** Crossmint represents money as a decimal string plus a currency code. The
 *  field carrying the number is `value` on some objects and `amount` on others
 *  (e.g. payment requests vs. captured receipts), so both are accepted. */
export interface CrossmintMoney {
  value?: string;
  amount?: string;
  currency?: string;
}

const USDC_FRACTION_DIGITS = 6;

/** USDC is dollar-pegged, so only USD-denominated Crossmint amounts map cleanly
 *  onto `Usdc`. Anything else would be a silent FX error — reject it loudly. */
function assertUsd(currency: string | undefined): void {
  if (currency && currency.toUpperCase() !== "USD") {
    throw new Error(
      `money-codec: expected USD-denominated amount, got ${currency}. ` +
        `Usdc is dollar-pegged; convert upstream before building a cart.`,
    );
  }
}

/** Parse a decimal money string like "12.49" or "7" into micro-USDC without
 *  ever touching a float. Tolerates surrounding whitespace, thousands commas,
 *  and a leading currency symbol. */
export function parseDecimalToUsdc(raw: string): Usdc {
  const cleaned = raw.trim().replace(/[,\s$]/g, "");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new Error(`money-codec: cannot parse money string ${JSON.stringify(raw)}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  // Pad/truncate the fractional part to exactly 6 digits (micro precision).
  const fracRaw = match[3] ?? "";
  const fracPadded = (fracRaw + "0".repeat(USDC_FRACTION_DIGITS)).slice(0, USDC_FRACTION_DIGITS);
  const fraction = BigInt(fracPadded);
  const totalMicros = sign * (whole * 1_000_000n + fraction);
  return micros(totalMicros);
}

/** Read a Crossmint money object (either `{value}` or `{amount}`) into `Usdc`. */
export function moneyToUsdc(money: CrossmintMoney): Usdc {
  assertUsd(money.currency);
  const raw = money.value ?? money.amount;
  if (raw === undefined) {
    throw new Error(`money-codec: money object has neither 'value' nor 'amount': ${JSON.stringify(money)}`);
  }
  return parseDecimalToUsdc(raw);
}

/** Render `Usdc` as a plain decimal string (no currency symbol) for sending
 *  back to Crossmint, e.g. constraints.maxCost. Defaults to 2 fraction digits
 *  (card precision) but keeps more when the amount has sub-cent micros. */
export function usdcToDecimalString(amount: Usdc, minFractionDigits = 2): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(USDC_FRACTION_DIGITS, "0");
  // Trim trailing zeros but never below `minFractionDigits`.
  frac = frac.replace(/0+$/, "");
  while (frac.length < minFractionDigits) frac += "0";
  const body = frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  return `${neg ? "-" : ""}${body}`;
}
