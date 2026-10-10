// OpenAPI 3.1 for the HTTP adapter (#11), hand-written. Every route in
// src/api/app.ts is here with its payload shape; test/api.test.ts asserts the
// route table, the query parameters and these paths are the same set.
//
// The command bodies mirror the jsonb contracts of the SQL functions (the
// header comments in db/migrations: 0006/0026 post_voucher, 0012
// bootstrap_entity, 0015/0019 close_fiscal_year, 0016/0020/0028 upsert_*).
// operationId is the SQL function or view each route is 1:1 with.
//
// Money: signed integer øre (+debit / −credit) everywhere. Row amounts are
// serialised by Postgres: bigint and numeric columns are JSON numbers.

type Schema = Record<string, unknown>;

// --- schema shorthands -------------------------------------------------------
const str = (description?: string): Schema => ({ type: "string", ...(description && { description }) });
const nstr = (description?: string): Schema => ({ type: ["string", "null"], ...(description && { description }) });
const int = (description?: string): Schema => ({ type: "integer", ...(description && { description }) });
const nint = (description?: string): Schema => ({ type: ["integer", "null"], ...(description && { description }) });
const ore = (description = "signed øre (+debit / −credit)"): Schema => ({ type: "integer", format: "int64", description });
const nore = (description = "signed øre (+debit / −credit)"): Schema => ({ type: ["integer", "null"], format: "int64", description });
const num = (description?: string): Schema => ({ type: "number", ...(description && { description }) });
const nnum = (description?: string): Schema => ({ type: ["number", "null"], ...(description && { description }) });
const bool = (description?: string): Schema => ({ type: "boolean", ...(description && { description }) });
const date = (description?: string): Schema => ({ type: "string", format: "date", ...(description && { description }) });
const ndate = (description?: string): Schema => ({ type: ["string", "null"], format: "date", ...(description && { description }) });
const ts = (): Schema => ({ type: "string", format: "date-time" });
const nts = (): Schema => ({ type: ["string", "null"], format: "date-time" });
const json = (description?: string): Schema => ({ type: "object", ...(description && { description }) });
const strs = (description?: string): Schema => ({ type: "array", items: { type: "string" }, ...(description && { description }) });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const obj = (properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema => ({
  type: "object",
  properties,
  ...(required.length && { required }),
  ...extra,
});
const rows = (name: string): Schema => ({ type: "array", items: ref(name) });

// --- parameter shorthands ----------------------------------------------------
type Param = Record<string, unknown>;
const q = (name: string, schema: Schema, description: string, required = false): Param => ({
  name, in: "query", required, description, schema,
});
const path = (name: string, schema: Schema, description: string): Param => ({
  name, in: "path", required: true, description, schema,
});
const entityQ = q("entity", { type: "string", pattern: "^\\d{9}$" }, "Entity orgnr (every read is scoped to one entity).", true);
const yearQ = q("year", { type: "integer" }, "Fiscal year.");
const periodQ = q("period", { type: "integer", minimum: 1, maximum: 13 }, "Bookkeeping period (1-12 months, 13 = year-end closing).");
const periodFromQ = q("period_from", { type: "integer", minimum: 1, maximum: 13 }, "First period of the range.");
const periodToQ = q("period_to", { type: "integer", minimum: 1, maximum: 13 }, "Last period of the range.");
const accountQ = q("account", { type: "string" }, "Account code.");
const partyQ = q("party", { type: "string" }, "Party id.");
const fromQ = (col: string) => q("from", { type: "string", format: "date" }, `${col} on or after (YYYY-MM-DD).`);
const toQ = (col: string) => q("to", { type: "string", format: "date" }, `${col} on or before (YYYY-MM-DD).`);
const paging = [
  q("limit", { type: "integer", minimum: 0 }, "Maximum number of rows."),
  q("offset", { type: "integer", minimum: 0 }, "Rows to skip (with the view's fixed order)."),
];
const yearP = path("year", { type: "integer" }, "Fiscal year of the voucher.");
const nrP = path("nr", { type: "integer" }, "Voucher number within the fiscal year.");

// --- responses ---------------------------------------------------------------
const errorResponses = {
  "400": { description: "Malformed request (bad JSON, cast failure: SQLSTATE class 22, unknown/missing parameter).", content: { "application/json": { schema: ref("Error") } } },
  "401": { description: "Missing or invalid bearer token.", content: { "application/json": { schema: ref("Error") } } },
  "403": { description: "Read-only token on a write, or a grant refused (SQLSTATE 42501).", content: { "application/json": { schema: ref("Error") } } },
  "409": { description: "Unique violation (23505) or a serialisation/lock conflict: retry or change the key.", content: { "application/json": { schema: ref("Error") } } },
  "422": { description: "The database refused the operation (RAISE P0001, integrity class 23): the message says why.", content: { "application/json": { schema: ref("Error") } } },
};
const bankErrors = {
  "502": { description: "Enable Banking refused or failed: the message is the bank API's.", content: { "application/json": { schema: ref("Error") } } },
  "503": { description: "Enable Banking is not configured on the server (the message names the missing variables).", content: { "application/json": { schema: ref("Error") } } },
};
const ok = (schema: Schema, description = "OK") => ({
  "200": { description, content: { "application/json": { schema } } },
  ...errorResponses,
});
const jsonBody = (schema: Schema, description?: string) => ({
  required: true,
  ...(description && { description }),
  content: { "application/json": { schema } },
});

function command(operationId: string, summary: string, body: Schema, result: Schema, extra: Record<string, unknown> = {}) {
  return { operationId, summary, requestBody: jsonBody(body), responses: ok(result), ...extra };
}

function read(operationId: string, summary: string, row: string, params: Param[]) {
  return {
    operationId,
    summary,
    parameters: [entityQ, ...params, ...paging],
    responses: ok(rows(row), "Rows of the view, in its fixed order."),
  };
}

// --- component schemas -------------------------------------------------------
const schemas: Record<string, Schema> = {
  Error: obj({
    error: str("The database's own message (written for agents), or the adapter's for request-shape errors."),
    sqlstate: nstr("Postgres SQLSTATE, null when the error did not come from Postgres."),
    detail: str(),
    hint: str(),
  }, ["error", "sqlstate"]),

  // commands
  BootstrapEntity: obj({
    orgnr: { type: "string", pattern: "^\\d{9}$" },
    name: str(),
    vat_registered: bool("Default false."),
    vat_term: { type: "string", enum: ["monthly", "bimonthly", "yearly"], description: "Default bimonthly." },
    year: int("Fiscal year to open; default the current year."),
  }, ["orgnr", "name"]),
  BootstrapEntityResult: obj({
    entity: str(), created: bool("false when the entity existed (idempotent, non-destructive)."),
    accounts_added: int(), year: int(),
  }, ["entity", "created", "accounts_added", "year"]),

  UpsertAccount: obj({
    entity: str(),
    code: { type: "string", pattern: "^\\d{4}$", description: "NS 4102 account code." },
    name: str("Required unless code is a standard account."),
    std_account: nstr("SAF-T standard account; defaults to code when standard. Immutable once posted."),
    grouping: nstr("SAF-T grouping code; derived from std_account or the code range."),
    default_vat: nstr("VAT code."),
    control: { type: ["string", "null"], enum: ["customer", "supplier", null] },
    opened: ndate(),
    closed: ndate(),
  }, ["entity", "code"], { description: "A key present with null clears the column; an absent key keeps the existing value." }),
  UpsertAccountResult: obj({ entity: str(), code: str(), created: bool() }, ["entity", "code", "created"]),

  UpsertParty: obj({
    entity: str(),
    id: str(),
    name: str("Required on insert."),
    orgnr: { type: ["string", "null"], pattern: "^\\d{9}$" },
    foreign_reg_no: nstr("Registration number abroad; excludes orgnr."),
    country: str("ISO 3166-1 alpha-2; default NO."),
    address: json("Free-form address object."),
    customer: bool(), supplier: bool(), owner: bool(), senior_employee: bool(),
    peppol_id: nstr(),
  }, ["entity", "id"], { description: "A key present with null clears the column; an absent key keeps the existing value." }),
  UpsertPartyResult: obj({ entity: str(), id: str(), created: bool() }, ["entity", "id", "created"]),

  VoucherLine: obj({
    account: str(),
    amount: ore(),
    description: str(),
    vat_code: str("On the base line only (ADR-0011); never on a 27xx VAT-account line."),
    vat_base: ore("VAT base, signed like amount."),
    vat_amount: ore("The document's stated VAT for this line (ADR-0012); null/absent = derived."),
    party: str(),
    ccy: str(), ccy_amount: { type: "integer", description: "Foreign amount in minor units." }, ccy_rate: num(),
    dim: json("Dimensions, e.g. {\"project\": \"x\"}."),
  }, ["account", "amount"]),
  PostVoucher: obj({
    entity: str(),
    posting_date: date(),
    document_date: date("Default posting_date."),
    period: { type: "integer", minimum: 1, maximum: 13, description: "Default month(posting_date); 13 = year-end." },
    description: str(),
    source: str("Default agent."),
    external_ref: str(),
    idempotency_key: str("Replaying a key returns the existing voucher with idempotent = true."),
    created_by: str("Name the principal; default the session user (ADR-0010)."),
    lines: { type: "array", minItems: 2, items: ref("VoucherLine"), description: "Must sum to 0." },
    documents: strs("sha256 of stored documents to attach."),
    matches: {
      type: "array",
      items: obj({ id_hash: str(), dedup_key: str(), line: int() }, ["id_hash", "dedup_key", "line"]),
      description: "Bank transactions this voucher explains.",
    },
  }, ["entity", "posting_date", "idempotency_key", "lines"]),
  VoucherResult: obj({ entity: str(), year: int(), nr: int(), idempotent: bool() }, ["entity", "year", "nr", "idempotent"]),
  ReverseVoucher: obj({
    entity: str(),
    posting_date: date("Default today."),
    description: str("Default 'Reversering av bilag <year>/<nr>: <description>'."),
  }, ["entity"]),
  ClosePeriod: obj({ entity: str(), year: int(), period: { type: "integer", minimum: 1, maximum: 13 } }, ["entity", "year", "period"]),
  ClosePeriodResult: obj({ entity: str(), year: int(), period: int(), status: { const: "closed" } }, ["entity", "year", "period", "status"]),
  CloseFiscalYear: obj({
    entity: str(), year: int(),
    equity_account: nstr("2000-2099; default 2050 on profit, 2080 on loss."),
  }, ["entity", "year"]),
  CloseFiscalYearResult: obj({
    entity: str(), year: int(),
    result: ore("The year's result, credit = profit (negative)."),
    equity_account: str(),
    vouchers: { type: "array", items: { type: "integer" } },
    period_13: { const: "closed" },
  }, ["entity", "year", "result", "equity_account", "vouchers", "period_13"]),

  // documents
  Document: obj({
    sha256: str(), mediaType: str(), bytes: int(),
    origin: { type: "string", enum: ["receipt", "invoice", "einvoice", "bank", "contract", "other"] },
    note: str(), createdAt: ts(),
  }, ["sha256", "mediaType", "bytes", "origin", "note", "createdAt"]),
  LinkDocument: obj({ entity: str(), sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["entity", "sha256"]),
  LinkDocumentResult: obj({ entity: str(), year: int(), nr: int(), sha256: str() }, ["entity", "year", "nr", "sha256"]),

  // Enable Banking (src/bank/sync.ts, 0030)
  StartConsent: obj({
    entity: str(),
    aspsp: obj({ name: str("ASPSP (bank) name as Enable Banking lists it."), country: str("Default NO.") }, ["name"]),
    redirect_url: str("Where the bank sends the browser back (registered on the app); default ENABLE_BANKING_REDIRECT_URL. Point it at /bank/consent-callback."),
    valid_until: { type: "string", format: "date-time", description: "Consent end; default the maximum (180 days)." },
    psu_type: { type: "string", enum: ["business", "personal"], description: "Default business." },
    language: str(),
  }, ["entity", "aspsp"]),
  StartConsentResult: obj({
    connectionId: int("The pending bank_connection."),
    state: str("CSRF state; the callback must carry it back."),
    url: str("Open in the owner's browser to authorise at the bank."),
  }, ["connectionId", "state", "url"]),
  SyncRequest: obj({
    connection_id: int("One consent. Omit for every authorized consent (of entity, when given)."),
    entity: str("Every authorized consent of this entity. Not together with connection_id."),
    attended: bool("A human is present: send PSU headers (needs PSU_IP_ADDRESS on the server) and skip the unattended budget. Default false."),
  }, [], { description: "May be empty: sync every authorized consent, unattended." }),
  AccountSyncResult: obj({
    idHash: str(), seen: int("BOOK transactions in the window."), inserted: int("New bank_transaction rows."),
    conflicts: int("Same entry_reference, different amount."), pending: int("Rows in the replaced pending snapshot."),
    ignored: int(), balances: int(), pages: int(),
    truncated: bool("Pagination cut short; last_synced_at not advanced."),
    dateFrom: ndate(), dateTo: ndate(),
  }),
  SyncResult: obj({
    connectionId: int(),
    outcome: {
      type: "string", enum: ["ok", "rate_limited", "expired", "deferred", "error"],
      description: "deferred: budget or backoff said no, nothing reached the bank. error: only in a multi-consent run (logged in bank_fetch); a single-consent run answers with an HTTP error instead.",
    },
    attended: bool(),
    accounts: { type: "array", items: ref("AccountSyncResult") },
    warnings: strs(),
    resumeAt: { type: "string", format: "date-time", description: "rate_limited/deferred: when unattended syncing may resume." },
    detail: str(),
  }, ["connectionId", "outcome", "attended", "accounts", "warnings"]),
  MatchBank: obj({
    id_hash: str("Bank account (identification_hash)."), dedup_key: str("The bank transaction within it."),
    entity: str(), year: int(), nr: int(),
    line: int("Voucher line; default the voucher's single line on the bank account's ledger account."),
  }, ["id_hash", "dedup_key", "entity", "year", "nr"]),
  MatchBankResult: obj({
    id_hash: str(), dedup_key: str(), entity: str(), year: int(), nr: int(), line: int(),
    created: bool("false when the link existed (idempotent)."),
  }, ["id_hash", "dedup_key", "entity", "year", "nr", "line", "created"]),
  UnmatchBank: obj({
    id_hash: str(), dedup_key: str(), entity: str(), year: int(), nr: int(),
    line: int("Omit to remove every link between the transaction and the voucher."),
  }, ["id_hash", "dedup_key", "entity", "year", "nr"]),
  UnmatchBankResult: obj({ deleted: int() }, ["deleted"]),

  // MVA-melding (src/mva.ts)
  MvaMelding: obj({
    xml: str(),
    lines: {
      type: "array",
      items: obj({ code: str(), base: int("kroner; utgående lines only"), rate: str("sats, e.g. \"25\", \"11,11\""), vat: int("kroner") }, ["code", "vat"]),
    },
    total: int("fastsattMerverdiavgift, kroner: positive = to pay, negative = refund."),
    period: obj({ element: str(), value: str() }, ["element", "value"]),
  }, ["xml", "lines", "total", "period"]),

  // view rows
  JournalRow: obj({
    entity: str(), year: int(), nr: int(), line: int(), posting_date: date(), document_date: date(), period: int(),
    voucher_description: str(), source: str(), external_ref: nstr(), account: str(), account_name: str(),
    amount: ore(), ccy: nstr(), ccy_amount: nint(), ccy_rate: nnum(), vat_code: nstr(), vat_base: nore(),
    party: nstr(), dim: json(), line_description: str(), reverses_year: nint(), reverses_nr: nint(),
    created_at: ts(), created_by: str(), vat_amount: nore("Stated VAT (ADR-0012); null = derived."),
  }),
  AccountBalanceRow: obj({ entity: str(), account: str(), balance: ore() }),
  AccountYearBalanceRow: obj({ entity: str(), year: int(), account: str(), opening: ore(), movement: ore(), closing: ore() }),
  SaldobalanseRow: obj({
    entity: str(), year: int(), period_from: int(), period_to: int(), account: str(), account_name: str(),
    opening: ore(), debit: ore("non-negative"), credit: ore("non-negative"), closing: ore(),
  }),
  KontospesifikasjonRow: obj({
    entity: str(), year: int(), period: int(), account: str(), account_name: str(), nr: int(), line: int(),
    posting_date: date(), document_date: date(), voucher_description: str(), line_description: str(),
    debit: ore("non-negative"), credit: ore("non-negative"), amount: ore(), balance_before: ore(), balance_after: ore(),
    counter_accounts: strs(), vat_code: nstr(), vat_base: nore(), party: nstr(), party_name: nstr(),
    reverses_year: nint(), reverses_nr: nint(),
  }),
  BokforingsspesifikasjonRow: obj({
    entity: str(), year: int(), nr: int(), line: int(), period: int(), document_date: date(), posting_date: date(),
    voucher_description: str(), source: str(), external_ref: nstr(), documents: strs("Attached document sha256s."),
    account: str(), account_name: str(), debit: ore("non-negative"), credit: ore("non-negative"), amount: ore(),
    ccy: nstr(), ccy_amount: nint(), ccy_rate: nnum(), vat_code: nstr(), vat_base: nore(), party: nstr(),
    party_name: nstr(), dim: json(), line_description: str(), reverses_year: nint(), reverses_nr: nint(),
    created_at: ts(), created_by: str(),
  }),
  KundespesifikasjonRow: obj({
    entity: str(), year: int(), period_from: int(), period_to: int(), party: str(), name: str(), orgnr: nstr(),
    account: str(), opening: ore(), debit: ore("non-negative"), credit: ore("non-negative"), closing: ore(),
  }),
  LeverandorspesifikasjonRow: obj({
    entity: str(), year: int(), period_from: int(), period_to: int(), party: str(), name: str(), orgnr: nstr(),
    country: str(), account: str(), opening: ore(), debit: ore("non-negative"), credit: ore("non-negative"), closing: ore(),
  }),
  ResultatRow: obj({
    entity: str(), year: int(), period_from: int(), period_to: int(), class: str(), grouping_category: nstr(),
    grouping: nstr(), amount: ore("Movement on 3000-8799; result = −sum (profit positive)."), accounts: strs(),
  }),
  BalanseRow: obj({
    entity: str(), year: int(), period: int(), class: str(), grouping_category: nstr(), grouping: nstr(),
    amount: ore("Closing balance at the end of the period."), accounts: strs(),
  }),
  VatSummaryRow: obj({
    entity: str(), year: int(), period: int(), vat_code: str(), base: ore(), vat: ore(), output_vat: ore(),
    input_vat: ore(), rate: nnum("Percent, e.g. 25.000."),
  }),
  VatControlRow: obj({
    entity: str(), year: int(), period: int(), derived_output_vat: ore(), booked_output_vat: ore(),
    output_difference: ore(), derived_input_vat: ore(), booked_input_vat: ore(), input_difference: ore(),
  }),
  MvaTermRow: obj({
    entity: str(), year: int(), vat_term: { type: "string", enum: ["monthly", "bimonthly", "yearly"] }, term: int(),
    date_from: date(), date_to: date(), vat_code: str(), kind: str(), deductible: bool(), report: bool(),
    rate: nnum(), base: ore("grunnlag, sales positive"), output_vat: ore("positive = owed"),
    input_vat: ore("negative = deducted"), vat: ore("output_vat + input_vat"),
  }),
  VoucherWithoutDocumentRow: obj({
    entity: str(), year: int(), nr: int(), document_date: date(), posting_date: date(), period: int(),
    description: str(), source: str(), external_ref: nstr(), idempotency_key: str(), reverses_year: nint(),
    reverses_nr: nint(), created_at: ts(), created_by: str(),
  }),
  AccountRow: obj({
    entity: str(), code: str(), name: str(), std_account: nstr(), grouping: nstr(), default_vat: nstr(),
    control: nstr(), opened: ndate(), closed: ndate(),
  }),
  PartyRow: obj({
    entity: str(), id: str(), name: str(), orgnr: nstr(), country: str(), address: json(), customer: bool(),
    supplier: bool(), owner: bool(), senior_employee: bool(), peppol_id: nstr(), created_at: ts(),
    foreign_reg_no: nstr(),
  }),
  UnmatchedBankRow: obj({
    entity: str(), id_hash: str(), dedup_key: str(), booking_date: ndate(), value_date: ndate(),
    amount: ore("Signed øre, positive = into the account."), ccy: str(), status: str(), counterparty: nstr(),
    reference: nstr(), reference_schema: nstr(), remittance: nstr(), raw: json(), imported_at: ts(),
  }),
  BankConnectionStatusRow: obj({
    entity: str(), id: int(), aspsp_name: str(), aspsp_country: str(),
    status: { type: "string", enum: ["pending", "authorized", "expired", "revoked", "superseded"] },
    valid_until: nts(), created_at: ts(), last_synced_at: nts(), backoff_until: nts(),
    backing_off: bool("A 429 backoff (≥ 6 h) is in force: unattended runs are deferred until backoff_until."),
    accounts: int("Bank accounts on this consent."),
    unattended_24h: int("Unattended runs that reached the bank in the last 24 h (budget: 4)."),
    unattended_left: int(),
    unattended_resume_at: { ...nts(), description: "When an unattended run may reach the bank again; null = now." },
    last_fetch_at: nts(), last_fetch_attended: { type: ["boolean", "null"] },
    last_fetch_outcome: { type: ["string", "null"], enum: ["ok", "rate_limited", "expired", "error", "deferred", null] },
    last_fetch_detail: nstr(),
  }),
  BankReconciliationRow: obj({
    entity: str(), id_hash: str(), ledger_account: str(), ledger_balance: ore(), bank_balance: nore(),
    balance_type: nstr(), reference_date: ndate(), fetched_at: nts(), difference: nore(),
  }),
};

// --- paths -------------------------------------------------------------------
const paths: Record<string, Record<string, unknown>> = {
  "/entities": {
    post: command("bootstrap_entity", "Create an entity with the standard chart and open a fiscal year (idempotent).",
      ref("BootstrapEntity"), ref("BootstrapEntityResult")),
  },
  "/accounts": {
    get: read("account", "The entity's chart of accounts.", "AccountRow", [q("code", { type: "string" }, "Account code.")]),
    put: command("upsert_account", "Create or update an account.", ref("UpsertAccount"), ref("UpsertAccountResult")),
    post: command("upsert_account_post", "Create or update an account (same as PUT: upsert_account).", ref("UpsertAccount"), ref("UpsertAccountResult")),
  },
  "/parties": {
    get: read("party", "The entity's customers and suppliers.", "PartyRow", [q("id", { type: "string" }, "Party id.")]),
    put: command("upsert_party", "Create or update a party.", ref("UpsertParty"), ref("UpsertPartyResult")),
    post: command("upsert_party_post", "Create or update a party (same as PUT: upsert_party).", ref("UpsertParty"), ref("UpsertPartyResult")),
  },
  "/vouchers": {
    post: command("post_voucher", "Post a balanced voucher (idempotent on idempotency_key).",
      ref("PostVoucher"), ref("VoucherResult")),
  },
  "/vouchers/{year}/{nr}/reverse": {
    post: command("reverse_voucher", "Post the exact negation of a voucher (once; idempotent).",
      ref("ReverseVoucher"), ref("VoucherResult"), { parameters: [yearP, nrP] }),
  },
  "/vouchers/{year}/{nr}/documents": {
    post: command("link_document", "Attach a stored document to a voucher (idempotent).",
      ref("LinkDocument"), ref("LinkDocumentResult"), { parameters: [yearP, nrP] }),
  },
  "/periods/close": {
    post: command("close_period", "Close an open period (irreversible).", ref("ClosePeriod"), ref("ClosePeriodResult")),
  },
  "/fiscal-years/close": {
    post: command("close_fiscal_year",
      "Year-end: post result → 8800 → 8960/8990 → equity in period 13, close it, open the next year. Periods 1-12 must be closed.",
      ref("CloseFiscalYear"), ref("CloseFiscalYearResult")),
  },
  "/documents": {
    post: {
      operationId: "store_document",
      summary: "Store a document (bilag) verbatim, content-addressed; storing the same bytes again returns the existing row.",
      parameters: [
        q("origin", { type: "string", enum: ["receipt", "invoice", "einvoice", "bank", "contract", "other"] }, "Where the document came from.", true),
        q("note", { type: "string" }, "Free-text note."),
      ],
      requestBody: {
        required: true,
        description: "The raw bytes; Content-Type is stored as the media type. Multipart is refused.",
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      responses: ok(ref("Document")),
    },
  },
  "/documents/{sha256}": {
    get: {
      operationId: "retrieve_document",
      summary: "The stored bytes, re-hashed on every read (500 if they no longer match).",
      parameters: [path("sha256", { type: "string", pattern: "^[0-9a-f]{64}$" }, "The document's sha256.")],
      responses: {
        "200": {
          description: "The bytes, with the stored media type as Content-Type and ETag = sha256.",
          headers: { "X-Document-Origin": { schema: { type: "string" } } },
          content: { "*/*": { schema: { type: "string", format: "binary" } } },
        },
        "404": { description: "No such document.", content: { "application/json": { schema: ref("Error") } } },
        "500": { description: "The blob on disk no longer hashes to sha256.", content: { "application/json": { schema: ref("Error") } } },
        ...errorResponses,
      },
    },
  },

  "/journal": {
    get: read("journal", "The flat journal: one row per posting line.", "JournalRow",
      [yearQ, periodQ, q("nr", { type: "integer" }, "Voucher number."), accountQ, partyQ,
        q("vat_code", { type: "string" }, "VAT code."), fromQ("posting_date"), toQ("posting_date")]),
  },
  "/account-balance": {
    get: read("account_balance", "Balance per account, all time.", "AccountBalanceRow", [accountQ]),
  },
  "/account-year-balance": {
    get: read("account_year_balance", "Opening, movement and closing per account and fiscal year.", "AccountYearBalanceRow",
      [yearQ, accountQ]),
  },
  "/saldobalanse": {
    get: read("saldobalanse", "Trial balance over a period range (one row per account and period_from/period_to pair).",
      "SaldobalanseRow", [yearQ, periodFromQ, periodToQ, accountQ]),
  },
  "/kontospesifikasjon": {
    get: read("kontospesifikasjon", "Every posting line per account with running balance and counter-accounts.",
      "KontospesifikasjonRow", [yearQ, accountQ, partyQ,
        q("period_from", { type: "integer", minimum: 1, maximum: 13 }, "Lines with period ≥ this."),
        q("period_to", { type: "integer", minimum: 1, maximum: 13 }, "Lines with period ≤ this.")]),
  },
  "/bokforingsspesifikasjon": {
    get: read("bokforingsspesifikasjon", "Vouchers line by line, with attached documents.", "BokforingsspesifikasjonRow",
      [yearQ, q("nr", { type: "integer" }, "Voucher number."),
        q("period_from", { type: "integer", minimum: 1, maximum: 13 }, "Lines with period ≥ this."),
        q("period_to", { type: "integer", minimum: 1, maximum: 13 }, "Lines with period ≤ this."),
        fromQ("posting_date"), toQ("posting_date")]),
  },
  "/kundespesifikasjon": {
    get: read("kundespesifikasjon", "Customer balances over a period range.", "KundespesifikasjonRow",
      [yearQ, periodFromQ, periodToQ, partyQ]),
  },
  "/leverandorspesifikasjon": {
    get: read("leverandorspesifikasjon", "Supplier balances over a period range.", "LeverandorspesifikasjonRow",
      [yearQ, periodFromQ, periodToQ, partyQ]),
  },
  "/resultat": {
    get: read("resultat", "Income statement over a period range, by class and SAF-T grouping.", "ResultatRow",
      [yearQ, periodFromQ, periodToQ]),
  },
  "/balanse": {
    get: read("balanse", "Balance sheet at the end of a period, by class and SAF-T grouping.", "BalanseRow",
      [yearQ, periodQ]),
  },
  "/vat-summary": {
    get: read("vat_summary", "VAT base and amounts per period, code and rate (stated-else-derived).", "VatSummaryRow",
      [yearQ, periodQ, q("vat_code", { type: "string" }, "VAT code.")]),
  },
  "/vat-control": {
    get: read("vat_control", "Derived VAT vs VAT booked on the 27xx accounts, per period.", "VatControlRow",
      [yearQ, periodQ]),
  },
  "/mva-term": {
    get: read("mva_term", "VAT per term (skattleggingsperiode), code and rate, signed as the MVA-melding reads.",
      "MvaTermRow", [yearQ, q("term", { type: "integer", minimum: 1, maximum: 12 }, "VAT term."),
        q("vat_code", { type: "string" }, "VAT code.")]),
  },
  "/voucher-without-document": {
    get: read("voucher_without_document", "The missing-receipts queue: vouchers with no document attached.",
      "VoucherWithoutDocumentRow", [yearQ, periodQ]),
  },
  "/mva-melding/{year}/{term}": {
    get: {
      operationId: "mva_melding",
      summary: "MVA-melding draft (Skatteetaten skattemeldingformerverdiavgift v1.0) for one term, from mva_term.",
      parameters: [
        path("year", { type: "integer" }, "Year."),
        path("term", { type: "integer", minimum: 1, maximum: 12 }, "Term within the entity's vat_term cadence."),
        entityQ,
        q("reference", { type: "string" }, "regnskapssystemsreferanse; default hovedbok:<entity>:<year>-<term>."),
        q("format", { type: "string", enum: ["xml", "json"] }, "xml (default) or json (lines and totals with the xml)."),
      ],
      responses: {
        "200": {
          description: "The melding.",
          content: {
            "application/xml": { schema: { type: "string" } },
            "application/json": { schema: ref("MvaMelding") },
          },
        },
        ...errorResponses,
      },
    },
  },
  "/saf-t": {
    get: {
      operationId: "saf_t",
      summary: "SAF-T Financial export for a period; Content-Disposition carries Skatteetaten's file name.",
      parameters: [
        entityQ,
        q("year", { type: "integer" }, "Whole fiscal year (instead of from/to)."),
        q("from", { type: "string", format: "date" }, "Selection start, inclusive."),
        q("to", { type: "string", format: "date" }, "Selection end, inclusive."),
        q("version", { type: "string", enum: ["1.30", "1.40"] }, "Schema version; default 1.30."),
      ],
      responses: {
        "200": {
          description: "SAF-T Financial XML; attachment filename `SAF-T Financial_<orgnr>_<YYYYMMDDHHMMSS>_1_1.xml`.",
          content: { "application/xml": { schema: { type: "string" } } },
        },
        ...errorResponses,
      },
    },
  },

  "/bank/unmatched": {
    get: read("unmatched_bank", "The agent work queue: booked bank transactions not yet explained by a voucher.",
      "UnmatchedBankRow", [fromQ("booking_date"), toQ("booking_date")]),
  },
  "/bank/reconciliation": {
    get: read("bank_reconciliation", "Ledger balance vs the latest bank balance per bank account.",
      "BankReconciliationRow", [q("ledger_account", { type: "string" }, "The 19xx ledger account.")]),
  },
  "/bank/connections": {
    get: read("bank_connection_status",
      "Enable Banking consents: status, accounts, the unattended budget (4 per 24 h) and the 429 backoff, last fetch.",
      "BankConnectionStatusRow", [q("id", { type: "integer" }, "Connection id."),
        q("status", { type: "string", enum: ["pending", "authorized", "expired", "revoked", "superseded"] }, "Consent status.")]),
  },
  "/bank/consents": {
    post: {
      ...command("start_consent",
        "Start an Enable Banking consent: a pending connection and the bank's authorization URL. The bank redirects the browser to /bank/consent-callback.",
        ref("StartConsent"), ref("StartConsentResult")),
      responses: { ...ok(ref("StartConsentResult")), ...bankErrors },
    },
  },
  "/bank/consent-callback": {
    get: {
      operationId: "complete_consent",
      summary: "Enable Banking consent redirect: records the session and its accounts (ledger account 1920), then backfills " +
        "(attended when PSU_IP_ADDRESS is set). Authenticated by state, not a bearer token. Answers in plain text for the browser.",
      security: [],
      parameters: [
        q("code", { type: "string" }, "Authorization code from the bank."),
        q("state", { type: "string" }, "The state start_consent issued."),
        q("error", { type: "string" }, "Set by the bank when the owner cancelled or authorization failed."),
        q("error_description", { type: "string" }, "The bank's explanation of error."),
      ],
      responses: {
        "200": { description: "Connection authorized; accounts and backfill summarised.", content: { "text/plain": { schema: { type: "string" } } } },
        "400": { description: "No code/state, or the bank reported an error.", content: { "text/plain": { schema: { type: "string" } } } },
        "409": { description: "The consent was completed by another request.", content: { "text/plain": { schema: { type: "string" } } } },
        "422": { description: "No pending connection for this state (already used, or unknown), or the database refused.", content: { "text/plain": { schema: { type: "string" } } } },
        "502": { description: "Enable Banking refused or failed.", content: { "text/plain": { schema: { type: "string" } } } },
        "503": { description: "Enable Banking is not configured on the server.", content: { "text/plain": { schema: { type: "string" } } } },
      },
    },
  },
  "/bank/sync": {
    post: {
      ...command("sync_connection",
        "Fetch transactions and balances for one consent or every authorized one. Unattended by default: ≤4 runs per consent per 24 h, " +
          "none during a 429 backoff (such runs come back deferred, with resumeAt).",
        ref("SyncRequest"), { type: "array", items: ref("SyncResult") }),
      requestBody: { required: false, content: { "application/json": { schema: ref("SyncRequest") } } },
      responses: { ...ok({ type: "array", items: ref("SyncResult") }, "One result per consent synced."), ...bankErrors },
    },
  },
  "/bank/matches": {
    post: command("match_bank", "Link a bank transaction to the voucher line on its bank account's ledger account (idempotent).",
      ref("MatchBank"), ref("MatchBankResult")),
    delete: command("unmatch_bank", "Remove a bank transaction's link(s) to a voucher; it returns to /bank/unmatched.",
      ref("UnmatchBank"), ref("UnmatchBankResult")),
  },
  "/openapi.json": {
    get: {
      operationId: "openapi",
      summary: "This document. No bearer token.",
      security: [],
      responses: { "200": { description: "OpenAPI 3.1", content: { "application/json": { schema: { type: "object" } } } } },
    },
  },
};

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "hovedbok",
    version: "1.0.0",
    description:
      "Agent-first Norwegian ledger. Every route is 1:1 with a SQL command function or view (operationId = its name); " +
      "the database enforces the bookkeeping law and its error messages are written for agents. " +
      "Errors: {error, sqlstate}. Money is signed integer øre (+debit/−credit). " +
      "Auth: Bearer API_TOKEN (read-write) or API_RO_TOKEN (GET only). Reads are scoped by ?entity=<orgnr>; writes carry entity in the body.",
  },
  security: [{ bearer: [] }],
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    schemas,
  },
  paths,
} as const;
