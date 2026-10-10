// Money as integer øre, never floats. Ledger amounts are signed (+debit/−credit) and stored as bigint øre in
// Postgres (ADR-0003); in TypeScript they are safe-integer numbers. Round half up.
// Ported from enkelt-regnskap src/core/money.ts (and the VAT-from-gross rule in src/core/expand.ts beregnLinje),
// 2026-10-10.

function assertSafeInteger(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer, got ${n}`);
}

/**
 * Parse "1234.56", "1,234.56", "-1 234,56", "1234" -> øre. Throws on invalid input.
 * A comma is a thousands separator when every group after it has exactly three digits (en-GB); otherwise it is the
 * decimal mark (bank CSV, nb-NO).
 */
export function parseOre(s: string): number {
  let t = s.trim().replace(/\s/g, "").replace(/−/g, "-");
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, "");
  else t = t.replace(",", ".");
  const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) throw new Error(`Invalid amount: ${JSON.stringify(s)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const kr = Number(m[2]);
  const frac = (m[3] ?? "").padEnd(2, "0");
  const ore = sign * (kr * 100 + Number(frac));
  assertSafeInteger(ore, "Amount");
  return ore === 0 ? 0 : ore; // never −0
}

/** Parse, or null when blank. */
export function parseOreOrNull(s: string | null | undefined): number | null {
  if (s == null || s.trim() === "") return null;
  return parseOre(s);
}

/** øre -> "1234.56" (dot, no thousands separator), as CSV/SAF-T want it. */
export function formatDot(ore: number): string {
  const neg = ore < 0;
  const a = Math.abs(ore);
  const kr = Math.floor(a / 100);
  const o = a % 100;
  return `${neg ? "-" : ""}${kr}.${String(o).padStart(2, "0")}`;
}

/** øre -> "1,234.56" (en-GB) for display. */
export function formatKr(ore: number): string {
  const neg = ore < 0;
  const a = Math.abs(ore);
  const kr = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const o = a % 100;
  return `${neg ? "-" : ""}${kr}.${String(o).padStart(2, "0")}`;
}

/** øre -> "1234.56" for input fields (dot, no thousands separator). */
export function formatInput(ore: number): string {
  return formatDot(ore);
}

/** a/b rounded half up, for integers a >= 0, b > 0: floor((2a + b) / (2b)). */
export function divRoundHalfUp(a: number, b: number): number {
  assertSafeInteger(a, "divRoundHalfUp numerator");
  assertSafeInteger(b, "divRoundHalfUp denominator");
  if (a < 0 || b <= 0) throw new Error("divRoundHalfUp requires a >= 0, b > 0");
  assertSafeInteger(2 * a + b, "divRoundHalfUp intermediate");
  return Math.floor((2 * a + b) / (2 * b));
}

/**
 * VAT contained in a VAT-inclusive (gross) amount at `ratePercent` (integer percent, e.g. 25, 15, 12):
 * round_half_up(|gross| · rate / (100 + rate)), carrying the sign of `gross`. Rounding is on the absolute value, so
 * debit and credit amounts round symmetrically.
 */
export function vatFromGross(gross: number, ratePercent: number): number {
  assertSafeInteger(gross, "Gross amount");
  assertSafeInteger(ratePercent, "VAT rate");
  if (ratePercent < 0) throw new Error(`VAT rate must be >= 0, got ${ratePercent}`);
  if (ratePercent === 0 || gross === 0) return 0;
  const vat = divRoundHalfUp(Math.abs(gross) * ratePercent, 100 + ratePercent);
  return gross < 0 && vat !== 0 ? -vat : vat;
}
