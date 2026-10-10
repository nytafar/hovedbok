// Calendar dates (YYYY-MM-DD) as seen from Europe/Oslo, Norwegian public holidays and the bimonthly MVA term
// deadlines. Bokføringsloven § 7 second paragraph via § 9: after the reporting deadline, booked information may not
// be changed or deleted, only corrected by a new posting — hence `isLocked`.
// Ported from enkelt-regnskap src/core/dato.ts (terminFor/terminPeriode from src/core/expand.ts), 2026-10-10.

const OSLO = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD for an instant, as seen from Europe/Oslo. */
export function osloDate(instant: Date): string {
  const p = Object.fromEntries(OSLO.formatToParts(instant).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Today in Europe/Oslo. The environment variable HOVEDBOK_TODAY (YYYY-MM-DD) overrides it, for smoke-testing locked
 * terms on a throwaway instance; it must never be set in production.
 */
export function today(): string {
  const o = process.env.HOVEDBOK_TODAY;
  return o && /^\d{4}-\d{2}-\d{2}$/.test(o) ? o : osloDate(new Date());
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Easter Sunday (Gregorian, anonymous computus) as YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(new Date(Date.UTC(year, month - 1, day)));
}

/** The date `days` days after `date` (YYYY-MM-DD); negative goes back. */
export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/**
 * Norwegian public holidays (lov om helligdager § 2): 1. januar, skjærtorsdag, langfredag, 1. og 2. påskedag, 1. og
 * 17. mai, Kristi himmelfartsdag, 1. og 2. pinsedag, 1. og 2. juledag. Sundays are not listed (see `isBusinessDay`).
 */
export function publicHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  return new Set([
    `${year}-01-01`, addDays(easter, -3), addDays(easter, -2), easter, addDays(easter, 1),
    `${year}-05-01`, `${year}-05-17`, addDays(easter, 39), addDays(easter, 49), addDays(easter, 50),
    `${year}-12-25`, `${year}-12-26`,
  ]);
}

export function isPublicHoliday(date: string): boolean {
  return publicHolidays(Number(date.slice(0, 4))).has(date);
}

/** Business day: Monday–Friday and not a public holiday. */
export function isBusinessDay(date: string): boolean {
  const u = new Date(date + "T00:00:00Z").getUTCDay();
  return u !== 0 && u !== 6 && !isPublicHoliday(date);
}

/** `date` itself if it is a business day, otherwise the first business day after it. */
export function nextBusinessDay(date: string): string {
  let d = date;
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** VAT term (1–6, two calendar months each) for a YYYY-MM-DD date. */
export function vatTermFor(date: string): number {
  return Math.ceil(Number(date.slice(5, 7)) / 2);
}

function assertTerm(term: number): void {
  if (!Number.isInteger(term) || term < 1 || term > 6) throw new Error(`Invalid VAT term ${term}`);
}

/** Period [from, to] (inclusive) of a VAT term. */
export function vatTermPeriod(year: number, term: number): { from: string; to: string } {
  assertTerm(term);
  const m1 = (term - 1) * 2 + 1;
  const m2 = m1 + 1;
  const lastDay = new Date(Date.UTC(year, m2, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return { from: `${year}-${p(m1)}-01`, to: `${year}-${p(m2)}-${p(lastDay)}` };
}

/**
 * Deadline for the MVA-melding of a bimonthly term (skatteforvaltningsforskriften § 8-3-10): one month and ten days
 * after the term ends, except term 3 (May–June) whose deadline is 31 August. A deadline on a Saturday, Sunday or public
 * holiday moves to the next business day (skatteforvaltningsloven § 5-5, cf. domstolloven § 149): term 4 2026
 * (10 October, a Saturday) is due Monday 12 October.
 */
export function vatTermDeadline(year: number, term: number): string {
  assertTerm(term);
  const statutory: Record<number, string> = {
    1: `${year}-04-10`, 2: `${year}-06-10`, 3: `${year}-08-31`, 4: `${year}-10-10`, 5: `${year}-12-10`, 6: `${year + 1}-02-10`,
  };
  return nextBusinessDay(statutory[term]!);
}

/** The term a date falls in, and its deadline. */
export function deadlineFor(date: string): { year: number; term: number; deadline: string } {
  const year = Number(date.slice(0, 4));
  const term = vatTermFor(date);
  return { year, term, deadline: vatTermDeadline(year, term) };
}

/** Is a voucher with this date locked on `onDate`? Locked from the day after its term's deadline. */
export function isLocked(date: string, onDate: string): boolean {
  return deadlineFor(date).deadline < onDate;
}
