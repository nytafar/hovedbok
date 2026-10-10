// Tiny migrator: applies db/migrations/*.sql in name order, once each,
// each file in its own transaction. No down migrations — the journal is
// append-only and so is its schema history.
import { SQL } from "bun";
import { readdir } from "node:fs/promises";

export const defaultDatabaseUrl =
  "postgres://hovedbok:hovedbok@localhost:5433/hovedbok";

const dir = new URL("./migrations/", import.meta.url);

/** Migration file names (*.sql) in the order they apply. */
export async function migrationFiles(): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

/** Migration file names with their SQL text, in apply order. */
export async function migrationSources(): Promise<{ name: string; text: string }[]> {
  const files = await migrationFiles();
  return Promise.all(
    files.map(async (name) => ({ name, text: await Bun.file(new URL(name, dir)).text() })),
  );
}

/** Applies pending migrations on `sql`; returns the names applied this run. */
export async function migrate(
  sql: SQL,
  log: (msg: string) => void = () => {},
): Promise<string[]> {
  const sources = await migrationSources();
  await sql.unsafe(
    `create table if not exists _migration
       (name text primary key, applied_at timestamptz not null default now())`,
  );
  const applied = new Set(
    (await sql`select name from _migration`).map((r: { name: string }) => r.name),
  );

  const ran: string[] = [];
  for (const { name, text } of sources) {
    if (applied.has(name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into _migration (name) values (${name})`;
    });
    log(`applied ${name}`);
    ran.push(name);
  }
  log(`${sources.length} migrations in place`);
  return ran;
}

if (import.meta.main) {
  const sql = new SQL(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  try {
    await migrate(sql, console.log);
  } finally {
    await sql.end();
  }
}
