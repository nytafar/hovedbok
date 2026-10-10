# Enable Banking fixtures

Responses replayed by `test/bank.test.ts` through the client's injectable
`fetch`, so the suite runs offline.

Provenance: hand-assembled on 2026-10-11 from the response examples in the
API reference (https://enablebanking.com/docs/api/reference/ — POST /auth,
POST /sessions, GET /accounts/{id}/balances, GET /accounts/{id}/transactions,
ErrorResponse), with Norwegian data (NOK, IBAN+BBAN, a NORF/KID reference) and
the shapes securo's provider handles in the wild (missing `entry_reference`,
`PDNG` rows, a repeated entry). They are NOT recordings from the sandbox: no
application is registered yet, and every endpoint — sandbox included —
requires an application JWT. Re-record against the Mock ASPSP once a sandbox
app exists (howto-enable-banking-consent.md) and replace these files; the
test only depends on the keys listed in `src/bank/client.ts`.

- `auth.json` — POST /auth
- `session.json` — POST /sessions: one account, "Driftskonto"
- `backfill-1.json`, `backfill-2.json` — GET transactions, strategy=longest, two pages
- `resync.json` — GET transactions for an overlapping window: 2 already-booked
  entries (one of them sent twice), 1 newly booked, 1 pending (PDNG)
- `balances-1.json`, `balances-2.json` — GET balances at backfill and at re-sync
- `rate-limited.json` — 429 ErrorResponse body
