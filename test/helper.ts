// Test database helper: every test gets a clean, just-migrated database.
//
// DATABASE_URL (default: the compose dev db) is only the maintenance
// connection — tests never touch its data. From it we build a template
// database named after a hash of db/migrations/*.sql, so it rebuilds itself
// whenever a migration changes, and clone a per-process test database from
// that template on every reset (CREATE DATABASE … TEMPLATE is a file copy:
// far cheaper than re-running migrations).
//
//   import { freshDb, dropTestDb } from "./helper";
//   let sql: SQL;
//   beforeEach(async () => { sql = await freshDb(); });
//   afterAll(dropTestDb);
//
// Needs CREATEDB on the DATABASE_URL user (the compose and CI superuser has it).
// Roles are cluster-level, so 0001's roles are shared by every clone.
import { SQL } from "bun";
import { defaultDatabaseUrl, migrate, migrationSources } from "../db/migrate";

export const databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;

const base = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
if (!/^[a-z0-9_]{1,40}$/.test(base)) {
  throw new Error(`test helper: unsupported database name ${JSON.stringify(base)}`);
}
const templatePrefix = `${base}_tpl_`;
const testPrefix = `${base}_test_`;
/** The database this process's tests run in. */
export const testDbName = `${testPrefix}${process.pid}`;

function urlFor(db: string): string {
  const u = new URL(databaseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

async function withAdmin<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  // One connection, so session-level advisory locks hold across statements.
  const sql = new SQL(databaseUrl, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function dropDatabase(sql: SQL, name: string): Promise<void> {
  await sql.unsafe(`alter database "${name}" is_template false`).catch(() => {});
  await sql.unsafe(`drop database if exists "${name}" with (force)`);
}

async function templateName(): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const { name, text } of await migrationSources()) {
    hasher.update(name).update("\0").update(text).update("\0");
  }
  return `${templatePrefix}${hasher.digest("hex").slice(0, 12)}`;
}

async function buildTemplate(): Promise<string> {
  const tpl = await templateName();
  await withAdmin(async (admin) => {
    // Serialise builders: concurrent `bun test` runs share the cluster.
    await admin`select pg_advisory_lock(hashtext(${templatePrefix}))`;
    try {
      const [row] = await admin`
        select datistemplate from pg_database where datname = ${tpl}`;
      if (row?.datistemplate) return; // built and sealed earlier

      // Missing, or a half-built leftover from a crashed run: (re)build.
      await dropDatabase(admin, tpl);
      await admin.unsafe(`create database "${tpl}"`);
      const db = new SQL(urlFor(tpl), { max: 1 });
      try {
        await migrate(db);
      } finally {
        await db.end();
      }
      // Seal: a template nobody can connect to (and therefore nobody can dirty).
      await admin.unsafe(
        `alter database "${tpl}" with is_template true allow_connections false`,
      );

      // Housekeeping: templates for older migration sets, and test databases
      // left behind by processes that no longer exist on this host.
      // Templates are only dropped when stale (registered > 2 h ago): parallel
      // runs from checkouts with different migration sets (e.g. a worktree)
      // each have a live template, and dropping by hash alone killed the
      // other run mid-flight.
      await admin.unsafe(
        `create table if not exists _tpl_registry
           (datname text primary key, created_at timestamptz not null default now())`,
      );
      await admin`
        insert into _tpl_registry (datname) values (${tpl})
        on conflict (datname) do update set created_at = now()`;
      // Adopt templates the registry doesn't know (crashed before registering),
      // so they age out on later runs instead of living forever.
      await admin`
        insert into _tpl_registry (datname)
        select datname from pg_database where starts_with(datname, ${templatePrefix})
        on conflict (datname) do nothing`;
      const stale = await admin`
        select d.datname from pg_database d
          join _tpl_registry r on r.datname = d.datname
         where (starts_with(d.datname, ${templatePrefix}) and d.datname <> ${tpl}
                and r.created_at < now() - interval '2 hours')
        union
        select datname from pg_database where starts_with(datname, ${testPrefix})`;
      for (const { datname } of stale as { datname: string }[]) {
        if (datname.startsWith(testPrefix) && pidAlive(datname.slice(testPrefix.length))) {
          continue;
        }
        await dropDatabase(admin, datname);
        await admin`delete from _tpl_registry where datname = ${datname}`;
      }
    } finally {
      await admin`select pg_advisory_unlock(hashtext(${templatePrefix}))`;
    }
  });
  return tpl;
}

function pidAlive(pid: string): boolean {
  if (!/^\d+$/.test(pid)) return false;
  if (Number(pid) === process.pid) return true;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

let template: Promise<string> | undefined;
let current: SQL | undefined;

/**
 * Drops this process's test database, clones it from the just-migrated
 * template and returns a client connected to it. Any client returned by an
 * earlier call is closed first.
 */
export async function freshDb(): Promise<SQL> {
  template ??= buildTemplate();
  const tpl = await template;
  await current?.end();
  current = undefined;
  await withAdmin(async (admin) => {
    await dropDatabase(admin, testDbName);
    await admin.unsafe(`create database "${testDbName}" template "${tpl}"`);
  });
  current = new SQL(urlFor(testDbName));
  return current;
}

/** Closes the current client and drops this process's test database. */
export async function dropTestDb(): Promise<void> {
  await current?.end();
  current = undefined;
  await withAdmin((admin) => dropDatabase(admin, testDbName));
}
