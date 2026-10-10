// MVA-melding draft (#8): mva_term rows -> the XML Skatteetaten takes.
//
//   const t = await readMvaTerm(sql, "999888777", 2026, 2);
//   const m = buildMvaMelding({ orgnr: "999888777", year: 2026, vatTerm: t.vatTerm, term: 2,
//                               reference: "hovedbok:999888777:2026-2", rows: t.rows });
//   m.xml; m.lines; m.total   // whole kroner
//
// Shape: Skatteetaten/mva-meldingen, skattemeldingformerverdiavgift v1.0 XSD
// (commit c1958e5) and its informasjonsmodell / forretningsregler pages,
// fetched 2026-10-11. mva_term's VAT is per line stated-else-derived,
// coalesce(vat_amount, round(vat_base × rate)) (ADR-0012), so merverdiavgift
// is the booked amount the XSD asks for. The rules this builder follows:
//   - one mvaSpesifikasjonslinje per (mvaKode, sats); codes with report = false
//     (0, 7, 20-22) never appear, and a code that nets to zero in the term is
//     left out;
//   - utgående lines carry grunnlag + sats + merverdiavgift (R066, R081);
//     inngående lines carry merverdiavgift only (R065, R081) — "skal ikke
//     fylles ut for inngående mva";
//   - signs as Skatteetaten expects them: grunnlag and utgående avgift
//     positive, fradrag negative (mva_term already reads that way);
//   - both-effect codes (import 81-84 and 85, reverse charge 86-89, 91, 92)
//     give an utgående line from the one coded base, plus — for the deductible
//     ones (81, 83, 86, 88, 91) — a fradrag line with the same mvaKode;
//   - 14/15 (innførselsmva paid at the border) are fradrag lines: no grunnlag;
//   - amounts in whole kroner (R082: no decimals), each line rounded half up
//     on the absolute value, and fastsattMerverdiavgift is the sum of the
//     rounded lines (R018: they must be equal). The øre left over against the
//     ledger is the settlement's øreavrunding (7740), not the melding's;
//   - sats as Skatteetaten's sats code list writes it: "25", "15", "11,11", "0".
// Out of scope here: spesifikasjon (uttak, tapPåKrav, justering,
// tilbakeføring) and merknad per line — the ledger does not record them yet.
import type { SQL } from "bun";

export type VatTerm = "monthly" | "bimonthly" | "yearly";
export type VatKind =
  | "none" | "input" | "output" | "zero" | "outside" | "no_turnover"
  | "import_base" | "import_input" | "reverse_charge";

/** One mva_term row; amounts are øre, signed as the melding reads (see 0025). */
export interface MvaTermRow {
  vatCode: string;
  kind: VatKind;
  deductible: boolean;
  report: boolean;
  /** vat_rate.rate as Postgres prints it, e.g. "25.000" or "11.110". */
  rate: string;
  base: number;
  outputVat: number;
  inputVat: number;
}

export interface MvaMeldingInput {
  orgnr: string;
  year: number;
  vatTerm: VatTerm;
  term: number;
  /** regnskapssystemsreferanse: unique per submission. */
  reference: string;
  system?: { name: string; version?: string };
  /** KID for a refund (tilgodebeløp), if the entity has one. */
  kid?: string;
  category?: "alminnelig" | "primaernaering";
  /** Free-text merknad on the melding. */
  note?: string;
  rows: MvaTermRow[];
}

/** A spesifikasjonslinje in whole kroner; base and rate only on utgående lines. */
export interface MvaMeldingLine {
  code: string;
  base?: number;
  rate?: string;
  vat: number;
}

export interface MvaMelding {
  xml: string;
  lines: MvaMeldingLine[];
  /** fastsattMerverdiavgift, kroner: positive = to pay, negative = refund. */
  total: number;
  period: { element: string; value: string };
}

const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august",
  "september", "oktober", "november", "desember"] as const;

/** The skattleggingsperiode choice for a cadence and term. */
export function periodFor(vatTerm: VatTerm, term: number): { element: string; value: string } {
  const max = vatTerm === "monthly" ? 12 : vatTerm === "bimonthly" ? 6 : 1;
  if (!Number.isInteger(term) || term < 1 || term > max) {
    throw new Error(`term ${term} is not a ${vatTerm} VAT term (1-${max})`);
  }
  switch (vatTerm) {
    case "monthly":
      return { element: "skattleggingsperiodeMaaned", value: MONTHS[term - 1]! };
    case "bimonthly":
      return { element: "skattleggingsperiodeToMaaneder", value: `${MONTHS[2 * term - 2]}-${MONTHS[2 * term - 1]}` };
    case "yearly":
      return { element: "skattleggingsperiodeAar", value: "aarlig" };
  }
}

/** øre -> whole kroner, half up on the absolute value. */
export function kroner(ore: number): number {
  if (!Number.isSafeInteger(ore)) throw new Error(`amount must be a safe integer of øre, got ${ore}`);
  const k = Math.floor((Math.abs(ore) + 50) / 100);
  return ore < 0 && k !== 0 ? -k : k;
}

/** "25.000" -> "25", "11.110" -> "11,11" (the sats code list's spelling). */
export function satsText(rate: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(rate.trim());
  if (!m) throw new Error(`rate ${JSON.stringify(rate)} is not a non-negative decimal`);
  const int = String(Number(m[1]));
  const frac = (m[2] ?? "").replace(/0+$/, "");
  return frac ? `${int},${frac}` : int;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const OUTPUT_SIDE: ReadonlySet<VatKind> = new Set(["output", "zero", "outside", "import_base", "reverse_charge"]);
const INPUT_SIDE: ReadonlySet<VatKind> = new Set(["input", "import_input"]);
const BOTH_EFFECT: ReadonlySet<VatKind> = new Set(["import_base", "reverse_charge"]);

/** The spesifikasjonslinjer for a term's rows, in code order (output before fradrag). */
export function meldingLines(rows: MvaTermRow[]): MvaMeldingLine[] {
  const sorted = [...rows].sort((a, b) =>
    Number(a.vatCode) - Number(b.vatCode) || Number(a.rate) - Number(b.rate));
  const lines: MvaMeldingLine[] = [];
  for (const r of sorted) {
    for (const v of [r.base, r.outputVat, r.inputVat]) {
      if (!Number.isSafeInteger(v)) throw new Error(`code ${r.vatCode}: amounts must be safe integers of øre, got ${v}`);
    }
    const sats = satsText(r.rate);
    if (!r.report) continue;
    if (r.base === 0 && r.outputVat === 0 && r.inputVat === 0) continue;
    if (OUTPUT_SIDE.has(r.kind)) {
      lines.push({ code: r.vatCode, base: kroner(r.base), rate: sats, vat: kroner(r.outputVat) });
      if (BOTH_EFFECT.has(r.kind) && r.deductible) lines.push({ code: r.vatCode, vat: kroner(r.inputVat) });
    } else if (INPUT_SIDE.has(r.kind)) {
      lines.push({ code: r.vatCode, vat: kroner(r.inputVat) });
    } else {
      throw new Error(`code ${r.vatCode} (kind ${r.kind}) is marked report but has no melding treatment`);
    }
  }
  return lines;
}

/** Build the MVA-melding (mvaMeldingDto) for one term. Pure. */
export function buildMvaMelding(input: MvaMeldingInput): MvaMelding {
  if (!/^\d{9}$/.test(input.orgnr)) throw new Error(`orgnr ${JSON.stringify(input.orgnr)} must be 9 digits`);
  if (!Number.isInteger(input.year) || input.year < 1000 || input.year > 9999) {
    throw new Error(`year ${input.year} must be a four-digit year`);
  }
  if (!input.reference.trim()) throw new Error("reference (regnskapssystemsreferanse) is required");
  const period = periodFor(input.vatTerm, input.term);
  const lines = meldingLines(input.rows);
  const total = lines.reduce((s, l) => s + l.vat, 0);
  const e = escapeXml;

  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="UTF-8"?>');
  x.push('<mvaMeldingDto xmlns="no:skatteetaten:fastsetting:avgift:mva:skattemeldingformerverdiavgift:v1.0">');
  x.push("  <innsending>");
  x.push(`    <regnskapssystemsreferanse>${e(input.reference)}</regnskapssystemsreferanse>`);
  if (input.system) {
    x.push("    <regnskapssystem>");
    x.push(`      <systemnavn>${e(input.system.name)}</systemnavn>`);
    if (input.system.version) x.push(`      <systemversjon>${e(input.system.version)}</systemversjon>`);
    x.push("    </regnskapssystem>");
  }
  x.push("  </innsending>");
  x.push("  <skattegrunnlagOgBeregnetSkatt>");
  x.push("    <skattleggingsperiode>");
  x.push("      <periode>");
  x.push(`        <${period.element}>${period.value}</${period.element}>`);
  x.push("      </periode>");
  x.push(`      <aar>${input.year}</aar>`);
  x.push("    </skattleggingsperiode>");
  x.push(`    <fastsattMerverdiavgift>${total}</fastsattMerverdiavgift>`);
  for (const l of lines) {
    x.push("    <mvaSpesifikasjonslinje>");
    x.push(`      <mvaKode>${e(l.code)}</mvaKode>`);
    if (l.base !== undefined) x.push(`      <grunnlag>${l.base}</grunnlag>`);
    if (l.rate !== undefined) x.push(`      <sats>${e(l.rate)}</sats>`);
    x.push(`      <merverdiavgift>${l.vat}</merverdiavgift>`);
    x.push("    </mvaSpesifikasjonslinje>");
  }
  x.push("  </skattegrunnlagOgBeregnetSkatt>");
  if (input.kid) {
    x.push("  <betalingsinformasjon>");
    x.push(`    <kundeIdentifikasjonsnummer>${e(input.kid)}</kundeIdentifikasjonsnummer>`);
    x.push("  </betalingsinformasjon>");
  } else {
    x.push("  <betalingsinformasjon/>");
  }
  x.push("  <skattepliktig>");
  x.push(`    <organisasjonsnummer>${input.orgnr}</organisasjonsnummer>`);
  x.push("  </skattepliktig>");
  x.push(`  <meldingskategori>${input.category ?? "alminnelig"}</meldingskategori>`);
  if (input.note) {
    x.push("  <merknad>");
    x.push(`    <beskrivelse>${e(input.note)}</beskrivelse>`);
    x.push("  </merknad>");
  }
  x.push("</mvaMeldingDto>");
  return { xml: x.join("\n") + "\n", lines, total, period };
}

function toOre(v: unknown, what: string): number {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isSafeInteger(n)) throw new Error(`${what}: ${String(v)} is not a safe integer of øre`);
  return n;
}

/** Read one term of mva_term for an entity. vatTerm is the entity's current cadence. */
export async function readMvaTerm(sql: SQL, entity: string, year: number, term: number): Promise<{ vatTerm: VatTerm; rows: MvaTermRow[] }> {
  const [e] = await sql`select vat_term from entity where orgnr = ${entity}`;
  if (!e) throw new Error(`entity ${entity} does not exist`);
  const rows = await sql`
    select vat_code, kind, deductible, report, rate::text as rate,
           base::text as base, output_vat::text as output_vat, input_vat::text as input_vat
      from mva_term
     where entity = ${entity} and year = ${year} and term = ${term}`;
  return {
    vatTerm: e.vat_term as VatTerm,
    rows: rows.map((r: Record<string, unknown>) => ({
      vatCode: r.vat_code as string,
      kind: r.kind as VatKind,
      deductible: r.deductible as boolean,
      report: r.report as boolean,
      rate: r.rate as string,
      base: toOre(r.base, `code ${r.vat_code} base`),
      outputVat: toOre(r.output_vat, `code ${r.vat_code} output_vat`),
      inputVat: toOre(r.input_vat, `code ${r.vat_code} input_vat`),
    })),
  };
}
