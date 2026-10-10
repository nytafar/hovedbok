// E2E (#13), CI driver: the agent bookkeeping loop (test/e2e_flow.ts) on a
// fresh database behind a real listener, under login roles in hovedbok_app /
// hovedbok_ro as deploy sets them up, with Enable Banking replayed from the
// recorded fixtures. scripts/e2e.ts drives the same flow against a live
// deployment.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api/app";
import { EnableBankingClient } from "../src/bank/client";
import { replay, testKeyPem, type Replay } from "./bank_replay";
import { EXPECTED, SAFT_XSD_STEP, STATEMENT, formatReport, runFlow, type FlowReport, type Http } from "./e2e_flow";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const BANKED = "999900001";
const LEDGER_ONLY = "999900002";
const RW_TOKEN = "rw-token-for-e2e";
const RO_TOKEN = "ro-token-for-e2e";
const rwRole = `hovedbok_e2e_rw_${process.pid}`;
const roRole = `hovedbok_e2e_ro_${process.pid}`;
const UID = "07cc67f4-45d6-494b-adac-09b5cbc7e2b5";
const REDIRECT = "https://hovedbok.example/bank/consent-callback";
const xmllint = Bun.which("xmllint");

let admin: SQL;
let rw: SQL;
let ro: SQL;
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let bank: Replay = replay([]);
let consents = 0;

function loginUrl(role: string): string {
  const u = new URL(databaseUrl);
  u.username = role;
  u.password = "pw";
  u.pathname = `/${testDbName}`;
  return u.toString();
}

beforeAll(async () => {
  admin = await freshDb();
  for (const r of [rwRole, roRole]) await admin.unsafe(`drop role if exists "${r}"`);
  await admin.unsafe(`create role "${rwRole}" login password 'pw' in role hovedbok_app`);
  await admin.unsafe(`create role "${roRole}" login password 'pw' in role hovedbok_ro`);
  rw = new SQL(loginUrl(rwRole), { max: 2 });
  ro = new SQL(loginUrl(roRole), { max: 2 });
  dir = await mkdtemp(join(tmpdir(), "hovedbok-e2e-docs-"));
  const pem = testKeyPem();
  const api = createApi({
    rw, ro, rwToken: RW_TOKEN, roToken: RO_TOKEN, documentsDir: dir,
    bank: {
      env: { ENABLE_BANKING_REDIRECT_URL: REDIRECT },
      client: () => new EnableBankingClient({ appId: "app-1", privateKeyPem: pem, fetch: ((...a) => bank.fetch(...a)) as typeof fetch }),
    },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: api.fetch });
});

afterAll(async () => {
  server?.stop(true);
  await rw?.end();
  await ro?.end();
  for (const r of [rwRole, roRole]) await admin?.unsafe(`drop role if exists "${r}"`);
  if (dir) await rm(dir, { recursive: true, force: true });
  await dropTestDb();
});

/** The consent the owner would click through, against the replayed bank: start, callback, backfill. */
async function connectBank(h: Http): Promise<void> {
  consents++;
  bank = replay([{ method: "POST", path: "/auth", reply: "auth" }]);
  const start = await h.ok("POST", "/bank/consents", { body: { entity: BANKED, aspsp: { name: "Mock ASPSP", country: "NO" } } });
  const TX = (k: { path: string }) => k.path === `/accounts/${UID}/transactions`;
  bank = replay([
    { method: "POST", path: "/sessions", reply: "session" },
    { method: "GET", path: (k) => TX(k) && !k.query.continuation_key, reply: "backfill-1" },
    { method: "GET", path: (k) => TX(k) && k.query.continuation_key === "page-2", reply: "backfill-2" },
    { method: "GET", path: `/accounts/${UID}/balances`, reply: "balances-1" },
  ]);
  const cb = await h.ok("GET", `/bank/consent-callback?code=code-e2e&state=${encodeURIComponent(start.json.state)}`, { token: null });
  if (!cb.text.includes("Backfill: ok, 4 new transaction(s)")) throw new Error(`backfill: ${cb.text}`);
}

const run = (entity: string, withBank: boolean) =>
  runFlow({
    baseUrl: server.url, token: RW_TOKEN, roToken: RO_TOKEN, entity, xmllint,
    connectBank: withBank ? connectBank : undefined,
  });

/** Every step passed or (bank-less) skipped; with xmllint, the SAF-T file validates as served. */
function expectGreen(r: FlowReport): void {
  const bad = r.steps.filter((s) => s.status !== "pass" && s.status !== "skip");
  // the whole report on failure: which step, and what it saw
  expect({ bad: bad.map((s) => s.name), report: bad.length ? formatReport(r) : "" }).toEqual({ bad: [], report: "" });
  expect(r.ok).toBe(true);
  if (xmllint) {
    expect(r.facts.saftXsd).toEqual({ valid: true });
    expect(r.steps.find((s) => s.name === SAFT_XSD_STEP)).toMatchObject({ status: "pass", detail: "valid as served" });
  }
}

const VOUCHERS = {
  opening: 1, "invoice-k1": 2, "payment-k1": 3, "rent-1042": 4, "fee-2026-09": 5,
  "telenor-2026-10": 6, reversal: 7, "telenor-2026-10-corrected": 8,
};

describe("the agent bookkeeping loop, bank facts in", () => {
  test("consent + backfill -> queue -> vouchers with documents and matches -> reconciled, VAT, MVA-melding, SAF-T", async () => {
    const r = await run(BANKED, true);
    expectGreen(r);
    expect(r.steps.map((s) => s.status)).not.toContain("skip");
    expect(consents).toBe(1);
    expect(r.facts.bank).toBe("matched");
    expect(r.facts.queueBefore).toBe(STATEMENT.transactions.length);
    expect(Object.fromEntries(Object.entries(r.facts.vouchers).map(([k, v]) => [k, v.nr]))).toEqual(VOUCHERS);
    expect(Object.values(r.facts.vouchers).every((v) => !v.idempotent)).toBe(true);
    expect(r.facts.reconciliation).toEqual({ ledger: 5_618_450, bank: 5_618_450, difference: 0, balanceType: "CLBD" });
    expect(r.facts.mva).toEqual({
      4: { total: 2500, lines: [{ code: "3", base: 10000, rate: "25", vat: 2500 }] },
      5: { total: -1248, lines: [{ code: "1", vat: -1248 }] },
    });
    expect(r.facts.saftEntries).toBe(8);
    if (xmllint) {
      for (const name of ["GET /mva-melding/2026/4", "GET /mva-melding/2026/5"]) {
        expect(r.steps.find((s) => s.name === name)?.detail).toContain("valid against the");
      }
    }

    // the match moved off the wrong voucher: the correct one carries it
    const matches = await admin`
      select nr, line, dedup_key from match where entity = ${BANKED} order by nr`;
    expect(matches.map((m: { nr: number; dedup_key: string }) => [m.nr, m.dedup_key])).toEqual([
      [3, "2026090100001"], [4, "2026090300002"], [5, expect.stringMatching(/^fp:/)], [8, "2026100200004"],
    ]);
  });

  test("a re-run is idempotent: same vouchers, no new consent, same figures", async () => {
    const r = await run(BANKED, true);
    expectGreen(r);
    expect(consents).toBe(1);
    expect(r.facts.queueBefore).toBe(0);
    expect(Object.fromEntries(Object.entries(r.facts.vouchers).map(([k, v]) => [k, v.nr]))).toEqual(VOUCHERS);
    expect(Object.values(r.facts.vouchers).every((v) => v.idempotent)).toBe(true);
    const [n] = await admin`select count(*)::int as n from voucher where entity = ${BANKED}`;
    expect(n.n).toBe(EXPECTED.vouchers);
  });
});

describe("live-mode degradation: no bank connection", () => {
  test("the bank steps are SKIPPED with the reason; the ledger loop runs and passes", async () => {
    const r = await run(LEDGER_ONLY, false);
    expectGreen(r);
    expect(r.facts.bank).toBe("skipped");
    expect(r.facts.bankSkipReason).toContain("no authorized bank connection");
    expect(r.steps.filter((s) => s.status === "skip").map((s) => s.name)).toEqual([
      "bank connection", "GET /bank/unmatched: the work queue", "GET /bank/unmatched is empty", "GET /bank/reconciliation: difference 0",
    ]);
    expect(r.facts.ledger1920).toBe(STATEMENT.closing);
    expect(r.facts.saftEntries).toBe(8);
    const report = formatReport(r);
    expect(report).toContain("SKIP  bank connection");
    expect(report).toMatch(/^OK: \d+ passed, 0 failed, 4 skipped, 0 not run$/m);
  });

  test("a failing step is reported, and halts what depends on it", async () => {
    const r = await runFlow({ baseUrl: server.url, token: "wrong-token", entity: LEDGER_ONLY });
    expect(r.ok).toBe(false);
    expect(r.steps[0]).toMatchObject({ name: `bootstrap entity ${LEDGER_ONLY}`, status: "fail" });
    expect(r.steps[0]!.detail).toStartWith("POST /entities -> 401");
    expect(r.steps.slice(1).every((s) => s.status === "not run")).toBe(true);
  });
});
