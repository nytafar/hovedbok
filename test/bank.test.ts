// Enable Banking end to end, offline: consent (replayed), backfill, re-sync of
// an overlapping window with zero duplicates, the pending snapshot, balance
// snapshots, the unmatched_bank / bank_reconciliation views, matching through
// match_bank, and the operational guards (unattended budget, 429 backoff,
// expired consent). Runs as a login role in hovedbok_app — the grants are
// part of what is under test.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { EnableBankingClient } from "../src/bank/client";
import {
  BACKOFF_SECONDS,
  MAX_UNATTENDED_PER_DAY,
  completeConsent,
  startConsent,
  syncConnection,
} from "../src/bank/sync";
import { replay, testKeyPem, type Replay, type Route } from "./bank_replay";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const E = "999888777";
const Y = 2026;
const UID = "07cc67f4-45d6-494b-adac-09b5cbc7e2b5";
const HASH = "WwpbCiJhY2NvdW50IiwKImFjY291bnRfaWQiLAoiaWJhbiIKXQpd.mockNO9386011117947hash=";
const TX = (k: { path: string }) => k.path === `/accounts/${UID}/transactions`;
const BAL = `/accounts/${UID}/balances`;
const pem = testKeyPem();
const agentRole = `hovedbok_bank_${process.pid}`;

let owner: SQL;
let app: SQL;
let connectionId: number;
let fetchedFrom: string | undefined;

function client(routes: Route[]): { client: EnableBankingClient; r: Replay } {
  const r = replay(routes);
  return { client: new EnableBankingClient({ appId: "app-1", privateKeyPem: pem, fetch: r.fetch }), r };
}

const psu = { ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0 (X11; Linux)" };
const today = () => "2026-10-10";
const T0 = new Date("2026-10-10T08:00:00Z");
const at = (hours: number) => () => new Date(T0.getTime() + hours * 3600_000);

async function postVoucher(key: string, date: string, bankOre: number, contra: string, description: string) {
  const [row] = await app`select post_voucher(${{
    entity: E,
    posting_date: date,
    description,
    idempotency_key: key,
    lines: [
      { account: "1920", amount: bankOre },
      { account: contra, amount: -bankOre },
    ],
  }}::jsonb) as r`;
  return row.r as { entity: string; year: number; nr: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** Awaits a statement that must fail with a Postgres error; returns the error. */
async function pgError(p: Promise<unknown>): Promise<{ message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { message: string };
  }
  throw new Error("expected a database error, but the statement succeeded");
}

const matches = async () => {
  const [{ n }] = await app`select count(*)::int as n from match`;
  return n as number;
};

const counts = async () => {
  const [c] = await app`
    select (select count(*)::int from bank_transaction) as booked,
           (select count(*)::int from bank_transaction_pending) as pending,
           (select count(*)::int from bank_balance) as balances,
           (select count(*)::int from unmatched_bank where entity = ${E}) as unmatched,
           (select count(*)::int from bank_fetch) as fetches`;
  return c as { booked: number; pending: number; balances: number; unmatched: number; fetches: number };
};

beforeAll(async () => {
  owner = await freshDb();
  await owner`select bootstrap_entity(${{ orgnr: E, name: "Test AS", year: Y }}::jsonb)`;
  await owner.unsafe(`create role "${agentRole}" login password 'agent' in role hovedbok_app`);
  const u = new URL(databaseUrl);
  u.username = agentRole;
  u.password = "agent";
  u.pathname = `/${testDbName}`;
  app = new SQL(u.toString());
});
afterAll(async () => {
  await app?.end();
  await owner.unsafe(`drop role if exists "${agentRole}"`).catch(() => {});
  await dropTestDb();
});

describe("consent and backfill", () => {
  test("startConsent: pending connection + the bank's redirect url, state round-trips", async () => {
    const { client: c, r } = client([{ method: "POST", path: "/auth", reply: "auth" }]);
    const res = await startConsent(app, c, {
      entity: E,
      aspsp: { name: "Mock ASPSP", country: "NO" },
      redirectUrl: "https://hovedbok.example/bank/callback",
      validUntil: new Date("2027-04-07T00:00:00Z"),
    });
    connectionId = res.connectionId;
    expect(res.url).toMatch(/^https:\/\/auth\.enablebanking\.com\//);
    expect(r.calls[0]!.body).toMatchObject({ state: res.state, aspsp: { name: "Mock ASPSP", country: "NO" } });
    const [conn] = await app`select status, auth_state from bank_connection where id = ${connectionId}`;
    expect(conn).toEqual({ status: "pending", auth_state: res.state });
  });

  test("completeConsent: session + accounts recorded, backfill attended with the longest history", async () => {
    const [{ auth_state }] = await app`select auth_state from bank_connection where id = ${connectionId}`;
    const { client: c, r } = client([
      { method: "POST", path: "/sessions", reply: "session" },
      { method: "GET", path: (k) => TX(k) && !k.query.continuation_key, reply: "backfill-1" },
      { method: "GET", path: (k) => TX(k) && k.query.continuation_key === "page-2", reply: "backfill-2" },
      { method: "GET", path: BAL, reply: "balances-1" },
    ]);
    const res = await completeConsent(app, c, {
      state: auth_state,
      code: "code-xyz",
      ledgerAccount: (acc) => (acc.currency === "NOK" ? "1920" : undefined),
      psu,
      today,
      now: at(0),
    });
    expect(res.sessionId).toBe("5b1d3a7e-2f4c-4a8e-9c1d-0e6f7a8b9c0d");
    expect(res.accounts).toEqual([
      { idHash: HASH, uid: UID, ledgerAccount: "1920", iban: "NO9386011117947", bban: "86011117947" },
    ]);
    expect(res.backfill?.outcome).toBe("ok");
    expect(res.backfill?.attended).toBe(true);
    expect(res.backfill?.accounts[0]).toMatchObject({ seen: 4, inserted: 4, conflicts: 0, pending: 0, balances: 2, pages: 2 });

    // the bank-side reads were attended (PSU headers) and asked for the longest history
    const reads = r.accountCalls();
    expect(reads).toHaveLength(3);
    expect(reads.every((k) => k.headers["psu-ip-address"] === psu.ipAddress)).toBe(true);
    expect(reads[0]!.query).toEqual({ strategy: "longest" });

    const [conn] = await app`
      select status, session_id, valid_until, auth_state, last_synced_at, aspsp_name
        from bank_connection where id = ${connectionId}`;
    expect(conn).toMatchObject({ status: "authorized", session_id: res.sessionId, auth_state: null, aspsp_name: "Mock ASPSP" });
    expect(conn.valid_until).toEqual(new Date("2027-04-07T00:00:00Z"));
    expect(conn.last_synced_at).toBeInstanceOf(Date);
    fetchedFrom = conn.last_synced_at.toISOString().slice(0, 10);

    const [acc] = await app`select * from bank_account where id_hash = ${HASH}`;
    expect(Number(acc.connection_id)).toBe(connectionId);
    expect(acc).toMatchObject({ entity: E, uid: UID, iban: "NO9386011117947", bban: "86011117947", currency: "NOK", ledger_account: "1920" });
    expect(acc.raw.identification_hashes).toHaveLength(2);
    expect(await counts()).toEqual({ booked: 4, pending: 0, balances: 2, unmatched: 4, fetches: 1 });
    const [f] = await app`select attended, outcome from bank_fetch`;
    expect(f).toEqual({ attended: true, outcome: "ok" });
  });

  test("facts: signed øre, dedup keys, KID, counterparty, raw kept", async () => {
    const rows = await app`
      select dedup_key, booking_date, amount, counterparty, reference, reference_schema, remittance, raw
        from bank_transaction order by booking_date` as Row[];
    expect(rows.map((r) => [r.dedup_key.startsWith("fp:") ? "fp" : r.dedup_key, Number(r.amount)])).toEqual([
      ["2026090100001", 1250000],
      ["2026090300002", -499000],
      ["fp", -7500],
      ["2026100200004", -125050],
    ]);
    expect(rows[0]).toMatchObject({ counterparty: "Kunde AS", reference: "0012345678906", reference_schema: "NORF", remittance: "KID 0012345678906" });
    expect(rows[1]!.counterparty).toBe("Leverandør AS");
    expect(rows[2]!.raw.transaction_id).toBe("tx-a3");
    expect(rows[3]!.remittance).toBeNull();
    const bal = await app`select balance_type, amount, reference_date from bank_balance order by balance_type` as Row[];
    expect(bal.map((b) => [b.balance_type, Number(b.amount)])).toEqual([["CLBD", 5618450], ["XPCD", 5618450]]);
  });
});

describe("views and matching", () => {
  const vouchers: Record<string, { entity: string; year: number; nr: number }> = {};

  test("bank_reconciliation: ledger vs the latest CLBD", async () => {
    const [before] = await app`select * from bank_reconciliation where id_hash = ${HASH}`;
    expect(before).toMatchObject({ entity: E, ledger_account: "1920", balance_type: "CLBD" });
    expect([Number(before.ledger_balance), Number(before.bank_balance), Number(before.difference)]).toEqual([0, 5618450, -5618450]);

    vouchers.opening = await postVoucher("ib", "2026-01-01", 5000000, "2050", "Inngående balanse bank");
    vouchers.sale = await postVoucher("sale", "2026-09-01", 1250000, "3000", "Kunde AS, KID 0012345678906");
    vouchers.supplier = await postVoucher("supplier", "2026-09-03", -499000, "4300", "Leverandør AS faktura 1042");
    vouchers.fee = await postVoucher("fee", "2026-09-30", -7500, "7770", "Gebyr nettbank");
    vouchers.telenor = await postVoucher("telenor", "2026-10-02", -125050, "6900", "Telenor");
    const [after] = await app`select ledger_balance, difference from bank_reconciliation where id_hash = ${HASH}`;
    expect([Number(after.ledger_balance), Number(after.difference)]).toEqual([5618450, 0]);
  });

  test("match_bank links each fact to the voucher's 1920 line and empties the queue", async () => {
    const queue = await app`select dedup_key, amount from unmatched_bank where entity = ${E} order by booking_date` as Row[];
    expect(queue).toHaveLength(4);
    const byKey = Object.fromEntries(queue.map((q) => [q.dedup_key.startsWith("fp:") ? "fp" : q.dedup_key, q.dedup_key]));
    const link = async (key: string, v: { year: number; nr: number }) => {
      const [row] = await app`select match_bank(${{ id_hash: HASH, dedup_key: key, entity: E, year: v.year, nr: v.nr }}::jsonb) as r`;
      return row.r as { line: number; created: boolean };
    };
    expect(await link(byKey["2026090100001"]!, vouchers.sale!)).toMatchObject({ line: 1, created: true });
    expect(await link(byKey["2026090300002"]!, vouchers.supplier!)).toMatchObject({ created: true });
    expect(await link(byKey.fp!, vouchers.fee!)).toMatchObject({ created: true });
    expect(await link(byKey["2026100200004"]!, vouchers.telenor!)).toMatchObject({ created: true });
    expect((await counts()).unmatched).toBe(0);
    // idempotent
    expect(await link(byKey.fp!, vouchers.fee!)).toMatchObject({ created: false });
    expect(await matches()).toBe(4);
  });

  test("a match must hit the bank's ledger account: command and direct insert both refuse", async () => {
    const [{ dedup_key }] = await app`select dedup_key from bank_transaction where dedup_key = '2026090100001'`;
    const v = vouchers.sale!;
    const viaCommand = await pgError(
      app`select match_bank(${{ id_hash: HASH, dedup_key, entity: E, year: v.year, nr: v.nr, line: 2 }}::jsonb)`,
    );
    expect(viaCommand.message).toMatch(/must link the line on ledger account 1920/);
    const direct = await pgError(
      app`insert into match (id_hash, dedup_key, entity, year, nr, line) values (${HASH}, ${dedup_key}, ${E}, ${v.year}, ${v.nr}, 2)`,
    );
    expect(direct.message).toMatch(/must link the line on ledger account 1920/);
    const missing = await pgError(
      app`select match_bank(${{ id_hash: HASH, dedup_key: "nope", entity: E, year: v.year, nr: v.nr }}::jsonb)`,
    );
    expect(missing.message).toMatch(/bank transaction .* does not exist/);
    const wrongEntity = await pgError(
      app`select match_bank(${{ id_hash: HASH, dedup_key, entity: "111111111", year: v.year, nr: v.nr }}::jsonb)`,
    );
    expect(wrongEntity.message).toMatch(/does not belong to entity/);
  });

  test("unmatch_bank puts the fact back in the queue", async () => {
    const v = vouchers.fee!;
    const [{ dedup_key }] = await app`select dedup_key from bank_transaction where dedup_key like 'fp:%'`;
    const [u] = await app`select unmatch_bank(${{ id_hash: HASH, dedup_key, entity: E, year: v.year, nr: v.nr }}::jsonb) as r`;
    expect(u.r).toEqual({ deleted: 1 });
    expect((await counts()).unmatched).toBe(1);
    await app`select match_bank(${{ id_hash: HASH, dedup_key, entity: E, year: v.year, nr: v.nr }}::jsonb)`;
    expect((await counts()).unmatched).toBe(0);
  });
});

describe("re-sync", () => {
  test("an overlapping window inserts only the new booking; pending replaces; balances append", async () => {
    const { client: c, r } = client([
      { method: "GET", path: TX, reply: "resync" },
      { method: "GET", path: BAL, reply: "balances-2" },
    ]);
    const res = await syncConnection(app, c, connectionId, { today, now: at(1) });
    expect(res.outcome).toBe("ok");
    expect(res.attended).toBe(false);
    expect(res.accounts[0]).toMatchObject({ seen: 4, inserted: 1, conflicts: 0, pending: 1, ignored: 0, balances: 2 });
    // unattended: no PSU headers; window reaches OVERLAP_DAYS back from the last sync
    const tx = r.accountCalls()[0]!;
    expect(Object.keys(tx.headers).some((h) => h.startsWith("psu-"))).toBe(false);
    expect(tx.query).toEqual({ date_from: "2026-10-03", date_to: "2026-10-10" });
    expect(fetchedFrom).toBe("2026-10-10");

    expect(await counts()).toEqual({ booked: 5, pending: 1, balances: 4, unmatched: 1, fetches: 2 });
    const [p] = await app`select seq, raw from bank_transaction_pending`;
    expect(p.seq).toBe(1);
    expect(p.raw.status).toBe("PDNG");
    const [rec] = await app`select bank_balance, difference, reference_date from bank_reconciliation where id_hash = ${HASH}`;
    expect([Number(rec.bank_balance), Number(rec.difference)]).toEqual([6418450, -800000]);

    const v = await postVoucher("sale2", "2026-10-09", 800000, "3000", "Kunde AS faktura 2026-17");
    await app`select match_bank(${{ id_hash: HASH, dedup_key: "2026100900005", entity: E, year: v.year, nr: v.nr }}::jsonb)`;
    const [rec2] = await app`select difference from bank_reconciliation where id_hash = ${HASH}`;
    expect(Number(rec2.difference)).toBe(0);
    expect((await counts()).unmatched).toBe(0);
  });

  test("the same window again: zero duplicates, snapshot rewritten, nothing unmatched", async () => {
    const { client: c } = client([
      { method: "GET", path: TX, reply: "resync" },
      { method: "GET", path: BAL, reply: "balances-2" },
    ]);
    const res = await syncConnection(app, c, connectionId, { today, now: at(2) });
    expect(res.accounts[0]).toMatchObject({ seen: 4, inserted: 0, conflicts: 0, pending: 1 });
    expect(await counts()).toEqual({ booked: 5, pending: 1, balances: 6, unmatched: 0, fetches: 3 });
  });

  test("a reused entry_reference with a different amount is counted as a conflict, not stored", async () => {
    const page = (await Bun.file(`${import.meta.dir}/fixtures/enable-banking/resync.json`).json()) as { transactions: Record<string, unknown>[] };
    const bad = { ...page.transactions[3]!, transaction_amount: { currency: "NOK", amount: "8001.00" } };
    const { client: c } = client([
      { method: "GET", path: TX, reply: { body: { transactions: [bad], continuation_key: null } } },
      { method: "GET", path: BAL, reply: { body: { balances: [] } } },
    ]);
    const warnings: string[] = [];
    const res = await syncConnection(app, c, connectionId, { today, now: at(3), onWarning: (m) => warnings.push(m) });
    expect(res.accounts[0]).toMatchObject({ seen: 1, inserted: 0, conflicts: 1 });
    expect(warnings[0]).toMatch(/2026100900005 seen with amount 800100, stored 800000/);
    expect((await counts()).booked).toBe(5);
  });
});

describe("operational guards", () => {
  test(`the ${MAX_UNATTENDED_PER_DAY}th unattended fetch in 24 h goes through, the next is deferred without a call`, async () => {
    const { client: c, r } = client([
      { method: "GET", path: TX, reply: "resync" },
      { method: "GET", path: BAL, reply: "balances-2" },
    ]);
    // three unattended ok runs so far (hours 1, 2, 3)
    const fourth = await syncConnection(app, c, connectionId, { today, now: at(4) });
    expect(fourth.outcome).toBe("ok");
    const callsAfterFourth = r.calls.length;
    const fifth = await syncConnection(app, c, connectionId, { today, now: at(5) });
    expect(fifth.outcome).toBe("deferred");
    expect(fifth.detail).toMatch(/budget/);
    expect(fifth.resumeAt).toEqual(at(25)());
    expect(r.calls.length).toBe(callsAfterFourth);
    // an attended run is not budgeted
    const attended = await syncConnection(app, c, connectionId, { today, now: at(5), psu });
    expect(attended.outcome).toBe("ok");
    expect(attended.attended).toBe(true);
    // an operator override runs regardless
    expect((await syncConnection(app, c, connectionId, { today, now: at(5), force: true })).outcome).toBe("ok");
    // the window slides: by hour 28 only the forced run (hour 5) is inside it
    expect((await syncConnection(app, c, connectionId, { today, now: at(28) })).outcome).toBe("ok");
    const log = await app`select attended, outcome from bank_fetch order by id` as Row[];
    expect(log.slice(-5).map((l) => `${l.attended ? "A" : "U"}:${l.outcome}`)).toEqual([
      "U:ok", "U:deferred", "A:ok", "U:ok", "U:ok",
    ]);
  });

  test("429 → 6 h backoff (or Retry-After if longer); attended runs still try the bank", async () => {
    const limited = client([
      { method: "GET", path: TX, reply: { status: 429, body: await Bun.file(`${import.meta.dir}/fixtures/enable-banking/rate-limited.json`).json() } },
    ]);
    const ok = client([
      { method: "GET", path: TX, reply: "resync" },
      { method: "GET", path: BAL, reply: "balances-2" },
    ]);
    const now = at(50);
    const res = await syncConnection(app, limited.client, connectionId, { today, now });
    expect(res.outcome).toBe("rate_limited");
    expect(res.detail).toMatch(/ASPSP_RATE_LIMIT_EXCEEDED/);
    expect(res.resumeAt).toEqual(new Date(now().getTime() + BACKOFF_SECONDS * 1000));
    const [conn] = await app`select backoff_until from bank_connection where id = ${connectionId}`;
    expect(conn.backoff_until).toEqual(res.resumeAt);

    const deferred = await syncConnection(app, ok.client, connectionId, { today, now: at(55) });
    expect(deferred.outcome).toBe("deferred");
    expect(deferred.detail).toMatch(/backoff/);
    expect(ok.r.calls).toHaveLength(0);

    const attended = await syncConnection(app, ok.client, connectionId, { today, now: at(55), psu });
    expect(attended.outcome).toBe("ok");
    const [cleared] = await app`select backoff_until from bank_connection where id = ${connectionId}`;
    expect(cleared.backoff_until).toBeNull();

    // a longer Retry-After wins over the 6 h floor
    const longer = client([
      { method: "GET", path: TX, reply: { status: 429, body: { message: "limit", error: "ASPSP_RATE_LIMIT_EXCEEDED" }, headers: { "retry-after": "36000" } } },
    ]);
    const res2 = await syncConnection(app, longer.client, connectionId, { today, now: at(80) });
    expect(res2.resumeAt).toEqual(new Date(at(90)().getTime()));
    expect((await syncConnection(app, ok.client, connectionId, { today, now: at(89) })).outcome).toBe("deferred");
    expect((await syncConnection(app, ok.client, connectionId, { today, now: at(91) })).outcome).toBe("ok");
  });

  test("an expired session marks the connection; later runs do not call the bank", async () => {
    const gone = client([
      { method: "GET", path: TX, reply: { status: 410, body: { message: "Session expired", error: "SESSION_EXPIRED" } } },
    ]);
    const res = await syncConnection(app, gone.client, connectionId, { today, now: at(120) });
    expect(res.outcome).toBe("expired");
    const [conn] = await app`select status from bank_connection where id = ${connectionId}`;
    expect(conn.status).toBe("expired");
    const again = await syncConnection(app, gone.client, connectionId, { today, now: at(121) });
    expect(again.outcome).toBe("expired");
    expect(gone.r.calls).toHaveLength(1);
  });

  test("re-consent: same identification_hash keeps the account and its facts, refreshes uid and connection", async () => {
    const { client: c } = client([
      { method: "POST", path: "/auth", reply: "auth" },
      { method: "POST", path: "/sessions", reply: { body: { ...(await Bun.file(`${import.meta.dir}/fixtures/enable-banking/session.json`).json()), session_id: "new-session", accounts: [{ ...((await Bun.file(`${import.meta.dir}/fixtures/enable-banking/session.json`).json()) as { accounts: Record<string, unknown>[] }).accounts[0], uid: "new-uid" }] } } },
    ]);
    const start = await startConsent(app, c, { entity: E, aspsp: { name: "Mock ASPSP" }, redirectUrl: "https://hovedbok.example/cb" });
    const done = await completeConsent(app, c, { state: start.state, code: "c2", ledgerAccount: () => "1930", noBackfill: true });
    expect(done.backfill).toBeNull();
    const [acc] = await app`select connection_id, uid, ledger_account from bank_account where id_hash = ${HASH}`;
    expect({ ...acc, connection_id: Number(acc.connection_id) }).toEqual({ connection_id: start.connectionId, uid: "new-uid", ledger_account: "1920" });
    expect((await counts()).booked).toBe(5);
    expect(await matches()).toBe(5);
  });
});
