// Seeds (0010-0012): SAF-T VAT codes with regimes and dated rates, the
// standard chart with SAF-T grouping, and bootstrap_entity().
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { dropTestDb, freshDb } from "./helper";

const E = "999888777";

let sql: SQL;

beforeEach(async () => {
  sql = await freshDb();
});
afterAll(dropTestDb);

async function bootstrap(db: SQL, over: Record<string, unknown> = {}) {
  const payload = { orgnr: E, name: "Demo AS", vat_registered: true, year: 2026, ...over };
  const [{ r }] = await db`select bootstrap_entity(${payload}::jsonb) as r`;
  return r as { entity: string; created: boolean; accounts_added: number; year: number };
}

describe("vat codes", () => {
  test("the full SAF-T standard tax code list is seeded", async () => {
    const rows = await sql`select code from vat_code order by code::int`;
    expect(rows.map((r: { code: string }) => r.code)).toEqual([
      "0", "1", "3", "5", "6", "7", "11", "12", "13", "14", "15", "20", "21", "22",
      "31", "32", "33", "51", "52", "81", "82", "83", "84", "85", "86", "87", "88",
      "89", "91", "92",
    ]);
  });

  test("kinds carry the regime: reverse charge and import base are both-effect codes", async () => {
    const rows = await sql`select code, kind, deductible, report from vat_code`;
    const by = Object.fromEntries(rows.map((r: any) => [r.code, r]));
    expect(by["3"]).toMatchObject({ kind: "output", deductible: false, report: true });
    expect(by["1"]).toMatchObject({ kind: "input", deductible: true, report: true });
    expect(by["14"]).toMatchObject({ kind: "import_input", deductible: true });
    expect(by["81"]).toMatchObject({ kind: "import_base", deductible: true });
    expect(by["82"]).toMatchObject({ kind: "import_base", deductible: false });
    expect(by["86"]).toMatchObject({ kind: "reverse_charge", deductible: true });
    expect(by["87"]).toMatchObject({ kind: "reverse_charge", deductible: false });
    expect(by["92"]).toMatchObject({ kind: "reverse_charge", deductible: false });
    expect(by["52"]).toMatchObject({ kind: "zero", report: true });
    expect(by["6"]).toMatchObject({ kind: "outside", report: true });
    expect(by["7"]).toMatchObject({ kind: "no_turnover", report: false });
    expect(by["0"]).toMatchObject({ kind: "none", report: false });
    expect(by["20"]).toMatchObject({ kind: "none", report: false });
  });

  test("every code has a rate on 2026-01-15, matching the four Norwegian rates", async () => {
    const rows = await sql`
      select c.code, (select rate from vat_rate r
                        where r.code = c.code and r.valid_from <= '2026-01-15'
                        order by valid_from desc limit 1)::float as rate
        from vat_code c`;
    const rate = Object.fromEntries(rows.map((r: any) => [r.code, r.rate]));
    for (const c of ["1", "3", "14", "21", "81", "82", "86", "87", "91", "92"]) expect(rate[c]).toBe(25);
    for (const c of ["11", "15", "22", "31", "83", "84"]) expect(rate[c]).toBe(15);
    for (const c of ["13", "33", "88", "89"]) expect(rate[c]).toBe(12);
    for (const c of ["12", "32"]) expect(rate[c]).toBe(11.11);
    for (const c of ["0", "5", "6", "7", "20", "51", "52", "85"]) expect(rate[c]).toBe(0);
  });
});

describe("standard chart", () => {
  test("all 745 standard accounts are seeded, each with exactly one SAF-T grouping", async () => {
    const [n] = await sql`
      select count(*)::int as total,
             count(*) filter (where grouping_code is null)::int as ungrouped
        from std_account`;
    expect(n).toEqual({ total: 745, ungrouped: 0 });
    const rows = await sql`
      select code, grouping_category, grouping_code from std_account
       where code in ('1500', '1900', '2711', '7770')
       order by code`;
    expect(rows).toEqual([
      { code: "1500", grouping_category: "balanseverdiForOmloepsmiddel", grouping_code: "1500" },
      { code: "1900", grouping_category: "balanseverdiForOmloepsmiddel", grouping_code: "1900" },
      { code: "2711", grouping_category: "kortsiktigGjeld", grouping_code: "2740" },
      { code: "7770", grouping_category: "annenDriftskostnad", grouping_code: "7700" },
    ]);
  });
});

describe("bootstrap_entity", () => {
  test("creates entity, copies the chart with control and vat defaults, opens the year", async () => {
    expect(await bootstrap(sql)).toEqual({ entity: E, created: true, accounts_added: 745, year: 2026 });

    const [ent] = await sql`select name, vat_registered, vat_term from entity where orgnr = ${E}`;
    expect(ent).toEqual({ name: "Demo AS", vat_registered: true, vat_term: "bimonthly" });

    const accts = await sql`
      select code, name, std_account, grouping, default_vat, control from account
       where entity = ${E} and code in ('1500', '2400', '2700', '2710', '2711', '3000')
       order by code`;
    expect(accts).toEqual([
      { code: "1500", name: "Kundefordringer", std_account: "1500", grouping: "1500", default_vat: null, control: "customer" },
      { code: "2400", name: "Leverandørgjeld", std_account: "2400", grouping: "2400", default_vat: null, control: "supplier" },
      { code: "2700", name: "Utgående merverdiavgift, høy sats", std_account: "2700", grouping: "2740", default_vat: "3", control: null },
      { code: "2710", name: "Inngående merverdiavgift, høy sats", std_account: "2710", grouping: "2740", default_vat: "1", control: null },
      { code: "2711", name: "Inngående merverdiavgift, middels sats", std_account: "2711", grouping: "2740", default_vat: "11", control: null },
      { code: "3000", name: "Salgsinntekt handelsvarer, avgiftspliktig, høy sats", std_account: "3000", grouping: "3000", default_vat: null, control: null },
    ]);

    const [p] = await sql`
      select count(*)::int as n, min(date_from)::text as first, max(date_to)::text as last
        from period where entity = ${E} and year = 2026`;
    expect(p).toEqual({ n: 13, first: "2026-01-01", last: "2026-12-31" });
  });

  test("is idempotent and never overwrites the entity's own changes", async () => {
    await bootstrap(sql);
    await sql`update account set name = 'Bank DNB' where entity = ${E} and code = '1920'`;
    expect(await bootstrap(sql, { name: "Other name" })).toEqual({
      entity: E, created: false, accounts_added: 0, year: 2026,
    });
    const [a] = await sql`select name from account where entity = ${E} and code = '1920'`;
    expect(a.name).toBe("Bank DNB");
    const [e] = await sql`select name from entity where orgnr = ${E}`;
    expect(e.name).toBe("Demo AS");
  });

  test("requires orgnr and name", async () => {
    const err = await sql`select bootstrap_entity('{"orgnr": "999888777"}'::jsonb)`.catch((e) => e);
    expect(String(err.message)).toContain("orgnr and name are required");
  });

  test("fresh db -> bootstrap -> README voucher -> vat_summary shows code 3 output VAT", async () => {
    await bootstrap(sql);
    // the README example, verbatim
    await sql`select post_voucher('{
      "entity": "999888777",
      "posting_date": "2026-01-15",
      "description": "Sale",
      "idempotency_key": "demo-1",
      "lines": [
        {"account": "1920", "amount": 12500},
        {"account": "3000", "amount": -10000, "vat_code": "3", "vat_base": -10000},
        {"account": "2700", "amount": -2500, "vat_code": "3"}
      ]
    }')`;
    const rows = await sql`
      select year, period, vat_code, base::int, vat::int, output_vat::int, input_vat::int
        from vat_summary where entity = ${E}`;
    expect(rows).toEqual([
      { year: 2026, period: 1, vat_code: "3", base: -10000, vat: -2500, output_vat: -2500, input_vat: 0 },
    ]);
  });

  test("reverse charge (86) reports both effects from the VAT accounts", async () => {
    await bootstrap(sql);
    await sql`insert into party (entity, id, name, supplier, country) values (${E}, 'L1', 'Foreign Ltd', true, 'IE')`;
    await sql`select post_voucher(${{
      entity: E,
      posting_date: "2026-03-10",
      description: "Software subscription from abroad",
      idempotency_key: "rc-1",
      lines: [
        { account: "6540", amount: 10000, vat_code: "86", vat_base: 10000 },
        { account: "2400", amount: -10000, party: "L1" },
        { account: "2714", amount: 2500, vat_code: "86" },
        { account: "2704", amount: -2500, vat_code: "86" },
      ],
    }}::jsonb)`;
    const [row] = await sql`
      select base::int, vat::int, output_vat::int, input_vat::int
        from vat_summary where entity = ${E} and vat_code = '86'`;
    expect(row).toEqual({ base: 10000, vat: 0, output_vat: -2500, input_vat: 2500 });
  });

  test("only hovedbok_app may run it; both roles read the seeds", async () => {
    const [priv] = await sql`
      select has_function_privilege('hovedbok_app', 'bootstrap_entity(jsonb)', 'execute') as app,
             has_function_privilege('hovedbok_ro', 'bootstrap_entity(jsonb)', 'execute') as ro,
             has_table_privilege('hovedbok_ro', 'std_account', 'select') as ro_std,
             has_table_privilege('hovedbok_ro', 'grouping_range', 'select') as ro_range,
             has_table_privilege('hovedbok_app', 'std_account', 'insert') as app_std_insert,
             has_table_privilege('hovedbok_ro', 'vat_summary', 'select') as ro_view`;
    expect(priv).toEqual({
      app: true, ro: false, ro_std: true, ro_range: true, app_std_insert: false, ro_view: true,
    });
  });
});
