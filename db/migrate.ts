// Tiny migrator: applies db/migrations/*.sql in name order, once each,
// each file in its own transaction. No down migrations — the journal is
// append-only and so is its schema history.
import { SQL } from "bun";
import { readdir } from "node:fs/promises";

const url =
  process.env.DATABASE_URL ?? "postgres://hovedbok:hovedbok@localhost:5433/hovedbok";
const sql = new SQL(url);
const dir = new URL("./migrations/", import.meta.url);

const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
await sql.unsafe(
  `create table if not exists _migration
     (name text primary key, applied_at timestamptz not null default now())`,
);
const applied = new Set(
  (await sql`select name from _migration`).map((r: { name: string }) => r.name),
);

for (const file of files) {
  if (applied.has(file)) continue;
  const text = await Bun.file(new URL(file, dir)).text();
  await sql.begin(async (tx) => {
    await tx.unsafe(text);
    await tx`insert into _migration (name) values (${file})`;
  });
  console.log(`applied ${file}`);
}
await sql.end();
console.log(`${files.length} migrations in place`);
