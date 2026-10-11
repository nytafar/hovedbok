// Deploy step: the login users, one per principal (ADR-0010), bound to the
// NOLOGIN anchors 0001 creates. Runs after `bun run migrate`, on the same
// owner connection: `bun db/logins.ts`. Idempotent — an existing role gets
// its password reset, so rotating a password is an edit to .env and a re-run.
//
//   HOVEDBOK_API_PASSWORD      -> hovedbok_api     login in role hovedbok_app
//   HOVEDBOK_READER_PASSWORD   -> hovedbok_reader  login in role hovedbok_ro
import { SQL } from "bun";
import { defaultDatabaseUrl } from "./migrate";

export interface Login {
  name: string;
  password: string;
  inRole: "hovedbok_app" | "hovedbok_ro";
}

/** The deploy's two logins from the environment; a missing password is an error. */
export function loginsFromEnv(env: Record<string, string | undefined>): Login[] {
  const spec = [
    ["hovedbok_api", "HOVEDBOK_API_PASSWORD", "hovedbok_app"],
    ["hovedbok_reader", "HOVEDBOK_READER_PASSWORD", "hovedbok_ro"],
  ] as const;
  return spec.map(([name, variable, inRole]) => {
    const password = env[variable];
    if (!password) throw new Error(`${variable} is required (the password for login role ${name})`);
    return { name, password, inRole };
  });
}

/** Creates or updates each login; returns one line per role. */
export async function ensureLogins(sql: SQL, logins: Login[]): Promise<string[]> {
  const out: string[] = [];
  for (const { name, password, inRole } of logins) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid role name ${JSON.stringify(name)}`);
    const [exists] = await sql`select 1 from pg_roles where rolname = ${name}`;
    // Passwords cannot be bound as parameters in CREATE/ALTER ROLE; quote them as literals.
    const pw = `'${password.replace(/'/g, "''")}'`;
    if (exists) {
      await sql.unsafe(`alter role "${name}" with login password ${pw}`);
      await sql.unsafe(`grant ${inRole} to "${name}"`);
      out.push(`updated ${name}`);
    } else {
      await sql.unsafe(`create role "${name}" with login password ${pw} in role ${inRole}`);
      out.push(`created ${name}`);
    }
  }
  return out;
}

if (import.meta.main) {
  const sql = new SQL(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  try {
    for (const line of await ensureLogins(sql, loginsFromEnv(process.env))) console.log(line);
  } finally {
    await sql.end();
  }
}
