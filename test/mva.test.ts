// MVA term aggregation and the MVA-melding draft (#8).
//
//   mva_term (0025)   vat_summary rolled up to the entity's vat_term cadence,
//                     signed the way the melding reads (sales and output VAT
//                     positive, deductions negative)
//   src/mva.ts        pure builder: mva_term rows -> MVA-melding XML
//
// Two goldens: a hand-computed term that exercises every regime, and the
// enkelt-regnskap oracle (4. termin 2026). The XML is checked against
// Skatteetaten's published XSD (vendored, see XSD below) with xmllint when
// the binary is on PATH, and structurally always.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropTestDb, freshDb } from "./helper";
import { buildMvaMelding, readMvaTerm, type MvaTermRow } from "../src/mva";

// Skatteetaten/mva-meldingen docs/informasjonsmodell_filer/xsd/
// no.skatteetaten.fastsetting.avgift.mva.skattemeldingformerverdiavgift.v1.0.xsd,
// commit c1958e5 (2023-01-02), Apache-2.0, fetched 2026-10-11, vendored verbatim
// (sha256 f314fae8…82031fcf).
const XSD = new URL(
  "./fixtures/mva-meldingen/no.skatteetaten.fastsetting.avgift.mva.skattemeldingformerverdiavgift.v1.0.xsd",
  import.meta.url,
).pathname;
const xmllint = Bun.which("xmllint");

/** Validate against the XSD with xmllint; returns null when valid, else the error output. */
async function xsdErrors(xml: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "mva-"));
  try {
    const file = join(dir, "melding.xml");
    await writeFile(file, xml);
    const p = Bun.spawnSync([xmllint!, "--noout", "--schema", XSD, file], { stderr: "pipe" });
    return p.exitCode === 0 ? null : p.stderr.toString();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The mvaSpesifikasjonslinje elements, as [code, grunnlag?, sats?, merverdiavgift] tuples. */
function specLines(xml: string): (string | undefined)[][] {
  return [...xml.matchAll(/<mvaSpesifikasjonslinje>([\s\S]*?)<\/mvaSpesifikasjonslinje>/g)].map(([, body]) => {
    const t = (n: string) => body!.match(new RegExp(`<${n}>([^<]*)</${n}>`))?.[1];
    return [t("mvaKode"), t("grunnlag"), t("sats"), t("merverdiavgift")];
  });
}

// ---------------------------------------------------------------------------
// Pure builder

const row = (r: Partial<MvaTermRow> & Pick<MvaTermRow, "vatCode" | "kind">): MvaTermRow => ({
  deductible: false, report: true, rate: "25.000", base: 0, outputVat: 0, inputVat: 0, ...r,
});

const header = { orgnr: "999888777", year: 2026, vatTerm: "bimonthly", term: 2, reference: "hovedbok:999888777:2026-2" } as const;

describe("buildMvaMelding (pure)", () => {
  test("output, input and both-effect regimes; whole kroner, half up; total is the sum of the lines", () => {
    const m = buildMvaMelding({
      ...header,
      rows: [
        row({ vatCode: "3", kind: "output", base: 799950, outputVat: 199987 }),
        row({ vatCode: "1", kind: "input", deductible: true, base: 800000, inputVat: -200000 }),
        row({ vatCode: "32", kind: "output", rate: "11.110", base: 1000300, outputVat: 111133 }),
        row({ vatCode: "86", kind: "reverse_charge", deductible: true, base: 1000000, outputVat: 250000, inputVat: -250000 }),
        row({ vatCode: "87", kind: "reverse_charge", base: 10000, outputVat: 2500 }),
        row({ vatCode: "14", kind: "import_input", deductible: true, base: 400000, inputVat: -100050 }),
        row({ vatCode: "85", kind: "import_base", rate: "0.000", base: 30000 }),
        row({ vatCode: "52", kind: "zero", rate: "0.000", base: 500000 }),
        row({ vatCode: "0", kind: "none", rate: "0.000", report: false, base: 4500 }),
      ],
    });
    expect(m.lines).toEqual([
      { code: "1", vat: -2000 },
      { code: "3", base: 8000, rate: "25", vat: 2000 },
      { code: "14", vat: -1001 },
      { code: "32", base: 10003, rate: "11,11", vat: 1111 },
      { code: "52", base: 5000, rate: "0", vat: 0 },
      { code: "85", base: 300, rate: "0", vat: 0 },
      { code: "86", base: 10000, rate: "25", vat: 2500 },
      { code: "86", vat: -2500 },
      { code: "87", base: 100, rate: "25", vat: 25 },
    ]);
    expect(m.total).toBe(-2000 + 2000 - 1001 + 1111 + 2500 - 2500 + 25);
    expect(m.period).toEqual({ element: "skattleggingsperiodeToMaaneder", value: "mars-april" });
    expect(specLines(m.xml)).toEqual(m.lines.map((l) => [l.code, l.base?.toString(), l.rate, l.vat.toString()]));
    expect(m.xml).toContain(`<fastsattMerverdiavgift>${m.total}</fastsattMerverdiavgift>`);
  });

  test("negative amounts round half up on the absolute value", () => {
    const m = buildMvaMelding({
      ...header,
      rows: [
        row({ vatCode: "3", kind: "output", base: -1050, outputVat: -250 }),
        row({ vatCode: "11", kind: "input", rate: "15.000", base: 1, inputVat: -69150 }),
      ],
    });
    expect(m.lines).toEqual([{ code: "3", base: -11, rate: "25", vat: -3 }, { code: "11", vat: -692 }]);
  });

  test("a code that nets to zero in the term is left out; report=false codes never appear", () => {
    const m = buildMvaMelding({
      ...header,
      rows: [
        row({ vatCode: "3", kind: "output" }),
        row({ vatCode: "7", kind: "no_turnover", report: false, rate: "0.000", base: 100000 }),
      ],
    });
    expect(m.lines).toEqual([]);
    expect(m.total).toBe(0);
    expect(m.xml).not.toContain("<mvaSpesifikasjonslinje>");
  });

  test("skattleggingsperiode per cadence", () => {
    const p = (vatTerm: "monthly" | "bimonthly" | "yearly", term: number) =>
      buildMvaMelding({ ...header, vatTerm, term, rows: [] }).period;
    expect(p("monthly", 1)).toEqual({ element: "skattleggingsperiodeMaaned", value: "januar" });
    expect(p("monthly", 12)).toEqual({ element: "skattleggingsperiodeMaaned", value: "desember" });
    expect(p("bimonthly", 1)).toEqual({ element: "skattleggingsperiodeToMaaneder", value: "januar-februar" });
    expect(p("bimonthly", 6)).toEqual({ element: "skattleggingsperiodeToMaaneder", value: "november-desember" });
    expect(p("yearly", 1)).toEqual({ element: "skattleggingsperiodeAar", value: "aarlig" });
    expect(() => p("bimonthly", 7)).toThrow(/term 7/);
    expect(() => p("monthly", 0)).toThrow(/term 0/);
    expect(() => p("yearly", 2)).toThrow(/term 2/);
  });

  test("text is escaped; bad input is refused", () => {
    const m = buildMvaMelding({
      ...header, reference: `a&b<c>"d'`, system: { name: "hovedbok & co", version: "0.1" }, note: "<x>", kid: "1234",
      rows: [],
    });
    expect(m.xml).toContain("<regnskapssystemsreferanse>a&amp;b&lt;c&gt;&quot;d&apos;</regnskapssystemsreferanse>");
    expect(m.xml).toContain("<systemnavn>hovedbok &amp; co</systemnavn>");
    expect(m.xml).toContain("<beskrivelse>&lt;x&gt;</beskrivelse>");
    expect(m.xml).toContain("<kundeIdentifikasjonsnummer>1234</kundeIdentifikasjonsnummer>");
    expect(() => buildMvaMelding({ ...header, orgnr: "12345678", rows: [] })).toThrow(/orgnr/);
    expect(() => buildMvaMelding({ ...header, reference: "", rows: [] })).toThrow(/reference/);
    expect(() => buildMvaMelding({ ...header, rows: [row({ vatCode: "3", kind: "output", base: 0.5 })] })).toThrow(/safe integer/);
    expect(() => buildMvaMelding({ ...header, rows: [row({ vatCode: "3", kind: "output", rate: "abc" })] })).toThrow(/rate/);
  });

  test.skipIf(!xmllint)("validates against the published XSD (xmllint)", async () => {
    const m = buildMvaMelding({
      ...header, system: { name: "hovedbok", version: "0.1" }, note: "utkast", kid: "1234",
      rows: [
        row({ vatCode: "3", kind: "output", base: 799950, outputVat: 199987 }),
        row({ vatCode: "1", kind: "input", base: 800000, inputVat: -200000 }),
        row({ vatCode: "86", kind: "reverse_charge", deductible: true, base: 1000000, outputVat: 250000, inputVat: -250000 }),
      ],
    });
    expect(await xsdErrors(m.xml)).toBeNull();
    for (const [vatTerm, term] of [["monthly", 3], ["yearly", 1]] as const) {
      expect(await xsdErrors(buildMvaMelding({ ...header, vatTerm, term, rows: [] }).xml)).toBeNull();
    }
    // the validator is live: a broken document is rejected
    expect(await xsdErrors(m.xml.replace("<meldingskategori>", "<meldingskategori>x"))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database: mva_term

let sql: SQL;
beforeEach(async () => {
  sql = await freshDb();
});
afterAll(dropTestDb);

type Line = { account: string; amount: number; party?: string; vat_code?: string; vat_base?: number; vat_amount?: number | string };

async function post(entity: string, key: string, posting_date: string, lines: Line[]) {
  const [r] = await sql`select post_voucher(${{ entity, posting_date, description: key, idempotency_key: key, lines }}::jsonb) as r`;
  return r.r as { nr: number };
}

async function termRows(entity: string, year: number, term: number) {
  return sql`
    select vat_code, kind, report, rate::text, base::int, output_vat::int, input_vat::int, vat::int
      from mva_term where entity = ${entity} and year = ${year} and term = ${term}
     order by vat_code::int, rate`;
}

const E = "999888777";

/** The hand-computed term: bimonthly, 2026 term 2 (mars-april), every regime once. */
async function postHandTerm(): Promise<void> {
  await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: 2026 }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "K1", name: "Kunde AS", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "L1", name: "Leverandør AS", supplier: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: E, id: "L2", name: "Foreign Ltd", supplier: true, country: "IE" }}::jsonb)`;
  // term 1: a sale, then its settlement and payment inside term 2. The
  // settlement voucher moves 2700 -> 2740 and carries no coded line: it must
  // not reach either term.
  await post(E, "jan-sale", "2026-01-20", [
    { account: "1920", amount: 125000 },
    { account: "3000", amount: -100000, vat_code: "3", vat_base: -100000 },
    { account: "2700", amount: -25000 },
  ]);
  await post(E, "t1-settle", "2026-03-10", [{ account: "2700", amount: 25000 }, { account: "2740", amount: -25000 }]);
  await post(E, "t1-pay", "2026-04-10", [{ account: "2740", amount: 25000 }, { account: "1920", amount: -25000 }]);
  // term 2
  await post(E, "sale-25", "2026-03-05", [
    { account: "1500", amount: 1250000, party: "K1" },
    { account: "3000", amount: -1000000, vat_code: "3", vat_base: -1000000 },
    { account: "2700", amount: -250000 },
  ]);
  await post(E, "credit-note", "2026-04-20", [ // 2000.50 back: VAT 500.125 -> 500.13
    { account: "1500", amount: -250063, party: "K1" },
    { account: "3000", amount: 200050, vat_code: "3", vat_base: 200050 },
    { account: "2700", amount: 50013 },
  ]);
  await post(E, "sale-15", "2026-03-10", [
    { account: "1920", amount: 1150000 },
    { account: "3000", amount: -1000000, vat_code: "31", vat_base: -1000000 },
    { account: "2701", amount: -150000 },
  ]);
  await post(E, "sale-fish", "2026-03-12", [ // 10003.00 × 11.11 % = 1111.3333 -> 1111.33
    { account: "1920", amount: 1111433 },
    { account: "3000", amount: -1000300, vat_code: "32", vat_base: -1000300 },
    { account: "2702", amount: -111133 },
  ]);
  await post(E, "export", "2026-03-20", [
    { account: "1500", amount: 500000, party: "K1" },
    { account: "3000", amount: -500000, vat_code: "52", vat_base: -500000 },
  ]);
  await post(E, "cost-25", "2026-04-02", [
    { account: "6300", amount: 800000, vat_code: "1", vat_base: 800000 },
    { account: "2710", amount: 200000 },
    { account: "2400", amount: -1000000, party: "L1" },
  ]);
  await post(E, "rc-86", "2026-04-10", [
    { account: "6540", amount: 1000000, vat_code: "86", vat_base: 1000000 },
    { account: "2400", amount: -1000000, party: "L2" },
    { account: "2714", amount: 250000 },
    { account: "2704", amount: -250000 },
  ]);
  await post(E, "import-81", "2026-04-15", [
    { account: "4300", amount: 400000, vat_code: "81", vat_base: 400000 },
    { account: "2400", amount: -400000, party: "L2" },
    { account: "2715", amount: 100000 },
    { account: "2705", amount: -100000 },
  ]);
  await post(E, "bank-fee", "2026-04-30", [
    { account: "7770", amount: 4500, vat_code: "0", vat_base: 4500 },
    { account: "1920", amount: -4500 },
  ]);
  // term 3: must stay out of term 2
  await post(E, "may-sale", "2026-05-02", [
    { account: "1920", amount: 12500 },
    { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
    { account: "2700", amount: -2500 },
  ]);
}

describe("mva_term", () => {
  test("hand-computed term 2 (mars-april 2026): grunnlag and avgift per code, signed as the melding reads", async () => {
    await postHandTerm();
    expect(await termRows(E, 2026, 2)).toEqual([
      { vat_code: "0", kind: "none", report: false, rate: "0.000", base: 4500, output_vat: 0, input_vat: 0, vat: 0 },
      { vat_code: "1", kind: "input", report: true, rate: "25.000", base: 800000, output_vat: 0, input_vat: -200000, vat: -200000 },
      // 10000.00 - 2000.50 = 7999.50; 2500.00 - 500.13 = 1999.87
      { vat_code: "3", kind: "output", report: true, rate: "25.000", base: 799950, output_vat: 199987, input_vat: 0, vat: 199987 },
      { vat_code: "31", kind: "output", report: true, rate: "15.000", base: 1000000, output_vat: 150000, input_vat: 0, vat: 150000 },
      { vat_code: "32", kind: "output", report: true, rate: "11.110", base: 1000300, output_vat: 111133, input_vat: 0, vat: 111133 },
      { vat_code: "52", kind: "zero", report: true, rate: "0.000", base: 500000, output_vat: 0, input_vat: 0, vat: 0 },
      { vat_code: "81", kind: "import_base", report: true, rate: "25.000", base: 400000, output_vat: 100000, input_vat: -100000, vat: 0 },
      { vat_code: "86", kind: "reverse_charge", report: true, rate: "25.000", base: 1000000, output_vat: 250000, input_vat: -250000, vat: 0 },
    ]);
    const [tot] = await sql`select sum(vat)::int as payable from mva_term where entity = ${E} and year = 2026 and term = 2`;
    expect(tot.payable).toBe(261120); // 1999.87 + 1500 + 1111.33 - 2000

    // term bounds, and the neighbours: the January sale is term 1, the May sale term 3
    const [b] = await sql`select distinct vat_term, date_from::text, date_to::text from mva_term where entity = ${E} and year = 2026 and term = 2`;
    expect(b).toEqual({ vat_term: "bimonthly", date_from: "2026-03-01", date_to: "2026-04-30" });
    expect(await termRows(E, 2026, 1)).toEqual([
      { vat_code: "3", kind: "output", report: true, rate: "25.000", base: 100000, output_vat: 25000, input_vat: 0, vat: 25000 },
    ]);
    expect((await termRows(E, 2026, 3)).map((r: { vat_code: string; vat: number }) => [r.vat_code, r.vat])).toEqual([["3", 2500]]);
  });

  test("the hand-computed term as an MVA-melding", async () => {
    await postHandTerm();
    const t = await readMvaTerm(sql, E, 2026, 2);
    expect(t.vatTerm).toBe("bimonthly");
    const m = buildMvaMelding({ orgnr: E, year: 2026, vatTerm: t.vatTerm, term: 2, reference: "hovedbok:999888777:2026-2", rows: t.rows });
    expect(m.lines).toEqual([
      { code: "1", vat: -2000 },
      { code: "3", base: 8000, rate: "25", vat: 2000 },
      { code: "31", base: 10000, rate: "15", vat: 1500 },
      { code: "32", base: 10003, rate: "11,11", vat: 1111 },
      { code: "52", base: 5000, rate: "0", vat: 0 },
      { code: "81", base: 4000, rate: "25", vat: 1000 },
      { code: "81", vat: -1000 },
      { code: "86", base: 10000, rate: "25", vat: 2500 },
      { code: "86", vat: -2500 },
    ]);
    expect(m.total).toBe(2611);
    expect(m.xml).toContain("<skattleggingsperiodeToMaaneder>mars-april</skattleggingsperiodeToMaaneder>");
    expect(m.xml).toContain("<aar>2026</aar>");
    expect(m.xml).toContain("<organisasjonsnummer>999888777</organisasjonsnummer>");
    expect(m.xml).toContain("<meldingskategori>alminnelig</meldingskategori>");
    if (xmllint) expect(await xsdErrors(m.xml)).toBeNull();
  });

  test("cadence follows entity.vat_term: monthly terms are months, a yearly term is the year; period 13 lands in the last term", async () => {
    for (const [orgnr, vat_term] of [["999777666", "monthly"], ["999666555", "yearly"]] as const) {
      await sql`select bootstrap_entity(${{ orgnr, name: vat_term, vat_registered: true, year: 2026, vat_term }}::jsonb)`;
      for (const [k, d] of [["a", "2026-04-15"], ["b", "2026-11-03"]] as const) {
        await post(orgnr, k, d, [
          { account: "1920", amount: 12500 },
          { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
          { account: "2700", amount: -2500 },
        ]);
      }
      // a coded line in the closing period (13, 31.12) counts in December's term
      await sql`select post_voucher(${{ entity: orgnr, posting_date: "2026-12-31", period: 13, description: "late", idempotency_key: "c", lines: [
        { account: "1920", amount: 12500 },
        { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
        { account: "2700", amount: -2500 },
      ] }}::jsonb)`;
    }
    const terms = async (orgnr: string) => (await sql`
      select term, date_from::text, date_to::text, base::int, output_vat::int
        from mva_term where entity = ${orgnr} order by term`).map((r: object) => ({ ...r }));
    expect(await terms("999777666")).toEqual([
      { term: 4, date_from: "2026-04-01", date_to: "2026-04-30", base: 10000, output_vat: 2500 },
      { term: 11, date_from: "2026-11-01", date_to: "2026-11-30", base: 10000, output_vat: 2500 },
      { term: 12, date_from: "2026-12-01", date_to: "2026-12-31", base: 10000, output_vat: 2500 },
    ]);
    expect(await terms("999666555")).toEqual([
      { term: 1, date_from: "2026-01-01", date_to: "2026-12-31", base: 30000, output_vat: 7500 },
    ]);
  });

  test("a rate change inside a term gives one row (and one melding line) per rate", async () => {
    await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: 2026 }}::jsonb)`;
    await sql`insert into vat_rate (code, valid_from, rate) values ('3', '2026-04-01', 24)`; // hypothetical
    for (const [k, d, vat] of [["mar", "2026-03-15", 2500], ["apr", "2026-04-15", 2400]] as const) {
      await post(E, k, d, [
        { account: "1920", amount: 10000 + vat },
        { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
        { account: "2700", amount: -vat },
      ]);
    }
    expect((await termRows(E, 2026, 2)).map((r: { rate: string; base: number; output_vat: number }) => [r.rate, r.base, r.output_vat]))
      .toEqual([["24.000", 10000, 2400], ["25.000", 10000, 2500]]);
    const t = await readMvaTerm(sql, E, 2026, 2);
    expect(buildMvaMelding({ ...header, rows: t.rows }).lines).toEqual([
      { code: "3", base: 100, rate: "24", vat: 24 },
      { code: "3", base: 100, rate: "25", vat: 25 },
    ]);
  });

  test("both roles read it; neither writes it", async () => {
    const [p] = await sql`
      select has_table_privilege('hovedbok_app', 'mva_term', 'select') as app,
             has_table_privilege('hovedbok_ro', 'mva_term', 'select') as ro,
             has_table_privilege('hovedbok_app', 'mva_term', 'insert') as app_insert,
             has_table_privilege('hovedbok_ro', 'vat_summary', 'select') as ro_summary`;
    expect(p).toEqual({ app: true, ro: true, app_insert: false, ro_summary: true });
  });
});

// ---------------------------------------------------------------------------
// ADR-0012: the base line may state the VAT on the document (vat_amount).

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a database error, but the statement succeeded");
}

/** A domestic purchase: base on 6300, the VAT (stated or as given) on 2710. */
const purchase = (key: string, base: number, vat: number, extra: Partial<Line> = {}) =>
  post(E, key, "2026-03-10", [
    { account: "6300", amount: base, vat_code: "1", vat_base: base, ...extra },
    { account: "2710", amount: vat },
    { account: "2400", amount: -(base + vat), party: "L1" },
  ]);

describe("stated vat_amount (ADR-0012)", () => {
  beforeEach(async () => {
    await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: 2026 }}::jsonb)`;
    await sql`select upsert_party(${{ entity: E, id: "L1", name: "Leverandør AS", supplier: true }}::jsonb)`;
  });

  test("stated beats derived in vat_summary, mva_term and the melding; unstated lines still derive", async () => {
    await purchase("stated", 421020, 105264, { vat_amount: 105264 }); // derived 105255
    await purchase("derived", 10000, 2500);
    await post(E, "sale", "2026-03-11", [ // a sale stating its VAT: signed like vat_base
      { account: "1920", amount: 12501 },
      { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000, vat_amount: -2501 },
      { account: "2700", amount: -2501 },
    ]);
    const s = await sql`select vat_code, output_vat::int, input_vat::int from vat_summary where entity = ${E} order by vat_code`;
    expect(s).toEqual([{ vat_code: "1", output_vat: 0, input_vat: 107764 }, { vat_code: "3", output_vat: -2501, input_vat: 0 }]);
    expect((await termRows(E, 2026, 2)).map((r: { vat_code: string; vat: number }) => [r.vat_code, r.vat]))
      .toEqual([["1", -107764], ["3", 2501]]);
    const [c] = await sql`select input_difference::int as i, output_difference::int as o from vat_control where entity = ${E} and period = 3`;
    expect(c).toEqual({ i: 0, o: 0 });
  });

  test("plausibility: same sign, within max(1 krone, 1 %) of derived; zero-VAT codes state 0", async () => {
    // derived 2500: 1 krone is the bound
    await purchase("ok-small", 10000, 2600, { vat_amount: 2600 });
    expect(await pgError(purchase("off-small", 10000, 2601, { vat_amount: 2601 }))).toContain("within 100 øre of it");
    // derived 250000: 1 % (2500 øre) is the bound
    await purchase("ok-big", 1000000, 252500, { vat_amount: 252500 });
    expect(await pgError(purchase("off-big", 1000000, 252501, { vat_amount: 252501 }))).toContain("derives 250000");
    // gross errors
    expect(await pgError(purchase("ten-x", 10000, 25000, { vat_amount: 25000 }))).toContain("implausible");
    expect(await pgError(purchase("sign", 10000, -2500, { vat_amount: -2500 }))).toContain("implausible");
    // a zero-rated sale has no VAT to state but 0
    expect(await pgError(post(E, "zero", "2026-03-12", [
      { account: "1920", amount: 500000 },
      { account: "3000", amount: -500000, vat_code: "52", vat_base: -500000, vat_amount: -1 },
    ]))).toContain("must be 0");
    expect((await sql`select nr from voucher where entity = ${E} order by nr`).map((r: { nr: number }) => r.nr)).toEqual([1, 2]);
  });

  test("vat_amount needs vat_code and vat_base, and must be an integer number of øre", async () => {
    expect(await pgError(post(E, "uncoded", "2026-03-10", [
      { account: "6300", amount: 10000, vat_amount: 2500 },
      { account: "1920", amount: -10000 },
    ]))).toContain("vat_amount on account 6300 needs a vat_code and vat_base");
    expect(await pgError(purchase("frac", 10000, 2500, { vat_amount: 2500.5 }))).toContain("vat_amount must be an integer number of øre");
    expect(await pgError(purchase("text", 10000, 2500, { vat_amount: "2500" }))).toContain("vat_amount must be an integer number of øre");
  });

  test("reverse_voucher negates vat_amount; a reversal that drops or alters it is refused; the column is append-only", async () => {
    await purchase("orig", 421020, 105264, { vat_amount: 105264 });
    const lines = (vat_amount?: number) => [
      { account: "6300", amount: -421020, vat_code: "1", vat_base: -421020, ...(vat_amount === undefined ? {} : { vat_amount }) },
      { account: "2710", amount: -105264 },
      { account: "2400", amount: 526284, party: "L1" },
    ];
    for (const [key, va] of [["drop", undefined], ["alter", -105263]] as const) {
      const err = await pgError(sql`select post_voucher(${{ entity: E, posting_date: "2026-03-20", description: key, idempotency_key: key,
        reverses: { year: 2026, nr: 1 }, lines: lines(va) }}::jsonb)`);
      expect(err).toContain("does not exactly negate");
    }
    await sql`select reverse_voucher(${E}, 2026::smallint, 1, '2026-03-20')`;
    const [r] = await sql`select vat_amount::int as va from posting where entity = ${E} and year = 2026 and nr = 2 and line = 1`;
    expect(r.va).toBe(-105264);
    const [s] = await sql`select sum(input_vat)::int as i from vat_summary where entity = ${E}`;
    expect(s.i).toBe(0);
    expect(await pgError(sql`update posting set vat_amount = 105255 where entity = ${E} and nr = 1 and line = 1`)).toContain("append-only");
  });
});

// ---------------------------------------------------------------------------
// Oracle: enkelt-regnskap, 4. termin 2026 (juli-august).
//
// Source: ~/code/enkelt-regnskap test/fixtures/saft/bilag.csv (29 vouchers,
// gross amounts) and the VAT split of each line from its SAF-T reference file
// "SAF-T Financial_987654321_20260930180503_1_1.xml" (TaxBase and Debit/
// CreditTaxAmount per line), ported by hand to post_voucher lines under
// ADR-0011: vat_code + vat_base on the base line, the 27xx line uncoded and
// carrying the VAT amount from the file. Expectations: its
// test/invarianter.test.ts,
//   "mva 4. termin 2026: 12 520,86 å betale, per kode":
//     0: 245.00 / 0.00   1: 4820.20 / 1205.14   3: 57671.00 / 14417.75   11: 4611.65 / 691.75
//   "saldo 4. termin 2026: 1920 = 61 573,75, 1921 = -2 505,04, 1580 = 0".
// The oracle's per-code VAT is the booked VAT, the amount on the document. On
// two lines that differs from base × rate, so those lines state it as
// vat_amount (ADR-0012): bilag 2 (391,30, derived 391,31) and bilag 18
// (1 052,64, derived 1 052,55). Every other line derives to the file's figure.
const ER = "987654321";
const ORACLE: [string, Line[]][] = [
  /*  1 */ ["2026-07-01", [{ account: "2050", amount: 21920 }, { account: "1921", amount: -21920 }]],
  // 2: VAT taken from the gross 3 000,00 is 391,30; 2 608,70 × 15 % = 391,305 would derive 391,31
  /*  2 */ ["2026-07-01", [{ account: "4300", amount: 260870, vat_code: "11", vat_base: 260870, vat_amount: 39130 },{ account: "2711", amount: 39130 }, { account: "2400", amount: -300000, party: "L002" }]],
  /*  3 */ ["2026-07-03", [{ account: "2400", amount: 300000, party: "L002" }, { account: "1920", amount: -300000 }]],
  /*  4 */ ["2026-07-06", [{ account: "4300", amount: 15626, vat_code: "11", vat_base: 15626 }, { account: "2711", amount: 2344 }, { account: "1921", amount: -17970 }]],
  /*  5 */ ["2026-07-08", [{ account: "6560", amount: 36000, vat_code: "1", vat_base: 36000 }, { account: "2710", amount: 9000 }, { account: "1921", amount: -45000 }]],
  /*  6 */ ["2026-07-10", [{ account: "1921", amount: 500000 }, { account: "1920", amount: -500000 }]],
  /*  7 */ ["2026-07-12", [{ account: "2050", amount: 65000 }, { account: "1921", amount: -65000 }]],
  /*  8 */ ["2026-07-15", [{ account: "3000", amount: -800000, vat_code: "3", vat_base: -800000 }, { account: "2700", amount: -200000 }, { account: "1580", amount: 1000000 }]],
  /*  9 */ ["2026-07-15", [{ account: "2050", amount: 9900 }, { account: "1921", amount: -9900 }]],
  /* 10 */ ["2026-07-15", [{ account: "2050", amount: 9900 }, { account: "1921", amount: -9900 }]],
  /* 11 */ ["2026-07-17", [{ account: "1580", amount: -980000 }, { account: "1920", amount: 980000 }, { account: "7770", amount: 20000, vat_code: "0", vat_base: 20000 }, { account: "1580", amount: -20000 }]],
  /* 12 */ ["2026-07-21", [{ account: "3000", amount: -181600, vat_code: "3", vat_base: -181600 }, { account: "2700", amount: -45400 }, { account: "1500", amount: 227000, party: "K001" }]],
  /* 13 */ ["2026-07-22", [{ account: "6550", amount: 25000, vat_code: "1", vat_base: 25000 }, { account: "2710", amount: 6250 }, { account: "1921", amount: -31250 }]],
  /* 14 */ ["2026-07-27", [{ account: "3000", amount: -2420900, vat_code: "3", vat_base: -2420900 }, { account: "2700", amount: -605225 }, { account: "1500", amount: 3026125, party: "K002" }]],
  /* 15 */ ["2026-07-29", [{ account: "1500", amount: -3026125, party: "K002" }, { account: "1920", amount: 3026125 }]],
  /* 16 */ ["2026-08-02", [{ account: "2050", amount: 3000 }, { account: "1921", amount: -3000 }]],
  /* 17 */ ["2026-08-02", [{ account: "2050", amount: 3000 }, { account: "1921", amount: -3000 }]],
  // 18: Vendor Ltd's invoice states VAT 1052.64 on 4210.20 (25 % would be 1052.55)
  /* 18 */ ["2026-08-05", [{ account: "6540", amount: 421020, vat_code: "1", vat_base: 421020, vat_amount: 105264 },{ account: "2710", amount: 105264 }, { account: "1921", amount: -526284 }]],
  /* 19 */ ["2026-08-10", [{ account: "4300", amount: 73504, vat_code: "11", vat_base: 73504 }, { account: "2711", amount: 11026 }, { account: "1921", amount: -84530 }]],
  /* 20 */ ["2026-08-12", [{ account: "2050", amount: 4000 }, { account: "1921", amount: -4000 }]],
  /* 21 */ ["2026-08-12", [{ account: "2050", amount: 4000 }, { account: "1921", amount: -4000 }]],
  /* 22 */ ["2026-08-12", [{ account: "2050", amount: 4000 }, { account: "1921", amount: -4000 }]],
  /* 23 */ ["2026-08-18", [{ account: "7770", amount: 4500, vat_code: "0", vat_base: 4500 }, { account: "1920", amount: -4500 }]],
  /* 24 */ ["2026-08-21", [{ account: "1500", amount: -227000, party: "K001" }, { account: "1920", amount: 227000 }]],
  /* 25 */ ["2026-08-25", [{ account: "4300", amount: 111165, vat_code: "11", vat_base: 111165 }, { account: "2711", amount: 16675 }, { account: "1921", amount: -127840 }]],
  /* 26 */ ["2026-08-28", [{ account: "3000", amount: -2364600, vat_code: "3", vat_base: -2364600 }, { account: "2700", amount: -591150 }, { account: "1500", amount: 2955750, party: "K002" }]],
  /* 27 */ ["2026-08-28", [{ account: "1921", amount: 227000 }, { account: "1920", amount: -227000 }]],
  /* 28 */ ["2026-08-31", [{ account: "1500", amount: -2955750, party: "K002" }, { account: "1920", amount: 2955750 }]],
  /* 29 */ ["2026-08-31", [{ account: "2050", amount: 19910 }, { account: "1921", amount: -19910 }]],
];

async function postOracle(): Promise<void> {
  await sql`select bootstrap_entity(${{ orgnr: ER, name: "Eksempel Catering", vat_registered: true, year: 2026 }}::jsonb)`;
  // accounts the standard chart lacks or names differently (kontoplan.csv)
  await sql`select upsert_account(${{ entity: ER, code: "1921", name: "Bank brukskonto 9876.54.32109 (blandet privat/næring)", std_account: "1920" }}::jsonb)`;
  await sql`select upsert_account(${{ entity: ER, code: "1580", name: "Oppgjørskonto kortterminal" }}::jsonb)`;
  await sql`select upsert_account(${{ entity: ER, code: "6550", name: "Driftsmateriale, renhold og engangsartikler", std_account: "6560" }}::jsonb)`;
  await sql`select upsert_party(${{ entity: ER, id: "K001", name: "Fjellheim Kulturlag", orgnr: "912345678", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: ER, id: "K002", name: "Eksempel AS", orgnr: "923456789", customer: true }}::jsonb)`;
  await sql`select upsert_party(${{ entity: ER, id: "L002", name: "Matgrossisten AS", orgnr: "934567890", supplier: true }}::jsonb)`;
  for (const [i, [date, lines]] of ORACLE.entries()) {
    const r = await post(ER, `bilag:${i + 1}`, date, lines);
    expect(r.nr).toBe(i + 1);
  }
}

describe("oracle: enkelt-regnskap 4. termin 2026", () => {
  test("the port is faithful: bank balances match", async () => {
    await postOracle();
    const rows = await sql`select account, balance::int as b from account_balance where entity = ${ER} and account in ('1580', '1920', '1921') order by account`;
    expect(rows).toEqual([{ account: "1580", b: 0 }, { account: "1920", b: 6157375 }, { account: "1921", b: -250504 }]);
  });

  test("mva 4. termin 2026 reproduces exactly: per code, and 12 520,86 to pay; vat_control reconciles to the øre", async () => {
    await postOracle();
    expect(await termRows(ER, 2026, 4)).toEqual([
      // oracle 0: 245.00 / 0.00
      { vat_code: "0", kind: "none", report: false, rate: "0.000", base: 24500, output_vat: 0, input_vat: 0, vat: 0 },
      // oracle 1: 4820.20 / 1205.14 (bilag 18 stated)
      { vat_code: "1", kind: "input", report: true, rate: "25.000", base: 482020, output_vat: 0, input_vat: -120514, vat: -120514 },
      // oracle 3: 57671.00 / 14417.75 (all derived)
      { vat_code: "3", kind: "output", report: true, rate: "25.000", base: 5767100, output_vat: 1441775, input_vat: 0, vat: 1441775 },
      // oracle 11: 4611.65 / 691.75 (bilag 2 stated)
      { vat_code: "11", kind: "input", report: true, rate: "15.000", base: 461165, output_vat: 0, input_vat: -69175, vat: -69175 },
    ]);
    const [d] = await sql`select sum(vat)::int as payable from mva_term where entity = ${ER} and year = 2026 and term = 4`;
    expect(d.payable).toBe(1252086); // 12 520,86

    // vat_control: reported VAT equals booked 27xx movement in both periods
    const ctl = await sql`
      select period, derived_output_vat::int as dout, booked_output_vat::int as bout, output_difference::int as odiff,
             derived_input_vat::int as din, booked_input_vat::int as bin, input_difference::int as idiff
        from vat_control where entity = ${ER} order by period`;
    expect(ctl).toEqual([
      { period: 7, dout: -850625, bout: -850625, odiff: 0, din: 56724, bin: 56724, idiff: 0 },
      { period: 8, dout: -591150, bout: -591150, odiff: 0, din: 132965, bin: 132965, idiff: 0 },
    ]);
  });

  test("the MVA-melding in whole kroner is the oracle's, rounded: 12 521", async () => {
    await postOracle();
    const t = await readMvaTerm(sql, ER, 2026, 4);
    const m = buildMvaMelding({ orgnr: ER, year: 2026, vatTerm: t.vatTerm, term: 4, reference: "hovedbok:987654321:2026-4", rows: t.rows });
    // oracle rounded per line: 14417.75 -> 14418, 1205.14 -> 1205, 691.75 -> 692
    expect(m.lines).toEqual([
      { code: "1", vat: -1205 },
      { code: "3", base: 57671, rate: "25", vat: 14418 },
      { code: "11", vat: -692 },
    ]);
    expect(m.total).toBe(12521);
    expect(m.period).toEqual({ element: "skattleggingsperiodeToMaaneder", value: "juli-august" });
    if (xmllint) expect(await xsdErrors(m.xml)).toBeNull();
  });
});
