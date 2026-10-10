// The statutory specifications (#7): saldobalanse, kontospesifikasjon,
// bokforingsspesifikasjon, kunde-/leverandorspesifikasjon, resultat, balanse.
//
// Oracle: enkelt-regnskap's test data set, 4. termin 2026. Its SAF-T reference
// file is vendored verbatim in test/fixtures/enkelt-regnskap/ (from
// ~/code/enkelt-regnskap test/fixtures/saft/, commit 6b937b6, sha256
// 35c7c25d…45377). The test posts every GeneralLedgerEntries transaction
// through post_voucher() and reads the figures back out of the views; the
// expected trial balance is the file's own MasterFiles opening/closing
// balances, plus the expectations enkelt-regnskap asserts in
// test/invarianter.test.ts ("saldo 4. termin 2026: 1920 = 61 573,75,
// 1921 = -2 505,04, 1580 = 0"; "mva 4. termin 2026: 12 520,86 å betale").
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dropTestDb, freshDb } from "./helper";

let sql: SQL;
beforeEach(async () => {
  sql = await freshDb();
});
afterAll(dropTestDb);

type Line = { account: string; amount: number; party?: string; vat_code?: string; vat_base?: number; description?: string };

async function post(entity: string, key: string, posting_date: string, lines: Line[], over: Record<string, unknown> = {}) {
  const [row] = await sql`select post_voucher(${{ entity, posting_date, description: key, idempotency_key: key, lines, ...over }}::jsonb) as r`;
  return row.r as { year: number; nr: number };
}

/** "1234.50" -> 123450 øre, no floating point on the way. */
function ore(s: string): number {
  const [kr, frac = ""] = s.trim().split(".");
  const sign = kr!.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(kr)) * 100 + Number((frac + "00").slice(0, 2)));
}

// ---------------------------------------------------------------------------
// The SAF-T reference file, read with nothing but regexes (its shape is fixed).
const xml = readFileSync(new URL("./fixtures/enkelt-regnskap/SAF-T Financial_987654321_20260930180503_1_1.xml", import.meta.url), "utf8");
const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
const blocks = (s: string, t: string) => [...s.matchAll(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "g"))].map((m) => m[1]!);
/** Opening/closing as signed øre from a SAF-T balance element pair. */
const balance = (s: string, when: "Opening" | "Closing") => {
  const d = tag(s, `${when}DebitBalance`);
  return d !== undefined ? ore(d) : -ore(tag(s, `${when}CreditBalance`)!);
};

const ER = "987654321";
const saftAccounts = blocks(xml, "Account").map((a) => ({
  code: tag(a, "AccountID")!, name: tag(a, "AccountDescription")!,
  category: tag(a, "GroupingCategory")!, grouping: tag(a, "GroupingCode")!,
  opening: balance(a, "Opening"), closing: balance(a, "Closing"),
}));
const saftParties = (t: "Customer" | "Supplier") => blocks(xml, t).map((c) => ({
  id: tag(c, `${t}ID`)!, name: tag(c, "Name")!, orgnr: tag(c, "RegistrationNumber")!,
  country: tag(blocks(c, "Address")[0]!, "Country")!,
  opening: balance(c, "Opening"), closing: balance(c, "Closing"),
}));
const saftTransactions = blocks(xml, "Transaction").map((t) => ({
  id: tag(t, "TransactionID")!, period: Number(tag(t, "Period")), date: tag(t, "TransactionDate")!,
  description: tag(t, "Description")!,
  lines: blocks(t, "Line").map((l): Line => {
    const debit = blocks(l, "DebitAmount")[0];
    const amount = debit !== undefined ? ore(tag(debit, "Amount")!) : -ore(tag(blocks(l, "CreditAmount")[0]!, "Amount")!);
    const tax = blocks(l, "TaxInformation")[0];
    const line: Line = { account: tag(l, "AccountID")!, amount, description: tag(l, "Description")! };
    const party = tag(l, "CustomerID") ?? tag(l, "SupplierID");
    if (party) line.party = party;
    // ADR-0011: the code and base ride on the base line; SAF-T bases are unsigned
    if (tax) Object.assign(line, { vat_code: tag(tax, "TaxCode")!, vat_base: Math.sign(amount) * ore(tag(tax, "TaxBase")!) });
    return line;
  }),
}));

/** Entity, chart, parties and journal of the reference file, through the commands. */
async function loadEnkeltRegnskap(): Promise<void> {
  await sql`select bootstrap_entity(${{ orgnr: ER, name: tag(xml, "Name"), vat_registered: true, year: 2026 }}::jsonb)`;
  // The chart exactly as the reference file declares it: every account mapped
  // by GroupingCategory/GroupingCode, no StandardAccountID. That also keeps
  // its 27xx accounts out of the VAT-account line rules, which are being
  // replaced (ADR-0011); this test is about the trial balance, not VAT.
  for (const a of saftAccounts) {
    await sql`select upsert_account(${{ entity: ER, code: a.code, name: a.name, std_account: null, grouping: a.grouping }}::jsonb)`;
  }
  for (const [t, role] of [["Customer", "customer"], ["Supplier", "supplier"]] as const) {
    for (const p of saftParties(t)) {
      // party.orgnr is a Norwegian orgnr; Vendor Ltd's IE VAT number has no place there
      const orgnr = /^\d{9}$/.test(p.orgnr) ? p.orgnr : null;
      await sql`select upsert_party(${{ entity: ER, id: p.id, name: p.name, orgnr, country: p.country, [role]: true }}::jsonb)`;
    }
  }
  for (const t of saftTransactions) {
    const r = await post(ER, `saft:${t.id}`, t.date, t.lines, { description: t.description, external_ref: t.id, period: t.period });
    expect(r.nr).toBe(Number(t.id));
  }
}

describe("oracle: enkelt-regnskap 4. termin 2026", () => {
  test("saldobalanse 07-08 reproduces the reference file's trial balance, account for account", async () => {
    await loadEnkeltRegnskap();
    const rows = await sql`select account, account_name, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8 order by account`;
    expect(rows.map((r: { account: string; account_name: string; opening: number; closing: number }) =>
      ({ code: r.account, name: r.account_name, opening: r.opening, closing: r.closing })))
      .toEqual(saftAccounts.map(({ code, name, opening, closing }) => ({ code, name, opening, closing })));
    // every row: closing = opening + debit - credit
    for (const r of rows) expect(r.closing).toBe(r.opening + r.debit - r.credit);
    // the debit and credit columns total the file's GeneralLedgerEntries totals
    const [tot] = await sql`select sum(debit)::int as d, sum(credit)::int as c from saldobalanse where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8`;
    expect(tot).toEqual({ d: ore(tag(xml, "TotalDebit")!), c: ore(tag(xml, "TotalCredit")!) });
    expect(tot.d).toBe(16726754);

    // invarianter.test.ts: "saldo 4. termin 2026: 1920 = 61 573,75, 1921 = -2 505,04, 1580 = 0"
    const ub = Object.fromEntries(rows.map((r: { account: string; closing: number }) => [r.account, r.closing]));
    expect(ub["1920"]).toBe(6157375);
    expect(ub["1921"]).toBe(-250504);
    expect(ub["1580"]).toBe(0);

    // per period: July's closing is August's opening, and the two single
    // periods add up to the range
    const jul = await sql`select account, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 7 order by account`;
    const aug = await sql`select account, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${ER} and year = 2026 and period_from = 8 and period_to = 8 order by account`;
    const julClosing = Object.fromEntries(jul.map((r: { account: string; closing: number }) => [r.account, r.closing]));
    for (const r of aug) expect({ a: r.account, opening: r.opening }).toEqual({ a: r.account, opening: julClosing[r.account] ?? 0 });
    const sumBy = (rs: { account: string; debit: number; credit: number }[], a: string) =>
      rs.filter((r) => r.account === a).reduce((s, r) => ({ debit: s.debit + r.debit, credit: s.credit + r.credit }), { debit: 0, credit: 0 });
    for (const r of rows) expect({ a: r.account, ...sumBy([...jul, ...aug], r.account) }).toEqual({ a: r.account, debit: r.debit, credit: r.credit });
    // a one-period range is the per-period layer's row
    const [one] = await sql`select opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${ER} and year = 2026 and period_from = 8 and period_to = 8 and account = '1920'`;
    const [row8] = await sql`select opening::int, debit::int, credit::int, closing::int from account_period_balance where entity = ${ER} and year = 2026 and period = 8 and account = '1920'`;
    expect(one).toEqual(row8);
    // the whole year: nothing before July or after August, so the same figures
    expect(await sql`select account, closing::int from saldobalanse where entity = ${ER} and year = 2026 and period_from = 1 and period_to = 13 order by account`)
      .toEqual(rows.map((r: { account: string; closing: number }) => ({ account: r.account, closing: r.closing })));
  });

  test("balanse and resultat roll the trial balance up by SAF-T grouping; 2740 is the VAT to pay", async () => {
    await loadEnkeltRegnskap();
    const byGrouping = (accounts: typeof saftAccounts) => {
      const m = new Map<string, number>();
      for (const a of accounts) m.set(`${a.category}/${a.grouping}`, (m.get(`${a.category}/${a.grouping}`) ?? 0) + a.closing);
      return Object.fromEntries(m);
    };
    const bal = await sql`
      select grouping_category || '/' || grouping as g, sum(amount)::int as amount
        from balanse where entity = ${ER} and year = 2026 and period = 8 group by 1`;
    expect(Object.fromEntries(bal.map((r: { g: string; amount: number }) => [r.g, r.amount])))
      .toEqual(byGrouping(saftAccounts.filter((a) => a.code < "3000")));
    // invarianter.test.ts: "mva 4. termin 2026: 12 520,86 å betale" — the 27xx accounts net to it
    expect(bal.find((r: { g: string }) => r.g === "kortsiktigGjeld/2740").amount).toBe(-1252086);

    const res = await sql`
      select grouping_category || '/' || grouping as g, sum(amount)::int as amount
        from resultat where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8 group by 1`;
    expect(Object.fromEntries(res.map((r: { g: string; amount: number }) => [r.g, r.amount])))
      .toEqual(byGrouping(saftAccounts.filter((a) => a.code >= "3000")));
    // the result: 57 671,00 revenue - 4 611,65 - 4 210,20 - 250,00 - 360,00 - 245,00
    const [r] = await sql`select -sum(amount)::int as result from resultat where entity = ${ER} and year = 2026 and period_from = 1 and period_to = 13`;
    expect(r.result).toBe(4799415);
    // before the close, balance + unclosed result = 0
    const [b] = await sql`select sum(amount)::int as s from balanse where entity = ${ER} and year = 2026 and period = 8`;
    expect(b.s).toBe(r.result);
    // a grouping spanning classes splits by class: 7700 holds 6550, 6560 (class 6) and 7770 (class 7)
    const split = await sql`
      select class, amount::int, accounts from resultat
       where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8 and grouping = '7700' order by class`;
    expect(split).toEqual([
      { class: "6", amount: 61000, accounts: ["6550", "6560"] },
      { class: "7", amount: 24500, accounts: ["7770"] },
    ]);
  });

  test("kunde- and leverandorspesifikasjon match the file's party balances; bokforingsspesifikasjon is its journal", async () => {
    await loadEnkeltRegnskap();
    const kunder = await sql`select party, name, orgnr, account, opening::int, closing::int from kundespesifikasjon where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8 order by party`;
    expect(kunder).toEqual(saftParties("Customer").map((p) => ({ party: p.id, name: p.name, orgnr: p.orgnr, account: "1500", opening: p.opening, closing: p.closing })));
    // Only Matgrossisten is ever posted on 2400 (the rest are paid on the spot)
    const lev = await sql`select party, name, orgnr, country, account, opening::int, debit::int, credit::int, closing::int from leverandorspesifikasjon where entity = ${ER} and year = 2026 and period_from = 7 and period_to = 8 order by party`;
    const l002 = saftParties("Supplier").find((p) => p.id === "L002")!;
    expect(lev).toEqual([{ party: "L002", name: l002.name, orgnr: "934567890", country: "NO", account: "2400", opening: l002.opening, debit: 300000, credit: 300000, closing: l002.closing }]);

    const journal = await sql`
      select nr, line, posting_date::text as date, voucher_description as d, external_ref, account, debit::int, credit::int, vat_code, party
        from bokforingsspesifikasjon where entity = ${ER} order by year, nr, line`;
    const expected = saftTransactions.flatMap((t) => t.lines.map((l, i) => ({
      nr: Number(t.id), line: i + 1, date: t.date, d: t.description, external_ref: t.id, account: l.account,
      debit: Math.max(l.amount, 0), credit: Math.max(-l.amount, 0), vat_code: l.vat_code ?? null, party: l.party ?? null,
    })));
    expect(journal).toEqual(expected);
    expect(journal.length).toBe(71);
  });
});

// ---------------------------------------------------------------------------
// Synthetic data: opening balances across periods and years, the party split,
// running context. No 27xx lines (the VAT-account line rules are being
// replaced, ADR-0011), so every voucher is a plain two- or three-line one.
const E = "999888777";

async function setup(): Promise<void> {
  await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", year: 2026 }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "K1", name: "Kunde En AS", orgnr: "911111111", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "K2", name: "Kunde To AS", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "L1", name: "Leverandør En AS", orgnr: "922222222", supplier: true }}::jsonb)`;
  // both roles: sells to us and buys from us
  await sql`select upsert_party(${{ entity: E, id: "B1", name: "Begge AS", orgnr: "933333333", customer: true, supplier: true }}::jsonb)`;
}

/** Jan..Apr 2026: sales on credit, a purchase on credit, partial settlements. */
async function postSpring(): Promise<void> {
  await post(E, "equity", "2026-01-02", [{ account: "1920", amount: 1000000 }, { account: "2000", amount: -1000000 }]);
  await post(E, "s1", "2026-01-15", [{ account: "1500", amount: 50000, party: "K1" }, { account: "3000", amount: -50000 }]);
  await post(E, "s2", "2026-02-10", [{ account: "1500", amount: 30000, party: "K2" }, { account: "3000", amount: -30000 }]);
  await post(E, "p1", "2026-02-20", [{ account: "1500", amount: -20000, party: "K1" }, { account: "1920", amount: 20000 }]);
  await post(E, "c1", "2026-03-05", [{ account: "6300", amount: 15000 }, { account: "2400", amount: -15000, party: "L1" }]);
  await post(E, "s3", "2026-03-10", [{ account: "1500", amount: 7000, party: "B1" }, { account: "3000", amount: -7000 }]);
  await post(E, "c2", "2026-03-12", [{ account: "6300", amount: 4000 }, { account: "2400", amount: -4000, party: "B1" }]);
  await post(E, "p2", "2026-04-01", [{ account: "2400", amount: 10000, party: "L1" }, { account: "1920", amount: -10000 }]);
  await post(E, "p3", "2026-04-03", [{ account: "1500", amount: -30000, party: "K2" }, { account: "1920", amount: 30000 }]);
}

describe("saldobalanse", () => {
  test("opening is everything before the range: a mid-year range opens with Jan+Feb", async () => {
    await setup();
    await postSpring();
    const mar = await sql`select account, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${E} and year = 2026 and period_from = 3 and period_to = 4 order by account`;
    expect(mar).toEqual([
      { account: "1500", opening: 60000, debit: 7000, credit: 30000, closing: 37000 },
      { account: "1920", opening: 1020000, debit: 30000, credit: 10000, closing: 1040000 },
      { account: "2000", opening: -1000000, debit: 0, credit: 0, closing: -1000000 },
      { account: "2400", opening: 0, debit: 10000, credit: 19000, closing: -9000 },
      { account: "3000", opening: -80000, debit: 0, credit: 7000, closing: -87000 },
      { account: "6300", opening: 0, debit: 19000, credit: 0, closing: 19000 },
    ]);
    // a range with no movement still lists what is carried; the debit/credit columns are positive
    const jun = await sql`select account, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${E} and year = 2026 and period_from = 6 and period_to = 6 order by account`;
    expect(jun.map((r: { account: string; opening: number; closing: number; debit: number }) => [r.account, r.opening, r.closing, r.debit]))
      .toEqual(mar.map((r: { account: string; closing: number }) => [r.account, r.closing, r.closing, 0]));
    const [sum] = await sql`select sum(closing)::int as s from saldobalanse where entity = ${E} and year = 2026 and period_from = 1 and period_to = 13`;
    expect(sum.s).toBe(0);
    // the per-period layer is dense: every period of the year for every posted account
    const [n] = await sql`select count(*)::int as n from account_period_balance where entity = ${E} and year = 2026`;
    expect(n.n).toBe(6 * 13);
    // and every range of the year (13 * 14 / 2 = 91) is there for an account that carries a balance
    const [r] = await sql`select count(*)::int as n from saldobalanse where entity = ${E} and year = 2026 and account = '2000'`;
    expect(r.n).toBe(91);
  });

  test("opening crosses years: balance accounts carry; P&L accounts open at zero after the close", async () => {
    await setup();
    await postSpring();
    for (let m = 1; m <= 12; m++) await sql`select close_period(${E}, 2026::smallint, ${m}::smallint)`;
    await sql`select close_fiscal_year(${E}, 2026::smallint)`;
    await post(E, "s27", "2027-02-01", [{ account: "1500", amount: 5000, party: "K1" }, { account: "3000", amount: -5000 }]);

    const rows = await sql`select account, opening::int, debit::int, credit::int, closing::int from saldobalanse where entity = ${E} and year = 2027 and period_from = 2 and period_to = 2 order by account`;
    expect(rows).toEqual([
      { account: "1500", opening: 37000, debit: 5000, credit: 0, closing: 42000 },
      { account: "1920", opening: 1040000, debit: 0, credit: 0, closing: 1040000 },
      { account: "2000", opening: -1000000, debit: 0, credit: 0, closing: -1000000 },
      // the 2026 profit, 87 000 - 19 000, disposed to 2050 (0015)
      { account: "2050", opening: -68000, debit: 0, credit: 0, closing: -68000 },
      { account: "2400", opening: -9000, debit: 0, credit: 0, closing: -9000 },
      { account: "3000", opening: 0, debit: 0, credit: 5000, closing: -5000 },
    ]);
    // the 2026 view still tells its own story; period 13 holds the close
    const [p13] = await sql`select opening::int, debit::int, closing::int from account_period_balance where entity = ${E} and year = 2026 and period = 13 and account = '3000'`;
    expect(p13).toEqual({ opening: -87000, debit: 87000, closing: 0 });
    // the year view of 0015 agrees with the period view on every account
    const yr = await sql`select account, opening::int, closing::int from account_year_balance where entity = ${E} and year = 2027 and (opening <> 0 or closing <> 0) order by account`;
    const sb = await sql`select account, opening::int, closing::int from saldobalanse where entity = ${E} and year = 2027 and period_from = 1 and period_to = 13 order by account`;
    expect(sb).toEqual(yr);

    // resultat ignores the close voucher: 2026 still shows its revenue and costs
    const res = await sql`select grouping, sum(amount)::int as amount from resultat where entity = ${E} and year = 2026 and period_from = 1 and period_to = 13 group by grouping order by grouping`;
    expect(res).toEqual([{ grouping: "3000", amount: -87000 }, { grouping: "6300", amount: 19000 }]);
    // and after the close the balance sheet balances
    const [b] = await sql`select sum(amount)::int as s from balanse where entity = ${E} and year = 2026 and period = 13`;
    expect(b.s).toBe(0);
  });
});

describe("kunde- and leverandorspesifikasjon", () => {
  test("per party on its control account, with opening across periods; a two-role party shows on both", async () => {
    await setup();
    await postSpring();
    const kunder = await sql`select party, name, orgnr, account, opening::int, debit::int, credit::int, closing::int from kundespesifikasjon where entity = ${E} and year = 2026 and period_from = 2 and period_to = 4 order by party`;
    expect(kunder).toEqual([
      { party: "B1", name: "Begge AS", orgnr: "933333333", account: "1500", opening: 0, debit: 7000, credit: 0, closing: 7000 },
      { party: "K1", name: "Kunde En AS", orgnr: "911111111", account: "1500", opening: 50000, debit: 0, credit: 20000, closing: 30000 },
      { party: "K2", name: "Kunde To AS", orgnr: null, account: "1500", opening: 0, debit: 30000, credit: 30000, closing: 0 },
    ]);
    const lev = await sql`select party, name, orgnr, country, account, opening::int, debit::int, credit::int, closing::int from leverandorspesifikasjon where entity = ${E} and year = 2026 and period_from = 4 and period_to = 4 order by party`;
    expect(lev).toEqual([
      { party: "B1", name: "Begge AS", orgnr: "933333333", country: "NO", account: "2400", opening: -4000, debit: 0, credit: 0, closing: -4000 },
      { party: "L1", name: "Leverandør En AS", orgnr: "922222222", country: "NO", account: "2400", opening: -15000, debit: 10000, credit: 0, closing: -5000 },
    ]);
    // the subledgers reconcile to their control accounts in every period
    const off = await sql`
      select s.period, s.account, s.closing::int, coalesce(sum(c.closing), 0)::int as parties
        from account_period_balance s
        left join control_account_balance c using (entity, year, period, account)
       where s.entity = ${E} and s.year = 2026 and s.account in ('1500', '2400')
       group by s.period, s.account, s.closing
      having s.closing <> coalesce(sum(c.closing), 0)`;
    expect(off).toEqual([]);
    // a single period
    const [k1] = await sql`select opening::int, credit::int, closing::int from kundespesifikasjon where entity = ${E} and year = 2026 and period_from = 2 and period_to = 2 and party = 'K1'`;
    expect(k1).toEqual({ opening: 50000, credit: 20000, closing: 30000 });
  });
});

describe("kontospesifikasjon and bokforingsspesifikasjon", () => {
  test("lines per account with running balance and counter accounts; voucher order with documents", async () => {
    await setup();
    await postSpring();
    await post(E, "split", "2026-03-20", [
      { account: "1920", amount: 9000 },
      { account: "1500", amount: -2000, party: "K1" },
      { account: "1500", amount: -7000, party: "B1" },
    ]);
    const k = await sql`
      select period, nr, line, posting_date::text as date, debit::int, credit::int, balance_before::int as before,
             balance_after::int as after, counter_accounts, party, party_name
        from kontospesifikasjon where entity = ${E} and account = '1500' and year = 2026
       order by year, period, posting_date, nr, line`;
    expect(k).toEqual([
      { period: 1, nr: 2, line: 1, date: "2026-01-15", debit: 50000, credit: 0, before: 0, after: 50000, counter_accounts: ["3000"], party: "K1", party_name: "Kunde En AS" },
      { period: 2, nr: 3, line: 1, date: "2026-02-10", debit: 30000, credit: 0, before: 50000, after: 80000, counter_accounts: ["3000"], party: "K2", party_name: "Kunde To AS" },
      { period: 2, nr: 4, line: 1, date: "2026-02-20", debit: 0, credit: 20000, before: 80000, after: 60000, counter_accounts: ["1920"], party: "K1", party_name: "Kunde En AS" },
      { period: 3, nr: 6, line: 1, date: "2026-03-10", debit: 7000, credit: 0, before: 60000, after: 67000, counter_accounts: ["3000"], party: "B1", party_name: "Begge AS" },
      { period: 3, nr: 10, line: 2, date: "2026-03-20", debit: 0, credit: 2000, before: 67000, after: 65000, counter_accounts: ["1920"], party: "K1", party_name: "Kunde En AS" },
      { period: 3, nr: 10, line: 3, date: "2026-03-20", debit: 0, credit: 7000, before: 65000, after: 58000, counter_accounts: ["1920"], party: "B1", party_name: "Begge AS" },
      { period: 4, nr: 9, line: 1, date: "2026-04-03", debit: 0, credit: 30000, before: 58000, after: 28000, counter_accounts: ["1920"], party: "K2", party_name: "Kunde To AS" },
    ]);
    // opening/closing of a range: first line's balance_before and last line's balance_after = saldobalanse
    const [sb] = await sql`select opening::int, closing::int from saldobalanse where entity = ${E} and year = 2026 and period_from = 3 and period_to = 3 and account = '1500'`;
    expect(sb).toEqual({ opening: k[3].before, closing: k[5].after });

    // bokforingsspesifikasjon: header context on every line, documents attached
    const sha = "a".repeat(64);
    await sql`insert into document (sha256, media_type, bytes, origin) values (${sha}, 'application/pdf', 10, 'invoice')`;
    const v = await post(E, "doc", "2026-04-10", [{ account: "6300", amount: 100 }, { account: "1920", amount: -100 }], { documents: [sha], external_ref: "F-1", document_date: "2026-04-08" });
    const lines = await sql`
      select nr, line, document_date::text as dd, posting_date::text as pd, voucher_description as d, external_ref, documents,
             account, account_name, debit::int, credit::int, created_by
        from bokforingsspesifikasjon where entity = ${E} and year = 2026 and nr >= ${v.nr - 1} order by nr, line`;
    expect(lines.slice(-2)).toEqual([
      { nr: v.nr, line: 1, dd: "2026-04-08", pd: "2026-04-10", d: "doc", external_ref: "F-1", documents: [sha], account: "6300", account_name: "Leie lokale", debit: 100, credit: 0, created_by: "hovedbok" },
      { nr: v.nr, line: 2, dd: "2026-04-08", pd: "2026-04-10", d: "doc", external_ref: "F-1", documents: [sha], account: "1920", account_name: "Bankinnskudd", debit: 0, credit: 100, created_by: "hovedbok" },
    ]);
    expect(lines[0].documents).toEqual([]);
  });
});

describe("grants", () => {
  test("both roles read every view; neither may write through them", async () => {
    await setup();
    await postSpring();
    const views = ["account_period_balance", "saldobalanse", "kontospesifikasjon", "bokforingsspesifikasjon", "control_account_balance", "kundespesifikasjon", "leverandorspesifikasjon", "resultat", "balanse"];
    for (const role of ["hovedbok_app", "hovedbok_ro"]) {
      for (const v of views) {
        const [p] = await sql`select has_table_privilege(${role}, ${v}, 'select') as s, has_table_privilege(${role}, ${v}, 'insert') as i`;
        expect({ role, v, ...p }).toEqual({ role, v, s: true, i: false });
      }
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx`select account, closing::int from saldobalanse where entity = ${E} and year = 2026 and period_from = 1 and period_to = 4 and account = '1920'`;
      });
      expect(rows).toEqual([{ account: "1920", closing: 1040000 }]);
    }
  });
});
