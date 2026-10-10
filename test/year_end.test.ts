// Year-end close (#5): a full dummy year posted, closed with close_period × 12
// + close_fiscal_year, and the next year opening with the right balances —
// balance accounts carry, P&L accounts start at zero, all from posted history.
// Plus the reference-data commands upsert_account / upsert_party.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { dropTestDb, freshDb } from "./helper";

const E = "999888777";
const Y = 2026;

let sql: SQL;

beforeEach(async () => {
  sql = await freshDb();
  await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: Y }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "K1", name: "Kunde AS", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "L1", name: "Leverandør AS", supplier: true }}::jsonb)`;
});
afterAll(dropTestDb);

type Line = { account: string; amount: number; party?: string; vat_code?: string; vat_base?: number };

async function post(db: SQL, key: string, posting_date: string, lines: Line[], over: Record<string, unknown> = {}) {
  const [row] = await db`select post_voucher(${{ entity: E, posting_date, description: key, idempotency_key: key, lines, ...over }}::jsonb) as r`;
  return row.r as { entity: string; year: number; nr: number; idempotent: boolean };
}

async function pgError(p: Promise<unknown>): Promise<{ errno: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { errno: string; message: string };
  }
  throw new Error("expected a database error, but the statement succeeded");
}

function as<T>(role: "hovedbok_app" | "hovedbok_ro", fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

async function closeYear(db: SQL, year = Y, equity?: string) {
  const [row] = equity
    ? await db`select close_fiscal_year(${E}, ${year}::smallint, ${equity}) as r`
    : await db`select close_fiscal_year(${E}, ${year}::smallint) as r`;
  return row.r as { entity: string; year: number; result: number; equity_account: string; vouchers: number[]; period_13: string };
}

async function balances(db: SQL, year?: number): Promise<Record<string, number>> {
  const rows = year === undefined
    ? await db`select account, balance::int as b from account_balance where entity = ${E} order by account`
    : await db`select account, closing::int as b from account_year_balance where entity = ${E} and year = ${year} order by account`;
  return Object.fromEntries(rows.map((r: { account: string; b: number }) => [r.account, r.b]));
}

/** A year of business: a sale every month, a cost in March, settlements. */
async function postDummyYear(db: SQL): Promise<void> {
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    await post(db, `sale-${m}`, `${Y}-${mm}-15`, [
      { account: "1500", amount: 12500, party: "K1" },
      { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
      { account: "2700", amount: -2500 },
    ]);
    await post(db, `paid-${m}`, `${Y}-${mm}-20`, [
      { account: "1920", amount: 12500 },
      { account: "1500", amount: -12500, party: "K1" },
    ]);
  }
  await post(db, "cost", `${Y}-03-10`, [
    { account: "6300", amount: 8000, vat_code: "1", vat_base: 8000 },
    { account: "2710", amount: 2000 },
    { account: "2400", amount: -10000, party: "L1" },
  ]);
  await post(db, "cost-paid", `${Y}-04-01`, [
    { account: "2400", amount: 10000, party: "L1" },
    { account: "1920", amount: -10000 },
  ]);
  // a year-end adjustment posted by hand into period 13 (an accrual)
  await post(db, "accrual", `${Y}-12-31`, [
    { account: "6300", amount: 1000 },
    { account: "2960", amount: -1000 },
  ], { period: 13 });
}

async function closeMonths(db: SQL, months = 12): Promise<void> {
  for (let m = 1; m <= months; m++) await db`select close_period(${E}, ${Y}::smallint, ${m}::smallint)`;
}

// ---------------------------------------------------------------------------
describe("close_fiscal_year", () => {
  test("a full dummy year: post, close 1-12, close the year, open the next with correct balances", async () => {
    await postDummyYear(sql);
    await closeMonths(sql);
    const before = await balances(sql);
    expect(before["3000"]).toBe(-120000);
    expect(before["6300"]).toBe(9000);

    const r = await closeYear(sql);
    // revenue 120 000 - costs 9 000 = profit 111 000 øre, a credit on 8800
    expect(r).toEqual({ entity: E, year: Y, result: -111000, equity_account: "2050", vouchers: [28, 29, 30], period_13: "closed" });

    // the closing is ordinary vouchers in period 13 on 31.12, numbered in sequence
    const closing = await sql`
      select nr, period, posting_date::text as d, description, idempotency_key as key, created_by
        from voucher where entity = ${E} and year = ${Y} and nr >= 28 order by nr`;
    expect(closing).toEqual([
      { nr: 28, period: 13, d: "2026-12-31", description: "Årsavslutning 2026: resultat til 8800", key: "close:2026:result", created_by: "hovedbok" },
      { nr: 29, period: 13, d: "2026-12-31", description: "Årsavslutning 2026: årsresultat overført 8960", key: "close:2026:transfer", created_by: "hovedbok" },
      { nr: 30, period: 13, d: "2026-12-31", description: "Årsavslutning 2026: disponering til 2050", key: "close:2026:equity", created_by: "hovedbok" },
    ]);
    const lines = await sql`
      select nr, account, amount::int from posting where entity = ${E} and year = ${Y} and nr >= 28 order by nr, line`;
    expect(lines).toEqual([
      { nr: 28, account: "3000", amount: 120000 },
      { nr: 28, account: "6300", amount: -9000 },
      { nr: 28, account: "8800", amount: -111000 },
      { nr: 29, account: "8800", amount: 111000 },
      { nr: 29, account: "8960", amount: -111000 },
      { nr: 30, account: "8960", amount: 111000 },
      { nr: 30, account: "2050", amount: -111000 },
    ]);

    // every P&L account sums to zero over all time; balance accounts carry
    const after = await balances(sql);
    const pl = Object.entries(after).filter(([a]) => a >= "3000");
    expect(pl.every(([, b]) => b === 0)).toBe(true);
    expect(after).toMatchObject({ "1920": 140000, "1500": 0, "2400": 0, "2700": -30000, "2710": 2000, "2960": -1000, "2050": -111000 });
    const [sum] = await sql`select sum(balance)::int as s from account_balance where entity = ${E}`;
    expect(sum.s).toBe(0);

    // period 13 is closed; the year takes nothing more; the next year is open
    const periods = await sql`select nr, status, closed_by from period where entity = ${E} and year = ${Y} order by nr`;
    expect(periods.every((p: { status: string }) => p.status === "closed")).toBe(true);
    expect(periods[12]).toEqual({ nr: 13, status: "closed", closed_by: "hovedbok" });
    const late = await pgError(post(sql, "late", `${Y}-12-31`, [{ account: "1920", amount: 1 }, { account: "1900", amount: -1 }], { period: 13 }));
    expect(late.message).toContain("closed");
    const [next] = await sql`select count(*)::int as n from period where entity = ${E} and year = ${Y + 1} and status = 'open'`;
    expect(next.n).toBe(13);

    // next year: opening balances fall out of the views, from posted history alone
    const first = await post(sql, "ny-sale", `${Y + 1}-01-10`, [
      { account: "1920", amount: 12500 },
      { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
      { account: "2700", amount: -2500 },
    ]);
    expect(first).toEqual({ entity: E, year: Y + 1, nr: 1, idempotent: false });
    const opening = await sql`
      select account, opening::int, movement::int, closing::int
        from account_year_balance
       where entity = ${E} and year = ${Y + 1} and account in ('1920', '2050', '2700', '3000', '6300', '8800')
       order by account`;
    expect(opening).toEqual([
      { account: "1920", opening: 140000, movement: 12500, closing: 152500 },
      { account: "2050", opening: -111000, movement: 0, closing: -111000 },
      { account: "2700", opening: -30000, movement: -2500, closing: -32500 },
      { account: "3000", opening: 0, movement: -10000, closing: -10000 },
      { account: "6300", opening: 0, movement: 0, closing: 0 },
      { account: "8800", opening: 0, movement: 0, closing: 0 },
    ]);
    expect(await balances(sql, Y)).toMatchObject({ "1920": 140000, "3000": 0, "8800": 0 });
    expect((await balances(sql))["3000"]).toBe(-10000);
  });

  test("a loss goes 8800 -> 8990 -> 2080, and hand-booked dispositions ride along", async () => {
    await post(sql, "cost", `${Y}-02-01`, [
      { account: "6300", amount: 5000, vat_code: "1", vat_base: 5000 },
      { account: "2710", amount: 1250 },
      { account: "1920", amount: -6250 },
    ]);
    // a dividend decided before the close (Dr 8920 / Cr 2800)
    await post(sql, "dividend", `${Y}-12-31`, [
      { account: "8920", amount: 3000 },
      { account: "2800", amount: -3000 },
    ], { period: 13 });
    await closeMonths(sql);
    const r = await closeYear(sql);
    expect(r).toMatchObject({ result: 5000, equity_account: "2080", vouchers: [3, 4, 5] });
    const lines = await sql`
      select nr, account, amount::int from posting where entity = ${E} and year = ${Y} and nr >= 3 order by nr, line`;
    expect(lines).toEqual([
      { nr: 3, account: "6300", amount: -5000 },
      { nr: 3, account: "8800", amount: 5000 },
      { nr: 4, account: "8800", amount: -5000 },
      { nr: 4, account: "8990", amount: 5000 },
      { nr: 5, account: "8920", amount: -3000 },
      { nr: 5, account: "8990", amount: -5000 },
      { nr: 5, account: "2080", amount: 8000 },
    ]);
    const after = await balances(sql);
    expect(Object.entries(after).filter(([a]) => a >= "3000").every(([, b]) => b === 0)).toBe(true);
    expect(after).toMatchObject({ "2080": 8000, "2800": -3000, "2710": 1250, "1920": -6250 });
  });

  test("the equity account can be chosen; a year with no P&L activity closes with no vouchers", async () => {
    await post(sql, "cost", `${Y}-02-01`, [{ account: "6300", amount: 5000 }, { account: "1920", amount: -5000 }]);
    await closeMonths(sql);
    const r = await closeYear(sql, Y, "2050");
    expect(r).toMatchObject({ result: 5000, equity_account: "2050" });
    expect((await balances(sql))["2050"]).toBe(5000);

    await sql`select ensure_fiscal_year(${E}, 2027::smallint)`;
    for (let m = 1; m <= 12; m++) await sql`select close_period(${E}, 2027::smallint, ${m}::smallint)`;
    const empty = await closeYear(sql, 2027);
    expect(empty).toEqual({ entity: E, year: 2027, result: 0, equity_account: "2050", vouchers: [], period_13: "closed" });
  });

  test("exact break-even and a dividend covering the whole result leave no zero-amount lines", async () => {
    await post(sql, "sale", `${Y}-01-15`, [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await post(sql, "cost", `${Y}-01-16`, [{ account: "6300", amount: 100 }, { account: "1920", amount: -100 }]);
    await closeMonths(sql);
    const even = await closeYear(sql);
    expect(even).toMatchObject({ result: 0, vouchers: [3] });
    let lines = await sql`select nr, account, amount::int from posting where entity = ${E} and year = ${Y} and nr = 3 order by line`;
    expect(lines).toEqual([{ nr: 3, account: "3000", amount: 100 }, { nr: 3, account: "6300", amount: -100 }]);

    await sql`select ensure_fiscal_year(${E}, 2027::smallint)`;
    await post(sql, "sale27", "2027-01-15", [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await post(sql, "dividend27", "2027-12-31", [{ account: "8920", amount: 100 }, { account: "2800", amount: -100 }], { period: 13 });
    for (let m = 1; m <= 12; m++) await sql`select close_period(${E}, 2027::smallint, ${m}::smallint)`;
    const full = await closeYear(sql, 2027);
    expect(full).toMatchObject({ result: -100, vouchers: [3, 4, 5] });
    lines = await sql`select nr, account, amount::int from posting where entity = ${E} and year = 2027 and nr = 5 order by line`;
    expect(lines).toEqual([{ nr: 5, account: "8920", amount: -100 }, { nr: 5, account: "8960", amount: 100 }]);
    const after = await balances(sql);
    expect(Object.entries(after).filter(([a]) => a >= "3000").every(([, b]) => b === 0)).toBe(true);
    expect(after["2800"]).toBe(-100);
  });

  test("a pre-existing close:<year> key is an error, not a silent skip; the year stays open", async () => {
    await post(sql, "sale", `${Y}-01-15`, [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await sql`select post_voucher(${{
      entity: E, posting_date: `${Y}-01-20`, description: "stray", idempotency_key: `close:${Y}:transfer`,
      lines: [{ account: "1920", amount: 1 }, { account: "1900", amount: -1 }],
    }}::jsonb)`;
    await closeMonths(sql);
    const err = await pgError(closeYear(sql));
    expect(err.message).toContain("voucher with idempotency key close:2026:transfer already exists");
    const [p] = await sql`select status from period where entity = ${E} and year = ${Y} and nr = 13`;
    expect(p.status).toBe("open");
    const [n] = await sql`select count(*)::int as n from voucher where entity = ${E}`;
    expect(n.n).toBe(2);
  });

  test("the equity account must be 2000-2099", async () => {
    await closeMonths(sql);
    const err = await pgError(closeYear(sql, Y, "1920"));
    expect(err.message).toContain("equity account 1920 is not an equity account (2000-2099)");
    const [p] = await sql`select status from period where entity = ${E} and year = ${Y} and nr = 13`;
    expect(p.status).toBe("open");
  });

  test("refuses while periods 1-12 are open, and refuses a second time", async () => {
    await post(sql, "sale", `${Y}-01-15`, [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await closeMonths(sql, 2);
    await sql`select close_period(${E}, ${Y}::smallint, 7::smallint)`;
    const open = await pgError(closeYear(sql));
    expect(open.message).toContain("period(s) 3, 4, 5, 6, 8, 9, 10, 11, 12 of 2026 for 999888777 are still open");
    const [n] = await sql`select count(*)::int as n from voucher where entity = ${E}`;
    expect(n.n).toBe(1);
    for (const m of [3, 4, 5, 6, 8, 9, 10, 11, 12]) await sql`select close_period(${E}, ${Y}::smallint, ${m}::smallint)`;
    await closeYear(sql);
    const again = await pgError(closeYear(sql));
    expect(again.message).toContain("period 2026/13 for 999888777 is not open: the year is already closed");
    const missing = await pgError(closeYear(sql, 2030));
    expect(missing.message).toContain("fiscal year 2030 does not exist");
  });

  test("needs 8800 and the transfer/equity accounts in the chart", async () => {
    await sql`delete from account where entity = ${E} and code = '8960'`;
    await post(sql, "sale", `${Y}-01-15`, [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await closeMonths(sql);
    const err = await pgError(closeYear(sql));
    expect(err.message).toContain("account 8960 is not in the chart of entity 999888777; the year-end close needs it");
    expect(err.errno).toBe("23503");
  });

  test("hovedbok_app runs it; hovedbok_ro cannot; integer literals resolve as from psql", async () => {
    await post(sql, "sale", `${Y}-01-15`, [{ account: "1920", amount: 100 }, { account: "3000", amount: -100 }]);
    await sql.unsafe(`select close_period('${E}', 2026, 1)`);
    for (let m = 2; m <= 12; m++) await sql`select close_period(${E}, ${Y}::smallint, ${m}::smallint)`;
    const r = await as("hovedbok_app", (tx) => closeYear(tx));
    expect(r.result).toBe(-100);
    await sql.unsafe(`select ensure_fiscal_year('${E}', 2027::smallint)`);
    for (let m = 1; m <= 12; m++) await sql.unsafe(`select close_period('${E}', 2027, ${m})`);
    const [{ r: lit }] = await sql.unsafe(`select close_fiscal_year('${E}', 2027) as r`);
    expect(lit).toMatchObject({ year: 2027, vouchers: [] });
    const err = await pgError(as("hovedbok_ro", (tx) => tx`select close_fiscal_year(${E}, 2027::smallint)`));
    expect(err.errno).toBe("42501");
    const [priv] = await sql`
      select has_table_privilege('hovedbok_ro', 'account_year_balance', 'select') as ro_view,
             has_table_privilege('hovedbok_app', 'account_year_balance', 'select') as app_view`;
    expect(priv).toEqual({ ro_view: true, app_view: true });
  });
});

// ---------------------------------------------------------------------------
describe("upsert_account", () => {
  test("creates a custom account from the standard one it maps to, then updates only what is given", async () => {
    const [{ r }] = await sql`select upsert_account(${{ entity: E, code: "1921", name: "Bank, sparekonto", std_account: "1920" }}::jsonb) as r`;
    expect(r).toEqual({ entity: E, code: "1921", created: true });
    let [a] = await sql`select name, std_account, grouping, default_vat, control from account where entity = ${E} and code = '1921'`;
    expect(a).toEqual({ name: "Bank, sparekonto", std_account: "1920", grouping: "1920", default_vat: null, control: null });

    const [{ r: again }] = await sql`select upsert_account(${{ entity: E, code: "1921", name: "Sparekonto DNB" }}::jsonb) as r`;
    expect(again).toEqual({ entity: E, code: "1921", created: false });
    [a] = await sql`select name, std_account, grouping from account where entity = ${E} and code = '1921'`;
    expect(a).toEqual({ name: "Sparekonto DNB", std_account: "1920", grouping: "1920" });

    // a standard code needs no name; a non-standard one with no std_account resolves grouping by range
    await sql`delete from account where entity = ${E} and code = '1950'`;
    await sql`select upsert_account(${{ entity: E, code: "1950" }}::jsonb)`;
    [a] = await sql`select name, std_account, grouping from account where entity = ${E} and code = '1950'`;
    expect(a).toEqual({ name: "Bankinnskudd for skattetrekk", std_account: "1950", grouping: "1950" });
    await sql`select upsert_account(${{ entity: E, code: "1923", name: "Kort", std_account: null }}::jsonb)`;
    [a] = await sql`select name, std_account, grouping from account where entity = ${E} and code = '1923'`;
    expect(a).toEqual({ name: "Kort", std_account: null, grouping: "1920" });

    // explicit null clears; a custom VAT account inherits the standard default code
    await sql`select upsert_account(${{ entity: E, code: "2719", name: "Inngående mva, spesial", std_account: "2710" }}::jsonb)`;
    [a] = await sql`select default_vat from account where entity = ${E} and code = '2719'`;
    expect(a.default_vat).toBe("1");
    await sql`select upsert_account(${{ entity: E, code: "2719", default_vat: null }}::jsonb)`;
    [a] = await sql`select default_vat from account where entity = ${E} and code = '2719'`;
    expect(a.default_vat).toBeNull();
  });

  test("std_account is immutable once the account has postings", async () => {
    await sql`select upsert_account(${{ entity: E, code: "2719", name: "Mva spesial", std_account: "2710" }}::jsonb)`;
    await sql`select upsert_account(${{ entity: E, code: "2719", std_account: "2711" }}::jsonb)`;
    await post(sql, "buy", `${Y}-02-01`, [
      { account: "6300", amount: 8000, vat_code: "11", vat_base: 8000 },
      { account: "2719", amount: 1200 },
      { account: "1920", amount: -9200 },
    ]);
    const err = await pgError(sql`select upsert_account(${{ entity: E, code: "2719", std_account: "2710" }}::jsonb)`);
    expect(err.message).toContain("account 2719 has postings; its std_account (2711) cannot change");
    // other columns still change; the same std_account is not a change
    await sql`select upsert_account(${{ entity: E, code: "2719", name: "Renamed", std_account: "2711" }}::jsonb)`;
    const [a] = await sql`select name, std_account from account where entity = ${E} and code = '2719'`;
    expect(a).toEqual({ name: "Renamed", std_account: "2711" });
  });

  test("validates its payload", async () => {
    const cases: [object, string][] = [
      [{ entity: E }, "entity and code are required"],
      [{ entity: "111111111", code: "1921", name: "x" }, "entity 111111111 does not exist"],
      [{ entity: E, code: "19210", name: "x" }, "account code 19210 must be 4 digits"],
      [{ entity: E, code: "1921", name: "x", std_account: "1919" }, "std_account 1919 is not a SAF-T standard account"],
      [{ entity: E, code: "1921", std_account: "1920", control: "owner" }, "control must be customer, supplier or null, got owner"],
      [{ entity: E, code: "1921", std_account: "1920", default_vat: "99" }, "default_vat 99 is not a vat code"],
      [{ entity: E, code: "0001" }, "name is required for account 0001"],
      [{ entity: E, code: "0001", name: "x", grouping: null }, "account 0001 needs a std_account or a grouping"],
    ];
    for (const [p, msg] of cases) {
      const err = await pgError(sql`select upsert_account(${p}::jsonb)`);
      expect({ p, message: err.message }).toEqual({ p, message: expect.stringContaining(msg) });
    }
  });
});

describe("upsert_party", () => {
  test("creates, then updates only what is given; app may run both commands", async () => {
    const r = await as("hovedbok_app", async (tx) => {
      const [{ r }] = await tx`select upsert_party(${{ entity: E, id: "K2", name: "Ny kunde AS", orgnr: "987654321", customer: true, address: { city: "Oslo" } }}::jsonb) as r`;
      await tx`select upsert_account(${{ entity: E, code: "1921", name: "x", std_account: "1920" }}::jsonb)`;
      return r;
    });
    expect(r).toEqual({ entity: E, id: "K2", created: true });
    let [p] = await sql`select name, orgnr, country, address, customer, supplier, owner, peppol_id from party where entity = ${E} and id = 'K2'`;
    expect(p).toEqual({ name: "Ny kunde AS", orgnr: "987654321", country: "NO", address: { city: "Oslo" }, customer: true, supplier: false, owner: false, peppol_id: null });

    const [{ r: again }] = await sql`select upsert_party(${{ entity: E, id: "K2", supplier: true, peppol_id: "0192:987654321" }}::jsonb) as r`;
    expect(again).toEqual({ entity: E, id: "K2", created: false });
    [p] = await sql`select name, orgnr, address, customer, supplier, peppol_id from party where entity = ${E} and id = 'K2'`;
    expect(p).toEqual({ name: "Ny kunde AS", orgnr: "987654321", address: { city: "Oslo" }, customer: true, supplier: true, peppol_id: "0192:987654321" });
    await sql`select upsert_party(${{ entity: E, id: "K2", orgnr: null, address: null }}::jsonb)`;
    [p] = await sql`select orgnr, address from party where entity = ${E} and id = 'K2'`;
    expect(p).toEqual({ orgnr: null, address: {} });
    // the new role is usable at once
    await post(sql, "buy", `${Y}-01-15`, [{ account: "2400", amount: -100, party: "K2" }, { account: "1920", amount: 100 }]);
  });

  test("validates its payload", async () => {
    const cases: [object, string][] = [
      [{ entity: E }, "entity and id are required"],
      [{ entity: "111111111", id: "K9", name: "x" }, "entity 111111111 does not exist"],
      [{ entity: E, id: "K9" }, "name is required for a new party"],
      [{ entity: E, id: "K9", name: "x", orgnr: "12" }, "orgnr 12 must be 9 digits"],
      [{ entity: E, id: "K9", name: "x", address: "Oslo" }, "address must be a JSON object"],
    ];
    for (const [p, msg] of cases) {
      const err = await pgError(sql`select upsert_party(${p}::jsonb)`);
      expect({ p, message: err.message }).toEqual({ p, message: expect.stringContaining(msg) });
    }
    const err = await pgError(as("hovedbok_ro", (tx) => tx`select upsert_party(${{ entity: E, id: "K9", name: "x" }}::jsonb)`));
    expect(err.errno).toBe("42501");
  });
});
