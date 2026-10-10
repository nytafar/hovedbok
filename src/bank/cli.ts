// Operator CLI for the Enable Banking adapter — the consent flow and a sync,
// as the owner runs them by hand (howto-enable-banking-consent.md).
//
//   bun src/bank/cli.ts aspsps [NO]
//   bun src/bank/cli.ts auth <entity> "<aspsp name>" [country]   → prints the bank's URL
//   bun src/bank/cli.ts callback "<redirected url or ?code=..&state=..>" [ledger-account]
//   bun src/bank/cli.ts sync [connection-id] [--attended]
//   bun src/bank/cli.ts status
//
// DATABASE_URL is the connection used; the roles are NOLOGIN, so in dev this
// is the owner. ENABLE_BANKING_* per src/bank/env.ts.
import { SQL } from "bun";
import { defaultDatabaseUrl } from "../../db/migrate";
import { bankEnv, clientFromEnv } from "./env";
import { completeConsent, startConsent, syncConnection } from "./sync";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  const sql = new SQL(process.env.DATABASE_URL ?? defaultDatabaseUrl);
  try {
    switch (cmd) {
      case "aspsps": {
        const client = await clientFromEnv();
        for (const a of await client.aspsps(args[0] ?? "NO")) {
          const days = a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : "?";
          console.log(`${a.country}\t${a.name}\tmax consent ${days} d\t${(a.psu_types ?? []).join(",")}`);
        }
        return;
      }
      case "auth": {
        const [entity, name, country] = args;
        if (!entity || !name) throw new Error("usage: auth <entity> <aspsp name> [country]");
        const env = bankEnv();
        if (!env.redirectUrl) throw new Error("ENABLE_BANKING_REDIRECT_URL is not set");
        const client = await clientFromEnv();
        const r = await startConsent(sql, client, {
          entity,
          aspsp: { name, country: country ?? "NO" },
          redirectUrl: env.redirectUrl,
        });
        console.log(`connection ${r.connectionId} (state ${r.state})\nopen in a browser:\n${r.url}`);
        return;
      }
      case "callback": {
        const [raw, ledger = "1920"] = args;
        if (!raw) throw new Error("usage: callback <redirected url> [ledger-account]");
        const q = new URL(raw.startsWith("?") ? `http://x/${raw}` : raw).searchParams;
        const code = q.get("code");
        const state = q.get("state");
        if (!code || !state) throw new Error("the callback url carries no code/state");
        const client = await clientFromEnv();
        const r = await completeConsent(sql, client, {
          state,
          code,
          ledgerAccount: () => ledger,
          onWarning: (m) => console.warn(m),
        });
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      case "sync": {
        const attended = args.includes("--attended");
        const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);
        const client = await clientFromEnv();
        const targets = ids.length
          ? ids
          : (await sql`select id from bank_connection where status = 'authorized' order by id`).map(
              (r: { id: number | string }) => Number(r.id),
            );
        for (const id of targets) {
          // --attended: a human is at the keyboard; without a browser we only
          // have an address, which is the one header every bank requires.
          const r = await syncConnection(sql, client, id, {
            psu: attended ? { ipAddress: process.env.PSU_IP_ADDRESS ?? "127.0.0.1" } : undefined,
            onWarning: (m) => console.warn(m),
          });
          console.log(JSON.stringify(r, null, 2));
        }
        return;
      }
      case "status": {
        const rows = await sql`
          select c.id, c.entity, c.aspsp_name, c.status, c.valid_until, c.last_synced_at, c.backoff_until,
                 (select count(*) from bank_account a where a.connection_id = c.id) as accounts,
                 (select count(*) from bank_fetch f where f.connection_id = c.id
                     and not f.attended and f.outcome in ('ok', 'rate_limited')
                     and f.started_at > now() - interval '24 hours') as unattended_24h
            from bank_connection c order by c.id`;
        console.table(rows);
        return;
      }
      default:
        throw new Error("usage: aspsps | auth | callback | sync | status");
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
