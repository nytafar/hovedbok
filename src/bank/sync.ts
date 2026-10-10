// Enable Banking → the bank tables (0005). Facts in, nothing interpreted.
//
//   const { url } = await startConsent(sql, client, { entity, aspsp, redirectUrl });
//   // ... the owner authorises at the bank; the callback carries ?code&state
//   await completeConsent(sql, client, { state, code, ledgerAccount: () => "1920", psu });
//   await syncConnection(sql, client, connectionId);           // unattended (cron)
//   await syncConnection(sql, client, connectionId, { psu });  // attended (a human clicked)
//
// Rules this layer owns (research-enable-banking.md, AGENTS.md):
// - A sync run of a consent is one fetch. Every run that reached the bank
//   (ok, rate_limited, error, expired-by-410) counts; unattended runs are
//   capped at 4 per rolling 24 h per consent, counted from bank_fetch, and a
//   5th is deferred. The bank_connection row is locked for the run, so two
//   concurrent syncs cannot both spend the budget.
// - 429 sets bank_connection.backoff_until = now + max(6 h, Retry-After);
//   unattended runs before that are deferred without touching the bank. An
//   attended run whose PSU headers the API refuses falls back to an
//   unattended read only when the budget and backoff allow it.
// - BOOK transactions become bank_transaction rows keyed by entry_reference,
//   else 'fp:' + a content fingerprint, with an occurrence number when the
//   same fingerprint appears more than once in the window (two identical
//   card payments the same day are two facts). Re-syncing an overlapping
//   window inserts nothing twice (on conflict do nothing). Pending
//   transactions replace the snapshot wholesale. Every balance the bank
//   returns is appended (fetched_at disambiguates within one fetch).
// - Backfill runs immediately after consent, attended when the browser
//   context is known — full history is often reachable only in the first hour.
// - A run whose pagination was cut short (repeated continuation_key, page
//   cap) keeps last_synced_at where it was, so the next window re-covers it.
import type { SQL } from "bun";
import {
  type AccountResource,
  type Balance,
  EnableBankingClient,
  EnableBankingError,
  type PsuContext,
  RateLimitedError,
  SessionExpiredError,
  type Transaction,
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

/** entry_reference when the bank gives one, else null. */
export function entryReference(tx: Transaction): string | null {
  const ref = (tx.entry_reference ?? "").trim();
  return ref || null;
}

/**
 * The content fingerprint behind a keyless transaction's dedup key: the fields
 * that survive a re-fetch. balance_after_transaction tells two otherwise
 * identical movements on the same day apart when present; when it is not,
 * `dedupKeys` numbers the occurrences.
 */
export function fingerprint(tx: Transaction): string {
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

/**
 * The dedup key (0005) of a single transaction: entry_reference, else the
 * fingerprint. For a whole window use `dedupKeys`, which also numbers repeated
 * fingerprints.
 */
export function dedupKey(tx: Transaction): string {
  return entryReference(tx) ?? fingerprint(tx);
}

/**
 * Dedup keys for every transaction in one fetched window, in order. Keyless
 * transactions whose fingerprint repeats get `fp:<hash>:2`, `:3` … — stable
 * across re-fetches because windows are whole days and booking_date is part
 * of the hash, so a day's identical movements always travel together.
 */
export function dedupKeys(transactions: Transaction[]): string[] {
  const seen = new Map<string, number>();
  return transactions.map((tx) => {
    const ref = entryReference(tx);
    if (ref) return ref;
    const fp = fingerprint(tx);
    const n = (seen.get(fp) ?? 0) + 1;
    seen.set(fp, n);
    return n === 1 ? fp : `${fp}:${n}`;
  });
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
  /** Same entry_reference, different amount — the bank reused a reference. */
  conflicts: number;
  /** Rows in the replaced pending snapshot. */
  pending: number;
  /** Non-BOOK, non-pending statuses (CNCL, RJCT, OTHR) left out. */
  ignored: number;
  balances: number;
  pages: number;
  /** Pagination was cut short by a guard; the window is not fully covered. */
  truncated: boolean;
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
  /** Earlier connections of the entity whose accounts all moved here. */
  superseded: number[];
  backfill: SyncResult | null;
}

/**
 * POST /sessions, records the session and its accounts, then backfills.
 * Earlier connections left without accounts are marked superseded so cron
 * stops syncing them.
 */
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
  let superseded: number[] = [];

  try {
    await sql.begin(async (tx) => {
      const claimed = await tx`
        update bank_connection
           set session_id = ${session.session_id}, valid_until = ${validUntil},
               status = 'authorized', auth_state = null,
               aspsp_name = coalesce(${session.aspsp?.name ?? null}, aspsp_name),
               aspsp_country = coalesce(${session.aspsp?.country ?? null}, aspsp_country)
         where id = ${connectionId} and status = 'pending' and auth_state = ${o.state}
         returning id`;
      if (!claimed.length) {
        throw new ConsentRaceError(`bank_connection ${connectionId} was completed by another caller`);
      }
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
          throw new ConsentEntityError(
            `bank account ${acc.identification_hash} already belongs to entity ${existing.entity}`,
          );
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
      const old = await tx`
        update bank_connection c set status = 'superseded'
         where c.entity = ${entity} and c.id <> ${connectionId} and c.status = 'authorized'
           and not exists (select 1 from bank_account a where a.connection_id = c.id)
         returning c.id`;
      superseded = old.map((r: { id: number | string }) => Number(r.id));
    });
  } catch (e) {
    if (e instanceof ConsentEntityError) {
      // The session at Enable Banking is live; don't leave it dangling on a
      // pending row that could be completed again. Record it and close it.
      await sql`
        update bank_connection
           set status = 'revoked', session_id = ${session.session_id}, auth_state = null
         where id = ${connectionId}`;
      await client.deleteSession(session.session_id).catch(() => {});
    }
    throw e;
  }

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
  return { connectionId, sessionId: session.session_id, validUntil, accounts, superseded, backfill };
}

export class ConsentRaceError extends Error {
  override name = "ConsentRaceError";
}
export class ConsentEntityError extends Error {
  override name = "ConsentEntityError";
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

type FetchOutcome = SyncOutcome | "error";

async function logFetch(
  sql: SQL,
  connectionId: number,
  at: Date,
  attended: boolean,
  outcome: FetchOutcome,
  detail: string,
  warnings: string[] = [],
): Promise<void> {
  const text = [detail, ...warnings].filter(Boolean).join("\n");
  await sql`
    insert into bank_fetch (connection_id, started_at, attended, outcome, detail)
    values (${connectionId}, ${at}, ${attended}, ${outcome}, ${text || null})`;
}

/**
 * Whether an unattended read may go to the bank now, and when it may if not.
 * Budget: every run that reached the bank in the last 24 h (not deferred).
 */
async function unattendedWindow(
  tx: SQL,
  connectionId: number,
  backoffUntil: Date | null,
  now: Date,
): Promise<{ allowed: true } | { allowed: false; resumeAt: Date; reason: string }> {
  if (backoffUntil && backoffUntil > now) {
    return { allowed: false, resumeAt: backoffUntil, reason: "rate-limit backoff" };
  }
  const [{ n, oldest }] = await tx`
    select count(*)::int as n, min(started_at) as oldest
      from bank_fetch
     where connection_id = ${connectionId} and not attended
       and outcome <> 'deferred'
       and started_at > ${now}::timestamptz - interval '24 hours'`;
  if (n >= MAX_UNATTENDED_PER_DAY) {
    return {
      allowed: false,
      resumeAt: new Date(new Date(oldest).getTime() + 86400_000),
      reason: `unattended budget (${MAX_UNATTENDED_PER_DAY}/day) spent: ${n} fetches in 24 h`,
    };
  }
  return { allowed: true };
}

/**
 * One fetch of every account on a consent, inside one transaction that holds
 * the bank_connection row. Never throws on 429, refused PSU headers or an
 * expired session; any other failure is logged (it still counts) and rethrown.
 */
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

  let failure: unknown;
  const result = (await sql.begin(async (t) => {
    const tx = t as unknown as SQL;
    const [conn] = await tx`
      select id, status, valid_until, last_synced_at, backoff_until
        from bank_connection where id = ${connectionId} for update`;
    if (!conn) throw new Error(`bank_connection ${connectionId} does not exist`);
    if (conn.status !== "authorized") {
      return { ...base, outcome: "expired", detail: `connection is ${conn.status}` };
    }
    const t0 = now();
    if (conn.valid_until && new Date(conn.valid_until) <= t0) {
      await tx`update bank_connection set status = 'expired' where id = ${connectionId}`;
      await logFetch(tx, connectionId, t0, attendedWanted, "expired", "consent valid_until passed");
      return { ...base, outcome: "expired", detail: "consent valid_until passed" };
    }

    const window = o.force
      ? ({ allowed: true } as const)
      : await unattendedWindow(tx, connectionId, conn.backoff_until ? new Date(conn.backoff_until) : null, t0);
    if (!attendedWanted && !window.allowed) {
      await logFetch(tx, connectionId, t0, false, "deferred", window.reason);
      return { ...base, outcome: "deferred", resumeAt: window.resumeAt, detail: window.reason };
    }

    const accounts = (await tx`
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
        const r = await syncAccount(tx, client, acc, {
          psu: attended ? o.psu : undefined,
          // falling back to an unattended read is itself an unattended fetch
          psuFallback: window.allowed,
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
        const resumeAt = new Date(t0.getTime() + seconds * 1000);
        await tx`update bank_connection set backoff_until = ${resumeAt} where id = ${connectionId}`;
        await logFetch(tx, connectionId, t0, attended, "rate_limited", e.message, warnings);
        return { ...base, attended, accounts: results, outcome: "rate_limited", resumeAt, detail: e.message };
      }
      if (e instanceof SessionExpiredError) {
        await tx`update bank_connection set status = 'expired' where id = ${connectionId}`;
        await logFetch(tx, connectionId, t0, attended, "expired", e.message, warnings);
        return { ...base, attended, accounts: results, outcome: "expired", detail: e.message };
      }
      if (e instanceof EnableBankingError && e.code?.startsWith("PSU_HEADER_") && !window.allowed) {
        // Enable Banking refused the attended read and the unattended budget
        // or backoff forbids the fallback. Nothing reached the bank.
        const reason = `PSU headers refused (${e.code}) and ${window.reason}`;
        await logFetch(tx, connectionId, t0, true, "deferred", reason, warnings);
        return { ...base, accounts: results, outcome: "deferred", resumeAt: window.resumeAt, detail: reason };
      }
      // Anything else reached the bank and counts against the budget. Log it
      // inside the transaction and rethrow after commit.
      await logFetch(tx, connectionId, t0, attended, "error", e instanceof Error ? e.message : String(e), warnings);
      failure = e;
      return undefined;
    }

    const truncated = results.some((r) => r.truncated);
    if (truncated) {
      warn("pagination was cut short; last_synced_at not advanced so the next run re-covers the window");
      await tx`update bank_connection set backoff_until = null where id = ${connectionId}`;
    } else {
      await tx`
        update bank_connection set last_synced_at = ${t0}, backoff_until = null
         where id = ${connectionId}`;
    }
    const detail = results
      .map((r) => `${r.idHash}: ${r.inserted} new of ${r.seen} booked, ${r.pending} pending, ${r.balances} balances, ${r.pages} pages` +
        (r.conflicts ? `, ${r.conflicts} conflicts` : "") + (r.truncated ? ", truncated" : ""))
      .join("\n");
    await logFetch(tx, connectionId, t0, attended, "ok", detail || "no accounts", warnings);
    return { ...base, attended, accounts: results, outcome: "ok" };
  })) as SyncResult | undefined;
  if (failure !== undefined) throw failure;
  return result as SyncResult;
}

interface AccountSyncOptions {
  psu?: PsuContext;
  psuFallback: boolean;
  backfill: boolean;
  dateFrom?: string;
  dateTo: string;
  onWarning: (msg: string) => void;
}

const PENDING_STATUSES = new Set(["PDNG", "HOLD", "SCHD"]);

/** Fetches one account and writes the facts on `tx`. */
export async function syncAccount(
  tx: SQL,
  client: EnableBankingClient,
  acc: { id_hash: string; uid: string },
  o: AccountSyncOptions,
): Promise<{ result: AccountSyncResult; psuRefused: boolean }> {
  let psuRefused = false;
  let psu = o.psu;
  let dateFrom = o.dateFrom;
  const copts = { psu, psuFallback: o.psuFallback, onWarning: o.onWarning };
  let fetched;
  if (o.backfill) {
    try {
      fetched = await client.transactions(acc.uid, { strategy: "longest" }, copts);
    } catch (e) {
      if (!(e instanceof EnableBankingError) || e.code !== "WRONG_TRANSACTIONS_PERIOD") throw e;
      dateFrom = addDays(o.dateTo, -FALLBACK_HISTORY_DAYS);
      o.onWarning(`account ${acc.id_hash}: bank refused the longest history; fetching ${dateFrom}..${o.dateTo}`);
      fetched = await client.transactions(acc.uid, { dateFrom, dateTo: o.dateTo }, copts);
    }
  } else {
    fetched = await client.transactions(acc.uid, { dateFrom, dateTo: o.dateTo }, copts);
  }
  if (fetched.psuRefused) {
    psuRefused = true;
    psu = undefined;
  }
  const balances = await client.balances(acc.uid, psu, o.psuFallback);
  if (balances.psuRefused) psuRefused = true;

  const result = await storeAccount(tx, acc.id_hash, fetched.transactions, balances.data, o.onWarning);
  return {
    result: {
      ...result,
      pages: fetched.pages,
      truncated: fetched.truncated,
      dateFrom: o.backfill && !dateFrom ? null : dateFrom ?? null,
      dateTo: o.dateTo,
    },
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
    pages: 0, truncated: false, dateFrom: null, dateTo: null,
  };
  const pending: Transaction[] = [];
  const booked: Transaction[] = [];
  for (const t of transactions) {
    const status = (t.status ?? "BOOK").toUpperCase();
    if (status === "BOOK") booked.push(t);
    else if (PENDING_STATUSES.has(status)) pending.push(t);
    else r.ignored++;
  }
  r.seen = booked.length;

  const keys = dedupKeys(booked);
  const seenKeys = new Map<string, number>();
  for (let i = 0; i < booked.length; i++) {
    const t = booked[i]!;
    const key = keys[i]!;
    const amount = transactionOre(t);
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      // the bank sent the same entry_reference twice in one window
      if (prior !== amount) {
        r.conflicts++;
        onWarning(`account ${idHash}: entry_reference ${key} seen twice in one window with amounts ${prior} and ${amount}`);
      }
      continue;
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

  // Every balance the bank returned is kept, in the bank's order: fetched_at
  // (part of the key) is the transaction's now() plus the position, so two
  // CLBD rows in one answer both land and bank_reconciliation picks the later.
  for (let i = 0; i < balances.length; i++) {
    const b = balances[i]!;
    if (!b.balance_type || !b.balance_amount?.amount) continue;
    await tx`
      insert into bank_balance (id_hash, balance_type, reference_date, amount, raw, fetched_at)
      values (${idHash}, ${b.balance_type}, ${dateOrNull(b.reference_date)},
              ${oreFromDecimal(b.balance_amount.amount)}, ${b as never}::jsonb,
              now() + ${i} * interval '1 microsecond')`;
    r.balances++;
  }
  return r;
}
