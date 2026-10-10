# hovedbok — agent notes

Agent-first Norwegian accounting ledger. **Docs live in `~/hvelv/repos/hovedbok/`**
(CONTEXT.md, architecture.md, adr/, plan-build.md, research-*) — read
`architecture.md` and the ADRs before touching the schema. Issues: GitHub via
`gh` (default tracker conventions in `~/hvelv/repos/issue-tracker.md`).

## Gate

`bun run check` (tsc --noEmit + bun test). Tests need the dev database:
`docker compose up -d db && bun run migrate`. Never merge red. CI
(`.github/workflows/ci.yml`) runs the same against a postgres:17 service.

DB tests use `test/helper.ts`: `freshDb()` clones a clean, just-migrated
database (template keyed by a hash of the migrations) per call; `afterAll(dropTestDb)`.
DATABASE_URL is only the maintenance connection — tests never touch its data.

## Load-bearing rules

- `voucher`/`posting` are **append-only, enforced in the DB**. Corrections are
  `reverse_voucher()` + a new `post_voucher()`. If an invariant trigger blocks
  you, the fix is never to weaken the trigger.
- Writes go through the SQL command functions (ADR-0009); adapters add no logic.
- New tables/views/functions in a migration must repeat grants (0008 style);
  there are no default privileges on purpose.
- Money is signed bigint øre (+debit/−credit). Round half up.
- Enable Banking: ≤4 unattended fetches/day/consent, 6 h backoff on 429,
  PSU headers all-or-none, identity = `identification_hash` only.
- Golden oracle: the new system must reproduce
  `~/code/enkelt-regnskap/test/fixtures/` (SAF-T XML, VAT figures).
