import { afterAll, expect, test } from "bun:test";
import { migrationFiles } from "../db/migrate";
import { dropTestDb, freshDb, testDbName } from "./helper";

afterAll(dropTestDb);

test("freshDb is fully migrated, grants included", async () => {
  const sql = await freshDb();
  const [{ db }] = await sql`select current_database() as db`;
  expect(db).toBe(testDbName);

  const applied = await sql`select name from _migration order by name`;
  expect(applied.map((r: { name: string }) => r.name)).toEqual(await migrationFiles());

  const [priv] = await sql`
    select has_function_privilege('hovedbok_app', 'post_voucher(jsonb)', 'execute') as app,
           has_function_privilege('hovedbok_ro', 'post_voucher(jsonb)', 'execute') as ro,
           has_table_privilege('hovedbok_app', 'posting', 'insert') as app_posting_insert`;
  expect(priv).toEqual({ app: true, ro: false, app_posting_insert: false });
});

test("freshDb resets to a clean just-migrated state", async () => {
  let sql = await freshDb();
  await sql`insert into entity (orgnr, name) values ('999888777', 'Leftover AS')`;
  await sql`select ensure_fiscal_year('999888777', 2026::smallint)`;
  const [dirty] = await sql`select count(*)::int as n from period`;
  expect(dirty.n).toBe(13);

  sql = await freshDb();
  const [clean] = await sql`
    select (select count(*)::int from entity) as entities,
           (select count(*)::int from fiscal_year) as years,
           (select count(*)::int from period) as periods`;
  expect(clean).toEqual({ entities: 0, years: 0, periods: 0 });
});
