// HTTP API (#11) × Enable Banking (#10): the consent flow, sync and matching
// over a real listener, with the client replaying recorded responses
// (test/bank_replay.ts) through createApi's injectable `bank.client`. Login
// roles in hovedbok_app / hovedbok_ro as deploy sets them up. Then the API
// without Enable Banking env: it serves, and the bank routes name what is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createApi } from "../src/api/app";
import { EnableBankingClient } from "../src/bank/client";
import { replay, testKeyPem, type Replay, type Route } from "./bank_replay";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const E = "999888777";
const Y = 2026;
const RW_TOKEN = "rw-token-for-bank-tests";
const RO_TOKEN = "ro-token-for-bank-tests";
const rwRole = `hovedbok_apibank_rw_${process.pid}`;
const roRole = `hovedbok_apibank_ro_${process.pid}`;
const UID = "07cc67f4-45d6-494b-adac-09b5cbc7e2b5";
const HASH = "WwpbCiJhY2NvdW50IiwKImFjY291bnRfaWQiLAoiaWJhbiIKXQpd.mockNO9386011117947hash=";
const REDIRECT = "https://hovedbok.example/bank/consent-callback";

const TX = (k: { path: string }) => k.path === `/accounts/${UID}/transactions`;
const BAL = (k: { path: string }) => k.path === `/accounts/${UID}/balances`;
const RESYNC: Route[] = [
  { method: "GET", path: TX, reply: "resync" },
  { method: "GET", path: BAL, reply: "balances-2" },
];

let admin: SQL;
let rw: SQL;
let ro: SQL;
let api: ReturnType<typeof createApi>;
let server: ReturnType<typeof Bun.serve>;
let bank: Replay = replay([]);
const bankEnv: Record<string, string | undefined> = { ENABLE_BANKING_REDIRECT_URL: REDIRECT };
let clientBuilds = 0;

function loginUrl(role: string): string {
  const u = new URL(databaseUrl);
  u.username = role;
  u.password = "pw";
  u.pathname = `/${testDbName}`;
  return u.toString();
}

beforeAll(async () => {
  admin = await freshDb();
  await admin`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: Y }}::jsonb)`;
  for (const r of [rwRole, roRole]) await admin.unsafe(`drop role if exists "${r}"`);
  await admin.unsafe(`create role "${rwRole}" login password 'pw' in role hovedbok_app`);
  await admin.unsafe(`create role "${roRole}" login password 'pw' in role hovedbok_ro`);
  rw = new SQL(loginUrl(rwRole), { max: 2 });
  ro = new SQL(loginUrl(roRole), { max: 2 });
  const pem = testKeyPem();
  api = createApi({
    rw, ro, rwToken: RW_TOKEN, roToken: RO_TOKEN,
    bank: {
      env: bankEnv,
      client: () => {
        clientBuilds++;
        return new EnableBankingClient({ appId: "app-1", privateKeyPem: pem, fetch: ((...a) => bank.fetch(...a)) as typeof fetch });
      },
    },
  });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: api.fetch });
});

afterAll(async () => {
  server?.stop(true);
  await rw?.end();
  await ro?.end();
  for (const r of [rwRole, roRole]) await admin?.unsafe(`drop role if exists "${r}"`);
  await dropTestDb();
});

interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string | null } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  const token = opts.token === undefined ? RW_TOKEN : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(new URL(path, server.url), { method, headers, body });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

const get = (path: string, token?: string | null) => call("GET", path, { token });
const post = (path: string, body: unknown, token?: string | null) => call("POST", path, { body, token });

let connectionId: number;
let state: string;

// ---------------------------------------------------------------------------
describe("consent over HTTP", () => {
  test("POST /bank/consents: a pending connection and the bank's URL; rw token only", async () => {
    bank = replay([{ method: "POST", path: "/auth", reply: "auth" }]);
    const denied = await post("/bank/consents", { entity: E, aspsp: { name: "Mock ASPSP" } }, RO_TOKEN);
    expect(denied.status).toBe(403);
    const bad = await post("/bank/consents", { entity: E, aspsp: "Mock ASPSP" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("field aspsp must be an object {name, country?}");
    expect(bank.calls).toHaveLength(0);

    const r = await post("/bank/consents", { entity: E, aspsp: { name: "Mock ASPSP", country: "NO" }, valid_until: "2027-04-07T00:00:00Z" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ connectionId: expect.any(Number), state: expect.any(String), url: expect.stringMatching(/^https:\/\/auth\.enablebanking\.com\//) });
    connectionId = r.json.connectionId;
    state = r.json.state;
    // the server's redirect URL and the state went to the bank
    expect(bank.calls[0]!.body).toMatchObject({ state, redirect_url: REDIRECT, aspsp: { name: "Mock ASPSP", country: "NO" } });

    const conns = await get(`/bank/connections?entity=${E}`, RO_TOKEN);
    expect(conns.status).toBe(200);
    expect(conns.json).toEqual([expect.objectContaining({ id: connectionId, status: "pending", accounts: 0, unattended_24h: 0, unattended_left: 4 })]);
    // the CSRF state and session handle are not status
    expect(Object.keys(conns.json[0])).not.toContain("auth_state");
    expect(Object.keys(conns.json[0])).not.toContain("session_id");
  });

  test("callback refusals: plain text for the browser, no token needed", async () => {
    bank = replay([]);
    const cancelled = await get("/bank/consent-callback?error=access_denied&error_description=user+cancelled&state=x", null);
    expect(cancelled.status).toBe(400);
    expect(cancelled.headers.get("content-type")).toStartWith("text/plain");
    expect(cancelled.text).toBe("Bank consent failed: the bank reported access_denied (user cancelled); start the consent again\n");
    const empty = await get("/bank/consent-callback", null);
    expect(empty.status).toBe(400);
    const forged = await get("/bank/consent-callback?code=c&state=forged", null);
    expect(forged.status).toBe(422);
    expect(forged.text).toBe('Bank consent failed: no pending bank_connection for state "forged"\n');
    expect(bank.calls).toHaveLength(0);
  });

  test("GET /bank/consent-callback completes the consent and backfills", async () => {
    bank = replay([
      { method: "POST", path: "/sessions", reply: "session" },
      { method: "GET", path: (k) => TX(k) && !k.query.continuation_key, reply: "backfill-1" },
      { method: "GET", path: (k) => TX(k) && k.query.continuation_key === "page-2", reply: "backfill-2" },
      { method: "GET", path: BAL, reply: "balances-1" },
    ]);
    const r = await get(`/bank/consent-callback?code=code-xyz&state=${encodeURIComponent(state)}`, null);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(r.text).toContain(`Bank connection ${connectionId} authorized, valid until 2027-04-07T00:00:00Z.`);
    expect(r.text).toContain("Account NO9386011117947 -> 1920");
    expect(r.text).toContain("Backfill: ok, 4 new transaction(s)");
    expect(bank.calls[0]).toMatchObject({ method: "POST", path: "/sessions", body: { code: "code-xyz" } });
    // no PSU_IP_ADDRESS on the server: the backfill ran unattended
    expect(bank.accountCalls().some((k) => Object.keys(k.headers).some((h) => h.startsWith("psu-")))).toBe(false);

    const unmatched = await get(`/bank/unmatched?entity=${E}`, RO_TOKEN);
    expect(unmatched.json).toHaveLength(4);
    const conns = await get(`/bank/connections?entity=${E}&id=${connectionId}`);
    expect(conns.json).toEqual([expect.objectContaining({
      status: "authorized", accounts: 1, unattended_24h: 1, unattended_left: 3, backing_off: false,
      unattended_resume_at: null, last_fetch_outcome: "ok", last_fetch_attended: false,
    })]);

    // the state is spent
    const replayed = await get(`/bank/consent-callback?code=code-xyz&state=${encodeURIComponent(state)}`, null);
    expect(replayed.status).toBe(422);
    expect(replayed.text).toStartWith("Bank consent failed: no pending bank_connection");
  });
});

// ---------------------------------------------------------------------------
describe("sync over HTTP", () => {
  test("ro token cannot sync; malformed requests are 400 before the bank is called", async () => {
    bank = replay(RESYNC);
    expect((await post("/bank/sync", {}, RO_TOKEN)).status).toBe(403);
    const both = await post("/bank/sync", { connection_id: connectionId, entity: E });
    expect(both.status).toBe(400);
    expect(both.json.error).toBe("give connection_id or entity, not both");
    expect((await post("/bank/sync", { attended: "yes" })).status).toBe(400);
    expect((await post("/bank/sync", "[1]")).status).toBe(400);
    const missing = await post("/bank/sync", { connection_id: 999999 });
    expect(missing.status).toBe(422);
    expect(missing.json.error).toBe("bank_connection 999999 does not exist");
    expect(bank.calls).toHaveLength(0);
  });

  test("unattended runs: the outcome struct, then the 4/day budget defers", async () => {
    bank = replay(RESYNC);
    // empty body: every authorized connection
    const all = await call("POST", "/bank/sync");
    expect(all.status).toBe(200);
    expect(all.json).toEqual([expect.objectContaining({ connectionId, outcome: "ok", attended: false, warnings: [] })]);
    expect(all.json[0].accounts[0]).toMatchObject({ idHash: HASH, seen: 3, inserted: 1, pending: 1, balances: 2, truncated: false });

    const one = await post("/bank/sync", { connection_id: connectionId });
    expect(one.json).toEqual([expect.objectContaining({ connectionId, outcome: "ok" })]);
    expect(one.json[0].accounts[0].inserted).toBe(0);
    const byEntity = await post("/bank/sync", { entity: E });
    expect(byEntity.json).toEqual([expect.objectContaining({ connectionId, outcome: "ok" })]);
    expect((await post("/bank/sync", { entity: "111222333" })).json).toEqual([]);

    // backfill + 3 = 4 unattended fetches in 24 h: the next is deferred without a call
    const before = bank.calls.length;
    const deferred = await post("/bank/sync", { connection_id: connectionId });
    expect(deferred.status).toBe(200);
    expect(deferred.json[0]).toMatchObject({ outcome: "deferred", resumeAt: expect.any(String) });
    expect(deferred.json[0].detail).toMatch(/unattended budget/);
    expect(bank.calls.length).toBe(before);

    const [status] = (await get(`/bank/connections?entity=${E}&status=authorized`)).json;
    expect(status).toMatchObject({ unattended_24h: 4, unattended_left: 0, last_fetch_outcome: "deferred" });
    expect(new Date(status.unattended_resume_at).getTime()).toBeGreaterThan(Date.now());
  });

  test("attended runs need PSU_IP_ADDRESS on the server, then send PSU headers past the budget", async () => {
    bank = replay(RESYNC);
    const refused = await post("/bank/sync", { connection_id: connectionId, attended: true });
    expect(refused.status).toBe(503);
    expect(refused.json.error).toContain("PSU_IP_ADDRESS");
    expect(bank.calls).toHaveLength(0);

    bankEnv.PSU_IP_ADDRESS = "203.0.113.9";
    bankEnv.PSU_USER_AGENT = "Mozilla/5.0 (X11; Linux)";
    try {
      const r = await post("/bank/sync", { connection_id: connectionId, attended: true });
      expect(r.status).toBe(200);
      expect(r.json[0]).toMatchObject({ outcome: "ok", attended: true });
      const reads = bank.accountCalls();
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((k) => k.headers["psu-ip-address"] === "203.0.113.9")).toBe(true);
      // attended is opt-in per request even when the server could
      const plain = await post("/bank/sync", { connection_id: connectionId });
      expect(plain.json[0]).toMatchObject({ outcome: "deferred", attended: false });
    } finally {
      delete bankEnv.PSU_IP_ADDRESS;
      delete bankEnv.PSU_USER_AGENT;
    }
    expect(clientBuilds).toBe(1); // built once, on first use
  });
});

// ---------------------------------------------------------------------------
describe("matching over HTTP", () => {
  test("POST /bank/matches empties /bank/unmatched; DELETE puts one back", async () => {
    const queue = (await get(`/bank/unmatched?entity=${E}`)).json as { dedup_key: string; amount: number; booking_date: string }[];
    expect(queue).toHaveLength(5);
    const vouchers: { nr: number; key: string }[] = [];
    for (const [i, t] of queue.entries()) {
      const v = await post("/vouchers", {
        entity: E, posting_date: t.booking_date, description: `bank ${t.dedup_key}`, idempotency_key: `bank-${i}`,
        lines: [{ account: "1920", amount: t.amount }, { account: "2050", amount: -t.amount }],
      });
      expect(v.status).toBe(200);
      vouchers.push({ nr: v.json.nr, key: t.dedup_key });
    }

    const ro = await post("/bank/matches", { id_hash: HASH, dedup_key: vouchers[0]!.key, entity: E, year: Y, nr: vouchers[0]!.nr }, RO_TOKEN);
    expect(ro.status).toBe(403);
    const wrongLine = await post("/bank/matches", { id_hash: HASH, dedup_key: vouchers[0]!.key, entity: E, year: Y, nr: vouchers[0]!.nr, line: 2 });
    expect(wrongLine.status).toBe(422);
    expect(wrongLine.json).toEqual({ error: expect.stringContaining("must link the line on ledger account 1920"), sqlstate: "P0001" });

    for (const v of vouchers) {
      const m = await post("/bank/matches", { id_hash: HASH, dedup_key: v.key, entity: E, year: Y, nr: v.nr });
      expect(m.status).toBe(200);
      expect(m.json).toEqual({ id_hash: HASH, dedup_key: v.key, entity: E, year: Y, nr: v.nr, line: 1, created: true });
    }
    expect((await get(`/bank/unmatched?entity=${E}`)).json).toEqual([]);
    const again = await post("/bank/matches", { id_hash: HASH, dedup_key: vouchers[0]!.key, entity: E, year: Y, nr: vouchers[0]!.nr });
    expect(again.json.created).toBe(false);

    const body = { id_hash: HASH, dedup_key: vouchers[1]!.key, entity: E, year: Y, nr: vouchers[1]!.nr };
    expect((await call("DELETE", "/bank/matches", { body, token: RO_TOKEN })).status).toBe(403);
    const un = await call("DELETE", "/bank/matches", { body });
    expect(un.status).toBe(200);
    expect(un.json).toEqual({ deleted: 1 });
    expect((await get(`/bank/unmatched?entity=${E}`)).json).toEqual([expect.objectContaining({ dedup_key: vouchers[1]!.key })]);
    expect((await call("DELETE", "/bank/matches", { body })).json).toEqual({ deleted: 0 });
    const incomplete = await call("DELETE", "/bank/matches", { body: { id_hash: HASH } });
    expect(incomplete.status).toBe(422);
    expect(incomplete.json.error).toBe("id_hash, dedup_key, entity, year and nr are required");
  });

  test("405 lists the bank methods", async () => {
    const r = await call("PUT", "/bank/matches", { body: {} });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST, DELETE");
  });
});

// ---------------------------------------------------------------------------
describe("without Enable Banking env", () => {
  test("the API serves; bank routes that need the client answer 503 naming the missing variables", async () => {
    const bare = createApi({ rw, ro, rwToken: RW_TOKEN, roToken: RO_TOKEN, bank: { env: {} } });
    const req = (method: string, path: string, body?: unknown, token: string | null = RW_TOKEN) =>
      bare.request(path, {
        method,
        headers: { ...(token && { authorization: `Bearer ${token}` }), "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    expect((await req("GET", `/journal?entity=${E}`)).status).toBe(200);
    expect((await req("GET", `/bank/connections?entity=${E}`)).status).toBe(200);

    const sync = await req("POST", "/bank/sync", {});
    expect(sync.status).toBe(503);
    expect(await sync.json()).toEqual({
      error: "Enable Banking is not configured: ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY_FILE are not set",
      sqlstate: null,
    });
    const consent = await req("POST", "/bank/consents", { entity: E, aspsp: { name: "Mock ASPSP" }, redirect_url: REDIRECT });
    expect(consent.status).toBe(503);
    const noRedirect = await req("POST", "/bank/consents", { entity: E, aspsp: { name: "Mock ASPSP" } });
    expect(noRedirect.status).toBe(400);
    expect(((await noRedirect.json()) as { error: string }).error).toContain("ENABLE_BANKING_REDIRECT_URL");
    // nothing was written for the refused consents
    const pending = await admin`select count(*)::int as n from bank_connection where status = 'pending'`;
    expect(pending[0].n).toBe(0);

    const cb = await req("GET", "/bank/consent-callback?code=c&state=s", undefined, null);
    expect(cb.status).toBe(503);
    expect(await cb.text()).toBe(
      "Bank consent failed: Enable Banking is not configured: ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY_FILE are not set\n");
  });
});
