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
    {"account": "2700", "amount": -2500}
  ]
}');

select * from journal;
select * from unmatched_bank;   -- the agent work queue
select * from bank_reconciliation;

-- reference data and year-end, the same way
select upsert_party('{"entity": "999888777", "id": "K0001", "name": "Kunde AS", "customer": true}');
select upsert_account('{"entity": "999888777", "code": "1921", "name": "Sparekonto", "std_account": "1920"}');
select close_period('999888777', 2026, 1);           -- ... through 12, then
select close_fiscal_year('999888777', 2026);         -- result -> 8800 -> 896x/899x -> equity, in period 13
select * from account_year_balance where year = 2027; -- opening balances, derived from the postings
```

VAT coding lives on the base line (ADR-0011): `vat_code` + `vat_base` on the
revenue/cost/asset line, nothing on the 27xx line. `vat_summary` derives the
VAT from base × rate; `vat_control` shows where the booked 27xx movement
differs. In a voucher that touches a VAT account every P&L line must carry a
code (`"0"` when it is genuinely outside VAT). The database refuses the other
shapes.

## Enable Banking

`src/bank/` pulls the bank statement in through Enable Banking's AIS API and
writes the facts into `bank_transaction` / `bank_balance` (BOOK only, keyed by
`entry_reference` or a content fingerprint; pending movements live in a
replaceable snapshot). Linking facts to vouchers goes through the
`match_bank` / `unmatch_bank` commands, or `post_voucher`'s `"matches"` array
when the voucher is posted for that movement; either way the database insists
the linked line sits on the bank account's own 19xx account. `unmatched_bank`
is the queue and `bank_reconciliation` the assertion.

Environment (an application registered in the Enable Banking Control Panel;
see `~/hvelv/repos/hovedbok/howto-enable-banking-consent.md`):

| variable | meaning |
|---|---|
| `ENABLE_BANKING_APP_ID` | application id from the Control Panel (the JWT `kid`) |
| `ENABLE_BANKING_KEY_FILE` | path to the application's RSA private key, PEM |
| `ENABLE_BANKING_REDIRECT_URL` | a redirect URL registered on the application; the consent callback lands here with `?code&state` |
| `ENABLE_BANKING_API_URL` | optional, default `https://api.enablebanking.com` |

```sh
bun src/bank/cli.ts aspsps NO                       # banks and their max consent
bun src/bank/cli.ts auth 999888777 "DNB"            # prints the bank's URL; open it, log in with BankID
bun src/bank/cli.ts callback "<url you landed on>"  # POST /sessions, records accounts, backfills
bun src/bank/cli.ts sync                            # unattended re-sync of every authorized consent
bun src/bank/cli.ts status
```

Rules the sync enforces (from `research-enable-banking.md`): at most 4
unattended fetches per consent per rolling 24 h — every run that reached the
bank counts, errors included; a 5th is deferred and logged in `bank_fetch`,
and the connection row is locked for the run so concurrent syncs cannot
double-spend; a 429 puts the consent on a 6 h backoff (longer if the bank
says so); a sync a human triggered sends the `Psu-*` headers all-or-none
(`sync --attended` needs the person's real address in `PSU_IP_ADDRESS`) and
is not budgeted, but if the API refuses the headers it only falls back to an
unattended read when the budget allows; the backfill runs immediately after
consent, attended when the browser context is known. Re-syncing an
overlapping window never inserts a fact twice; keyless movements that repeat
within a day are numbered (`fp:<hash>:2`), not collapsed. Account identity is
`identification_hash`; re-consent refreshes `uid` and the connection, keeps
the account and its facts, and marks the old connection `superseded`.
Warnings (conflicts, truncated pagination) land in `bank_fetch.detail`.

## Layout

- `db/migrations/` — the system: schema, invariants, commands, views
- `db/migrate.ts` — tiny migrator (`bun run migrate`)
- `src/` — adapters only: HTTP API, MCP server, Enable Banking sync, exporters
- `test/` — invariant suite against real Postgres + golden fixtures

Design docs and ADRs: `~/hvelv/repos/hovedbok/`.
