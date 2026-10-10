// E2E (#13), deployment driver: the agent bookkeeping loop (test/e2e_flow.ts)
// against a live hovedbok API. The CI driver is test/e2e.test.ts.
//
//   bun scripts/e2e.ts --base-url=https://hovedbok.example --token=… [--ro-token=…] [--entity=999999999]
//
// or through the environment: E2E_BASE_URL, E2E_TOKEN, E2E_RO_TOKEN (optional),
// E2E_ENTITY (optional). Flags win over the environment.
//
// Non-destructive by design: everything is written to one dedicated test
// entity (orgnr 9999xxxxx, default 999999999), under fixed idempotency keys,
// so a re-run replays instead of booking twice; documents are content-addressed;
// no period is closed. Nothing touches any other entity. Bank facts only enter
// through Enable Banking sync: without an authorized connection for the test
// entity the bank steps are reported SKIPPED and the ledger loop runs alone.
//
// Exit status: 0 when no step failed, 1 when one did, 2 on bad usage.
import { parseArgs } from "node:util";
import { formatReport, runFlow } from "../test/e2e_flow";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "base-url": { type: "string" },
    token: { type: "string" },
    "ro-token": { type: "string" },
    entity: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const usage = "usage: bun scripts/e2e.ts --base-url=URL --token=RW_TOKEN [--ro-token=RO_TOKEN] [--entity=9999xxxxx]\n" +
  "       (or E2E_BASE_URL, E2E_TOKEN, E2E_RO_TOKEN, E2E_ENTITY)";
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const env = process.env;
const baseUrl = values["base-url"] ?? env.E2E_BASE_URL;
const token = values.token ?? env.E2E_TOKEN;
const roToken = values["ro-token"] ?? (env.E2E_RO_TOKEN || undefined);
const entity = values.entity ?? env.E2E_ENTITY ?? "999999999";

const problems: string[] = [];
if (!baseUrl) problems.push("base URL missing (--base-url or E2E_BASE_URL)");
else if (!URL.canParse(baseUrl)) problems.push(`base URL ${JSON.stringify(baseUrl)} is not a URL`);
if (!token) problems.push("read-write token missing (--token or E2E_TOKEN)");
// a guard, not a convenience: the flow books into this entity
if (!/^9999\d{5}$/.test(entity)) problems.push(`entity ${entity} is not a dedicated test orgnr (9999xxxxx)`);
if (problems.length) {
  console.error(`${problems.join("\n")}\n${usage}`);
  process.exit(2);
}

console.log(`hovedbok e2e against ${baseUrl}, test entity ${entity}${roToken ? ", with the read-only token" : ""}\n`);
const report = await runFlow({ baseUrl: baseUrl!, token: token!, roToken, entity, xmllint: Bun.which("xmllint") });
console.log(formatReport(report));
if (report.facts.bank === "skipped" && report.facts.bankSkipReason) {
  console.log(`\nbank loop SKIPPED: ${report.facts.bankSkipReason}`);
}
process.exit(report.ok ? 0 : 1);
