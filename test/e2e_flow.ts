// The agent bookkeeping loop (#13), end to end over HTTP: bank facts in, the
// agent explains them, law-grade outputs fall out. One flow, two drivers:
//
//   test/e2e.test.ts   CI: a fresh database, a real listener, Enable Banking
//                      replayed from test/fixtures/enable-banking
//   scripts/e2e.ts     a live deployment: base URL + tokens
//
// The flow only speaks HTTP and is safe to re-run against the same entity:
// every write is idempotent (bootstrap, content-addressed documents, vouchers
// under fixed idempotency keys, reverse-once, idempotent match/unmatch), and
// nothing closes a period. Bank facts only arrive through Enable Banking sync
// (no HTTP route inserts them, by design); without an authorized connection
// for the entity the bank steps are SKIPPED and the ledger loop still runs on
// the same statement.
//
// The statement is the recorded fixture (backfill-1/2 + balances-1): opening
// 50 000,00 -> CLBD 56 184,50. What the agent books for it:
//   1 opening balance        2026-01-01  1920 / 2050             50 000,00
//   2 invoice to Kunde AS    2026-08-17  1500 / 3000 (3) / 2700  12 500,00
//   3 KID payment            2026-09-01  1920 / 1500             12 500,00  bank
//   4 rent, Faktura 1042     2026-09-03  6300 (1) / 2710 / 1920   4 990,00  bank
//   5 bank fee               2026-09-30  7770 / 1920                 75,00  bank
//   6 Telenor, wrongly 6800  2026-10-02  6800 (1) / 2710 / 1920   1 250,50  bank (match moved to 8)
//   7 reversal of 6          2026-10-05
//   8 Telenor on 6900        2026-10-02  6900 (1) / 2710 / 1920   1 250,50  bank
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const YEAR = 2026;
export const ENTITY_NAME = "E2E Test AS";
/** SAF-T Header/Company for the test entity (#15): what GET /saf-t needs to serve a valid file. */
export const COMPANY_PROFILE = {
  address: { street: "Testveien", number: "1", city: "Oslo", postalCode: "0150", country: "NO" },
  contact: { firstName: "E2E", lastName: "Testesen", telephone: "+47 22 00 00 00", email: "e2e@hovedbok.invalid" },
};

const MVA_XSD = join(import.meta.dir, "fixtures", "mva-meldingen",
  "no.skatteetaten.fastsetting.avgift.mva.skattemeldingformerverdiavgift.v1.0.xsd");
const SAFT_XSD = join(import.meta.dir, "fixtures", "saft", "Norwegian_SAF-T_Financial_Schema_v_1.30.xsd");

// ---------------------------------------------------------------------------
// The books, and the figures they must produce.

export interface Line {
  account: string;
  amount: number;
  description?: string;
  vat_code?: string;
  vat_base?: number;
  party?: string;
}

interface Explanation {
  key: string;
  label: string;
  date: string;
  description: string;
  /** The bank movement this voucher explains (signed øre, + = into 1920). */
  bank?: { amount: number };
  document: { origin: "receipt" | "invoice" | "bank" | "other"; text: string };
  lines: Line[];
}

const OPENING = 5_000_000;

const opening: Explanation = {
  key: "opening", label: "opening balance", date: "2026-01-01", description: "Inngående balanse bank",
  document: { origin: "other", text: "Åpningsbalanse 2026: Driftskonto NO9386011117947 50 000,00" },
  lines: [{ account: "1920", amount: OPENING }, { account: "2050", amount: -OPENING }],
};
const invoice: Explanation = {
  key: "invoice-k1", label: "invoice to Kunde AS", date: "2026-08-17", description: "Faktura 1 Kunde AS, KID 0012345678906",
  document: { origin: "invoice", text: "Faktura 1 til Kunde AS: konsulenttjenester 10 000,00 + mva 2 500,00" },
  lines: [
    { account: "1500", amount: 1_250_000, party: "K1" },
    { account: "3000", amount: -1_000_000, vat_code: "3", vat_base: -1_000_000 },
    { account: "2700", amount: -250_000 },
  ],
};
const payment: Explanation = {
  key: "payment-k1", label: "KID payment from Kunde AS", date: "2026-09-01", description: "Innbetaling Kunde AS, KID 0012345678906",
  bank: { amount: 1_250_000 },
  document: { origin: "bank", text: "Kontoutskrift 2026-09-01: innbetaling Kunde AS 12 500,00 KID 0012345678906" },
  lines: [{ account: "1920", amount: 1_250_000 }, { account: "1500", amount: -1_250_000, party: "K1" }],
};
const rent: Explanation = {
  key: "rent-1042", label: "Leverandør AS, Faktura 1042", date: "2026-09-03", description: "Husleie september, Leverandør AS faktura 1042",
  bank: { amount: -499_000 },
  document: { origin: "invoice", text: "Faktura 1042 fra Leverandør AS: husleie 3 992,00 + mva 998,00" },
  lines: [
    { account: "6300", amount: 399_200, vat_code: "1", vat_base: 399_200 },
    { account: "2710", amount: 99_800 },
    { account: "1920", amount: -499_000 },
  ],
};
const fee: Explanation = {
  key: "fee-2026-09", label: "bank fee", date: "2026-09-30", description: "Gebyr nettbank bedrift",
  bank: { amount: -7_500 },
  document: { origin: "bank", text: "Gebyrspesifikasjon september 2026: nettbank bedrift 75,00" },
  lines: [{ account: "7770", amount: 7_500 }, { account: "1920", amount: -7_500 }],
};
const telenorDoc = { origin: "invoice" as const, text: "Faktura fra Telenor Norge AS: mobilabonnement 1 000,40 + mva 250,10" };
const telenorWrong: Explanation = {
  key: "telenor-2026-10", label: "Telenor bill (booked on 6800 by mistake)", date: "2026-10-02", description: "Telenor Norge AS",
  bank: { amount: -125_050 },
  document: telenorDoc,
  lines: [
    { account: "6800", amount: 100_040, vat_code: "1", vat_base: 100_040 },
    { account: "2710", amount: 25_010 },
    { account: "1920", amount: -125_050 },
  ],
};
const telenor: Explanation = {
  key: "telenor-2026-10-corrected", label: "Telenor bill on 6900", date: "2026-10-02", description: "Telenor Norge AS, telefon",
  bank: { amount: -125_050 },
  document: telenorDoc,
  lines: [
    { account: "6900", amount: 100_040, vat_code: "1", vat_base: 100_040 },
    { account: "2710", amount: 25_010 },
    { account: "1920", amount: -125_050 },
  ],
};
const REVERSAL_DATE = "2026-10-05";
const correctionNote = { origin: "other" as const, text: "Korreksjon: Telenor-faktura ført på 6800, skal på 6900 (telefon)" };

/** The bank statement the books explain (fixture backfill-1/2, balances-1). */
export const STATEMENT = {
  opening: OPENING,
  closing: 5_618_450,
  transactions: [payment, rent, fee, telenor].map((e) => ({ date: e.date, amount: e.bank!.amount })),
};

/** What the flow asserts. */
export const EXPECTED = {
  vouchers: 8,
  /** vat_summary per period: [period, code, base, vat] (øre, signed as booked). */
  vatSummary: [
    [8, "3", -1_000_000, -250_000],
    [9, "1", 399_200, 99_800],
    [10, "1", 100_040, 25_010],
  ] as [number, string, number, number][],
  /** MVA-melding per bimonthly term, whole kroner. */
  mva: {
    4: { total: 2500, lines: [{ code: "3", base: 10000, rate: "25", vat: 2500 }] },
    5: { total: -1248, lines: [{ code: "1", vat: -1248 }] },
  } as Record<number, { total: number; lines: unknown[] }>,
};

// ---------------------------------------------------------------------------
// Report

export type StepStatus = "pass" | "fail" | "skip" | "not run";
export interface Step {
  name: string;
  status: StepStatus;
  detail: string;
}
export interface Facts {
  bank: "matched" | "skipped";
  bankSkipReason?: string;
  queueBefore?: number;
  vouchers: Record<string, { nr: number; idempotent: boolean }>;
  reconciliation?: { ledger: number; bank: number; difference: number; balanceType: string };
  ledger1920?: number;
  mva: Record<number, { total: number; lines: unknown[] }>;
  saftEntries?: number;
  saftXsd?: { valid: boolean };
}

export const SAFT_XSD_STEP = "SAF-T valid against the v1.30 XSD";
export interface FlowReport {
  ok: boolean;
  steps: Step[];
  facts: Facts;
}

class Skip extends Error {}
class Check extends Error {}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Check(msg);
}
function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

export function formatReport(r: FlowReport): string {
  const tag: Record<StepStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP", "not run": "----" };
  const width = Math.max(...r.steps.map((s) => s.name.length));
  const lines = r.steps.map((s) => `${tag[s.status]}  ${s.name.padEnd(width)}${s.detail ? `  ${s.detail}` : ""}`);
  const n = (st: StepStatus) => r.steps.filter((s) => s.status === st).length;
  lines.push("", `${r.ok ? "OK" : "FAILED"}: ${n("pass")} passed, ${n("fail")} failed, ${n("skip")} skipped, ${n("not run")} not run`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTTP

interface Res {
  status: number;
  text: string;
  json: any;
}

export interface FlowOptions {
  baseUrl: string | URL;
  token: string;
  /** Read-only token: when given, every read goes through it, and writes must be refused. */
  roToken?: string;
  entity: string;
  /**
   * Called when the entity has no authorized bank connection: establish one
   * (CI: consent + backfill against the replayed bank). Absent: the bank loop
   * is skipped.
   */
  connectBank?: (http: Http) => Promise<void>;
  /** xmllint for XSD validation; null/undefined = skip validation. */
  xmllint?: string | null;
  /** Called with each finished step (live progress). */
  onStep?: (s: Step) => void;
}

export interface Http {
  call(method: string, path: string, opts?: { body?: unknown; raw?: Uint8Array; contentType?: string; token?: string | null }): Promise<Res>;
  /** A 2xx JSON response, or throws naming the request and the answer. */
  ok(method: string, path: string, opts?: { body?: unknown; raw?: Uint8Array; contentType?: string; token?: string | null }): Promise<Res>;
  read(path: string): Promise<Res>;
}

function http(o: FlowOptions): Http {
  const call: Http["call"] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? o.token : opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    let body: RequestInit["body"];
    if (opts.raw) {
      body = opts.raw;
      headers["content-type"] = opts.contentType ?? "application/octet-stream";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(new URL(path, o.baseUrl), { method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  };
  const ok: Http["ok"] = async (method, path, opts) => {
    const r = await call(method, path, opts);
    check(r.status >= 200 && r.status < 300, `${method} ${path} -> ${r.status}: ${r.text.slice(0, 300)}`);
    return r;
  };
  return { call, ok, read: (path) => ok("GET", path, { token: o.roToken ?? o.token }) };
}

async function xsdErrors(xmllint: string, xsd: string, xml: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "hovedbok-e2e-"));
  try {
    const file = join(dir, "doc.xml");
    await writeFile(file, xml);
    const p = Bun.spawnSync([xmllint, "--noout", "--schema", xsd, file], { stderr: "pipe", stdout: "pipe" });
    return p.exitCode === 0 ? null : p.stderr.toString().replaceAll(`${dir}/`, "").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** booking_date as the API serializes it -> YYYY-MM-DD. */
function day(v: unknown): string {
  return String(v).slice(0, 10);
}

interface QueueItem {
  id_hash: string;
  dedup_key: string;
  booking_date: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// The flow

export async function runFlow(o: FlowOptions): Promise<FlowReport> {
  const h = http(o);
  const E = o.entity;
  const steps: Step[] = [];
  const facts: Facts = { bank: "skipped", vouchers: {}, mva: {} };
  let halted = false;

  async function step(name: string, fn: () => Promise<string | void>, opts: { critical?: boolean } = {}): Promise<boolean> {
    let s: Step;
    if (halted) {
      s = { name, status: "not run", detail: "an earlier critical step failed" };
    } else {
      try {
        s = { name, status: "pass", detail: (await fn()) ?? "" };
      } catch (e) {
        if (e instanceof Skip) s = { name, status: "skip", detail: e.message };
        else {
          s = { name, status: "fail", detail: e instanceof Error ? e.message : String(e) };
          if (opts.critical) halted = true;
        }
      }
    }
    steps.push(s);
    o.onStep?.(s);
    return s.status === "pass";
  }

  // bank transactions waiting for an explanation, keyed date|amount
  const queue = new Map<string, QueueItem>();
  const qkey = (date: string, amount: number) => `${date}|${amount}`;
  const docs = new Map<string, string>();

  async function storeDocument(d: Explanation["document"]): Promise<string> {
    const bytes = new TextEncoder().encode(`%PDF-1.7\n% hovedbok e2e ${E}\n${d.text}\n`);
    const r = await h.ok("POST", `/documents?origin=${d.origin}&note=${encodeURIComponent(`e2e ${E}`)}`, {
      raw: bytes, contentType: "application/pdf",
    });
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    same(r.json.sha256, sha, "stored document hash");
    return sha;
  }

  /** Post the voucher that explains `x`: its document, its lines, and (bank mode) the match on its 1920 line. */
  async function explain(x: Explanation, opts: { matchOnReplay?: boolean } = {}): Promise<string> {
    const sha = await storeDocument(x.document);
    docs.set(x.key, sha);
    const item = x.bank ? queue.get(qkey(x.date, x.bank.amount)) : undefined;
    const bankLine = x.lines.findIndex((l) => l.account === "1920") + 1;
    const r = await h.ok("POST", "/vouchers", {
      body: {
        entity: E, posting_date: x.date, description: x.description,
        idempotency_key: `e2e-${x.key}`, source: "agent",
        lines: x.lines, documents: [sha],
        ...(item && { matches: [{ id_hash: item.id_hash, dedup_key: item.dedup_key, line: bankLine }] }),
      },
    });
    const { nr, idempotent } = r.json as { nr: number; idempotent: boolean };
    check(r.json.year === YEAR, `voucher year: expected ${YEAR}, got ${r.json.year}`);
    facts.vouchers[x.key] = { nr, idempotent };
    let matched = "";
    if (item) {
      // a replay ignores the payload's matches: link explicitly (match_bank is idempotent)
      if (idempotent && opts.matchOnReplay !== false) {
        await h.ok("POST", "/bank/matches", { body: { id_hash: item.id_hash, dedup_key: item.dedup_key, entity: E, year: YEAR, nr } });
      }
      if (!idempotent || opts.matchOnReplay !== false) matched = `, matched bank ${item.dedup_key}`;
    }
    return `voucher ${YEAR}/${nr}${idempotent ? " (idempotent replay)" : ""}, document ${sha.slice(0, 12)}${matched}`;
  }

  // --- 1. the entity ----------------------------------------------------------
  await step(`bootstrap entity ${E}`, async () => {
    const r = await h.ok("POST", "/entities", {
      body: { orgnr: E, name: ENTITY_NAME, vat_registered: true, vat_term: "bimonthly", year: YEAR, company_profile: COMPANY_PROFILE },
    });
    check(r.json.entity === E && r.json.year === YEAR, `unexpected answer ${r.text}`);
    // stored on creation, or filled on a re-run of an entity that had none
    check(Bun.deepEquals(r.json.company_profile, COMPANY_PROFILE),
      `company profile: expected ${JSON.stringify(COMPANY_PROFILE)}, got ${JSON.stringify(r.json.company_profile)}`);
    await h.ok("PUT", "/parties", { body: { entity: E, id: "K1", name: "Kunde AS", customer: true } });
    return r.json.created ? `created, ${r.json.accounts_added} accounts` : "exists (re-run)";
  }, { critical: true });

  if (o.roToken) {
    await step("read-only token refuses writes", async () => {
      const r = await h.call("POST", "/vouchers", { body: { entity: E }, token: o.roToken });
      same(r.status, 403, "POST /vouchers with the read-only token");
    });
  }

  // --- 2. bank facts in -------------------------------------------------------
  const authorized = async () =>
    (await h.read(`/bank/connections?entity=${E}&status=authorized`)).json as { id: number; accounts: number }[];
  await step("bank connection", async () => {
    let conns = await authorized();
    if (conns.length === 0 && o.connectBank) {
      await o.connectBank(h);
      conns = await authorized();
      check(conns.length > 0, "connectBank ran but no authorized connection appeared");
      facts.bank = "matched";
      return `consent completed and backfilled: connection ${conns.map((c) => c.id).join(", ")}`;
    }
    if (conns.length === 0) {
      facts.bankSkipReason = `no authorized bank connection for ${E} on this deployment; bank facts only arrive through Enable Banking sync (no HTTP route inserts them), so the bank loop is skipped and the ledger loop runs on the recorded statement`;
      throw new Skip(facts.bankSkipReason);
    }
    facts.bank = "matched";
    return `authorized connection ${conns.map((c) => c.id).join(", ")}`;
  });
  const bank = facts.bank === "matched";

  await step("GET /bank/unmatched: the work queue", async () => {
    if (!bank) throw new Skip("bank loop skipped");
    const items = (await h.read(`/bank/unmatched?entity=${E}`)).json as QueueItem[];
    facts.queueBefore = items.length;
    const known = new Set(STATEMENT.transactions.map((t) => qkey(t.date, t.amount)));
    const unknown: string[] = [];
    for (const t of items) {
      const k = qkey(day(t.booking_date), Number(t.amount));
      if (!known.has(k)) unknown.push(`${t.dedup_key} ${k}`);
      else if (queue.has(k)) unknown.push(`${t.dedup_key} ${k} (two transactions on one key)`);
      else queue.set(k, { ...t, booking_date: day(t.booking_date), amount: Number(t.amount) });
    }
    check(unknown.length === 0, `the agent has no explanation for: ${unknown.join("; ")}`);
    return `${items.length} unexplained transaction(s)`;
  }, { critical: true });

  // --- 3. the agent explains them -----------------------------------------------
  for (const x of [opening, invoice, payment, rent, fee]) {
    await step(`explain: ${x.label}`, () => explain(x), { critical: true });
  }

  // --- 4. the correction path: unmatch, reverse, re-post ------------------------
  await step(`explain: ${telenorWrong.label}`, () => explain(telenorWrong, { matchOnReplay: false }), { critical: true });
  await step("correct it: unmatch, reverse, re-post on 6900", async () => {
    const wrong = facts.vouchers[telenorWrong.key]!;
    const item = queue.get(qkey(telenor.date, telenor.bank!.amount));
    let unmatched = 0;
    if (item) {
      const r = await h.ok("DELETE", "/bank/matches", {
        body: { id_hash: item.id_hash, dedup_key: item.dedup_key, entity: E, year: YEAR, nr: wrong.nr },
      });
      unmatched = r.json.deleted;
    }
    const rev = await h.ok("POST", `/vouchers/${YEAR}/${wrong.nr}/reverse`, {
      body: { entity: E, posting_date: REVERSAL_DATE, description: `Reversering av ${YEAR}/${wrong.nr}: feil konto` },
    });
    facts.vouchers.reversal = { nr: rev.json.nr, idempotent: rev.json.idempotent };
    const note = await storeDocument(correctionNote);
    await h.ok("POST", `/vouchers/${YEAR}/${rev.json.nr}/documents`, { body: { entity: E, sha256: note } });
    const j = (await h.read(`/journal?entity=${E}&year=${YEAR}&nr=${rev.json.nr}`)).json as { reverses_nr: number; amount: number; account: string }[];
    same(j.map((l) => [l.account, l.amount, l.reverses_nr]), telenorWrong.lines.map((l) => [l.account, -l.amount, wrong.nr]), "reversal lines");
    const repost = await explain(telenor);
    return `unmatched ${unmatched}, reversal ${YEAR}/${rev.json.nr}${rev.json.idempotent ? " (idempotent)" : ""}; ${repost}`;
  }, { critical: true });

  // --- 5. the books agree with the bank -----------------------------------------
  await step("GET /bank/unmatched is empty", async () => {
    if (!bank) throw new Skip("bank loop skipped");
    const items = (await h.read(`/bank/unmatched?entity=${E}`)).json as QueueItem[];
    same(items.map((t) => t.dedup_key), [], "unmatched bank transactions");
  });
  await step("GET /bank/reconciliation: difference 0", async () => {
    if (!bank) throw new Skip("bank loop skipped");
    const rows = (await h.read(`/bank/reconciliation?entity=${E}`)).json as
      { ledger_account: string; ledger_balance: number; bank_balance: number; difference: number; balance_type: string }[];
    check(rows.length === 1, `expected one bank-linked account, got ${rows.length}`);
    const r = rows[0]!;
    facts.reconciliation = { ledger: Number(r.ledger_balance), bank: Number(r.bank_balance), difference: Number(r.difference), balanceType: r.balance_type };
    same([r.ledger_account, r.balance_type, Number(r.difference)], ["1920", "CLBD", 0], "ledger account, balance type, difference");
    same(Number(r.ledger_balance), STATEMENT.closing, "ledger 1920");
    return `ledger 1920 ${r.ledger_balance} = CLBD ${r.bank_balance} øre`;
  });
  await step("ledger 1920 equals the statement's closing balance", async () => {
    const [b] = (await h.read(`/account-balance?entity=${E}&account=1920`)).json as { balance: number }[];
    facts.ledger1920 = Number(b?.balance);
    same(facts.ledger1920, STATEMENT.closing, "account_balance 1920");
    return `${facts.ledger1920} øre`;
  });
  await step("every voucher has its document", async () => {
    const missing = (await h.read(`/voucher-without-document?entity=${E}`)).json as { nr: number }[];
    same(missing.map((v) => v.nr), [], "vouchers without a document");
    const n = Object.keys(facts.vouchers).length;
    same(n, EXPECTED.vouchers, "vouchers posted by the flow");
  });

  // --- 6. VAT --------------------------------------------------------------------
  await step("GET /vat-summary", async () => {
    const rows = (await h.read(`/vat-summary?entity=${E}&year=${YEAR}`)).json as { period: number; vat_code: string; base: number; vat: number }[];
    const got = rows.map((r) => [r.period, r.vat_code, Number(r.base), Number(r.vat)] as const)
      .sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]));
    same(got, EXPECTED.vatSummary, "vat_summary [period, code, base, vat]");
    return EXPECTED.vatSummary.map(([p, c, , v]) => `p${p} code ${c}: ${v}`).join("; ");
  });
  await step("GET /vat-control: derived = booked", async () => {
    const rows = (await h.read(`/vat-control?entity=${E}&year=${YEAR}`)).json as { period: number; output_difference: number; input_difference: number }[];
    same(rows.map((r) => r.period).sort((a, b) => a - b), [8, 9, 10], "periods with VAT");
    for (const r of rows) same([Number(r.output_difference), Number(r.input_difference)], [0, 0], `period ${r.period} differences`);
  });
  for (const term of [4, 5]) {
    await step(`GET /mva-melding/${YEAR}/${term}`, async () => {
      const j = (await h.read(`/mva-melding/${YEAR}/${term}?entity=${E}&format=json`)).json as { total: number; lines: unknown[]; xml: string };
      facts.mva[term] = { total: j.total, lines: j.lines };
      same({ total: j.total, lines: j.lines }, EXPECTED.mva[term], `term ${term} melding`);
      const xml = (await h.read(`/mva-melding/${YEAR}/${term}?entity=${E}`)).text;
      check(xml.includes(`<fastsattMerverdiavgift>${j.total}</fastsattMerverdiavgift>`), "XML lacks the fastsattMerverdiavgift of the JSON form");
      let validated = "xmllint not available, XSD not checked";
      if (o.xmllint) {
        const err = await xsdErrors(o.xmllint, MVA_XSD, xml);
        check(err === null, `XSD: ${err}`);
        validated = "valid against the XSD";
      }
      return `fastsattMerverdiavgift ${j.total} kr, ${validated}`;
    });
  }

  // --- 7. SAF-T ----------------------------------------------------------------
  let saft = "";
  await step(`GET /saf-t (${YEAR})`, async () => {
    saft = (await h.read(`/saf-t?entity=${E}&year=${YEAR}`)).text;
    const m = /<NumberOfEntries>(\d+)<\/NumberOfEntries>/.exec(saft);
    facts.saftEntries = Number(m?.[1]);
    same(facts.saftEntries, EXPECTED.vouchers, "SAF-T NumberOfEntries");
    return `${facts.saftEntries} entries`;
  });
  await step(SAFT_XSD_STEP, async () => {
    if (!saft) throw new Skip("no SAF-T file to validate");
    if (!o.xmllint) throw new Skip("xmllint not available");
    const err = await xsdErrors(o.xmllint, SAFT_XSD, saft);
    facts.saftXsd = { valid: err === null };
    check(err === null, `XSD: ${err}`);
    return "valid as served";
  });

  return { ok: steps.every((s) => s.status === "pass" || s.status === "skip"), steps, facts };
}
