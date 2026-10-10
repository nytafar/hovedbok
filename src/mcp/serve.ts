// MCP entrypoint: `bun src/mcp/serve.ts`. Streamable HTTP at POST /mcp.
//
// Environment (as src/api/serve.ts, read-write only):
//   MCP_TOKEN          bearer token MCP clients send (default: $API_TOKEN; one is required)
//   DATABASE_URL_APP   login in role hovedbok_app (default: $DATABASE_URL, else the compose dev db)
//   DOCUMENTS_DIR      document blob root (default ./documents) — the same store as the API's
//   PORT_MCP           default 3001; HOST default 127.0.0.1
//   ENABLE_BANKING_*   bank tools (src/bank/env.ts); read on the first bank call
//   PSU_IP_ADDRESS     attended syncs (`attended: true`), as for the API
//   PSU_USER_AGENT
import { SQL } from "bun";
import { defaultDatabaseUrl } from "../../db/migrate";
import { MCP_PATH, createMcp } from "./server";

const env = process.env;
const token = env.MCP_TOKEN || env.API_TOKEN;
if (!token) {
  console.error("MCP_TOKEN (or API_TOKEN) is required (the bearer token MCP clients send)");
  process.exit(1);
}
const rw = new SQL(env.DATABASE_URL_APP ?? env.DATABASE_URL ?? defaultDatabaseUrl);

const [r] = await rw`
  select current_user as who, rolsuper as superuser,
         pg_has_role(current_user, 'hovedbok_app', 'member') as app
    from pg_roles where rolname = current_user`;
const fine = !r.superuser && r.app;
console.log(`rw: connected as ${r.who}${fine ? "" : "  WARNING: not a plain member of hovedbok_app (dev only)"}`);

const mcp = createMcp({ rw, token, documentsDir: env.DOCUMENTS_DIR });
const server = Bun.serve({
  port: Number(env.PORT_MCP ?? 3001),
  hostname: env.HOST ?? "127.0.0.1",
  fetch: mcp.fetch,
});
console.log(`hovedbok MCP (streamable-http) on ${new URL(MCP_PATH, server.url)} — ${mcp.tools.length} tools`);
