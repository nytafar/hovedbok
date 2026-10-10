// Tool descriptions for the MCP server (#12): the agent bookkeeper's UX. One
// per API operation (operationId); test/mcp.test.ts asserts the key set is
// exactly the tool set. Payload shapes come from src/api/openapi.ts; these
// say what the operation means in ledger terms, what the database expects and
// what its refusals mean.

/** Shared by the server's instructions and every write tool. */
export const CONVENTIONS =
  "Money is signed integer øre (100 øre = 1 kr): +debit, −credit. entity is the company's 9-digit orgnr. " +
  "Refusals come back as isError with JSON {status, error, sqlstate, detail?, hint?}; error is the database's own " +
  "message naming the rule and the fix. 422 = a bookkeeping rule refused the input (fix it, do not resend as is); " +
  "409 = conflict (retry, or use another key); 400 = malformed input; 502/503 = the bank or its configuration.";

const WRITE = " Refusals: isError with the database's message (422 rule broken, 409 conflict, 400 malformed).";

const VIEW =
  " Read-only view: entity required; every other filter optional (ANDed); limit/offset page in the view's fixed order." +
  " Amounts are signed øre (+debit/−credit).";

export const descriptions: Record<string, string> = {
  // --- commands ----------------------------------------------------------------
  bootstrap_entity:
    "Create an accounting entity (company, by 9-digit orgnr) with the NS 4102 standard chart, control accounts and VAT " +
    "defaults, and open a fiscal year (periods 1-12 = months, 13 = year-end closing). year defaults to the current year; " +
    "vat_registered (default false) and vat_term monthly|bimonthly|yearly (default bimonthly) drive the MVA-melding. " +
    "Idempotent and non-destructive: on an existing entity it only adds what is missing (new standard accounts, the " +
    "requested year) and returns created=false. Run it once per entity and again to open a new year. Optional " +
    "company_profile (see set_company_profile) is stored on a new entity, or on an existing one without a profile; a " +
    "re-run never overwrites a stored one. The result carries the profile now stored." + WRITE,

  set_company_profile:
    "Set the company profile the SAF-T export puts in Header/Company: {address {street, number, city, postalCode, " +
    "country}, contact {firstName, lastName, telephone, email}, bankAccounts [{number, ledgerAccount, currency}]}. " +
    "Replaces the stored profile as a whole (an absent key is removed; {} clears it). saf_t refuses until contact " +
    "firstName, lastName, telephone and address city, postalCode are set. bankAccounts defaults to the bank accounts " +
    "connected through Enable Banking. Returns {entity, company_profile}." + WRITE,

  upsert_account:
    "Create or update an account in the entity's chart. code is 4 digits (NS 4102). name is required unless code is a " +
    "standard account. std_account maps it to a SAF-T standard account (immutable once the account has postings); " +
    "control customer|supplier makes it a reskontro control account whose lines need a party with that role; " +
    "default_vat records the account's usual VAT code (a hint: post_voucher never applies it). A key sent as null clears " +
    "the column, an absent key keeps it. Returns {entity, code, created}." + WRITE,

  upsert_party:
    "Create or update a party (customer and/or supplier) that voucher lines reference by id. id is your key (e.g. a " +
    "customer number). name is required on insert. The customer/supplier roles decide which control accounts (e.g. 1500 " +
    "kundefordringer, 2400 leverandørgjeld) the party may be posted to. orgnr is a Norwegian 9-digit orgnr; a foreign " +
    "party uses foreign_reg_no and country (ISO alpha-2, default NO). owner/senior_employee mark related parties. A key " +
    "sent as null clears the column, an absent key keeps it. Returns {entity, id, created}." + WRITE,

  post_voucher:
    "Post one balanced voucher (bilag) to the journal; the only way anything enters the ledger. lines: ≥2, each " +
    "{account (4-digit code in the entity's chart), amount (signed øre, non-zero)}, summing to exactly 0. " +
    "VAT goes on the base line, never on the 27xx VAT line: vat_code + vat_base (the net amount, signed like amount); " +
    "the 27xx line carries the VAT with no code. Optional vat_amount = the VAT the document states (must be within " +
    "1 kr or 1 % of rate × base). Common codes: 1 input 25 %, 11 input 15 % (food), 13 input 12 %, 3 output 25 %, " +
    "31 output 15 %, 33 output 12 %, 5 zero-rated domestic, 52 export, 6 outside the VAT Act, 0 no VAT (purchase), " +
    "86/88 services bought from abroad (reverse charge). Sale of 100 kr + 25 % VAT: " +
    "[{account 1500, amount 12500, party K1}, {account 3000, amount -10000, vat_code 3, vat_base -10000}, " +
    "{account 2700, amount -2500}]. Lines on control accounts (1500, 2400 …) need party with the matching role. " +
    "posting_date must fall in an open period of an open fiscal year; period defaults to its month (13 = year-end " +
    "closing, posting_date 31.12 only). idempotency_key is required and identifies the source event: replaying a key " +
    "returns the voucher first posted under it (idempotent=true) and posts nothing, even if the payload differs. " +
    "documents: sha256s from store_document; matches: bank transactions (from unmatched_bank) this voucher explains. " +
    "Returns {entity, year, nr, idempotent}; read it back with journal (year, nr). Posted vouchers never change: " +
    "correct with reverse_voucher and a new post_voucher." + WRITE,

  reverse_voucher:
    "Correct a posted voucher (year, nr): post its exact negation — every line, VAT fields included — as a new voucher " +
    "that references it. Vouchers are append-only; reversal plus a new post_voucher is the only correction. Once per " +
    "voucher: repeating returns the existing reversal (idempotent=true). posting_date defaults to today and must fall " +
    "in an open period. Returns {entity, year, nr, idempotent} of the reversal." + WRITE,

  close_period:
    "Close one period (1-12 = month, 13 = year-end closing) of a fiscal year: nothing more can be posted to it, and " +
    "there is no reopen. Refused when the period is missing or already closed. Close 1-12 before close_fiscal_year." +
    WRITE,

  close_fiscal_year:
    "Year-end close: in period 13 (posting_date 31.12) posts the year's result to 8800 → 8960 (profit) / 8990 (loss) → " +
    "equity (equity_account 2000-2099; default 2050 on profit, 2080 on loss), closes period 13 and opens the next " +
    "year. Requires periods 1-12 closed. Irreversible. Returns the result (credit = profit, negative), the equity " +
    "account and the closing voucher numbers." + WRITE,

  // --- documents -----------------------------------------------------------------
  store_document:
    "Store a source document (receipt, invoice, contract …) verbatim, content-addressed by sha256: content_base64 is the " +
    "file's bytes in base64, media_type its type (application/pdf, image/jpeg …), origin where it came from. Storing the " +
    "same bytes again returns the existing row. Attach it via post_voucher.documents or link_document. Returns " +
    "{sha256, mediaType, bytes, origin, note, createdAt}." + WRITE,

  retrieve_document:
    "Fetch a stored document by sha256, re-hashed on every read (an integrity error means the stored blob changed). " +
    "Returned as an embedded resource: text for text media types, base64 blob otherwise.",

  link_document:
    "Attach a stored document (sha256 from store_document) to an already posted voucher (year, nr) — how a voucher " +
    "leaves voucher_without_document. Idempotent. Returns {entity, year, nr, sha256}." + WRITE,

  // --- reads -----------------------------------------------------------------------
  journal:
    "The journal: one row per posting line (voucher year/nr/line, dates, period, account, amount, VAT fields, party, " +
    "reversal links, created_by). Filter year + nr to read one voucher back." + VIEW,
  account_balance: "Balance per account over all time." + VIEW,
  account_year_balance: "Opening, movement and closing per account and fiscal year." + VIEW,
  saldobalanse:
    "Trial balance (saldobalanse): opening, debit, credit, closing per account, one row set per period_from/period_to " +
    "pair; filter both to get one range." + VIEW,
  kontospesifikasjon:
    "General ledger per account (kontospesifikasjon): every line with running balance before/after and the " +
    "counter-accounts." + VIEW,
  bokforingsspesifikasjon:
    "Vouchers line by line with their attached document sha256s (bokføringsspesifikasjon) — the audit view." + VIEW,
  kundespesifikasjon: "Customer balances per party and control account over a period range (kundereskontro)." + VIEW,
  leverandorspesifikasjon:
    "Supplier balances per party and control account over a period range (leverandørreskontro)." + VIEW,
  resultat:
    "Income statement over a period range by class and SAF-T grouping; amount is the movement (revenue negative, " +
    "cost positive), so the result is −sum (profit positive)." + VIEW,
  balanse:
    "Balance sheet at the end of a period by class and SAF-T grouping; amount is the closing balance (assets positive, " +
    "equity and liabilities negative)." + VIEW,
  vat_summary:
    "VAT per period, code and rate: base, VAT, output/input split (the stated vat_amount where given, else derived)." +
    VIEW,
  vat_control:
    "Derived VAT (from coded base lines) vs VAT booked on the 27xx accounts, per period. A non-zero difference means a " +
    "base line lacks its vat_code or a 27xx line is wrong." + VIEW,
  mva_term:
    "VAT per VAT term (skattleggingsperiode, by the entity's vat_term), code and rate, signed as the MVA-melding reads " +
    "it: output_vat positive = owed, input_vat negative = deducted." + VIEW,
  voucher_without_document:
    "The missing-receipts queue: vouchers with no document attached. Fix with store_document + link_document." + VIEW,
  account: "The entity's chart of accounts (code, name, SAF-T mapping, default_vat, control role, open/closed)." + VIEW,
  party: "The entity's customers and suppliers." + VIEW,
  unmatched_bank:
    "The bank work queue: booked bank transactions no voucher explains yet (amount positive = into the account). " +
    "Explain each with post_voucher (matches) or match_bank to an existing voucher." + VIEW,
  bank_reconciliation:
    "Ledger balance of each bank ledger account (19xx) vs the latest balance from the bank; a non-zero difference " +
    "means bank activity is unbooked or mis-booked." + VIEW,
  bank_connection_status:
    "Enable Banking consents: status, validity, accounts, the unattended budget (4 bank fetches per consent per 24 h), " +
    "any 429 backoff and the last fetch. Check it before sync_connection." + VIEW,

  mva_melding:
    "Build the VAT return draft (MVA-melding, Skatteetaten skattemeldingformerverdiavgift v1.0) for one term of a year " +
    "from mva_term; term counts within the entity's vat_term (bimonthly 1-6, monthly 1-12, yearly 1). format xml " +
    "(default: the XML document) or json (lines and total in whole kroner plus the XML; total positive = to pay, " +
    "negative = refund). Read-only.",

  saf_t:
    "Export SAF-T Financial XML (the format Skatteetaten demands on request) for a whole year, or from/to dates " +
    "(not both); version 1.30 (default) or 1.40. Returned as an XML resource named per Skatteetaten's file-name " +
    "convention. Header/Company comes from the entity's company profile: refused (naming the fields) until it has " +
    "contact firstName, lastName, telephone and address city, postalCode (set them with set_company_profile). " +
    "Refused when an account lacks a SAF-T mapping (fix with upsert_account). Read-only.",

  // --- bank (Enable Banking) ---------------------------------------------------------
  start_consent:
    "Begin connecting a bank (PSD2 via Enable Banking): creates a pending connection and returns the bank's " +
    "authorization url. A human must open url in a browser and authorise at the bank; the bank then redirects to the " +
    "server's consent callback, which completes the connection and backfills transactions (there is no tool for that " +
    "step — watch bank_connection_status). aspsp {name, country} as Enable Banking lists the bank. Returns " +
    "{connectionId, state, url}." + WRITE,

  sync_connection:
    "Fetch new bank transactions and balances for one consent (connection_id), an entity's consents (entity), or every " +
    "authorized consent (no arguments). Unattended by default: at most 4 bank fetches per consent per 24 h and none for " +
    "≥6 h after a 429 — such runs come back outcome deferred/rate_limited with resumeAt; wait, do not retry. " +
    "attended=true only when a human is present (needs PSU_IP_ADDRESS on the server). New transactions land in " +
    "unmatched_bank. Returns one result per consent." + WRITE,

  match_bank:
    "Record that a posted voucher explains a bank transaction: links (id_hash, dedup_key) from unmatched_bank to the " +
    "voucher's line on the bank account's ledger account (line defaults to the voucher's single line on that account). " +
    "The transaction leaves unmatched_bank. Idempotent (created=false when already linked)." + WRITE,

  unmatch_bank:
    "Remove a wrong link between a bank transaction and a voucher (one line, or every link to that voucher when line is " +
    "omitted); the transaction returns to unmatched_bank. Returns {deleted}." + WRITE,
};
