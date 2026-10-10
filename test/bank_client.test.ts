// Enable Banking client, offline: JWT, PSU headers, 429, pagination guards,
// amount and dedup-key rules. No database.
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  EnableBankingClient,
  EnableBankingError,
  RateLimitedError,
  SessionExpiredError,
  type Transaction,
} from "../src/bank/client";
import { JWT_AUDIENCE, JWT_ISSUER, loadPrivateKey, signJwt, tokenSource } from "../src/bank/jwt";
import { dedupKey, dedupKeys, oreFromDecimal, transactionOre } from "../src/bank/sync";
import { fixture, replay, testKeyPem, type Route } from "./bank_replay";

const pem = testKeyPem();
const APP = "cf589be3-3755-465b-a8df-a90a16a31403";

function client(routes: Route[], now?: () => number) {
  const r = replay(routes);
  const c = new EnableBankingClient({ appId: APP, privateKeyPem: pem, fetch: r.fetch, now });
  return { c, r };
}

const b64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

describe("jwt", () => {
  test("RS256, kid = app id, iss/aud per the reference, verifiable with the public key", () => {
    const key = loadPrivateKey(pem);
    const token = signJwt(APP, key, { iat: 1_700_000_000, ttlSeconds: 3600 });
    const [h, c, s] = token.split(".") as [string, string, string];
    expect(b64(h)).toEqual({ typ: "JWT", alg: "RS256", kid: APP });
    expect(b64(c)).toEqual({ iss: JWT_ISSUER, aud: JWT_AUDIENCE, iat: 1_700_000_000, exp: 1_700_003_600 });
    const ok = verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(key), Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    expect(() => signJwt(APP, key, { ttlSeconds: 90_000 })).toThrow(/86400/);
  });

  test("the token is reused until it nears expiry, then re-minted", () => {
    let t = 1_000_000_000_000;
    const src = tokenSource(APP, loadPrivateKey(pem), 3600, () => t);
    const a = src();
    t += 1000 * 1000; // +1000 s: still fresh
    expect(src()).toBe(a);
    t += 2100 * 1000; // 3100 s in: inside the 600 s refresh margin
    expect(src()).not.toBe(a);
  });

  test("PKCS#8 keys load too; non-RSA keys are refused", () => {
    const pkcs8 = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(loadPrivateKey(pkcs8 as string).asymmetricKeyType).toBe("rsa");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
    expect(() => loadPrivateKey(ec as string)).toThrow(/RSA/);
  });
});

describe("requests", () => {
  test("every call carries the bearer token and json accept", async () => {
    const { c, r } = client([{ method: "GET", path: "/aspsps", reply: { body: { aspsps: [{ name: "Mock ASPSP", country: "NO" }] } } }]);
    const aspsps = await c.aspsps("NO");
    expect(aspsps[0]?.name).toBe("Mock ASPSP");
    const call = r.calls[0]!;
    expect(call.headers.authorization).toMatch(/^Bearer ey/);
    expect(call.headers.accept).toBe("application/json");
    expect(call.query).toEqual({ country: "NO" });
  });

  test("startAuth posts the consent body; createSession posts the code", async () => {
    const { c, r } = client([
      { method: "POST", path: "/auth", reply: "auth" },
      { method: "POST", path: "/sessions", reply: "session" },
    ]);
    const validUntil = new Date("2027-04-07T00:00:00.000Z");
    const a = await c.startAuth({
      aspsp: { name: "Mock ASPSP", country: "NO" },
      redirectUrl: "https://hovedbok.example/bank/callback",
      state: "s1",
      validUntil,
    });
    expect(a.url).toMatch(/^https:\/\/auth\.enablebanking\.com\//);
    expect(r.calls[0]!.body).toEqual({
      access: { valid_until: "2027-04-07T00:00:00Z" },
      aspsp: { name: "Mock ASPSP", country: "NO" },
      state: "s1",
      redirect_url: "https://hovedbok.example/bank/callback",
      psu_type: "business",
    });
    const s = await c.createSession("code-1");
    expect(r.calls[1]!.body).toEqual({ code: "code-1" });
    expect(s.accounts[0]!.identification_hash).toContain("mockNO9386011117947hash");
  });

  test("429 → RateLimitedError with the bank's error code and Retry-After", async () => {
    const { c } = client([
      {
        method: "GET",
        path: (call) => call.path.endsWith("/transactions"),
        reply: { status: 429, body: await fixture("rate-limited"), headers: { "retry-after": "7200" } },
      },
    ]);
    const err = await c.transactionsPage("u1", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.code).toBe("ASPSP_RATE_LIMIT_EXCEEDED");
    expect(err.retryAfterSeconds).toBe(7200);
  });

  test("401/410 → SessionExpiredError; other 4xx → EnableBankingError with the code", async () => {
    const { c } = client([
      { method: "GET", path: "/sessions/gone", reply: { status: 410, body: { message: "Session expired", error: "SESSION_EXPIRED" } } },
      { method: "GET", path: "/accounts/u1/balances", reply: { status: 422, body: { message: "bad", error: "WRONG_TRANSACTIONS_PERIOD" } } },
    ]);
    await expect(c.session("gone")).rejects.toBeInstanceOf(SessionExpiredError);
    const e = await c.balances("u1").catch((x) => x);
    expect(e).toBeInstanceOf(EnableBankingError);
    expect(e.code).toBe("WRONG_TRANSACTIONS_PERIOD");
    expect(e.status).toBe(422);
  });
});

describe("PSU headers", () => {
  const psu = {
    ipAddress: "203.0.113.9",
    userAgent: "Mozilla/5.0",
    acceptLanguage: "nb-NO",
    referer: "https://hovedbok.example/",
  };

  test("attended reads send every header the context carries; unattended send none", async () => {
    const { c, r } = client([{ method: "GET", path: "/accounts/u1/balances", reply: "balances-1" }]);
    await c.balances("u1", psu);
    await c.balances("u1");
    const [attended, unattended] = r.calls as [typeof r.calls[0], typeof r.calls[0]];
    expect(attended.headers["psu-ip-address"]).toBe("203.0.113.9");
    expect(attended.headers["psu-user-agent"]).toBe("Mozilla/5.0");
    expect(attended.headers["psu-accept-language"]).toBe("nb-NO");
    expect(attended.headers["psu-referer"]).toBe("https://hovedbok.example/");
    expect(Object.keys(unattended.headers).some((h) => h.startsWith("psu-"))).toBe(false);
  });

  test("all-or-none: without an address nothing is sent; a bad value drops the lot", async () => {
    const { c, r } = client([{ method: "GET", path: "/accounts/u1/balances", reply: "balances-1" }]);
    await c.balances("u1", { ipAddress: "", userAgent: "Mozilla/5.0" });
    await c.balances("u1", { ipAddress: "203.0.113.9\r\nX-Injected: 1", userAgent: "Mozilla/5.0" });
    for (const call of r.calls) {
      expect(Object.keys(call.headers).some((h) => h.startsWith("psu-"))).toBe(false);
    }
  });

  test("refused PSU headers → one unattended retry, reported as psuRefused", async () => {
    const { c, r } = client([
      {
        method: "GET",
        path: (call) => call.path === "/accounts/u1/balances" && "psu-ip-address" in call.headers,
        reply: { status: 400, body: { message: "PSU headers required", error: "PSU_HEADER_NOT_PROVIDED" } },
      },
      { method: "GET", path: "/accounts/u1/balances", reply: "balances-1" },
    ]);
    const res = await c.balances("u1", psu);
    expect(res.psuRefused).toBe(true);
    expect(res.data).toHaveLength(2);
    expect(r.calls).toHaveLength(2);
    expect("psu-ip-address" in r.calls[1]!.headers).toBe(false);
  });
});

describe("pagination", () => {
  test("follows continuation_key to the end and reports page count", async () => {
    const { c, r } = client([
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && !k.query.continuation_key, reply: "backfill-1" },
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && k.query.continuation_key === "page-2", reply: "backfill-2" },
    ]);
    const res = await c.transactions("u1", { strategy: "longest" });
    expect(res.pages).toBe(2);
    expect(res.transactions).toHaveLength(4);
    expect(r.calls[0]!.query).toEqual({ strategy: "longest" });
    expect(r.calls[1]!.query).toEqual({ strategy: "longest", continuation_key: "page-2" });
  });

  test("a repeated continuation_key stops the walk; repeated rows are yielded once", async () => {
    const page = (await fixture("backfill-1")) as Record<string, unknown>;
    const { c, r } = client([
      { method: "GET", path: (k) => k.path.endsWith("/transactions"), reply: { body: { ...page, continuation_key: "loop" } } },
    ]);
    const warnings: string[] = [];
    const res = await c.transactions("u1", { dateFrom: "2026-09-01", dateTo: "2026-10-10" }, { onWarning: (m) => warnings.push(m) });
    expect(r.calls).toHaveLength(2); // first page, then the page behind "loop", which points to "loop" again
    expect(res.transactions).toHaveLength(2);
    expect(warnings[0]).toMatch(/continuation_key loop repeated/);
  });

  test("PSU refusal mid-walk keeps the rest of the walk unattended", async () => {
    const { c, r } = client([
      {
        method: "GET",
        path: (k) => k.path.endsWith("/transactions") && "psu-ip-address" in k.headers,
        reply: { status: 422, body: { message: "invalid", error: "PSU_HEADER_INVALID" } },
        once: true,
      },
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && !k.query.continuation_key, reply: "backfill-1" },
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && k.query.continuation_key === "page-2", reply: "backfill-2" },
    ]);
    const res = await c.transactions("u1", {}, { psu: { ipAddress: "10.0.0.1" } });
    expect(res.psuRefused).toBe(true);
    expect(res.transactions).toHaveLength(4);
    // refused attended call, unattended retry, unattended page 2
    expect(r.calls.map((k) => "psu-ip-address" in k.headers)).toEqual([true, false, false]);
  });
});

describe("amounts and dedup keys", () => {
  test("decimal strings → øre, half up, sign from credit_debit_indicator", () => {
    expect(oreFromDecimal("1.23")).toBe(123);
    expect(oreFromDecimal("-1234.5")).toBe(-123450);
    expect(oreFromDecimal("0.005")).toBe(1);
    expect(oreFromDecimal("0.004")).toBe(0);
    expect(oreFromDecimal("12500")).toBe(1250000);
    expect(() => oreFromDecimal("1,5")).toThrow();
    const base: Transaction = { transaction_amount: { currency: "NOK", amount: "75.00" } };
    expect(transactionOre({ ...base, credit_debit_indicator: "DBIT" })).toBe(-7500);
    expect(transactionOre({ ...base, credit_debit_indicator: "CRDT" })).toBe(7500);
    expect(transactionOre({ ...base, transaction_amount: { currency: "NOK", amount: "-75.00" } })).toBe(-7500);
  });

  test("entry_reference wins; otherwise a stable fp: fingerprint that ignores transaction_id", () => {
    const a: Transaction = {
      entry_reference: null,
      transaction_amount: { currency: "NOK", amount: "75.00" },
      credit_debit_indicator: "DBIT",
      booking_date: "2026-09-30",
      value_date: "2026-09-30",
      balance_after_transaction: { currency: "NOK", amount: "57435.00" },
      remittance_information: ["Gebyr nettbank bedrift"],
      transaction_id: "tx-a3",
    };
    const b = { ...a, transaction_id: "tx-b3", creditor: { name: "Mock ASPSP" } };
    expect(dedupKey(a)).toMatch(/^fp:[0-9a-f]{64}$/);
    expect(dedupKey(b)).toBe(dedupKey(a));
    expect(dedupKey({ ...a, balance_after_transaction: { currency: "NOK", amount: "57360.00" } })).not.toBe(dedupKey(a));
    expect(dedupKey({ ...a, entry_reference: " 2026093000003 " })).toBe("2026093000003");
  });

  test("repeated fingerprints in one window are numbered, in order; keyed rows are not", () => {
    const k: Transaction = { transaction_amount: { currency: "NOK", amount: "59.00" }, credit_debit_indicator: "DBIT", booking_date: "2026-10-05" };
    const ref: Transaction = { ...k, entry_reference: "R1" };
    const keys = dedupKeys([k, ref, { ...k }, { ...k, booking_date: "2026-10-06" }, { ...k }]);
    const fp = dedupKey(k);
    expect(keys).toEqual([fp, "R1", `${fp}:2`, dedupKey({ ...k, booking_date: "2026-10-06" }), `${fp}:3`]);
  });

  test("the client folds a keyed row repeated across pages, never a keyless one", async () => {
    const keyless = { transaction_amount: { currency: "NOK", amount: "59.00" }, credit_debit_indicator: "DBIT", booking_date: "2026-10-05", status: "BOOK" };
    const keyed = { ...keyless, entry_reference: "R1" };
    const { c } = client([
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && !k.query.continuation_key, reply: { body: { transactions: [keyless, keyed, keyless], continuation_key: "p2" } } },
      { method: "GET", path: (k) => k.path.endsWith("/transactions") && k.query.continuation_key === "p2", reply: { body: { transactions: [keyed, keyless], continuation_key: null } } },
    ]);
    const res = await c.transactions("u1", {});
    expect(res.transactions).toHaveLength(4);
    expect(res.truncated).toBe(false);
  });
});
