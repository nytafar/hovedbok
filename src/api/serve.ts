// HTTP API entrypoint: `bun src/api/serve.ts`.
//
// Environment:
//   API_TOKEN          read-write bearer token (required)
//   API_RO_TOKEN       read-only bearer token (optional; GET only)
//   DATABASE_URL_APP   login in role hovedbok_app (default: $DATABASE_URL, else the compose dev db)
//   DATABASE_URL_RO    login in role hovedbok_ro (default: DATABASE_URL_APP — dev only)
//   DOCUMENTS_DIR      document blob root (default ./documents)
//   PORT               default 3000; HOST default 127.0.0.1
//
// hovedbok_app and hovedbok_ro are NOLOGIN privilege anchors (0001); deploy
// creates the login users: `create role <name> login password '…' in role hovedbok_app`.
import { SQL } from "bun";
import { defaultDatabaseUrl } from "../../db/migrate";
import { createApi } from "./app";

const env = process.env;
const rwToken = env.API_TOKEN;
if (!rwToken) {
  console.error("API_TOKEN is required (the read-write bearer token)");
  process.exit(1);
}
const rwUrl = env.DATABASE_URL_APP ?? env.DATABASE_URL ?? defaultDatabaseUrl;
const roUrl = env.DATABASE_URL_RO ?? rwUrl;

const rw = new SQL(rwUrl);
const ro = env.API_RO_TOKEN ? new SQL(roUrl) : undefined;

for (const [label, sql] of [["rw", rw], ["ro", ro]] as const) {
  if (!sql) continue;
  const [r] = await sql`
    select current_user as who, rolsuper as superuser,
           pg_has_role(current_user, 'hovedbok_app', 'member') as app,
           pg_has_role(current_user, 'hovedbok_ro', 'member') as ro
      from pg_roles where rolname = current_user`;
  const want = label === "rw" ? "hovedbok_app" : "hovedbok_ro";
  const fine = !r.superuser && (label === "rw" ? r.app : r.ro && !r.app);
  console.log(`${label}: connected as ${r.who}${fine ? "" : `  WARNING: not a plain member of ${want} (dev only)`}`);
}

const app = createApi({ rw, ro, rwToken, roToken: env.API_RO_TOKEN, documentsDir: env.DOCUMENTS_DIR });
const server = Bun.serve({
  port: Number(env.PORT ?? 3000),
  hostname: env.HOST ?? "127.0.0.1",
  fetch: app.fetch,
});
console.log(`hovedbok API on ${server.url} (spec: ${server.url}openapi.json)`);
