// SAF-T Financial export (Skatteetaten, v1.30 today, v1.40-ready), fed from
// the stored journal — never from re-expanded vouchers.
//
// Ported from enkelt-regnskap src/core/saft.ts (byggSaft, osloStamp,
// saftFilnavn) and src/rapport.ts (saftEksport, periodeNavn), 2026-10-11;
// those were themselves a port of make_saft.py. Element order follows the
// Norwegian XSD (test/fixtures/saft/*.xsd); the golden fixture from
// enkelt-regnskap must byte-match after the normalisation its tests used
// (test/saft.test.ts).
//
// What is read, and from where (research-norsk-compliance.md § 7):
//   Header         entity + the caller's company profile (address, contact,
//                  bank accounts default to bank_account rows)
//   MasterFiles    account (name, grouping; std_account fills gaps), balances
//                  summed from the journal view (opening = before `from`,
//                  closing = through `to`); party with customer/supplier/owner
//                  balances on the control accounts; TaxTable from vat_code +
//                  vat_rate for the codes used in the period; Owners
//   GeneralLedger  vouchers with posting_date in [from, to], lines in order;
//                  TaxInformation on coded base lines (ADR-0011): the booked
//                  VAT from the voucher's own 27xx lines where attributable,
//                  base × rate (half up) otherwise.
//
// Amount formatting is a Format object chosen by version (see FORMATS), so
// v1.40 (mandatory for periods from 2027-01-01) is a switch: amounts keep the
// same monetary type, foreign-currency amounts get the 38/18 type, VAT on
// foreign-currency lines is locked in NOK (Debit/CreditNOKTaxAmount), and an
// owner may list every account.
import type { SQL } from "bun";
import { osloDate, vatTermPeriod } from "./core/date";
import { divRoundHalfUp, formatDot } from "./core/money";

export type SaftVersion = "1.30" | "1.40";

export interface SaftAddress {
  street?: string;
  number?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

export interface SaftCompany {
  /** Defaults to entity.name. */
  name?: string;
  address?: SaftAddress;
  contact?: { firstName: string; lastName: string; telephone?: string; email?: string };
  /** Defaults to the entity's bank_account rows (bban → ledger_account). */
  bankAccounts?: { number: string; ledgerAccount: string; currency?: string }[];
}

export interface SaftOptions {
  entity: string;
  /** Selection period, YYYY-MM-DD inclusive. */
  from: string;
  to: string;
  /** File creation instant (AuditFileDateCreated, file name). Default: now. */
  now?: Date;
  version?: SaftVersion;
  company?: SaftCompany;
  software?: { company: string; id: string; version: string };
  headerComment?: string;
  journalDescription?: string;
}

export interface SaftExport {
  /** Skatteetaten convention: `SAF-T Financial_<orgnr>_<YYYYMMDDHHMMSS Oslo>_1_1.xml`. */
  filename: string;
  xml: string;
  version: SaftVersion;
  /** NumberOfEntries: vouchers in the period. */
  entries: number;
}

const SOFTWARE = { company: "Egenutviklet (hovedbok)", id: "hovedbok", version: "1.0" };

// ---------------------------------------------------------------------------
// Version switch

interface Format {
  version: SaftVersion;
  /** NOK ledger amounts (SAFmonetaryType: 18 digits, 2 decimals in both versions). */
  amount(ore: number): string;
  /**
   * Foreign-currency amounts, stored in minor units. 1.30: SAFmonetaryType
   * (2 decimals); 1.40: SAFlongmonetaryType (38 digits, 18 decimals), where
   * more precision lands when the ledger stores it.
   */
  currencyAmount(minor: number): string;
  exchangeRate(rate: string): string;
  /** 1.40: VAT on a foreign-currency line is also given locked in NOK. */
  nokTaxAmount: boolean;
  /** Owner/AccountID: one in 1.30, unbounded in 1.40. */
  ownerAccounts: "first" | "all";
}

const FORMATS: Record<SaftVersion, Format> = {
  "1.30": {
    version: "1.30",
    amount: formatDot,
    currencyAmount: formatDot,
    exchangeRate: (r) => r,
    nokTaxAmount: false,
    ownerAccounts: "first",
  },
  "1.40": {
    version: "1.40",
    amount: formatDot,
    currencyAmount: formatDot,
    exchangeRate: (r) => r,
    nokTaxAmount: true,
    ownerAccounts: "all",
  },
};

// ---------------------------------------------------------------------------
// XML writer (enkelt-regnskap class X, verbatim)

class X {
  parts: string[] = [];
  ind = 0;
  open(tag: string) {
    this.parts.push(`${"  ".repeat(this.ind)}<${tag}>\n`);
    this.ind++;
  }
  close(tag: string) {
    this.ind--;
    this.parts.push(`${"  ".repeat(this.ind)}</${tag}>\n`);
  }
  el(tag: string, text: string | number) {
    this.parts.push(`${"  ".repeat(this.ind)}<${tag}>${esc(String(text))}</${tag}>\n`);
  }
  toString() {
    return this.parts.join("");
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function balance(x: X, f: Format, prefix: string, v: number) {
  if (v >= 0) x.el(`${prefix}DebitBalance`, f.amount(v));
  else x.el(`${prefix}CreditBalance`, f.amount(-v));
}

function address(x: X, a: SaftAddress) {
  x.open("Address");
  if (a.street) x.el("StreetName", a.street);
  if (a.number) x.el("Number", a.number);
  x.el("City", a.city || "Ukjent");
  x.el("PostalCode", a.postalCode || "0000");
  x.el("Country", a.country || "NO");
  x.close("Address");
}

// ---------------------------------------------------------------------------
// Dates, names, numbers

/** Timestamp in Europe/Oslo as YYYYMMDDHHMMSS (file name convention). */
export function osloStamp(d: Date): string {
  const p = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((q) => q.type === t)!.value;
  return `${g("year")}${g("month")}${g("day")}${g("hour")}${g("minute")}${g("second")}`;
}

export function saftFilename(orgnr: string, now: Date): string {
  return `SAF-T Financial_${orgnr}_${osloStamp(now)}_1_1.xml`;
}

/** "4. termin 2026" when [from, to] is exactly a bimonthly VAT term, else "from–to". */
export function periodName(from: string, to: string): string {
  const year = Number(from.slice(0, 4));
  for (let t = 1; t <= 6; t++) {
    const p = vatTermPeriod(year, t);
    if (p.from === from && p.to === to) return `${t}. termin ${year}`;
  }
  return `${from}–${to}`;
}

function assertDate(s: string, what: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new Error(`${what} must be YYYY-MM-DD, got ${JSON.stringify(s)}`);
  }
}

/** Postgres bigint comes back as text; the ledger fits safe integers (ADR-0003). */
function ore(s: string | number | null): number {
  if (s === null) return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`amount ${s} is not a safe integer number of øre`);
  return n;
}

/** numeric(6,3) "25.000" -> "25", "12.500" -> "12.5" (TaxPercentage is xs:decimal). */
function percent(rate: string): string {
  return rate.includes(".") ? rate.replace(/0+$/, "").replace(/\.$/, "") : rate;
}

/** VAT at `rate` (numeric(6,3) text) on |base| øre, half up, carrying base's sign. */
function derivedVat(base: number, rate: string): number {
  const thousandths = Math.round(Number(rate) * 1000);
  if (thousandths === 0 || base === 0) return 0;
  const v = divRoundHalfUp(Math.abs(base) * thousandths, 100_000);
  return base < 0 ? -v : v;
}

// ---------------------------------------------------------------------------
// Rows

interface AccountRow {
  code: string;
  name: string;
  category: string | null;
  grouping: string | null;
  opening: string;
  closing: string;
}

interface PartyRow {
  id: string;
  name: string;
  orgnr: string | null;
  foreign_reg_no: string | null;
  country: string;
  address: Record<string, unknown>;
  customer: boolean;
  supplier: boolean;
  owner: boolean;
}

interface PartyBalanceRow {
  party: string;
  control: "customer" | "supplier";
  account: string;
  opening: string;
  closing: string;
}

interface TaxRow {
  code: string;
  description_nb: string;
  rate: string;
}

interface LineRow {
  year: number;
  nr: number;
  period: number;
  posting_date: string;
  document_date: string;
  voucher_description: string;
  external_ref: string | null;
  created_at: Date;
  line: number;
  account: string;
  amount: string;
  ccy: string | null;
  ccy_amount: string | null;
  ccy_rate: string | null;
  vat_code: string | null;
  vat_base: string | null;
  vat_amount: string | null;
  party: string | null;
  line_description: string;
  control: "customer" | "supplier" | null;
  vat_side: "output" | "input" | null;
  default_vat: string | null;
  kind: string | null;
}

interface Voucher {
  year: number;
  nr: number;
  period: number;
  postingDate: string;
  documentDate: string;
  description: string;
  externalRef: string | null;
  createdAt: Date;
  lines: LineRow[];
}

interface RateRow {
  code: string;
  valid_from: string;
  rate: string;
}

function rateAt(rates: RateRow[], code: string, date: string): string {
  let best: RateRow | undefined;
  for (const r of rates) {
    if (r.code === code && r.valid_from <= date && (!best || r.valid_from > best.valid_from)) best = r;
  }
  if (!best) throw new Error(`vat code ${code} has no rate valid on ${date}`);
  return best.rate;
}

/**
 * Tax amount per coded line of a voucher: stated, else booked-attributed,
 * else derived (ADR-0011, ADR-0012). The code sits on the base line, the VAT
 * itself on a 27xx line. A line with vat_amount (the figure on the source
 * document) reports that. Otherwise, single-effect codes (input/output) take
 * the VAT booked on the voucher's VAT accounts that default to the code: one
 * coded line gets it whole, several get base × rate each with the rounding
 * remainder on the last, so the lines add up to what was booked. Codes with
 * no booked VAT in the voucher (code 0, zero rate, both-effect regimes) are
 * base × rate, half up.
 */
function taxAmounts(v: Voucher, rates: RateRow[]): Map<number, number> {
  const out = new Map<number, number>();
  const coded = new Map<string, LineRow[]>();
  const booked = new Map<string, number>();
  for (const l of v.lines) {
    if (l.vat_code !== null) coded.set(l.vat_code, [...(coded.get(l.vat_code) ?? []), l]);
    if (l.vat_side !== null && l.default_vat !== null) {
      booked.set(l.default_vat, (booked.get(l.default_vat) ?? 0) + ore(l.amount));
    }
  }
  for (const [code, lines] of coded) {
    const rate = rateAt(rates, code, v.postingDate);
    const derived = lines.map((l) => derivedVat(ore(l.vat_base), rate));
    const kind = lines[0]?.kind;
    const single = kind === "input" || kind === "output" || kind === "import_input";
    const b = booked.get(code);
    if (single && b !== undefined) {
      if (derived.length === 1) derived[0] = b;
      else derived[derived.length - 1] = (derived[derived.length - 1] ?? 0) + b - derived.reduce((a, d) => a + d, 0);
    }
    lines.forEach((l, i) => out.set(l.line, l.vat_amount !== null ? ore(l.vat_amount) : derived[i] ?? 0));
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Builds the SAF-T Financial file for one entity and period from the stored journal. */
export async function buildSaft(sql: SQL, opts: SaftOptions): Promise<SaftExport> {
  const { entity, from, to } = opts;
  assertDate(from, "from");
  assertDate(to, "to");
  if (from > to) throw new Error(`from ${from} is after to ${to}`);
  const f = FORMATS[opts.version ?? "1.30"];
  if (!f) throw new Error(`unsupported SAF-T version ${opts.version}`);
  const now = opts.now ?? new Date();
  const sw = opts.software ?? SOFTWARE;
  const today = osloDate(now);
  const name = periodName(from, to);

  const [ent] = await sql`select orgnr, name from entity where orgnr = ${entity}` as { orgnr: string; name: string }[];
  if (!ent) throw new Error(`entity ${entity} does not exist`);
  const company = opts.company ?? {};

  const bankAccounts = company.bankAccounts ?? (await sql`
    select bban as number, ledger_account as "ledgerAccount", currency
      from bank_account
     where entity = ${entity} and bban is not null
     order by ledger_account, bban` as { number: string; ledgerAccount: string; currency: string }[]);

  // MasterFiles: only accounts posted on or before `to` (an untouched standard
  // chart would bloat the file); opening = before `from`, closing = through `to`.
  const accounts = await sql`
    with b as (
      select account,
             coalesce(sum(amount) filter (where posting_date < ${from}::date), 0)::text as opening,
             sum(amount)::text as closing
        from journal
       where entity = ${entity} and posting_date <= ${to}::date
       group by account)
    select a.code, a.name,
           coalesce(g.category, s.grouping_category) as category,
           coalesce(a.grouping, s.grouping_code) as grouping,
           b.opening, b.closing
      from b
      join account a on a.entity = ${entity} and a.code = b.account
      left join std_account s on s.code = a.std_account
      left join lateral (select category from grouping_range where code = a.grouping limit 1) g on true
     order by a.code` as AccountRow[];

  const parties = await sql`
    select id, name, orgnr, foreign_reg_no, country, address, customer, supplier, owner
      from party where entity = ${entity} order by id` as PartyRow[];
  const partyBalances = await sql`
    select j.party, a.control, j.account,
           coalesce(sum(j.amount) filter (where j.posting_date < ${from}::date), 0)::text as opening,
           sum(j.amount)::text as closing
      from journal j
      join account a on a.entity = j.entity and a.code = j.account
     where j.entity = ${entity} and j.posting_date <= ${to}::date
       and j.party is not null and a.control is not null
     group by j.party, a.control, j.account
     order by j.party, j.account` as PartyBalanceRow[];
  const controlDefault = await sql`
    select control, min(code) as code from account
     where entity = ${entity} and control is not null group by control` as { control: string; code: string }[];
  const ownerAccounts = await sql`
    select distinct party, account from journal
     where entity = ${entity} and posting_date <= ${to}::date
       and party is not null and account between '2000' and '2099'
     order by party, account` as { party: string; account: string }[];

  const taxCodes = await sql`
    select distinct j.vat_code as code, c.description_nb,
           (select r.rate::text from vat_rate r
             where r.code = j.vat_code and r.valid_from <= ${to}::date
             order by r.valid_from desc limit 1) as rate
      from journal j
      join vat_code c on c.code = j.vat_code
     where j.entity = ${entity} and j.posting_date between ${from}::date and ${to}::date
       and j.vat_code is not null` as TaxRow[];
  taxCodes.sort((a, b) => Number(a.code) - Number(b.code));

  const rates = await sql`select code, valid_from::text, rate::text from vat_rate` as RateRow[];

  const lines = await sql`
    select j.year, j.nr, j.period, j.posting_date::text, j.document_date::text,
           j.voucher_description, j.external_ref, j.created_at,
           j.line, j.account, j.amount::text, j.ccy, j.ccy_amount::text, j.ccy_rate::text,
           j.vat_code, j.vat_base::text, j.vat_amount::text, j.party, j.line_description,
           a.control, s.vat_side, s.default_vat, c.kind
      from journal j
      join account a on a.entity = j.entity and a.code = j.account
      left join std_account s on s.code = a.std_account
      left join vat_code c on c.code = j.vat_code
     where j.entity = ${entity} and j.posting_date between ${from}::date and ${to}::date
     order by j.year, j.nr, j.line` as LineRow[];

  const vouchers: Voucher[] = [];
  for (const l of lines) {
    const last = vouchers[vouchers.length - 1];
    if (last && last.year === l.year && last.nr === l.nr) last.lines.push(l);
    else {
      vouchers.push({
        year: l.year, nr: l.nr, period: l.period, postingDate: l.posting_date,
        documentDate: l.document_date, description: l.voucher_description,
        externalRef: l.external_ref, createdAt: l.created_at, lines: [l],
      });
    }
  }

  // -------------------------------------------------------------------------
  const x = new X();
  x.parts.push("<?xml version='1.0' encoding='UTF-8'?>\n");
  x.parts.push('<AuditFile xmlns="urn:StandardAuditFile-Taxation-Financial:NO">\n');
  x.ind = 1;

  // Header
  x.open("Header");
  x.el("AuditFileVersion", f.version);
  x.el("AuditFileCountry", "NO");
  x.el("AuditFileDateCreated", today);
  x.el("SoftwareCompanyName", sw.company);
  x.el("SoftwareID", sw.id);
  x.el("SoftwareVersion", sw.version);
  x.open("Company");
  x.el("RegistrationNumber", ent.orgnr);
  x.el("Name", company.name ?? ent.name);
  address(x, company.address ?? {});
  if (company.contact) {
    x.open("Contact");
    x.open("ContactPerson");
    x.el("FirstName", company.contact.firstName);
    x.el("LastName", company.contact.lastName);
    x.close("ContactPerson");
    if (company.contact.telephone) x.el("Telephone", company.contact.telephone);
    if (company.contact.email) x.el("Email", company.contact.email);
    x.close("Contact");
  }
  x.open("TaxRegistration");
  x.el("TaxRegistrationNumber", ent.orgnr);
  x.el("TaxAuthority", "Skatteetaten");
  x.close("TaxRegistration");
  for (const b of bankAccounts) {
    x.open("BankAccount");
    x.el("BankAccountNumber", b.number);
    x.el("CurrencyCode", b.currency ?? "NOK");
    x.el("GeneralLedgerAccountID", b.ledgerAccount);
    x.close("BankAccount");
  }
  x.close("Company");
  x.el("DefaultCurrencyCode", "NOK");
  x.open("SelectionCriteria");
  x.el("PeriodStart", Number(from.slice(5, 7)));
  x.el("PeriodStartYear", from.slice(0, 4));
  x.el("PeriodEnd", Number(to.slice(5, 7)));
  x.el("PeriodEndYear", to.slice(0, 4));
  x.close("SelectionCriteria");
  x.el("HeaderComment", opts.headerComment ?? `Regnskap ført i hovedbok for ${name}.`);
  x.el("TaxAccountingBasis", "A");
  x.el("UserID", ent.orgnr);
  x.close("Header");

  // MasterFiles
  x.open("MasterFiles");
  x.open("GeneralLedgerAccounts");
  for (const a of accounts) {
    if (a.category === null || a.grouping === null) {
      throw new Error(`account ${a.code} has no SAF-T grouping (upsert_account sets std_account or grouping)`);
    }
    x.open("Account");
    x.el("AccountID", a.code);
    x.el("AccountDescription", a.name);
    x.el("GroupingCategory", a.category);
    x.el("GroupingCode", a.grouping);
    x.el("AccountType", "GL");
    balance(x, f, "Opening", ore(a.opening));
    balance(x, f, "Closing", ore(a.closing));
    x.close("Account");
  }
  x.close("GeneralLedgerAccounts");

  const partyAddress = (p: PartyRow): SaftAddress => ({
    street: str(p.address.street), number: str(p.address.number), city: str(p.address.city),
    postalCode: str(p.address.postal_code), country: p.country,
  });
  const partyMaster = (tag: "Customer" | "Supplier", control: "customer" | "supplier") => {
    const rows = parties.filter((p) => p[control]);
    if (rows.length === 0) return;
    const fallback = controlDefault.find((c) => c.control === control)?.code ?? (control === "customer" ? "1500" : "2400");
    x.open(tag + "s");
    for (const p of rows) {
      x.open(tag);
      const reg = p.orgnr ?? p.foreign_reg_no;
      if (reg) x.el("RegistrationNumber", reg);
      x.el("Name", p.name);
      address(x, partyAddress(p));
      x.el(`${tag}ID`, p.id);
      const bals = partyBalances.filter((b) => b.party === p.id && b.control === control);
      for (const b of bals.length ? bals : [{ account: fallback, opening: "0", closing: "0" }]) {
        x.open("BalanceAccount");
        x.el("AccountID", b.account);
        balance(x, f, "Opening", ore(b.opening));
        balance(x, f, "Closing", ore(b.closing));
        x.close("BalanceAccount");
      }
      x.close(tag);
    }
    x.close(tag + "s");
  };
  partyMaster("Customer", "customer");
  partyMaster("Supplier", "supplier");

  if (taxCodes.length) {
    x.open("TaxTable");
    x.open("TaxTableEntry");
    x.el("TaxType", "MVA");
    x.el("Description", "Merverdiavgift");
    for (const t of taxCodes) {
      if (t.rate === null) throw new Error(`vat code ${t.code} has no rate valid on ${to}`);
      x.open("TaxCodeDetails");
      x.el("TaxCode", t.code);
      x.el("Description", t.description_nb);
      x.el("TaxPercentage", percent(t.rate));
      x.el("Country", "NO");
      x.el("StandardTaxCode", t.code);
      x.el("BaseRate", "100");
      x.close("TaxCodeDetails");
    }
    x.close("TaxTableEntry");
    x.close("TaxTable");
  }

  const owners = parties.filter((p) => p.owner);
  if (owners.length) {
    x.open("Owners");
    for (const p of owners) {
      x.open("Owner");
      const reg = p.orgnr ?? p.foreign_reg_no;
      if (reg) x.el("RegistrationNumber", reg);
      x.el("Name", p.name);
      address(x, partyAddress(p));
      x.el("OwnerID", p.id);
      const accs = ownerAccounts.filter((o) => o.party === p.id).map((o) => o.account);
      for (const a of f.ownerAccounts === "all" ? accs : accs.slice(0, 1)) x.el("AccountID", a);
      x.close("Owner");
    }
    x.close("Owners");
  }
  x.close("MasterFiles");

  // GeneralLedgerEntries
  let totD = 0, totC = 0;
  for (const l of lines) {
    const a = ore(l.amount);
    if (a > 0) totD += a;
    else totC -= a;
  }
  x.open("GeneralLedgerEntries");
  x.el("NumberOfEntries", vouchers.length);
  x.el("TotalDebit", f.amount(totD));
  x.el("TotalCredit", f.amount(totC));
  x.open("Journal");
  x.el("JournalID", "GL");
  x.el("Description", opts.journalDescription ?? `Hovedbok ${name}`);
  x.el("Type", "GL");
  for (const v of vouchers) {
    const tax = taxAmounts(v, rates);
    x.open("Transaction");
    x.el("TransactionID", v.nr);
    x.el("Period", v.period);
    x.el("PeriodYear", v.year);
    x.el("TransactionDate", v.documentDate);
    x.el("Description", v.description);
    x.el("SystemEntryDate", osloDate(v.createdAt));
    x.el("GLPostingDate", v.postingDate);
    for (const l of v.lines) {
      const amount = ore(l.amount);
      const side = amount >= 0 ? "Debit" : "Credit";
      x.open("Line");
      x.el("RecordID", l.line);
      x.el("AccountID", l.account);
      if (l.party !== null && l.control === "customer") x.el("CustomerID", l.party);
      if (l.party !== null && l.control === "supplier") x.el("SupplierID", l.party);
      x.el("Description", l.line_description || v.description);
      x.open(`${side}Amount`);
      x.el("Amount", f.amount(Math.abs(amount)));
      if (l.ccy !== null && l.ccy_amount !== null) {
        x.el("CurrencyCode", l.ccy);
        x.el("CurrencyAmount", f.currencyAmount(Math.abs(ore(l.ccy_amount))));
        if (l.ccy_rate !== null) x.el("ExchangeRate", f.exchangeRate(l.ccy_rate));
      }
      x.close(`${side}Amount`);
      if (l.vat_code !== null) {
        const base = ore(l.vat_base);
        const vat = tax.get(l.line) ?? 0;
        x.open("TaxInformation");
        x.el("TaxType", "MVA");
        x.el("TaxCode", l.vat_code);
        x.el("TaxPercentage", percent(rateAt(rates, l.vat_code, v.postingDate)));
        x.el("Country", "NO");
        x.el("TaxBase", f.amount(Math.abs(base)));
        x.open(`${side}TaxAmount`);
        x.el("Amount", f.amount(Math.abs(vat)));
        x.close(`${side}TaxAmount`);
        if (f.nokTaxAmount && l.ccy !== null) {
          x.open(`${side}NOKTaxAmount`);
          x.el("NOKAmount", f.amount(Math.abs(vat)));
          x.el("NOKTaxBase", f.amount(Math.abs(base)));
          x.close(`${side}NOKTaxAmount`);
        }
        x.close("TaxInformation");
      }
      if (v.externalRef) x.el("ReferenceNumber", v.externalRef);
      x.close("Line");
    }
    x.close("Transaction");
  }
  x.close("Journal");
  x.close("GeneralLedgerEntries");
  x.ind = 0;
  x.parts.push("</AuditFile>\n");

  return { filename: saftFilename(ent.orgnr, now), xml: x.toString(), version: f.version, entries: vouchers.length };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
