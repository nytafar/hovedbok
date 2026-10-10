# hovedbok

Agent-first accounting ledger for Norwegian bookkeeping. An immutable
double-entry journal in Postgres where the database enforces the law's
invariants and *is* the API: commands are SQL functions, reads are views,
HTTP and MCP are thin peers on top. The bank statement (Enable Banking) is
the source of truth; balances, reports, MVA-melding and SAF-T are disposable
projections.

Facts are immutable. Meaning is derived. Policy is data.

## Quick start

```sh
docker compose up -d db
bun install
bun run migrate
bun run check
```

Talk to the books directly:

```sql
select post_voucher('{
  "entity": "999888777",
  "posting_date": "2026-01-15",
  "description": "Sale",
  "idempotency_key": "demo-1",
  "lines": [
    {"account": "1920", "amount": 12500},
    {"account": "3000", "amount": -10000, "vat_code": "3", "vat_base": -10000},
    {"account": "2700", "amount": -2500, "vat_code": "3"}
  ]
}');

select * from journal;
select * from unmatched_bank;   -- the agent work queue
select * from bank_reconciliation;
```

## Layout

- `db/migrations/` — the system: schema, invariants, commands, views
- `db/migrate.ts` — tiny migrator (`bun run migrate`)
- `src/` — adapters only: HTTP API, MCP server, Enable Banking sync, exporters
- `test/` — invariant suite against real Postgres + golden fixtures

Design docs and ADRs: `~/hvelv/repos/hovedbok/`.
