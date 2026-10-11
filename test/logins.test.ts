// db/logins.ts: deploy creates one login per principal, bound to the NOLOGIN
// anchors (ADR-0010). Roles are cluster-level, so the test uses throwaway names
// and drops them itself.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { ensureLogins, loginsFromEnv } from "../db/logins";
import { databaseUrl } from "./helper";

const suffix = `${process.pid}_${Date.now().toString(36)}`;
const api = `t_api_${suffix}`;
const reader = `t_reader_${suffix}`;
let sql: SQL;

beforeAll(() => {
  sql = new SQL(databaseUrl);
});
afterAll(async () => {
  await sql.unsafe(`drop role if exists "${api}"`);
  await sql.unsafe(`drop role if exists "${reader}"`);
  await sql.end();
});

async function roleInfo(name: string) {
  const [r] = await sql`
    select rolcanlogin as login, rolsuper as superuser,
           pg_has_role(${name}, 'hovedbok_app', 'member') as app,
           pg_has_role(${name}, 'hovedbok_ro', 'member') as ro
      from pg_roles where rolname = ${name}`;
  return r;
}

test("creates login roles in their anchor role, and is idempotent", async () => {
  const spec = [
    { name: api, password: "pw-one", inRole: "hovedbok_app" as const },
    { name: reader, password: "pw-two", inRole: "hovedbok_ro" as const },
  ];
  expect(await ensureLogins(sql, spec)).toEqual([`created ${api}`, `created ${reader}`]);
  expect(await roleInfo(api)).toEqual({ login: true, superuser: false, app: true, ro: false });
  expect(await roleInfo(reader)).toEqual({ login: true, superuser: false, app: false, ro: true });

  // A second run keeps the roles and resets the password (rotation is an edit to .env).
  spec[0]!.password = "pw-rotated";
  expect(await ensureLogins(sql, spec)).toEqual([`updated ${api}`, `updated ${reader}`]);
  const u = new URL(databaseUrl);
  u.username = api;
  u.password = "pw-rotated";
  const asApi = new SQL(u.toString());
  try {
    const [r] = await asApi`select session_user as who`;
    expect(r.who).toBe(api);
  } finally {
    await asApi.end();
  }
});

test("loginsFromEnv maps the deploy variables and refuses a blank password", () => {
  expect(loginsFromEnv({ HOVEDBOK_API_PASSWORD: "a", HOVEDBOK_READER_PASSWORD: "b" })).toEqual([
    { name: "hovedbok_api", password: "a", inRole: "hovedbok_app" },
    { name: "hovedbok_reader", password: "b", inRole: "hovedbok_ro" },
  ]);
  expect(() => loginsFromEnv({ HOVEDBOK_API_PASSWORD: "a" })).toThrow(/HOVEDBOK_READER_PASSWORD/);
});
