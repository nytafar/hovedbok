// SAF-T Financial export (#9) against the golden oracle: the enkelt-regnskap
// fixture set (test/fixtures/saft/, copied 2026-10-11 from
// ~/code/enkelt-regnskap/test/fixtures/saft/, reference XML sha256 35c7c25d…)
// posted into a fresh database through bootstrap_entity / upsert_account /
// upsert_party / post_voucher under ADR-0011 (vat_code + vat_base on the base
// line, 27xx lines uncoded), then exported and compared byte for byte after
// the normalisation enkelt-regnskap's test/invarianter.test.ts uses, and
// validated against Skatteetaten's XSDs:
//   Norwegian_SAF-T_Financial_Schema_v_1.30.xsd  Skatteetaten/saf-t 487df08 (2024-03-21)
//   Norwegian_SAF-T_Financial_Schema_v_1.40.xsd  Skatteetaten/saf-t 7b8ecf8 (2026-04-30)
// XSD validation runs through xmllint (libxml2) when it is on PATH; CI installs it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOreOrNull, vatFromGross } from "../src/core/money";
import { buildSaft, osloStamp, periodName, saftFilename, type SaftCompany } from "../src/saft";
import { dropTestDb, freshDb } from "./helper";

const DIR = fileURLToPath(new URL("./fixtures/saft/", import.meta.url));
const E = "987654321";
const FROM = "2026-07-01";
const TO = "2026-08-31";
const NOW = new Date("2026-09-30T18:05:03+02:00");
const REFERENCE = join(DIR, "SAF-T Financial_987654321_20260930180503_1_1.xml");
const XMLLINT = Bun.which("xmllint");

// ---------------------------------------------------------------------------
// Seeding: the bilag.csv model expanded to double entry. Port of
// enkelt-regnskap src/core/expand.ts (beregnLinje, ekspanderLinje, party) and
// the code table of src/core/mva.ts, 2026-10-11 — test-only, so the fixture's
// vouchers reach the journal exactly as the oracle booked them.
const MVA: Record<string, { rate: number; account: string | null }> = {
  "0": { rate: 0, account: null },
  "1": { rate: 25, account: "2710" },
  "11": { rate: 15, account: "2711" },
  "3": { rate: 25, account: "2700" },
  "31": { rate: 15, account: "2700" },
  "5": { rate: 0, account: null },
};
const CONTROL: Record<string, string> = { "1500": "K", "2400": "L" };

type Line = { account: string; amount: number; description: string; vat_code?: string; vat_base?: number; party?: string };

type Row = Record<string, string>;

function csv(name: string): Row[] {
  const [head = "", ...rows] = readFileSync(join(DIR, name), "utf8").trimEnd().split("\n");
  const cols = head.split(";");
  return rows.map((r) => Object.fromEntries(r.split(";").map((v, i) => [cols[i] ?? "", v])));
}

/** Column value; the fixture CSVs are complete, so a missing column is a bug. */
function col(r: Row, k: string): string {
  const v = r[k];
  if (v === undefined) throw new Error(`fixture column ${k} is missing`);
  return v;
}

function party(account: string, counterparty: string): string | undefined {
  const prefix = CONTROL[account];
  return prefix && counterparty.startsWith(prefix) ? counterparty : undefined;
}

/** One bilag.csv row -> 2 or 3 posting lines (base, VAT, counter). */
function expand(r: Row): Line[] {
  const gross = parseOreOrNull(col(r, "belop_inkl_mva"))!;
  const code = col(r, "mva_kode");
  const mva = code ? MVA[code] : undefined;
  if (code && !mva) throw new Error(`unknown VAT code ${code}`);
  const s = -gross;
  let vat = 0;
  if (mva && mva.rate > 0) {
    const explicit = parseOreOrNull(col(r, "mva_belop"));
    const abs = explicit !== null ? Math.abs(explicit) : Math.abs(vatFromGross(s, mva.rate));
    vat = s > 0 ? abs : -abs;
  }
  const net = s - vat;
  const d = col(r, "beskrivelse");
  const counterparty = col(r, "motpart_id");
  const base: Line = { account: col(r, "konto"), amount: net, description: d, party: party(col(r, "konto"), counterparty) };
  if (code) Object.assign(base, { vat_code: code, vat_base: net });
  // ADR-0012: a VAT amount stated on the document (bilag.csv mva_belop) is stated on the base line too
  if (code && parseOreOrNull(col(r, "mva_belop")) !== null) Object.assign(base, { vat_amount: vat });
  const out: Line[] = [base];
  if (vat !== 0 && mva?.account) out.push({ account: mva.account, amount: vat, description: d });
  out.push({ account: col(r, "motkonto"), amount: gross, description: d, party: party(col(r, "motkonto"), counterparty) });
  return out;
}

function firma(): Row {
  return Object.fromEntries(csv("firma.csv").map((r) => [col(r, "felt"), col(r, "verdi")]));
}

function company(): SaftCompany {
  const f = firma();
  const g = (k: string) => col(f, k);
  return {
    name: g("navn"),
    address: { street: g("gate"), number: g("husnr"), postalCode: g("postnr"), city: g("poststed"), country: g("land") },
    contact: { firstName: g("kontaktperson_fornavn"), lastName: g("kontaktperson_etternavn"), telephone: g("telefon"), email: g("epost") },
    bankAccounts: [
      { number: g("bankkonto_1920"), ledgerAccount: "1920" },
      { number: g("bankkonto_1921"), ledgerAccount: "1921" },
    ],
  };
}

async function seed(sql: SQL): Promise<void> {
  const f = firma();
  await sql`select bootstrap_entity(${{ orgnr: col(f, "orgnr"), name: col(f, "navn"), vat_registered: true, year: 2026 }}::jsonb)`;
  for (const k of csv("kontoplan.csv")) {
    await sql`select upsert_account(${{ entity: E, code: col(k, "konto"), name: col(k, "navn"), grouping: col(k, "gruppe_kode") }}::jsonb)`;
  }
  const address = (r: Row) => ({ street: col(r, "gate"), postal_code: col(r, "postnr"), city: col(r, "poststed") });
  for (const k of csv("kunder.csv")) {
    await sql`select upsert_party(${{ entity: E, id: col(k, "id"), name: col(k, "navn"), orgnr: col(k, "orgnr"), country: "NO", address: address(k), customer: true }}::jsonb)`;
  }
  for (const l of csv("leverandorer.csv")) {
    // enkelt-regnskap seeding.ts: L001 is the Irish supplier; a non-Norwegian number is foreign_reg_no
    const id = col(l, "id");
    const reg = /^\d{9}$/.test(col(l, "orgnr")) ? { orgnr: col(l, "orgnr") } : { foreign_reg_no: col(l, "orgnr") };
    const country = id === "L001" ? "IE" : "NO";
    await sql`select upsert_party(${{ entity: E, id, name: col(l, "navn"), ...reg, country, address: address(l), supplier: true }}::jsonb)`;
  }
  const byNr = new Map<string, Row[]>();
  for (const r of csv("bilag.csv")) byNr.set(col(r, "bilagsnr"), [...(byNr.get(col(r, "bilagsnr")) ?? []), r]);
  for (const [nr, rows] of byNr) {
    const first = rows[0]!;
    const ref = rows.map((r) => col(r, "referanse")).find((x) => x);
    const p = {
      entity: E, posting_date: col(first, "dato"), description: col(first, "beskrivelse"), source: "import",
      external_ref: ref || undefined, idempotency_key: `bilag:${nr}`, lines: rows.flatMap(expand),
    };
    const [{ r }] = await sql`select post_voucher(${p}::jsonb) as r`;
    expect(r.nr).toBe(Number(nr));
  }
}

/** Removes what may legitimately differ (enkelt-regnskap test/invarianter.test.ts `normaliser`, verbatim). */
function normalise(xml: string): string {
  return xml
    .replace(/<AuditFileDateCreated>[^<]*<\/AuditFileDateCreated>/, "<AuditFileDateCreated/>")
    .replace(/<SoftwareCompanyName>[^<]*<\/SoftwareCompanyName>/, "<SoftwareCompanyName/>")
    .replace(/<SoftwareID>[^<]*<\/SoftwareID>/, "<SoftwareID/>")
    .replace(/<HeaderComment>[^<]*<\/HeaderComment>/, "<HeaderComment/>")
    .replace(/<SystemEntryDate>[^<]*<\/SystemEntryDate>/g, "<SystemEntryDate/>");
}

let tmp: string;
async function validate(xml: string, version: "1.30" | "1.40"): Promise<void> {
  const file = join(tmp, `saft-${version}-${Date.now()}.xml`);
  await writeFile(file, xml);
  const r = Bun.spawnSync([XMLLINT!, "--noout", "--schema", join(DIR, `Norwegian_SAF-T_Financial_Schema_v_${version}.xsd`), file]);
  expect({ exit: r.exitCode, stderr: r.stderr.toString() }).toEqual({ exit: 0, stderr: `${file} validates\n` });
}

/** Runs fn as the SELECT-only role: the exporter needs nothing more. */
function asRo<T>(sql: SQL, fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role hovedbok_ro");
    return fn(tx as unknown as SQL);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
let sql: SQL;

beforeAll(async () => {
  sql = await freshDb();
  tmp = await mkdtemp(join(tmpdir(), "hovedbok-saft-"));
  await seed(sql);
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  await dropTestDb();
});

const withXmllint = XMLLINT ? test : test.skip;

describe("golden fixture (enkelt-regnskap, 4. termin 2026)", () => {
  test("file name follows the Skatteetaten convention", () => {
    expect(osloStamp(NOW)).toBe("20260930180503");
    expect(saftFilename(E, NOW)).toBe("SAF-T Financial_987654321_20260930180503_1_1.xml");
    expect(periodName(FROM, TO)).toBe("4. termin 2026");
    expect(periodName("2026-07-01", "2026-07-31")).toBe("2026-07-01–2026-07-31");
  });

  test("the export from stored postings equals the reference file after normalisation", async () => {
    const out = await asRo(sql, (tx) => buildSaft(tx, {
      entity: E, from: FROM, to: TO, now: NOW, company: company(),
      software: { company: "Egenutviklet (enkelt-regnskap)", id: "enkelt-regnskap", version: "1.0" },
    }));
    expect(out.filename).toBe("SAF-T Financial_987654321_20260930180503_1_1.xml");
    expect(out.entries).toBe(29);
    const reference = await Bun.file(REFERENCE).text();
    expect(normalise(out.xml)).toBe(normalise(reference));
    // the Vendor Ltd line carries the invoice's VAT (1 052,64 where 25 % derives 1 052,55): stated, ADR-0012
    const [stated] = await sql`select vat_amount::int as v from posting where entity = ${E} and year = 2026 and nr = 18 and line = 1`;
    expect(stated.v).toBe(105264);
    expect(out.xml).toContain("<TaxBase>4210.20</TaxBase>\n            <DebitTaxAmount>\n              <Amount>1052.64</Amount>");
  });

  withXmllint("the export validates against the v1.30 XSD", async () => {
    const out = await buildSaft(sql, { entity: E, from: FROM, to: TO, now: NOW, company: company() });
    await validate(out.xml, "1.30");
  });

  withXmllint("the same books as v1.40 validate against the v1.40 XSD and differ only in the version", async () => {
    const v130 = await buildSaft(sql, { entity: E, from: FROM, to: TO, now: NOW, company: company() });
    const v140 = await buildSaft(sql, { entity: E, from: FROM, to: TO, now: NOW, company: company(), version: "1.40" });
    await validate(v140.xml, "1.40");
    expect(v140.xml).toBe(v130.xml.replace("<AuditFileVersion>1.30</AuditFileVersion>", "<AuditFileVersion>1.40</AuditFileVersion>"));
  });

  test("defaults: software, header comment, journal description, bank accounts from bank_account", async () => {
    await sql`insert into bank_account (id_hash, entity, bban, ledger_account) values ('h1', ${E}, '12345678901', '1920')`;
    const out = await buildSaft(sql, { entity: E, from: FROM, to: TO, now: NOW });
    expect(out.xml).toContain("<SoftwareID>hovedbok</SoftwareID>");
    expect(out.xml).toContain("<Name>Eksempel Catering</Name>");
    expect(out.xml).toContain("<HeaderComment>Regnskap ført i hovedbok for 4. termin 2026.</HeaderComment>");
    expect(out.xml).toContain("<Description>Hovedbok 4. termin 2026</Description>");
    expect(out.xml).toContain("<BankAccountNumber>12345678901</BankAccountNumber>");
    expect(out.xml).not.toContain("98765432109");
    await sql`delete from bank_account where id_hash = 'h1'`;
  });

  test("rejects a bad period or unknown entity", async () => {
    await expect(buildSaft(sql, { entity: E, from: "2026-7-1", to: TO })).rejects.toThrow("from must be YYYY-MM-DD");
    await expect(buildSaft(sql, { entity: E, from: TO, to: FROM })).rejects.toThrow("is after");
    await expect(buildSaft(sql, { entity: "111111111", from: FROM, to: TO })).rejects.toThrow("does not exist");
  });
});

describe("v1.40 switch: foreign currency, NOK tax amounts, owners", () => {
  const SEP = { from: "2026-09-01", to: "2026-09-30" };

  beforeAll(async () => {
    await sql`select upsert_party(${{ entity: E, id: "E1", name: "Ola Nordmann", owner: true, address: { city: "Lilleby", postal_code: "1234" } }}::jsonb)`;
    // an EUR purchase with input VAT (code 1): the VAT is booked in NOK (BF § 4-2)
    await sql`select post_voucher(${{
      entity: E, posting_date: "2026-09-05", description: "EUR-kjøp", idempotency_key: "sep:eur",
      lines: [
        { account: "6540", amount: 110000, vat_code: "1", vat_base: 110000, ccy: "EUR", ccy_amount: 10000, ccy_rate: 11 },
        { account: "2710", amount: 27500 },
        { account: "1920", amount: -137500 },
      ],
    }}::jsonb)`;
    // two base lines on one code share one 27xx line: the booked VAT is split, remainder on the last
    await sql`select post_voucher(${{
      entity: E, posting_date: "2026-09-10", description: "To linjer, én mva-linje", idempotency_key: "sep:split",
      lines: [
        { account: "6550", amount: 333, vat_code: "1", vat_base: 333 },
        { account: "6560", amount: 333, vat_code: "1", vat_base: 333 },
        { account: "2710", amount: 167 },
        { account: "1920", amount: -833 },
      ],
    }}::jsonb)`;
    // a stated vat_amount wins over the booked 27xx line (ADR-0012)
    await sql`select post_voucher(${{
      entity: E, posting_date: "2026-09-11", description: "Oppgitt mva", idempotency_key: "sep:stated",
      lines: [
        { account: "6550", amount: 1000, vat_code: "1", vat_base: 1000, vat_amount: 251 },
        { account: "2710", amount: 250 },
        { account: "1920", amount: -1250 },
      ],
    }}::jsonb)`;
    // an owner withdrawal against 2050, tagged with the owner
    await sql`select post_voucher(${{
      entity: E, posting_date: "2026-09-12", description: "Privat uttak", idempotency_key: "sep:owner",
      lines: [{ account: "2050", amount: 50000, party: "E1" }, { account: "1920", amount: -50000 }],
    }}::jsonb)`;
  });

  test("v1.30: currency on the amount, VAT in NOK only, one owner account", async () => {
    const { xml } = await buildSaft(sql, { entity: E, ...SEP, company: company() });
    expect(xml).toContain([
      "          <DebitAmount>",
      "            <Amount>1100.00</Amount>",
      "            <CurrencyCode>EUR</CurrencyCode>",
      "            <CurrencyAmount>100.00</CurrencyAmount>",
      "            <ExchangeRate>11.00000000</ExchangeRate>",
      "          </DebitAmount>",
    ].join("\n"));
    expect(xml).not.toContain("NOKTaxAmount");
    expect(xml).toContain("<OwnerID>E1</OwnerID>\n        <AccountID>2050</AccountID>");
    // split: 333 × 25 % = 83.25 -> 83 on the first line, 167 − 83 = 84 on the last
    const amounts = [...xml.matchAll(/<DebitTaxAmount>\s*<Amount>([\d.]+)<\/Amount>/g)].map((m) => m[1]);
    expect(amounts).toEqual(["275.00", "0.83", "0.84", "2.51"]);
    if (XMLLINT) await validate(xml, "1.30");
  });

  withXmllint("v1.40: the VAT on the EUR line is also locked in NOK, and validates", async () => {
    const { xml } = await buildSaft(sql, { entity: E, ...SEP, company: company(), version: "1.40" });
    expect(xml).toContain([
      "            <DebitTaxAmount>",
      "              <Amount>275.00</Amount>",
      "            </DebitTaxAmount>",
      "            <DebitNOKTaxAmount>",
      "              <NOKAmount>275.00</NOKAmount>",
      "              <NOKTaxBase>1100.00</NOKTaxBase>",
      "            </DebitNOKTaxAmount>",
    ].join("\n"));
    await validate(xml, "1.40");
  });

  test("opening balances carry across periods; a later period leaves the golden period's figures alone", async () => {
    const { xml } = await buildSaft(sql, { entity: E, ...SEP, company: company() });
    expect(xml).toContain("<AccountID>1920</AccountID>\n        <AccountDescription>Bank brukskonto 1234.56.78901 (næring)</AccountDescription>\n        <GroupingCategory>balanseverdiForOmloepsmiddel</GroupingCategory>\n        <GroupingCode>1920</GroupingCode>\n        <AccountType>GL</AccountType>\n        <OpeningDebitBalance>61573.75</OpeningDebitBalance>");
    expect(xml).toContain("<NumberOfEntries>4</NumberOfEntries>");
    // master data (the new owner) is period-independent; the ledger section is not
    const golden = await buildSaft(sql, { entity: E, from: FROM, to: TO, now: NOW, company: company() });
    const reference = await Bun.file(REFERENCE).text();
    const ledger = (s: string) => s.slice(s.indexOf("<GeneralLedgerEntries>"));
    expect(normalise(ledger(golden.xml))).toBe(normalise(ledger(reference)));
  });
});
