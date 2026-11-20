/**
 * Money is USDC, always represented as an integer number of micro-dollars
 * (1 USDC = 1_000_000 micro). Never use floats for money.
 *
 * The branded `Usdc` type makes it impossible to accidentally pass a raw
 * number (e.g. dollars, or wei of some other token) where USDC micros are
 * expected.
 */

declare const usdcBrand: unique symbol;

/** An integer amount of USDC in micro-dollars (6 decimals). */
export type Usdc = bigint & { readonly [usdcBrand]: true };

/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6;
const SCALE = 1_000_000n;
/** Micro-dollars in one cent. Money is split and shown to the cent, never to a fraction of one. */
const CENT = 10_000n;

/** Construct a Usdc amount from micro-dollars (the raw on-chain unit). */
export function micros(value: bigint | number): Usdc {
  const v = typeof value === "number" ? BigInt(Math.round(value)) : value;
  return v as Usdc;
}

/** Construct a Usdc amount from a dollar figure, e.g. usdc(12.5) => $12.50. */
export function usdc(dollars: number): Usdc {
  // Round to the cent first to avoid float dust, then scale to micros.
  const cents = Math.round(dollars * 100);
  return (BigInt(cents) * 10_000n) as Usdc;
}

export function addUsdc(...amounts: Usdc[]): Usdc {
  return amounts.reduce((a, b) => (a + b) as Usdc, 0n as Usdc);
}

export function subUsdc(a: Usdc, b: Usdc): Usdc {
  return (a - b) as Usdc;
}

export function gtUsdc(a: Usdc, b: Usdc): boolean {
  return a > b;
}

/** Split a total evenly across `n` participants. Each share is a whole number of cents (no sub-cent
 * amounts), the leftover cent(s) go one at a time to the first shares, and the parts sum exactly
 * back to the total. Any sub-cent dust in `total` (normally none, since money is built to the cent)
 * is kept on the first share so nothing is lost. */
export function splitEven(total: Usdc, n: number): Usdc[] {
  if (n <= 0) throw new Error("splitEven: need at least one participant");
  const cents = total / CENT;
  const dust = total % CENT; // sub-cent remainder, normally 0n
  const base = cents / BigInt(n);
  let remainder = cents % BigInt(n);
  const parts: Usdc[] = [];
  for (let i = 0; i < n; i++) {
    let shareCents = base;
    if (remainder > 0n) {
      shareCents += 1n;
      remainder -= 1n;
    }
    parts.push((shareCents * CENT + (i === 0 ? dust : 0n)) as Usdc);
  }
  return parts;
}

/** Human-readable string, e.g. "$12.50", rounded to the nearest cent (half up). */
export function formatUsdc(amount: Usdc): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const cents = (abs + CENT / 2n) / CENT; // round to the nearest cent (carries into dollars)
  const whole = cents / 100n;
  const centsPart = (cents % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole.toString()}.${centsPart}`;
}
