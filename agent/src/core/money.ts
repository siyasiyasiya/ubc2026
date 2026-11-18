import type { Handle, Units } from "./types.js";

export const USDC_DECIMALS = 6;
const UNITS_PER_DOLLAR = 10 ** USDC_DECIMALS;
const UNITS_PER_CENT = UNITS_PER_DOLLAR / 100;

/** Converts a dollar amount to USDC base units, rounded to the cent. */
export function usdToUnits(usd: number): Units {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid dollar amount: ${usd}`);
  return Math.round(usd * 100) * UNITS_PER_CENT;
}

export function formatUsd(units: Units): string {
  return `$${(units / UNITS_PER_DOLLAR).toFixed(2)}`;
}

/**
 * Splits a total evenly across handles, to the cent. Leftover cents go to the first handles
 * in the given order, so shares always add up to exactly the total.
 */
export function splitEvenly(total: Units, handles: Handle[]): Record<Handle, Units> {
  const unique = [...new Set(handles)];
  if (unique.length === 0) throw new Error("A split needs at least one person");
  const cents = Math.round(total / UNITS_PER_CENT);
  const base = Math.floor(cents / unique.length);
  const remainder = cents - base * unique.length;
  const shares: Record<Handle, Units> = {};
  unique.forEach((h, i) => {
    shares[h] = (base + (i < remainder ? 1 : 0)) * UNITS_PER_CENT;
  });
  return shares;
}

/**
 * Uses explicit per-person amounts (e.g. "by what each person ordered"). Tax/tip rounding may leave
 * them a few cents off the total; up to 1 cent per person is absorbed by the largest share.
 */
export function splitByAmounts(
  total: Units,
  amounts: Record<Handle, Units>,
): Record<Handle, Units> {
  const entries = Object.entries(amounts);
  if (entries.length === 0) throw new Error("A split needs at least one person");
  const sum = entries.reduce((acc, [, a]) => acc + a, 0);
  const diff = total - sum;
  if (Math.abs(diff) > entries.length * UNITS_PER_CENT) {
    throw new Error(`Shares add up to ${formatUsd(sum)}, not the total ${formatUsd(total)}`);
  }
  const shares = Object.fromEntries(entries);
  const largest = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  shares[largest] = (shares[largest] ?? 0) + diff;
  return shares;
}

export function sumShares(shares: Record<Handle, Units>): Units {
  return Object.values(shares).reduce((a, b) => a + b, 0);
}
