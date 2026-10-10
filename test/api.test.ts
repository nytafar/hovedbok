// HTTP API (#11) end to end: a real listener on a fresh database, driven the
// way an agent would — bootstrap, reference data, vouchers (and a refused
// one), reversal, reports, VAT, SAF-T, documents, period/year close — under
// login roles that are members of hovedbok_app and hovedbok_ro, as deploy
// sets them up. Then auth, 404/405, and the OpenAPI document against the
// route table.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api/app";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const E = "999888777";
const Y = 2026;
const RW_TOKEN = "rw-token-for-tests";
const RO_TOKEN = "ro-token-for-tests";
const rwRole = `hovedbok_api_rw_${process.pid}`;
const roRole = `hovedbok_api_ro_${process.pid}`;

let admin: SQL;
let rw: SQL;
let ro: SQL;
let dir: string;
let api: ReturnType<typeof createApi>;
let server: ReturnType<typeof Bun.serve>;

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
  dir = await mkdtemp(join(tmpdir(), "hovedbok-api-docs-"));
  api = createApi({ rw, ro, rwToken: RW_TOKEN, roToken: RO_TOKEN, documentsDir: dir, bank: { env: {} } });
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

interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: RequestInit["body"]; token?: string | null; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...opts.headers };
  const token = opts.token === undefined ? RW_TOKEN : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  let body: RequestInit["body"] = opts.raw;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
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

const sale = {
  entity: E, posting_date: "2026-01-15", description: "Salg K1", idempotency_key: "sale-1",
  lines: [
    { account: "1500", amount: 12500, party: "K1" },
    { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
    { account: "2700", amount: -2500 },
  ],
};
const purchase = {
  entity: E, posting_date: "2026-01-20", description: "Kjøp L1", idempotency_key: "purchase-1",
  lines: [
    { account: "6300", amount: 4000, vat_code: "1", vat_base: 4000 },
    { account: "2710", amount: 1000 },
    { account: "2400", amount: -5000, party: "L1" },
  ],
};
const mistake = {
  entity: E, posting_date: "2026-01-22", description: "Feilføring", idempotency_key: "mistake-1",
  lines: [{ account: "1920", amount: 777 }, { account: "1921", amount: -777 }],
};

// ---------------------------------------------------------------------------
describe("the agent flow over HTTP", () => {
  test("bootstrap the entity", async () => {
    const r = await post("/entities", { orgnr: E, name: "Demo AS", vat_registered: true, year: Y });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ entity: E, created: true, accounts_added: expect.any(Number), year: Y });
    const again = await post("/entities", { orgnr: E, name: "Demo AS", year: Y });
    expect(again.json.created).toBe(false);
  });

  test("reference data: parties and accounts, PUT and POST", async () => {
    let r = await call("PUT", "/parties", { body: { entity: E, id: "K1", name: "Kunde AS", customer: true } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ entity: E, id: "K1", created: true });
    r = await post("/parties", { entity: E, id: "L1", name: "Leverandør AS", supplier: true, orgnr: "987654321" });
    expect(r.json).toEqual({ entity: E, id: "L1", created: true });
    r = await call("PUT", "/accounts", { body: { entity: E, code: "1921", name: "Sparekonto", std_account: "1920" } });
    expect(r.json).toEqual({ entity: E, code: "1921", created: true });
    r = await post("/accounts", { entity: E, code: "1921", name: "Bank, sparekonto" });
    expect(r.json).toEqual({ entity: E, code: "1921", created: false });

    const parties = await get(`/parties?entity=${E}`);
    expect(parties.json.map((p: { id: string }) => p.id)).toEqual(["K1", "L1"]);
    const acct = await get(`/accounts?entity=${E}&code=1921`);
    expect(acct.json).toEqual([expect.objectContaining({ code: "1921", name: "Bank, sparekonto", std_account: "1920" })]);

    // the DB's message and SQLSTATE come through
    r = await call("PUT", "/accounts", { body: { entity: E, code: "19x1", name: "x" } });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: "account code 19x1 must be 4 digits (NS 4102)", sqlstate: "P0001" });
  });

  test("post vouchers; a refused one echoes the database's message and SQLSTATE", async () => {
    for (const [v, nr] of [[sale, 1], [purchase, 2], [mistake, 3]] as const) {
      const r = await post("/vouchers", v);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ entity: E, year: Y, nr, idempotent: false });
    }
    const replay = await post("/vouchers", sale);
    expect(replay.json).toEqual({ entity: E, year: Y, nr: 1, idempotent: true });

    const unbalanced = await post("/vouchers", {
      ...sale, idempotency_key: "bad-1",
      lines: [{ account: "1920", amount: 100 }, { account: "3000", amount: -90, vat_code: "3", vat_base: -90 }],
    });
    expect(unbalanced.status).toBe(422);
    expect(unbalanced.json).toEqual({
      error: "lines do not balance: 10 øre (debits positive, credits negative, sum must be 0)",
      sqlstate: "P0001",
    });

    const noParty = await post("/vouchers", {
      ...sale, idempotency_key: "bad-2",
      lines: [{ account: "1500", amount: 12500 }, { account: "3000", amount: -12500 }],
    });
    expect(noParty.status).toBe(422);
    expect(noParty.json.error).toContain("account 1500 is a customer control account; party is required (BF § 3-1)");

    const malformed = await post("/vouchers", "{not json");
    expect(malformed.status).toBe(400);
    expect(malformed.json.sqlstate).toBe("22P02");

    const missing = await post("/vouchers", { entity: E });
    expect(missing.status).toBe(422);
    expect(missing.json.error).toBe("missing required field(s): posting_date, idempotency_key");
  });

  test("reverse a voucher (once)", async () => {
    const r = await post(`/vouchers/${Y}/3/reverse`, { entity: E, posting_date: "2026-01-23" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ entity: E, year: Y, nr: 4, idempotent: false });
    const again = await post(`/vouchers/${Y}/3/reverse`, { entity: E, posting_date: "2026-01-23" });
    expect(again.json).toEqual({ entity: E, year: Y, nr: 4, idempotent: true });

    const j = await get(`/journal?entity=${E}&nr=4`);
    expect(j.json).toHaveLength(2);
    expect(j.json[0]).toMatchObject({ reverses_year: Y, reverses_nr: 3, amount: -777, posting_date: "2026-01-23" });

    const nope = await post(`/vouchers/${Y}/99/reverse`, { entity: E });
    expect(nope.status).toBe(422);
    expect(nope.json).toEqual({ error: `voucher ${Y}/99 not found for ${E}`, sqlstate: "P0001" });
    const bad = await post(`/vouchers/${Y}/x/reverse`, { entity: E });
    expect(bad.status).toBe(400);
    expect(bad.json.sqlstate).toBe("22P02");
    const noEntity = await post(`/vouchers/${Y}/3/reverse`, {});
    expect(noEntity.status).toBe(400);
    expect(noEntity.json).toEqual({ error: "missing required field(s): entity", sqlstate: null });
  });

  test("the journal names the login that posted (ADR-0010) and filters by key and range", async () => {
    const all = await get(`/journal?entity=${E}`);
    expect(all.status).toBe(200);
    expect(all.json).toHaveLength(10);
    expect(new Set(all.json.map((r: { created_by: string }) => r.created_by))).toEqual(new Set([rwRole]));
    expect(all.json.map((r: { nr: number; line: number }) => `${r.nr}.${r.line}`)).toEqual(
      ["1.1", "1.2", "1.3", "2.1", "2.2", "2.3", "3.1", "3.2", "4.1", "4.2"]);

    const range = await get(`/journal?entity=${E}&from=2026-01-16&to=2026-01-22&account=2400`);
    expect(range.json).toEqual([expect.objectContaining({ nr: 2, account: "2400", amount: -5000, party: "L1" })]);
    const page = await get(`/journal?entity=${E}&limit=2&offset=3`);
    expect(page.json.map((r: { nr: number; line: number }) => `${r.nr}.${r.line}`)).toEqual(["2.1", "2.2"]);

    const noEntity = await get("/journal");
    expect(noEntity.status).toBe(400);
    expect(noEntity.json.error).toBe("missing required query parameter(s): entity");
    const unknown = await get(`/journal?entity=${E}&acount=1920`);
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toStartWith("unknown query parameter(s): acount; accepted: entity, year");
    const badYear = await get(`/journal?entity=${E}&year=twenty`);
    expect(badYear.status).toBe(400);
    expect(badYear.json.sqlstate).toBe("22P02");
  });

  test("reports", async () => {
    const bal = await get(`/account-balance?entity=${E}&account=1500`);
    expect(bal.json).toEqual([{ entity: E, account: "1500", balance: 12500 }]);
    const ayb = await get(`/account-year-balance?entity=${E}&year=${Y}&account=2400`);
    expect(ayb.json).toEqual([{ entity: E, year: Y, account: "2400", opening: 0, movement: -5000, closing: -5000 }]);

    const sb = await get(`/saldobalanse?entity=${E}&year=${Y}&period_from=1&period_to=1`);
    const byAccount = Object.fromEntries(sb.json.map((r: { account: string; closing: number }) => [r.account, r.closing]));
    expect(byAccount).toMatchObject({ "1500": 12500, "2400": -5000, "2700": -2500, "2710": 1000, "3000": -10000, "6300": 4000, "1920": 0 });
    const debit1920 = sb.json.find((r: { account: string }) => r.account === "1920");
    expect(debit1920).toMatchObject({ debit: 777, credit: 777, closing: 0 });

    const ks = await get(`/kontospesifikasjon?entity=${E}&account=1920&period_from=1&period_to=1`);
    expect(ks.json.map((r: { nr: number; balance_after: number }) => [r.nr, r.balance_after])).toEqual([[3, 777], [4, 0]]);

    const bs = await get(`/bokforingsspesifikasjon?entity=${E}&year=${Y}&nr=1`);
    expect(bs.json).toHaveLength(3);
    expect(bs.json[0]).toMatchObject({ nr: 1, account: "1500", party_name: "Kunde AS", documents: [] });

    const kunde = await get(`/kundespesifikasjon?entity=${E}&year=${Y}&period_from=1&period_to=1`);
    expect(kunde.json).toEqual([expect.objectContaining({ party: "K1", name: "Kunde AS", closing: 12500 })]);
    const lev = await get(`/leverandorspesifikasjon?entity=${E}&year=${Y}&period_from=1&period_to=1&party=L1`);
    expect(lev.json).toEqual([expect.objectContaining({ party: "L1", orgnr: "987654321", closing: -5000 })]);

    const res = await get(`/resultat?entity=${E}&year=${Y}&period_from=1&period_to=12`);
    const sum = res.json.reduce((a: number, r: { amount: number }) => a + r.amount, 0);
    expect(sum).toBe(-6000); // 10 000 revenue − 4 000 cost, credit = profit
    const balanse = await get(`/balanse?entity=${E}&year=${Y}&period=1`);
    expect(balanse.json.reduce((a: number, r: { amount: number }) => a + r.amount, 0)).toBe(6000);

    const missing = await get(`/voucher-without-document?entity=${E}`);
    expect(missing.json.map((v: { nr: number }) => v.nr)).toEqual([1, 2, 3, 4]);
  });

  test("VAT: summary, control, term, and the MVA-melding draft", async () => {
    const vs = await get(`/vat-summary?entity=${E}&year=${Y}&period=1`);
    expect(vs.json.map((r: { vat_code: string; base: number; vat: number }) => [r.vat_code, r.base, r.vat])).toEqual([
      ["1", 4000, 1000],
      ["3", -10000, -2500],
    ]);
    const vc = await get(`/vat-control?entity=${E}&year=${Y}`);
    expect(vc.json).toEqual([expect.objectContaining({ period: 1, output_difference: 0, input_difference: 0 })]);
    const mt = await get(`/mva-term?entity=${E}&year=${Y}&term=1`);
    expect(mt.json.map((r: { vat_code: string; vat: number }) => [r.vat_code, r.vat])).toEqual([["1", -1000], ["3", 2500]]);

    const xml = await get(`/mva-melding/${Y}/1?entity=${E}`);
    expect(xml.status).toBe(200);
    expect(xml.headers.get("content-type")).toStartWith("application/xml");
    expect(xml.headers.get("content-disposition")).toBe(`attachment; filename="mva-melding_${E}_${Y}-1.xml"`);
    expect(xml.text).toContain("<fastsattMerverdiavgift>15</fastsattMerverdiavgift>");
    expect(xml.text).toContain(`<regnskapssystemsreferanse>hovedbok:${E}:${Y}-1</regnskapssystemsreferanse>`);

    const json = await get(`/mva-melding/${Y}/1?entity=${E}&format=json&reference=ref-1`);
    expect(json.json).toMatchObject({ total: 15, lines: [{ code: "1", vat: -10 }, { code: "3", base: 100, rate: "25", vat: 25 }] });
    expect(json.json.xml).toContain("ref-1");

    const badTerm = await get(`/mva-melding/${Y}/7?entity=${E}`);
    expect(badTerm.status).toBe(422);
    expect(badTerm.json).toEqual({ error: "term 7 is not a bimonthly VAT term (1-6)", sqlstate: null });
  });

  test("SAF-T export carries Skatteetaten's file name", async () => {
    const r = await get(`/saf-t?entity=${E}&year=${Y}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("application/xml");
    expect(r.headers.get("content-disposition")).toMatch(
      new RegExp(`^attachment; filename="SAF-T Financial_${E}_\\d{14}_1_1\\.xml"$`));
    expect(r.text).toStartWith("<?xml");
    expect(r.text).toContain("<NumberOfEntries>4</NumberOfEntries>");

    const range = await get(`/saf-t?entity=${E}&from=2026-01-01&to=2026-01-31&version=1.40`);
    expect(range.status).toBe(200);
    expect(range.text).toContain("1.40");
    const both = await get(`/saf-t?entity=${E}&year=${Y}&from=2026-01-01`);
    expect(both.status).toBe(400);
    const none = await get(`/saf-t?entity=${E}`);
    expect(none.json).toEqual({ error: "give year, or from and to (YYYY-MM-DD)", sqlstate: null });
    const noEntity = await get(`/saf-t?entity=111222333&year=${Y}`);
    expect(noEntity.json).toEqual({ error: "entity 111222333 does not exist", sqlstate: null });
  });

  test("documents: store, retrieve verified, link to a voucher", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 kvittering");
    const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const stored = await call("POST", "/documents?origin=receipt&note=lunsj", {
      raw: bytes, headers: { "content-type": "application/pdf" },
    });
    expect(stored.status).toBe(200);
    expect(stored.json).toMatchObject({ sha256: sha, mediaType: "application/pdf", bytes: bytes.length, origin: "receipt", note: "lunsj" });

    const back = await fetch(new URL(`/documents/${sha}`, server.url), { headers: { authorization: `Bearer ${RO_TOKEN}` } });
    expect(back.status).toBe(200);
    expect(back.headers.get("content-type")).toBe("application/pdf");
    expect(back.headers.get("etag")).toBe(`"${sha}"`);
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);

    const link = await post(`/vouchers/${Y}/1/documents`, { entity: E, sha256: sha });
    expect(link.json).toEqual({ entity: E, year: Y, nr: 1, sha256: sha });
    const bs = await get(`/bokforingsspesifikasjon?entity=${E}&year=${Y}&nr=1`);
    expect(bs.json[0].documents).toEqual([sha]);
    const missing = await get(`/voucher-without-document?entity=${E}`);
    expect(missing.json.map((v: { nr: number }) => v.nr)).toEqual([2, 3, 4]);

    const noVoucher = await post(`/vouchers/${Y}/99/documents`, { entity: E, sha256: sha });
    expect(noVoucher.status).toBe(422);
    expect(noVoucher.json.sqlstate).toBe("23503");

    const badOrigin = await call("POST", "/documents?origin=selfie", { raw: bytes, headers: { "content-type": "image/png" } });
    expect(badOrigin.status).toBe(422);
    expect(badOrigin.json.sqlstate).toBe("23514");
    const multipart = await call("POST", "/documents?origin=receipt", { raw: new FormData() });
    expect(multipart.status).toBe(400);

    expect((await get(`/documents/${"0".repeat(64)}`)).status).toBe(404);
    expect((await get("/documents/nothex")).status).toBe(400);

    // verify-on-read: a tampered blob is refused
    await writeFile(join(dir, sha.slice(0, 2), sha), "tampered");
    const tampered = await get(`/documents/${sha}`);
    expect(tampered.status).toBe(500);
    expect(tampered.json.error).toContain(`document ${sha}: blob on disk hashes to`);
  });

  test("bank reads; the consent callback is tokenless (bank flow: test/api_bank.test.ts)", async () => {
    expect((await get(`/bank/unmatched?entity=${E}`)).json).toEqual([]);
    expect((await get(`/bank/reconciliation?entity=${E}`)).json).toEqual([]);
    expect((await get(`/bank/connections?entity=${E}`)).json).toEqual([]);
    const cb = await call("GET", "/bank/consent-callback?code=x&state=y", { token: null });
    expect(cb.status).toBe(503); // no Enable Banking env here, and no 401
    expect(cb.text).toContain("ENABLE_BANKING_APP_ID");
    expect((await post("/bank/consent-callback", {}, null)).status).toBe(401);
  });

  test("close periods, then the fiscal year", async () => {
    const r = await post("/periods/close", { entity: E, year: Y, period: 1 });
    expect(r.json).toEqual({ entity: E, year: Y, period: 1, status: "closed" });
    const late = await post("/vouchers", { ...sale, idempotency_key: "late", posting_date: "2026-01-31" });
    expect(late.status).toBe(422);
    expect(late.json.sqlstate).toBe("P0001");
    expect(late.json.error).toContain("closed");
    const twice = await post("/periods/close", { entity: E, year: Y, period: 1 });
    expect(twice.json).toEqual({ error: `period ${Y}/1 for ${E} is not open`, sqlstate: "P0001" });

    const early = await post("/fiscal-years/close", { entity: E, year: Y });
    expect(early.status).toBe(422);
    for (let p = 2; p <= 12; p++) {
      expect((await post("/periods/close", { entity: E, year: Y, period: p })).status).toBe(200);
    }
    const close = await post("/fiscal-years/close", { entity: E, year: Y });
    expect(close.status).toBe(200);
    expect(close.json).toMatchObject({ entity: E, year: Y, result: -6000, equity_account: "2050", period_13: "closed" });
    const next = await get(`/account-year-balance?entity=${E}&year=${Y + 1}&account=2050`);
    expect(next.json).toEqual([expect.objectContaining({ opening: -6000 })]);
  });
});

// ---------------------------------------------------------------------------
describe("auth", () => {
  test("no or wrong token: 401 with a Bearer challenge", async () => {
    for (const token of [null, "wrong"]) {
      const r = await get(`/journal?entity=${E}`, token);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toStartWith("Bearer");
      expect(r.json.error).toContain("bearer token");
    }
    expect((await get("/nowhere", null)).status).toBe(401);
  });

  test("read-only token: GETs on the hovedbok_ro connection, no writes", async () => {
    const r = await get(`/journal?entity=${E}&nr=1`, RO_TOKEN);
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(3);
    expect((await get(`/saf-t?entity=${E}&year=${Y}`, RO_TOKEN)).status).toBe(200);
    expect((await get(`/mva-melding/${Y}/1?entity=${E}`, RO_TOKEN)).status).toBe(200);
    for (const [method, path] of [["POST", "/vouchers"], ["PUT", "/accounts"], ["POST", "/periods/close"], ["POST", "/documents?origin=other"]]) {
      const w = await call(method!, path!, { body: { entity: E }, token: RO_TOKEN });
      expect(w.status).toBe(403);
      expect(w.json.error).toContain("read-only token allows GET only");
    }
    // and the wall behind it: the ro login cannot execute a command at all
    const denied = await ro`select post_voucher(${sale}::jsonb)`.catch((e: { errno: string }) => e);
    expect(denied).toMatchObject({ errno: "42501" });
  });

  test("read-write token: full access", async () => {
    expect((await get(`/journal?entity=${E}&nr=1`)).status).toBe(200);
    expect((await call("PUT", "/parties", { body: { entity: E, id: "K2", name: "Kunde 2 AS", customer: true } })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("unknown routes and methods", () => {
  test("404 for an unknown path, 405 with Allow for a known path", async () => {
    const nf = await get("/nowhere");
    expect(nf.status).toBe(404);
    expect(nf.json.error).toContain("/openapi.json");
    const del = await call("DELETE", "/vouchers");
    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toBe("POST");
    const getReverse = await get(`/vouchers/${Y}/1/reverse`);
    expect(getReverse.status).toBe(405);
    const accounts = await call("DELETE", "/accounts");
    expect(accounts.headers.get("allow")).toBe("PUT, POST, GET, HEAD");
  });
});

// ---------------------------------------------------------------------------
describe("openapi.json", () => {
  test("served without a token, OpenAPI 3.1", async () => {
    const r = await get("/openapi.json", null);
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe("3.1.0");
  });

  test("documents exactly the route table: paths, methods, operationIds, query parameters", async () => {
    const spec = (await get("/openapi.json", null)).json;
    const toSpecPath = (p: string) => p.replace(/:([a-z0-9_]+)/gi, "{$1}");
    const fromTable = api.routeTable.map((r) => `${r.method} ${toSpecPath(r.path)} ${r.operationId}`).sort();
    const fromSpec: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, { operationId: string }>>)) {
      for (const [method, op] of Object.entries(ops)) fromSpec.push(`${method.toUpperCase()} ${path} ${op.operationId}`);
    }
    expect(fromSpec.sort()).toEqual(fromTable);

    const ids = fromSpec.map((s) => s.split(" ")[2]);
    expect(new Set(ids).size).toBe(ids.length);

    for (const r of api.routeTable) {
      const op = spec.paths[toSpecPath(r.path)][r.method.toLowerCase()];
      const params = (op.parameters ?? []) as { name: string; in: string }[];
      expect({ route: `${r.method} ${r.path}`, query: params.filter((p) => p.in === "query").map((p) => p.name) })
        .toEqual({ route: `${r.method} ${r.path}`, query: r.query ?? [] });
      const pathParams = [...r.path.matchAll(/:([a-z0-9_]+)/gi)].map((m) => m[1]!);
      expect(params.filter((p) => p.in === "path").map((p) => p.name)).toEqual(pathParams);
      expect(op.security === undefined ? !r.public : r.public && op.security.length === 0).toBe(true);
    }
  });

  test("every $ref resolves", async () => {
    const spec = (await get("/openapi.json", null)).json;
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([A-Za-z]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(30);
    for (const name of refs) expect({ name, defined: name in spec.components.schemas }).toEqual({ name, defined: true });
  });
});
