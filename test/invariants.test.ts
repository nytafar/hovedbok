// The constitution: every ledger invariant, proven against the real database.
// If one of these fails, the schema is wrong or the test misreads it — never
// weaken a trigger, constraint or grant to make it pass (AGENTS.md).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { dropTestDb, freshDb } from "./helper";

const E = "999888777";
const Y = 2026;

let sql: SQL;

beforeEach(async () => {
  sql = await freshDb();
  await seed(sql);
});
afterAll(dropTestDb);

async function seed(db: SQL): Promise<void> {
  await db`insert into entity (orgnr, name, vat_registered) values (${E}, 'Test AS', true)`;
  await db`select ensure_fiscal_year(${E}, ${Y}::smallint)`;
  await db`
    insert into account (entity, code, name, std_account, control) values
      (${E}, '1920', 'Bank', '1920', null),
      (${E}, '3000', 'Salgsinntekt', '3000', null),
      (${E}, '2700', 'Utgående mva', '2700', null),
      (${E}, '1500', 'Kundefordringer', '1500', 'customer'),
      (${E}, '2400', 'Leverandørgjeld', '2400', 'supplier')`;
  await db`
    insert into party (entity, id, name, customer, supplier) values
      (${E}, 'K1', 'Kunde AS', true, false),
      (${E}, 'L1', 'Leverandør AS', false, true)`;
  await db`
    insert into vat_code (code, description, description_nb, kind) values
      ('3', 'Output VAT, high rate', 'Utgående mva, høy sats', 'output'),
      ('99', 'Rate only from 2027', 'Sats først fra 2027', 'output')`;
  await db`
    insert into vat_rate (code, valid_from, rate) values
      ('3', '2026-01-01', 25), ('99', '2027-01-01', 25)`;
}

type Line = { account: string; amount: number; party?: string; vat_code?: string; vat_base?: number };

const simpleLines: Line[] = [
  { account: "1920", amount: 12500 },
  { account: "3000", amount: -12500 },
];

function voucher(key: string, over: Record<string, unknown> = {}) {
  return {
    entity: E,
    posting_date: "2026-01-15",
    description: `voucher ${key}`,
    idempotency_key: key,
    lines: simpleLines,
    ...over,
  };
}

type Posted = { entity: string; year: number; nr: number; idempotent: boolean };

async function post(db: SQL, p: object): Promise<Posted> {
  const [row] = await db`select post_voucher(${p}::jsonb) as r`;
  return row.r as Posted;
}

/** Awaits a promise that must reject with a Postgres error; returns the error. */
async function pgError(p: Promise<unknown>): Promise<{ errno: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { errno: string; message: string };
  }
  throw new Error("expected a database error, but the statement succeeded");
}

/** Runs fn in a transaction with `set local role` — the roles are NOLOGIN. */
function as<T>(role: "hovedbok_app" | "hovedbok_ro", fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

async function lastNr(db: SQL): Promise<number> {
  const [r] = await db`select last_voucher_nr as n from fiscal_year where entity = ${E} and year = ${Y}`;
  return r.n;
}

async function voucherNrs(db: SQL): Promise<number[]> {
  const rows = await db`select nr from voucher where entity = ${E} and year = ${Y} order by nr`;
  return rows.map((r: { nr: number }) => r.nr);
}

/** Direct owner-level insert of a voucher header (bypasses post_voucher). */
function insertVoucherHeader(tx: SQL, nr: number, extra: { reverses_nr?: number } = {}) {
  const rev = extra.reverses_nr ?? null;
  return tx`
    insert into voucher (entity, year, nr, document_date, posting_date, period,
                         description, idempotency_key, reverses_year, reverses_nr)
    values (${E}, ${Y}, ${nr}, '2026-01-15', '2026-01-15', 1, 'direct', ${`direct-${nr}`},
            ${rev === null ? null : Y}, ${rev})`;
}

function insertPosting(tx: SQL, nr: number, line: number, account: string, amount: number) {
  return tx`
    insert into posting (entity, year, nr, line, account, amount)
    values (${E}, ${Y}, ${nr}, ${line}, ${account}, ${amount})`;
}

/** Resolves once `pid` is waiting on a lock. */
async function waitUntilBlocked(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const [r] = await sql`
      select wait_event_type from pg_stat_activity where pid = ${pid}`;
    if (r?.wait_event_type === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

// ---------------------------------------------------------------------------
describe("balance: every voucher sums to zero with at least two lines", () => {
  test("post_voucher refuses unbalanced lines and fewer than two lines", async () => {
    const unbalanced = await pgError(
      post(sql, voucher("u", { lines: [{ account: "1920", amount: 100 }, { account: "3000", amount: -99 }] })),
    );
    expect(unbalanced.message).toContain("do not balance");
    const single = await pgError(post(sql, voucher("s", { lines: [{ account: "1920", amount: 100 }] })));
    expect(single.message).toContain("at least 2 lines");
    expect(await voucherNrs(sql)).toEqual([]);
  });

  test("unbalanced direct insert is rejected at commit by the deferred trigger", async () => {
    let reachedEnd = false;
    const err = await pgError(
      sql.begin(async (tx) => {
        await insertVoucherHeader(tx, 1);
        await insertPosting(tx, 1, 1, "1920", 100);
        await insertPosting(tx, 1, 2, "3000", -50);
        // still inside the transaction: the check is deferred, nothing raised yet
        const [r] = await tx`select sum(amount)::int as s from posting where nr = 1`;
        expect(r.s).toBe(50);
        reachedEnd = true;
      }),
    );
    expect(reachedEnd).toBe(true);
    expect(err.message).toContain("does not balance");
    expect(await voucherNrs(sql)).toEqual([]);
  });

  test("single-line direct insert is rejected at commit", async () => {
    const err = await pgError(
      sql.begin(async (tx) => {
        await insertVoucherHeader(tx, 1);
        await insertPosting(tx, 1, 1, "1920", 100);
      }),
    );
    expect(err.message).toContain("at least 2 lines");
  });

  test("voucher with no lines at all is rejected at commit", async () => {
    const err = await pgError(sql.begin(async (tx) => void (await insertVoucherHeader(tx, 1))));
    expect(err.message).toContain("at least 2 lines");
    expect(await voucherNrs(sql)).toEqual([]);
  });

  test("balanced direct insert by the owner commits (positive control)", async () => {
    await sql.begin(async (tx) => {
      await insertVoucherHeader(tx, 1);
      await insertPosting(tx, 1, 1, "1920", 100);
      await insertPosting(tx, 1, 2, "3000", -100);
    });
    expect(await voucherNrs(sql)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
describe("append-only facts", () => {
  async function seedFacts(): Promise<void> {
    await post(sql, voucher("a"));
    await sql`
      insert into document (sha256, media_type, bytes, origin)
      values (${"a".repeat(64)}, 'application/pdf', 10, 'receipt')`;
    await sql`
      insert into bank_account (id_hash, entity, ledger_account) values ('h1', ${E}, '1920')`;
    await sql`
      insert into bank_transaction (id_hash, dedup_key, booking_date, amount, raw)
      values ('h1', 'k1', '2026-01-15', 12500, '{}')`;
  }

  const mutations: [string, string][] = [
    ["voucher", "update voucher set description = 'x'"],
    ["voucher", "delete from voucher"],
    ["posting", "update posting set amount = -amount"],
    ["posting", "delete from posting"],
    ["document", "update document set note = 'x'"],
    ["document", "delete from document"],
    ["bank_transaction", "update bank_transaction set amount = 1"],
    ["bank_transaction", "delete from bank_transaction"],
  ];

  test("UPDATE/DELETE is rejected for the table owner (trigger backstop)", async () => {
    await seedFacts();
    const [{ owner, isSuper }] = await sql`
      select pg_get_userbyid(relowner) = current_user as owner,
             (select rolsuper from pg_roles where rolname = current_user) as "isSuper"
        from pg_class where relname = 'voucher'`;
    expect(owner).toBe(true); // we really are the owner (and superuser)
    expect(isSuper).toBe(true);
    for (const [table, stmt] of mutations) {
      const err = await pgError(sql.unsafe(stmt));
      expect(err.message).toContain(`${table} is append-only`);
    }
    const [c] = await sql`
      select (select count(*)::int from voucher) as v, (select count(*)::int from posting) as p,
             (select count(*)::int from document) as d,
             (select count(*)::int from bank_transaction) as b`;
    expect(c).toEqual({ v: 1, p: 2, d: 1, b: 1 });
  });

  test("UPDATE/DELETE is rejected for hovedbok_app (no privilege)", async () => {
    await seedFacts();
    for (const [, stmt] of mutations) {
      const err = await pgError(as("hovedbok_app", (tx) => tx.unsafe(stmt)));
      expect(err.errno).toBe("42501");
    }
  });
});

// ---------------------------------------------------------------------------
describe("periods", () => {
  test("posting into a closed period is rejected and burns no number", async () => {
    await post(sql, voucher("before"));
    await sql`select close_period(${E}, ${Y}::smallint, 1::smallint)`;
    const err = await pgError(post(sql, voucher("after", { posting_date: "2026-01-20" })));
    expect(err.message).toContain("missing, closed, or does not cover");
    expect(await lastNr(sql)).toBe(1);
    // other periods stay open
    expect((await post(sql, voucher("feb", { posting_date: "2026-02-01" }))).nr).toBe(2);
  });

  test("posting_date outside the voucher's period is rejected", async () => {
    const err = await pgError(post(sql, voucher("p13", { posting_date: "2026-01-15", period: 13 })));
    expect(err.message).toContain("does not cover");
    expect((await post(sql, voucher("ye", { posting_date: "2026-12-31", period: 13 }))).nr).toBe(1);
  });

  test("a closed period cannot reopen, even for the owner", async () => {
    await sql`select close_period(${E}, ${Y}::smallint, 1::smallint)`;
    const err = await pgError(
      sql`update period set status = 'open' where entity = ${E} and year = ${Y} and nr = 1`,
    );
    expect(err.message).toContain("cannot reopen");
    const again = await pgError(sql`select close_period(${E}, ${Y}::smallint, 1::smallint)`);
    expect(again.message).toContain("is not open");
    const [p] = await sql`select status from period where entity = ${E} and year = ${Y} and nr = 1`;
    expect(p.status).toBe("closed");
  });

  test("hovedbok_app cannot update periods directly", async () => {
    const err = await pgError(as("hovedbok_app", (tx) => tx`update period set status = 'closed'`));
    expect(err.errno).toBe("42501");
  });
});

// ---------------------------------------------------------------------------
describe("idempotency on (entity, idempotency_key)", () => {
  test("the same key returns the same voucher", async () => {
    const first = await post(sql, voucher("same"));
    expect(first).toEqual({ entity: E, year: Y, nr: 1, idempotent: false });
    // even with a different payload: the key identifies the operation
    const second = await post(sql, voucher("same", { description: "retry", posting_date: "2026-02-01" }));
    expect(second).toEqual({ entity: E, year: Y, nr: 1, idempotent: true });
    expect(await voucherNrs(sql)).toEqual([1]);
    expect(await lastNr(sql)).toBe(1);
  });

  test("a concurrent race on one key yields one voucher and no gap", async () => {
    const a = await sql.reserve();
    const b = await sql.reserve();
    try {
      const [{ pid: bPid }] = await b`select pg_backend_pid() as pid`;
      await a`begin`;
      await b`begin`;
      const ra = await post(a, voucher("race"));
      // b collides with a's uncommitted voucher and must wait for it
      const rb = post(b, voucher("race"));
      await waitUntilBlocked(bPid);
      await a`commit`;
      const rbDone = await rb;
      await b`commit`;
      expect(ra).toEqual({ entity: E, year: Y, nr: 1, idempotent: false });
      expect(rbDone).toEqual({ entity: E, year: Y, nr: 1, idempotent: true });
    } finally {
      a.release();
      b.release();
    }
    expect(await voucherNrs(sql)).toEqual([1]);
    expect(await lastNr(sql)).toBe(1);
    expect((await post(sql, voucher("next"))).nr).toBe(2);
  });

  test("many simultaneous posts of one key yield one voucher", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(sql, voucher("herd"))),
    );
    expect(new Set(results.map((r) => r.nr))).toEqual(new Set([1]));
    expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
    expect(await lastNr(sql)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("reversals", () => {
  const vatLines: Line[] = [
    { account: "1500", amount: 12500, party: "K1" },
    { account: "3000", amount: -10000 },
    { account: "2700", amount: -2500, vat_code: "3", vat_base: -10000 },
  ];

  test("reverse_voucher posts the exact negation, idempotently", async () => {
    await post(sql, voucher("orig", { lines: vatLines }));
    const [r] = await sql`select reverse_voucher(${E}, ${Y}::smallint, 1, '2026-02-01') as r`;
    expect(r.r).toEqual({ entity: E, year: Y, nr: 2, idempotent: false });
    const [again] = await sql`select reverse_voucher(${E}, ${Y}::smallint, 1, '2026-02-01') as r`;
    expect(again.r).toEqual({ entity: E, year: Y, nr: 2, idempotent: true });
    const [net] = await sql`
      select count(*)::int as n from (
        select account, coalesce(vat_code, ''), coalesce(party, '')
          from posting group by 1, 2, 3
        having sum(amount) <> 0 or coalesce(sum(vat_base), 0) <> 0) x`;
    expect(net.n).toBe(0);
    const [v] = await sql`select reverses_year, reverses_nr from voucher where nr = 2`;
    expect(v).toEqual({ reverses_year: Y, reverses_nr: 1 });
  });

  test("a tampered reversal (not an exact negation) is rejected at commit", async () => {
    await post(sql, voucher("orig"));
    const tampered: [string, number][][] = [
      [["1920", -12000], ["3000", 12000]], // wrong amounts, still balanced
      [["2700", -12500], ["3000", 12500]], // wrong account
      [["1920", -12500], ["3000", 12500], ["2700", 1], ["2700", -1]], // extra lines
    ];
    for (const lines of tampered) {
      const err = await pgError(
        sql.begin(async (tx) => {
          await insertVoucherHeader(tx, 2, { reverses_nr: 1 });
          for (const [i, [acc, amt]] of lines.entries()) await insertPosting(tx, 2, i + 1, acc, amt);
        }),
      );
      expect(err.message).toContain("does not exactly negate");
    }
    // the exact negation through the same direct path is accepted
    await sql.begin(async (tx) => {
      await insertVoucherHeader(tx, 2, { reverses_nr: 1 });
      await insertPosting(tx, 2, 1, "3000", 12500);
      await insertPosting(tx, 2, 2, "1920", -12500);
    });
    expect(await voucherNrs(sql)).toEqual([1, 2]);
  });

  test("a tampered vat_base or party in a reversal is rejected", async () => {
    await post(sql, voucher("orig", { lines: vatLines }));
    const bad = [
      { ...vatLines[0]!, amount: -12500, party: undefined as string | undefined },
      { ...vatLines[1]!, amount: 10000 },
      { ...vatLines[2]!, amount: 2500, vat_base: 9999 },
    ];
    // vat_base off by one
    let err = await pgError(
      post(sql, voucher("rev-vat", {
        reverses: { year: Y, nr: 1 },
        lines: [{ ...bad[0], party: "K1" }, bad[1], bad[2]],
      })),
    );
    expect(err.message).toContain("does not exactly negate");
    // party swapped (L1 is not a customer, so use a second customer)
    await sql`insert into party (entity, id, name, customer) values (${E}, 'K2', 'Annen kunde', true)`;
    err = await pgError(
      post(sql, voucher("rev-party", {
        reverses: { year: Y, nr: 1 },
        lines: [{ ...bad[0], party: "K2" }, bad[1], { ...bad[2], vat_base: 10000 }],
      })),
    );
    expect(err.message).toContain("does not exactly negate");
    expect(await voucherNrs(sql)).toEqual([1]);
    expect(await lastNr(sql)).toBe(1);
  });

  test("a voucher can be reversed only once", async () => {
    await post(sql, voucher("orig"));
    await sql`select reverse_voucher(${E}, ${Y}::smallint, 1, '2026-02-01')`;
    const err = await pgError(
      post(sql, voucher("second-reversal", {
        posting_date: "2026-02-02",
        reverses: { year: Y, nr: 1 },
        lines: [{ account: "1920", amount: -12500 }, { account: "3000", amount: 12500 }],
      })),
    );
    expect(err.errno).toBe("23505");
    expect(err.message).toContain("reverses");
    expect(await voucherNrs(sql)).toEqual([1, 2]);
    expect(await lastNr(sql)).toBe(2);
  });

  test("a reversal can itself be reversed", async () => {
    await post(sql, voucher("orig"));
    await sql`select reverse_voucher(${E}, ${Y}::smallint, 1, '2026-02-01')`;
    const [r] = await sql`select reverse_voucher(${E}, ${Y}::smallint, 2, '2026-02-02') as r`;
    expect(r.r).toEqual({ entity: E, year: Y, nr: 3, idempotent: false });
    const rows = await sql`select nr, reverses_nr from voucher order by nr`;
    expect(rows.map((x: { nr: number; reverses_nr: number | null }) => [x.nr, x.reverses_nr])).toEqual([
      [1, null],
      [2, 1],
      [3, 2],
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("gapless numbering", () => {
  test("concurrent post_voucher calls produce consecutive numbers", async () => {
    const n = 25;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => post(sql, voucher(`c${i}`))),
    );
    const nrs = results.map((r) => r.nr).sort((x, y) => x - y);
    expect(nrs).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(await voucherNrs(sql)).toEqual(nrs);
    expect(await lastNr(sql)).toBe(n);
  });

  test("a failed insert burns no number", async () => {
    expect((await post(sql, voucher("ok1"))).nr).toBe(1);
    // fails after the counter bump and voucher insert, on a posting line
    const err = await pgError(
      post(sql, voucher("bad", { lines: [{ account: "1500", amount: 100 }, { account: "3000", amount: -100 }] })),
    );
    expect(err.message).toContain("party is required");
    expect(await lastNr(sql)).toBe(1);
    expect((await post(sql, voucher("ok2"))).nr).toBe(2);
  });

  test("failures interleaved with concurrent successes leave no gaps", async () => {
    const jobs = Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0
        ? post(sql, voucher(`bad${i}`, { lines: [{ account: "2400", amount: 5 }, { account: "1920", amount: -5 }] }))
            .then(() => "unexpected success", () => "failed")
        : post(sql, voucher(`good${i}`)).then((r) => r.nr),
    );
    const out = await Promise.all(jobs);
    const nrs = out.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    expect(out.filter((x) => x === "failed")).toHaveLength(7);
    expect(nrs).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(await lastNr(sql)).toBe(13);
  });
});

// ---------------------------------------------------------------------------
describe("line checks", () => {
  test("a control account requires a party", async () => {
    const err = await pgError(
      post(sql, voucher("x", { lines: [{ account: "1500", amount: 100 }, { account: "3000", amount: -100 }] })),
    );
    expect(err.message).toContain("party is required");
  });

  test("a control account requires a party with the matching role", async () => {
    let err = await pgError(
      post(sql, voucher("x", { lines: [{ account: "1500", amount: 100, party: "L1" }, { account: "3000", amount: -100 }] })),
    );
    expect(err.message).toContain("does not have the customer role");
    err = await pgError(
      post(sql, voucher("y", { lines: [{ account: "2400", amount: -100, party: "K1" }, { account: "1920", amount: 100 }] })),
    );
    expect(err.message).toContain("does not have the supplier role");
    err = await pgError(
      post(sql, voucher("z", { lines: [{ account: "1500", amount: 100, party: "NOPE" }, { account: "3000", amount: -100 }] })),
    );
    expect(err.errno).toBe("23503"); // unknown party: foreign key
    expect(await voucherNrs(sql)).toEqual([]);
    // matching roles pass
    await post(sql, voucher("ok-c", { lines: [{ account: "1500", amount: 100, party: "K1" }, { account: "3000", amount: -100 }] }));
    await post(sql, voucher("ok-s", { lines: [{ account: "2400", amount: -100, party: "L1" }, { account: "1920", amount: 100 }] }));
    expect(await voucherNrs(sql)).toEqual([1, 2]);
  });

  test("a vat code requires a rate valid on the posting date", async () => {
    const line = (code: string, date: string, key: string) =>
      voucher(key, {
        posting_date: date,
        lines: [
          { account: "1920", amount: 2500 },
          { account: "2700", amount: -2500, vat_code: code, vat_base: -10000 },
        ],
      });
    const err = await pgError(post(sql, line("99", "2026-06-30", "early")));
    expect(err.message).toContain("no rate valid on 2026-06-30");
    // a code valid from 2026-01-01 is fine on that date
    expect((await post(sql, line("3", "2026-01-01", "valid"))).nr).toBe(1);
    // unknown code: the row trigger refuses it before the foreign key is checked
    const unknown = await pgError(post(sql, line("nope", "2026-06-30", "unknown")));
    expect(unknown.message).toContain("vat code nope has no rate");
    expect(await voucherNrs(sql)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
describe("the role wall", () => {
  const commands = [
    "select ensure_fiscal_year('999888777', 2027::smallint)",
    `select post_voucher('${JSON.stringify(voucher("ro"))}'::jsonb)`,
    "select reverse_voucher('999888777', 2026::smallint, 1, '2026-02-01')",
    "select close_period('999888777', 2026::smallint, 2::smallint)",
  ];

  async function relations(): Promise<string[]> {
    const rows = await sql`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p') order by 1`;
    return rows.map((r: { relname: string }) => r.relname);
  }

  test("hovedbok_ro can SELECT every table and view", async () => {
    await post(sql, voucher("seen"));
    const rels = await relations();
    expect(rels).toContain("voucher");
    expect(rels).toContain("journal");
    await as("hovedbok_ro", async (tx) => {
      for (const rel of rels) await tx.unsafe(`select * from "${rel}" limit 1`);
      const [j] = await tx`select count(*)::int as n from journal`;
      expect(j.n).toBe(2);
    });
  });

  test("hovedbok_ro can EXECUTE no function", async () => {
    await post(sql, voucher("orig"));
    // catalog: no callable (non-trigger) function in public is executable by ro
    const exec = await sql`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
         and has_function_privilege('hovedbok_ro', p.oid, 'execute')`;
    expect(exec).toHaveLength(0);
    // and in practice: every command is refused
    for (const cmd of commands) {
      const err = await pgError(as("hovedbok_ro", (tx) => tx.unsafe(cmd)));
      expect(err.errno).toBe("42501");
    }
    expect(await voucherNrs(sql)).toEqual([1]);
  });

  test("hovedbok_ro can write nothing", async () => {
    for (const rel of await relations()) {
      const [{ ins, upd, del }] = await sql`
        select has_table_privilege('hovedbok_ro', ${rel}, 'insert') as ins,
               has_table_privilege('hovedbok_ro', ${rel}, 'update') as upd,
               has_table_privilege('hovedbok_ro', ${rel}, 'delete') as del`;
      expect({ rel, ins, upd, del }).toEqual({ rel, ins: false, upd: false, del: false });
    }
  });

  test("hovedbok_app cannot INSERT/UPDATE/DELETE voucher or posting directly", async () => {
    await post(sql, voucher("orig"));
    const stmts = [
      `insert into voucher (entity, year, nr, document_date, posting_date, period, description, idempotency_key)
       values ('${E}', ${Y}, 2, '2026-01-15', '2026-01-15', 1, 'direct', 'direct')`,
      "update voucher set description = 'x'",
      "delete from voucher",
      "truncate voucher cascade",
      `insert into posting (entity, year, nr, line, account, amount) values ('${E}', ${Y}, 1, 3, '1920', 1)`,
      "update posting set amount = -amount",
      "delete from posting",
      "truncate posting",
      "update fiscal_year set last_voucher_nr = 0",
    ];
    for (const stmt of stmts) {
      const err = await pgError(as("hovedbok_app", (tx) => tx.unsafe(stmt)));
      expect(err.errno).toBe("42501");
    }
    expect(await voucherNrs(sql)).toEqual([1]);
  });

  test("hovedbok_app writes the journal through the commands (positive control)", async () => {
    const r = await as("hovedbok_app", async (tx) => {
      const posted = await post(tx, voucher("app"));
      await tx`select reverse_voucher(${E}, ${Y}::smallint, 1, '2026-02-01')`;
      await tx`select close_period(${E}, ${Y}::smallint, 1::smallint)`;
      return posted;
    });
    expect(r.nr).toBe(1);
    expect(await voucherNrs(sql)).toEqual([1, 2]);
  });
});
