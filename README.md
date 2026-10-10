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
VAT from base × rate, unless the line states the document's figure in
`vat_amount` (ADR-0012; it must lie within 1 krone or 1 % of the derived
VAT); `vat_control` shows where the booked 27xx movement
differs. In a voucher that touches a VAT account every P&L line must carry a
code (`"0"` when it is genuinely outside VAT). The database refuses the other
shapes. `mva_term` rolls `vat_summary` up to the entity's VAT term
(`entity.vat_term`, bimonthly by default), signed as the MVA-melding reads;
`src/mva.ts` builds the melding XML from it (whole kroner, per Skatteetaten's
XSD).

## HTTP API

`bun src/api/serve.ts` serves the same operations over HTTP (Hono on
Bun.serve). Every route is 1:1 with a SQL function or view — the OpenAPI 3.1
document at `/openapi.json` lists them all, `operationId` = the SQL name. The
adapter adds no logic: a refused command comes back as
`{"error": <the database's message>, "sqlstate": "P0001"}` with a 4xx (class
22 → 400, 42501 → 403, 23505/40xxx → 409, other 23xxx and RAISE → 422).

```sh
API_TOKEN=… API_RO_TOKEN=… bun src/api/serve.ts
curl -H "Authorization: Bearer $API_TOKEN" -d @voucher.json localhost:3000/vouchers
curl -H "Authorization: Bearer $API_RO_TOKEN" "localhost:3000/saldobalanse?entity=999888777&year=2026&period_from=1&period_to=12"
```

- Commands: `POST /entities` (bootstrap_entity), `PUT|POST /accounts`,
  `PUT|POST /parties`, `POST /vouchers`, `POST /vouchers/{year}/{nr}/reverse`,
  `POST /periods/close`, `POST /fiscal-years/close`. jsonb commands take
  their payload verbatim as the body; the others take `{entity, …}`.
- Reads: `GET /journal`, `/account-balance`, `/account-year-balance`,
  `/saldobalanse`, `/kontospesifikasjon`, `/bokforingsspesifikasjon`,
  `/kundespesifikasjon`, `/leverandorspesifikasjon`, `/resultat`, `/balanse`,
  `/vat-summary`, `/vat-control`, `/mva-term`, `/voucher-without-document`,
  `/accounts`, `/parties`, `/bank/unmatched`, `/bank/reconciliation` —
  `?entity=<orgnr>` (required), equality filters on the keys, `limit`/`offset`.
  `GET /mva-melding/{year}/{term}?entity=` (XML, `format=json` for lines and
  totals) and `GET /saf-t?entity=&year=` or `&from=&to=` (XML, Skatteetaten's
  file name in Content-Disposition).
- Documents: `POST /documents?origin=receipt` with the raw bytes as the body
  and the media type as Content-Type (no multipart); `GET /documents/{sha256}`
  returns the bytes, re-hashed on every read; `POST
  /vouchers/{year}/{nr}/documents {"entity", "sha256"}` attaches one.

Auth: one listener, two bearer tokens. `API_TOKEN` runs on
`DATABASE_URL_APP`, `API_RO_TOKEN` on `DATABASE_URL_RO` and gets GET only.
`hovedbok_app` and `hovedbok_ro` stay NOLOGIN privilege anchors (0001);
deploy creates the logins, one per principal (ADR-0010), so `created_by`
names who posted:

```sql
create role hovedbok_api login password '…' in role hovedbok_app;
create role hovedbok_api_ro login password '…' in role hovedbok_ro;
```

Environment: `API_TOKEN` (required), `API_RO_TOKEN`, `DATABASE_URL_APP`
(default `DATABASE_URL`, else the compose db on 5433 — superuser, dev only;
the server warns), `DATABASE_URL_RO` (default `DATABASE_URL_APP`),
`DOCUMENTS_DIR` (default `./documents`), `PORT` (3000), `HOST` (127.0.0.1).
`/openapi.json` and `/bank/consent-callback` (Enable Banking's redirect,
#10) take no token.

## Layout

- `db/migrations/` — the system: schema, invariants, commands, views
- `db/migrate.ts` — tiny migrator (`bun run migrate`)
- `src/` — adapters only: HTTP API, MCP server, Enable Banking sync, exporters
- `test/` — invariant suite against real Postgres + golden fixtures

Design docs and ADRs: `~/hvelv/repos/hovedbok/`.
