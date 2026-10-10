// Enable Banking → the bank tables (0005). Facts in, nothing interpreted.
//
//   const { url } = await startConsent(sql, client, { entity, aspsp, redirectUrl });
//   // ... the owner authorises at the bank; the callback carries ?code&state
//   await completeConsent(sql, client, { state, code, ledgerAccount: () => "1920", psu });
//   await syncConnection(sql, client, connectionId);           // unattended (cron)
//   await syncConnection(sql, client, connectionId, { psu });  // attended (a human clicked)
//
// Rules this layer owns (research-enable-banking.md, AGENTS.md):
// - A sync run of a consent is one fetch. Unattended runs are capped at 4 per
//   rolling 24 h per consent, counted from bank_fetch; a 5th is deferred.
// - 429 sets bank_connection.backoff_until = now + max(6 h, Retry-After);
//   unattended runs before that are deferred without touching the bank.
// - BOOK transactions become bank_transaction rows keyed by entry_reference,
//   else 'fp:' + a content fingerprint. Re-syncing an overlapping window inserts
//   nothing twice (on conflict do nothing). Pending transactions replace the
//   snapshot wholesale. Balances are appended per sync.
// - Backfill runs immediately after consent, attended when the browser
//   context is known — full history is often reachable only in the first hour.
import type { SQL } from "bun";
import {
  type AccountResource,
  type Balance,
  EnableBankingClient,
  type PsuContext,
  RateLimitedError,
  SessionExpiredError,
  type Transaction,
  EnableBankingError,
} from "./client";

export const MAX_UNATTENDED_PER_DAY = 4;
export const BACKOFF_SECONDS = 6 * 3600;
/** Days a regular sync reaches back past the previous one (bookings arrive late). */
export const OVERLAP_DAYS = 7;
/** First window when there is no previous sync and the bank refuses `longest`. */
export const FALLBACK_HISTORY_DAYS = 89;

// ----- parsing -----

/** "1.23" / "-1234.5" / "1.235" (half up) → signed øre. */
export function oreFromDecimal(s: string): number {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal amount: ${JSON.stringify(s)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let ore = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) ore += 1;
  if (!Number.isSafeInteger(ore)) throw new Error(`amount out of range: ${s}`);
  return sign * ore || 0;
}

/** Signed øre of a transaction: + into the account (CRDT), − out (DBIT). */
export function transactionOre(tx: Transaction): number {
  const ore = oreFromDecimal(tx.transaction_amount.amount);
  const ind = tx.credit_debit_indicator;
  if (ind === "DBIT") return -Math.abs(ore);
  if (ind === "CRDT") return Math.abs(ore);
  return ore; // no indicator: trust the sign
}

function remittance(tx: Transaction): string | null {
  const lines = (tx.remittance_information ?? []).map((l) => (l ?? "").trim()).filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

/**
 * The dedup key (0005): entry_reference when the bank gives one, else a
 * fingerprint of the content that survives a re-fetch. balance_after_transaction
 * tells two otherwise identical movements on the same day apart when present.
 */
export function dedupKey(tx: Transaction): string {
  const ref = (tx.entry_reference ?? "").trim();
  if (ref) return ref;
  const parts = [
    tx.booking_date ?? "",
    tx.value_date ?? "",
    String(transactionOre(tx)),
    tx.transaction_amount.currency ?? "",
    tx.credit_debit_indicator ?? "",
    tx.reference_number ?? "",
    remittance(tx) ?? "",
    tx.balance_after_transaction?.amount ?? "",
  ];
  return "fp:" + new Bun.CryptoHasher("sha256").update(parts.join("\x1f")).digest("hex");
}

function counterparty(tx: Transaction): string | null {
  const creditor = tx.creditor?.name?.trim() || null;
  const debtor = tx.debtor?.name?.trim() || null;
  return tx.credit_debit_indicator === "DBIT" ? creditor ?? debtor : debtor ?? creditor;
}

function dateOrNull(s: string | null | undefined): string | null {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function accountIdentifiers(acc: AccountResource): { iban: string | null; bban: string | null } {
  let iban = acc.account_id?.iban ?? null;
  let bban: string | null = null;
  const other = acc.account_id?.other;
  if (other?.identification && (other.scheme_name ?? "").toUpperCase() === "BBAN") bban = other.identification;
  for (const id of acc.all_account_ids ?? []) {
    const scheme = (id.scheme_name ?? "").toUpperCase();
    if (!iban && scheme === "IBAN" && id.identification) iban = id.identification;
    if (!bban && scheme === "BBAN" && id.identification) bban = id.identification;
  }
  return { iban, bban };
}

// ----- results -----

export interface AccountSyncResult {
  idHash: string;
  /** BOOK transactions in the fetched window. */
  seen: number;
  /** New bank_transaction rows. */
  inserted: number;
  /** Same dedup key, different amount — the bank reused an entry_reference. */
  conflicts: number;
  /** Rows in the replaced pending snapshot. */
  pending: number;
  /** Non-BOOK, non-pending statuses (CNCL, RJCT, OTHR) left out. */
  ignored: number;
  balances: number;
  pages: number;
  dateFrom: string | null;
  dateTo: string | null;
}

export type SyncOutcome = "ok" | "rate_limited" | "expired" | "deferred";

export interface SyncResult {
  connectionId: number;
  outcome: SyncOutcome;
  attended: boolean;
  accounts: AccountSyncResult[];
  warnings: string[];
  /** For rate_limited/deferred: when unattended syncing may resume. */
  resumeAt?: Date;
  detail?: string;
}

// ----- consent -----

export interface StartConsentOptions {
  entity: string;
  aspsp: { name: string; country?: string };
  redirectUrl: string;
  validUntil?: Date;
  psuType?: "personal" | "business";
  language?: string;
}

/** Creates a pending bank_connection and the bank's authorization URL. */
export async function startConsent(
  sql: SQL,
  client: EnableBankingClient,
  o: StartConsentOptions,
): Promise<{ connectionId: number; state: string; url: string }> {
  const country = o.aspsp.country ?? "NO";
  const state = crypto.randomUUID();
  const [row] = await sql`
    insert into bank_connection (entity, aspsp_name, aspsp_country, auth_state)
    values (${o.entity}, ${o.aspsp.name}, ${country}, ${state})
    returning id`;
  const connectionId = Number(row.id);
  const { url } = await client.startAuth({
    aspsp: { name: o.aspsp.name, country },
    redirectUrl: o.redirectUrl,
    state,
    validUntil: o.validUntil,
    psuType: o.psuType,
    language: o.language,
  });
  return { connectionId, state, url };
}

export interface CompleteConsentOptions {
  /** `state` from the callback query string. */
  state: string;
  /** `code` from the callback query string. */
  code: string;
  /**
   * The 19xx account each bank account feeds (must exist on the entity).
   * Return undefined to leave an account out of the books.
   */
  ledgerAccount: (acc: AccountResource) => string | undefined;
  /** The authorising user's browser context: makes the backfill attended. */
  psu?: PsuContext;
  /** Skip the post-consent backfill (tests, or when the quota is known spent). */
  noBackfill?: boolean;
  today?: () => string;
  now?: () => Date;
  onWarning?: (msg: string) => void;
}

export interface CompleteConsentResult {
  connectionId: number;
  sessionId: string;
  validUntil: string | null;
  accounts: { idHash: string; uid: string | null; ledgerAccount: string | null; iban: string | null; bban: string | null }[];
  backfill: SyncResult | null;
}

/** POST /sessions, records the session and its accounts, then backfills. */
export async function completeConsent(
  sql: SQL,
  client: EnableBankingClient,
  o: CompleteConsentOptions,
): Promise<CompleteConsentResult> {
  const [conn] = await sql`
    select id, entity, status from bank_connection where auth_state = ${o.state}`;
  if (!conn) throw new Error(`no pending bank_connection for state ${JSON.stringify(o.state)}`);
  if (conn.status !== "pending") throw new Error(`bank_connection ${conn.id} is ${conn.status}, not pending`);
  const connectionId = Number(conn.id);
  const entity = String(conn.entity);

  const session = await client.createSession(o.code);
  const validUntil = session.access?.valid_until ?? null;
  const accounts: CompleteConsentResult["accounts"] = [];

  await sql.begin(async (tx) => {
    await tx`
      update bank_connection
         set session_id = ${session.session_id}, valid_until = ${validUntil},
             status = 'authorized', auth_state = null,
             aspsp_name = coalesce(${session.aspsp?.name ?? null}, aspsp_name),
             aspsp_country = coalesce(${session.aspsp?.country ?? null}, aspsp_country)
       where id = ${connectionId}`;
    for (const acc of session.accounts ?? []) {
      if (typeof acc !== "object" || !acc.identification_hash) continue;
      const ledger = o.ledgerAccount(acc) ?? null;
      const { iban, bban } = accountIdentifiers(acc);
      const uid = acc.uid ?? null;
      if (!ledger) {
        accounts.push({ idHash: acc.identification_hash, uid, ledgerAccount: null, iban, bban });
        continue;
      }
      const [existing] = await tx`select entity from bank_account where id_hash = ${acc.identification_hash}`;
      if (existing && existing.entity !== entity) {
        throw new Error(`bank account ${acc.identification_hash} already belongs to entity ${existing.entity}`);
      }
      // Identity hangs on identification_hash; uid and connection are refreshed
      // on every consent. ledger_account is set once and kept.
      await tx`
        insert into bank_account (id_hash, entity, connection_id, uid, iban, bban, name, currency, ledger_account, raw)
        values (${acc.identification_hash}, ${entity}, ${connectionId}, ${uid}, ${iban}, ${bban},
                ${acc.name ?? acc.product ?? acc.details ?? null}, ${acc.currency ?? "NOK"}, ${ledger}, ${acc as never}::jsonb)
        on conflict (id_hash) do update
           set connection_id = excluded.connection_id, uid = excluded.uid,
               iban = coalesce(excluded.iban, bank_account.iban),
               bban = coalesce(excluded.bban, bank_account.bban),
               name = coalesce(excluded.name, bank_account.name),
               currency = excluded.currency, raw = excluded.raw`;
      accounts.push({ idHash: acc.identification_hash, uid, ledgerAccount: ledger, iban, bban });
    }
  });

  let backfill: SyncResult | null = null;
  if (!o.noBackfill) {
    backfill = await syncConnection(sql, client, connectionId, {
      psu: o.psu,
      backfill: true,
      today: o.today,
      now: o.now,
      onWarning: o.onWarning,
    });
  }
  return { connectionId, sessionId: session.session_id, validUntil, accounts, backfill };
}

// ----- sync -----

export interface SyncOptions {
  /** Present when a human triggered the run: sends PSU headers, skips the unattended budget. */
  psu?: PsuContext;
  /** Ask for the longest history the bank allows (post-consent). */
  backfill?: boolean;
  /** Explicit window (ISO dates, inclusive) instead of the computed one. */
  dateFrom?: string;
  dateTo?: string;
  /** Run even when the unattended budget or backoff says no (operator override). */
  force?: boolean;
  /** UTC calendar date; injectable for tests. */
  today?: () => string;
  now?: () => Date;
  onWarning?: (msg: string) => void;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function logFetch(
  sql: SQL,
  connectionId: number,
  at: Date,
  attended: boolean,
  outcome: SyncOutcome | "error",
  detail?: string,
): Promise<void> {
  await sql`
    insert into bank_fetch (connection_id, started_at, attended, outcome, detail)
    values (${connectionId}, ${at}, ${attended}, ${outcome}, ${detail ?? null})`;
}

/** One fetch of every account on a consent. Never throws on 429 or an expired session. */
export async function syncConnection(
  sql: SQL,
  client: EnableBankingClient,
  connectionId: number,
  o: SyncOptions = {},
): Promise<SyncResult> {
  const now = o.now ?? (() => new Date());
  const today = o.today ?? utcToday;
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    o.onWarning?.(m);
  };
  const attendedWanted = !!o.psu;
  const base = { connectionId, attended: attendedWanted, accounts: [] as AccountSyncResult[], warnings };

  const [conn] = await sql`
    select id, status, valid_until, last_synced_at, backoff_until
      from bank_connection where id = ${connectionId}`;
  if (!conn) throw new Error(`bank_connection ${connectionId} does not exist`);
  if (conn.status !== "authorized") {
    return { ...base, outcome: "expired", detail: `connection is ${conn.status}` };
  }
  if (conn.valid_until && new Date(conn.valid_until) <= now()) {
    await sql`update bank_connection set status = 'expired' where id = ${connectionId}`;
    await logFetch(sql, connectionId, now(), attendedWanted, "expired", "consent valid_until passed");
    return { ...base, outcome: "expired", detail: "consent valid_until passed" };
  }

  if (!attendedWanted && !o.force) {
    if (conn.backoff_until && new Date(conn.backoff_until) > now()) {
      const resumeAt = new Date(conn.backoff_until);
      await logFetch(sql, connectionId, now(), false, "deferred", `backoff until ${resumeAt.toISOString()}`);
      return { ...base, outcome: "deferred", resumeAt, detail: "rate-limit backoff" };
    }
    const [{ n, oldest }] = await sql`
      select count(*)::int as n, min(started_at) as oldest
        from bank_fetch
       where connection_id = ${connectionId} and not attended
         and outcome in ('ok', 'rate_limited')
         and started_at > ${now()}::timestamptz - interval '24 hours'`;
    if (n >= MAX_UNATTENDED_PER_DAY) {
      const resumeAt = new Date(new Date(oldest).getTime() + 86400_000);
      await logFetch(sql, connectionId, now(), false, "deferred", `${n} unattended fetches in 24 h`);
      return { ...base, outcome: "deferred", resumeAt, detail: `unattended budget (${MAX_UNATTENDED_PER_DAY}/day) spent` };
    }
  }

  const accounts = (await sql`
    select id_hash, uid from bank_account
     where connection_id = ${connectionId} and uid is not null
     order by id_hash`) as { id_hash: string; uid: string }[];

  const dateTo = o.dateTo ?? today();
  let dateFrom: string | undefined = o.dateFrom;
  if (!dateFrom && !o.backfill) {
    dateFrom = conn.last_synced_at
      ? addDays(new Date(conn.last_synced_at).toISOString().slice(0, 10), -OVERLAP_DAYS)
      : addDays(dateTo, -FALLBACK_HISTORY_DAYS);
  }

  let attended = attendedWanted;
  const results: AccountSyncResult[] = [];
  try {
    for (const acc of accounts) {
      const r = await syncAccount(sql, client, acc, {
        psu: attended ? o.psu : undefined,
        backfill: !!o.backfill,
        dateFrom,
        dateTo,
        onWarning: warn,
      });
      if (r.psuRefused) {
        attended = false;
        warn(`account ${acc.id_hash}: PSU headers refused; continuing unattended`);
      }
      results.push(r.result);
    }
  } catch (e) {
    if (e instanceof RateLimitedError) {
      const seconds = Math.max(BACKOFF_SECONDS, e.retryAfterSeconds ?? 0);
      const resumeAt = new Date(now().getTime() + seconds * 1000);
      await sql`update bank_connection set backoff_until = ${resumeAt} where id = ${connectionId}`;
      await logFetch(sql, connectionId, now(), attended, "rate_limited", e.message);
      return { ...base, attended, accounts: results, outcome: "rate_limited", resumeAt, detail: e.message };
    }
    if (e instanceof SessionExpiredError) {
      await sql`update bank_connection set status = 'expired' where id = ${connectionId}`;
      await logFetch(sql, connectionId, now(), attended, "expired", e.message);
      return { ...base, attended, accounts: results, outcome: "expired", detail: e.message };
    }
    await logFetch(sql, connectionId, now(), attended, "error", e instanceof Error ? e.message : String(e));
    throw e;
  }

  await sql`
    update bank_connection set last_synced_at = ${now()}, backoff_until = null
     where id = ${connectionId}`;
  await logFetch(sql, connectionId, now(), attended, "ok", `${results.length} accounts`);
  return { ...base, attended, accounts: results, outcome: "ok" };
}

interface AccountSyncOptions {
  psu?: PsuContext;
  backfill: boolean;
  dateFrom?: string;
  dateTo: string;
  onWarning: (msg: string) => void;
}

const PENDING_STATUSES = new Set(["PDNG", "HOLD", "SCHD"]);

/** Fetches one account and writes the facts in a single transaction. */
export async function syncAccount(
  sql: SQL,
  client: EnableBankingClient,
  acc: { id_hash: string; uid: string },
  o: AccountSyncOptions,
): Promise<{ result: AccountSyncResult; psuRefused: boolean }> {
  let psuRefused = false;
  let psu = o.psu;
  let dateFrom = o.dateFrom;
  let fetched;
  if (o.backfill) {
    try {
      fetched = await client.transactions(acc.uid, { strategy: "longest" }, { psu, onWarning: o.onWarning });
    } catch (e) {
      if (!(e instanceof EnableBankingError) || e.code !== "WRONG_TRANSACTIONS_PERIOD") throw e;
      dateFrom = addDays(o.dateTo, -FALLBACK_HISTORY_DAYS);
      o.onWarning(`account ${acc.id_hash}: bank refused the longest history; fetching ${dateFrom}..${o.dateTo}`);
      fetched = await client.transactions(acc.uid, { dateFrom, dateTo: o.dateTo }, { psu, onWarning: o.onWarning });
    }
  } else {
    fetched = await client.transactions(acc.uid, { dateFrom, dateTo: o.dateTo }, { psu, onWarning: o.onWarning });
  }
  if (fetched.psuRefused) {
    psuRefused = true;
    psu = undefined;
  }
  const balances = await client.balances(acc.uid, psu);
  if (balances.psuRefused) psuRefused = true;

  const result = await sql.begin(async (tx) =>
    storeAccount(tx as unknown as SQL, acc.id_hash, fetched.transactions, balances.data, o.onWarning),
  ) as AccountSyncResult;
  return {
    result: { ...result, pages: fetched.pages, dateFrom: o.backfill && !dateFrom ? null : dateFrom ?? null, dateTo: o.dateTo },
    psuRefused,
  };
}

/** Writes one account's fetched transactions and balances. Pure DB; used by the replay tests too. */
export async function storeAccount(
  tx: SQL,
  idHash: string,
  transactions: Transaction[],
  balances: Balance[],
  onWarning: (msg: string) => void = () => {},
): Promise<AccountSyncResult> {
  const r: AccountSyncResult = {
    idHash, seen: 0, inserted: 0, conflicts: 0, pending: 0, ignored: 0, balances: 0,
    pages: 0, dateFrom: null, dateTo: null,
  };
  const pending: Transaction[] = [];
  const seenKeys = new Map<string, number>();
  for (const t of transactions) {
    const status = (t.status ?? "BOOK").toUpperCase();
    if (status !== "BOOK") {
      if (PENDING_STATUSES.has(status)) pending.push(t);
      else r.ignored++;
      continue;
    }
    r.seen++;
    const key = dedupKey(t);
    const amount = transactionOre(t);
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      if (prior !== amount) r.conflicts++;
      continue; // the bank sent the same entry twice in one window
    }
    seenKeys.set(key, amount);
    const rows = await tx`
      insert into bank_transaction
        (id_hash, dedup_key, booking_date, value_date, amount, ccy, status,
         counterparty, reference, reference_schema, remittance, raw)
      values
        (${idHash}, ${key}, ${dateOrNull(t.booking_date)}, ${dateOrNull(t.value_date)},
         ${amount}, ${t.transaction_amount.currency ?? "NOK"}, 'BOOK',
         ${counterparty(t)}, ${t.reference_number ?? null}, ${t.reference_number_schema ?? null},
         ${remittance(t)}, ${t as never}::jsonb)
      on conflict (id_hash, dedup_key) do nothing
      returning dedup_key`;
    if (rows.length) {
      r.inserted++;
      continue;
    }
    const [existing] = await tx`
      select amount from bank_transaction where id_hash = ${idHash} and dedup_key = ${key}`;
    if (existing && Number(existing.amount) !== amount) {
      r.conflicts++;
      onWarning(`account ${idHash}: entry_reference ${key} seen with amount ${amount}, stored ${existing.amount}`);
    }
  }

  await tx`delete from bank_transaction_pending where id_hash = ${idHash}`;
  for (let i = 0; i < pending.length; i++) {
    await tx`
      insert into bank_transaction_pending (id_hash, seq, raw)
      values (${idHash}, ${i + 1}, ${pending[i] as never}::jsonb)`;
  }
  r.pending = pending.length;

  for (const b of balances) {
    if (!b.balance_type || !b.balance_amount?.amount) continue;
    const rows = await tx`
      insert into bank_balance (id_hash, balance_type, reference_date, amount, raw)
      values (${idHash}, ${b.balance_type}, ${dateOrNull(b.reference_date)},
              ${oreFromDecimal(b.balance_amount.amount)}, ${b as never}::jsonb)
      on conflict do nothing
      returning balance_type`;
    r.balances += rows.length;
  }
  return r;
}
