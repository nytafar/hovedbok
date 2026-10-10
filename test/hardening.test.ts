// Command hardening (#5): TRUNCATE backstop, the same-transaction fence on
// postings, created_by = caller, VAT coding rules, kind-vs-account rules, and
// post_voucher errors that say which line failed and why.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const E = "999888777";
const Y = 2026;

let sql: SQL;

beforeEach(async () => {
  sql = await freshDb();
  await sql`select bootstrap_entity(${{ orgnr: E, name: "Demo AS", vat_registered: true, year: Y }}::jsonb)`;
  await sql`
    insert into party (entity, id, name, customer, supplier) values
      (${E}, 'K1', 'Kunde AS', true, false),
      (${E}, 'L1', 'Leverandør AS', false, true)`;
});
afterAll(dropTestDb);

type Line = { account: string; amount: number; party?: string; vat_code?: string; vat_base?: number };

function voucher(key: string, lines: Line[], over: Record<string, unknown> = {}) {
  return { entity: E, posting_date: "2026-01-15", description: key, idempotency_key: key, lines, ...over };
}

async function post(db: SQL, p: object) {
  const [row] = await db`select post_voucher(${p}::jsonb) as r`;
  return row.r as { entity: string; year: number; nr: number; idempotent: boolean };
}

async function pgError(p: Promise<unknown>): Promise<{ errno: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { errno: string; message: string };
  }
  throw new Error("expected a database error, but the statement succeeded");
}

async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [r] = await sql`select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (r?.wait_event_type === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

const sale: Line[] = [
  { account: "1920", amount: 12500 },
  { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
  { account: "2700", amount: -2500, vat_code: "3" },
];

// ---------------------------------------------------------------------------
describe("TRUNCATE is refused on every fact table, owner included", () => {
  test("voucher, posting, document, voucher_document, bank_transaction, bank_balance", async () => {
    await post(sql, voucher("pre", sale));
    await sql`insert into document (sha256, media_type, bytes, origin) values (${"a".repeat(64)}, 'application/pdf', 10, 'receipt')`;
    await post(sql, voucher("doc", sale, { documents: ["a".repeat(64)] }));
    await sql`insert into bank_account (id_hash, entity, ledger_account) values ('h1', ${E}, '1920')`;
    await sql`insert into bank_transaction (id_hash, dedup_key, booking_date, amount, raw) values ('h1', 'k1', '2026-01-15', 12500, '{}')`;
    await sql`insert into bank_balance (id_hash, balance_type, amount) values ('h1', 'CLBD', 12500)`;
    const before = await counts();
    // cascade: without it Postgres refuses referenced tables on the FK alone,
    // before any trigger runs; with it the trigger is what stands in the way
    for (const stmt of [
      "truncate voucher cascade",
      "truncate posting cascade",
      "truncate voucher, posting, voucher_document, match",
      "truncate document cascade",
      "truncate voucher_document",
      "truncate bank_transaction cascade",
      "truncate bank_balance",
    ]) {
      const err = await pgError(sql.unsafe(stmt));
      expect({ stmt, message: err.message }).toEqual({ stmt, message: expect.stringContaining("is append-only") });
    }
    expect(await counts()).toEqual(before);
  });

  async function counts() {
    const [c] = await sql`
      select (select count(*)::int from voucher) as v, (select count(*)::int from posting) as p,
             (select count(*)::int from document) as d, (select count(*)::int from voucher_document) as vd,
             (select count(*)::int from bank_transaction) as bt, (select count(*)::int from bank_balance) as bb`;
    return c;
  }
});

// ---------------------------------------------------------------------------
describe("a posted voucher takes no new lines", () => {
  test("a balanced pair appended in a later transaction is refused", async () => {
    await post(sql, voucher("orig", sale));
    const err = await pgError(
      sql.begin(async (tx) => {
        await tx`insert into posting (entity, year, nr, line, account, amount) values (${E}, ${Y}, 1, 4, '1920', 100)`;
        await tx`insert into posting (entity, year, nr, line, account, amount) values (${E}, ${Y}, 1, 5, '1900', -100)`;
      }),
    );
    expect(err.message).toContain("posted in an earlier transaction");
    const [c] = await sql`select count(*)::int as n from posting where nr = 1`;
    expect(c.n).toBe(3);
  });

  test("lines added in the same transaction, across a savepoint, are fine", async () => {
    // post_voucher inserts the header inside a subtransaction; the fence must
    // recognise the current transaction's subtransactions as its own
    for (let i = 0; i < 5; i++) await post(sql, voucher(`pv${i}`, sale));
    await sql.begin(async (tx) => {
      await tx`savepoint header`;
      await tx`
        insert into voucher (entity, year, nr, document_date, posting_date, period, description, idempotency_key)
        values (${E}, ${Y}, 6, '2026-01-15', '2026-01-15', 1, 'direct', 'direct-6')`;
      await tx`release savepoint header`;
      await tx`insert into posting (entity, year, nr, line, account, amount) values (${E}, ${Y}, 6, 1, '1920', 100)`;
      await tx`savepoint lines`;
      await tx`insert into posting (entity, year, nr, line, account, amount) values (${E}, ${Y}, 6, 2, '1900', -100)`;
      await tx`release savepoint lines`;
    });
    const [c] = await sql`select count(*)::int as n from posting where nr = 6`;
    expect(c.n).toBe(2);
    const [v] = await sql`select count(*)::int as n from voucher`;
    expect(v.n).toBe(6);
  });
});

// ---------------------------------------------------------------------------
describe("created_by / closed_by record the caller", () => {
  const agentRole = `hovedbok_agent_${process.pid}`;

  test("a login role posting through the commands is named, not the definer", async () => {
    await sql.unsafe(`create role "${agentRole}" login password 'agent' in role hovedbok_app`);
    try {
      const u = new URL(databaseUrl);
      u.username = agentRole;
      u.password = "agent";
      u.pathname = `/${testDbName}`;
      const agent = new SQL(u.toString(), { max: 1 });
      try {
        const [{ who }] = await agent`select current_user as who`;
        expect(who).toBe(agentRole);
        expect((await post(agent, voucher("by-agent", sale))).nr).toBe(1);
        await agent`select close_period(${E}, ${Y}::smallint, 2::smallint)`;
      } finally {
        await agent.end();
      }
      const [v] = await sql`select created_by from voucher where nr = 1`;
      expect(v.created_by).toBe(agentRole);
      const [p] = await sql`select closed_by from period where entity = ${E} and year = ${Y} and nr = 2`;
      expect(p.closed_by).toBe(agentRole);
      // an adapter that knows the principal may name it explicitly
      await post(sql, voucher("named", sale, { created_by: "agent:claude/session-1" }));
      const [n] = await sql`select created_by from voucher where nr = 2`;
      expect(n.created_by).toBe("agent:claude/session-1");
    } finally {
      await sql.unsafe(`drop role "${agentRole}"`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("VAT lines", () => {
  test("an uncoded line on a VAT account is refused (vat_summary would drop it)", async () => {
    const err = await pgError(
      post(sql, voucher("x", [
        { account: "1920", amount: 12500 },
        { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
        { account: "2700", amount: -2500 },
      ])),
    );
    expect(err.message).toContain("line 3 of 3 (account 2700, -2500 øre): account 2700 is an output-VAT account");
    expect(err.message).toContain("must carry a vat_code");
    // custom accounts mapped to a standard VAT account get the same rule
    await sql`select upsert_account(${{ entity: E, code: "2719", name: "Inngående mva, spesial", std_account: "2710" }}::jsonb)`;
    const custom = await pgError(
      post(sql, voucher("y", [{ account: "2719", amount: 2500 }, { account: "1920", amount: -2500 }])),
    );
    expect(custom.message).toContain("account 2719 is an input-VAT account (standard account 2710)");
    const [c] = await sql`select count(*)::int as n from voucher`;
    expect(c.n).toBe(0);
  });

  test("vat_base lives on the base line only, and needs a code", async () => {
    let err = await pgError(
      post(sql, voucher("x", [
        { account: "1920", amount: 12500 },
        { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
        { account: "2700", amount: -2500, vat_code: "3", vat_base: -10000 },
      ])),
    );
    expect(err.message).toContain("line 3 of 3");
    expect(err.message).toContain("vat_base belongs on the base line");
    err = await pgError(
      post(sql, voucher("y", [{ account: "1920", amount: 100, vat_base: 100 }, { account: "1900", amount: -100 }])),
    );
    expect(err.message).toContain("vat_base on account 1920 needs a vat_code");
    // the README voucher is the convention
    expect((await post(sql, voucher("ok", sale))).nr).toBe(1);
    const [s] = await sql`select base::int, output_vat::int from vat_summary where entity = ${E}`;
    expect(s).toEqual({ base: -10000, output_vat: -2500 });
  });

  test("code kind vs account, where unambiguous", async () => {
    const cases: [string, Line[], string][] = [
      ["input code on revenue", [
        { account: "1920", amount: 12500 },
        { account: "3000", amount: -10000, vat_code: "1", vat_base: -10000 },
        { account: "2700", amount: -2500, vat_code: "3" },
      ], "vat code 1 is input VAT; it cannot go on revenue account 3000"],
      ["input code on an output-VAT account", [
        { account: "1920", amount: 12500 },
        { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
        { account: "2700", amount: -2500, vat_code: "1" },
      ], "vat code 1 is input VAT; account 2700 is an output-VAT account"],
      ["output code on an input-VAT account", [
        { account: "6300", amount: 8000, vat_code: "1", vat_base: 8000 },
        { account: "2710", amount: 2000, vat_code: "3" },
        { account: "2400", amount: -10000, party: "L1" },
      ], "vat code 3 is output VAT; account 2710 is an input-VAT account"],
      ["base-only code on a VAT account", [
        { account: "1920", amount: 12500 },
        { account: "3100", amount: -10000, vat_code: "52", vat_base: -10000 },
        { account: "2700", amount: -2500, vat_code: "52" },
      ], "vat code 52 carries no VAT amount (kind zero)"],
      ["reverse charge on revenue", [
        { account: "1920", amount: 10000 },
        { account: "3000", amount: -10000, vat_code: "86", vat_base: -10000 },
      ], "vat code 86 is a purchase regime (kind reverse_charge)"],
    ];
    for (const [name, lines, msg] of cases) {
      const err = await pgError(post(sql, voucher(name, lines)));
      expect({ name, message: err.message }).toEqual({ name, message: expect.stringContaining(msg) });
    }
    // allowed: a purchase, a zero-rated export, output VAT corrected from a loss on receivables
    await post(sql, voucher("buy", [
      { account: "6300", amount: 8000, vat_code: "1", vat_base: 8000 },
      { account: "2710", amount: 2000, vat_code: "1" },
      { account: "2400", amount: -10000, party: "L1" },
    ]));
    await post(sql, voucher("export", [
      { account: "1500", amount: 10000, party: "K1" },
      { account: "3105", amount: -10000, vat_code: "52", vat_base: -10000 },
    ]));
    await post(sql, voucher("loss", [
      { account: "7830", amount: 8000, vat_code: "3", vat_base: 8000 },
      { account: "2700", amount: 2000, vat_code: "3" },
      { account: "1500", amount: -10000, party: "K1" },
    ]));
    const [c] = await sql`select count(*)::int as n from voucher`;
    expect(c.n).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("post_voucher says which line failed and why", () => {
  test("missing fields are listed together", async () => {
    const err = await pgError(post(sql, { lines: sale }));
    expect(err.message).toBe("missing required field(s): entity, posting_date, idempotency_key");
    const bad = await pgError(post(sql, voucher("d", sale, { posting_date: "15.01.2026" })));
    expect(bad.message).toContain("posting_date 15.01.2026 is not a date");
    const ent = await pgError(post(sql, voucher("e", sale, { entity: "111111111" })));
    expect(ent.message).toContain("entity 111111111 does not exist");
    expect(ent.errno).toBe("23503");
  });

  test("line shape: unknown account, non-integer or zero amount, no lines", async () => {
    let err = await pgError(post(sql, voucher("a", [{ account: "1920", amount: 100 }, { account: "9999", amount: -100 }])));
    expect(err.message).toContain("line 2 of 2: account 9999 is not in the chart of entity 999888777");
    expect(err.errno).toBe("23503");
    err = await pgError(post(sql, voucher("b", [{ account: "1920", amount: 100.5 }, { account: "1900", amount: -100.5 }])));
    expect(err.message).toContain("line 1 of 2 (account 1920): amount must be an integer number of øre, got 100.5");
    err = await pgError(post(sql, voucher("c", [{ account: "1920", amount: 0 }, { account: "1900", amount: 0 }])));
    expect(err.message).toContain("line 1 of 2 (account 1920): amount must not be zero");
    err = await pgError(post(sql, voucher("d", [{ account: "1920" } as Line, { account: "1900", amount: -1 }])));
    expect(err.message).toContain("amount must be an integer number of øre, got nothing");
    err = await pgError(post(sql, voucher("e", [], { lines: "nope" })));
    expect(err.message).toContain("at least 2 lines");
    err = await pgError(post(sql, voucher("f", sale, { documents: ["b".repeat(64)] })));
    expect(err.message).toContain(`document ${"b".repeat(64)} is not registered`);
    const [c] = await sql`select last_voucher_nr as n from fiscal_year where entity = ${E}`;
    expect(c.n).toBe(0);
  });

  test("invariant failures carry the line, account and amount, and keep their SQLSTATE", async () => {
    const err = await pgError(
      post(sql, voucher("a", [{ account: "1920", amount: 100 }, { account: "1500", amount: -100 }])),
    );
    expect(err.message).toBe("line 2 of 2 (account 1500, -100 øre): account 1500 is a customer control account; party is required (BF § 3-1)");
    expect(err.errno).toBe("P0001");
    const fk = await pgError(
      post(sql, voucher("b", [{ account: "1920", amount: 100 }, { account: "1500", amount: -100, party: "NOPE" }])),
    );
    expect(fk.message).toContain("line 2 of 2 (account 1500, -100 øre):");
    expect(fk.errno).toBe("23503");
  });

  test("period 13 takes 31.12 only", async () => {
    const err = await pgError(post(sql, voucher("p13", sale, { period: 13 })));
    expect(err.message).toBe("period 13 (year-end closing) does not cover 2026-01-15: it only takes posting_date 2026-12-31");
    const [c] = await sql`select last_voucher_nr as n from fiscal_year where entity = ${E}`;
    expect(c.n).toBe(0);
    expect((await post(sql, voucher("ye", sale, { posting_date: "2026-12-31", period: 13 }))).nr).toBe(1);
    // the trigger holds the rule on its own, even if the period's dates were widened
    await sql`update period set date_from = '2026-12-01' where entity = ${E} and year = ${Y} and nr = 13`;
    const direct = await pgError(
      sql.begin(async (tx) => {
        await tx`
          insert into voucher (entity, year, nr, document_date, posting_date, period, description, idempotency_key)
          values (${E}, ${Y}, 2, '2026-12-15', '2026-12-15', 13, 'direct', 'direct-2')`;
      }),
    );
    expect(direct.message).toContain("period 13 (year-end closing) does not cover 2026-12-15");
    const month = await pgError(post(sql, voucher("m", sale, { posting_date: "2026-12-15", period: 11 })));
    expect(month.message).toContain("does not cover");
  });
});

// ---------------------------------------------------------------------------
describe("close_period serialises with in-flight postings", () => {
  test("a posting that waited on an in-flight close sees the period closed", async () => {
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      const [{ pid }] = await a`select pg_backend_pid() as pid`;
      await b`begin`;
      await b`select close_period(${E}, ${Y}::smallint, 1::smallint)`;
      const posting = post(a, voucher("late", sale));
      await waitUntilBlocked(pid);
      await b`commit`;
      const err = await pgError(posting);
      expect(err.message).toContain("closed");
    } finally {
      a.release();
      b.release();
    }
    const [c] = await sql`select count(*)::int as n from voucher`;
    expect(c.n).toBe(0);
  });

  test("a close that waited on an in-flight posting closes after it", async () => {
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      const [{ pid }] = await b`select pg_backend_pid() as pid`;
      await a`begin`;
      await post(a, voucher("early", sale));
      // .execute(): a bare tagged template is lazy and would only run when awaited
      const closing = b`select close_period(${E}, ${Y}::smallint, 1::smallint)`.execute();
      await waitUntilBlocked(pid);
      await a`commit`;
      await closing;
    } finally {
      a.release();
      b.release();
    }
    const [c] = await sql`select count(*)::int as n from voucher where period = 1`;
    expect(c.n).toBe(1);
  });
});
