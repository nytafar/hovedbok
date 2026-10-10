// Enable Banking API client (https://enablebanking.com/docs/api/reference/).
// Pure HTTP: no database, no policy beyond what the API itself demands.
//
//   const client = new EnableBankingClient({ appId, privateKeyPem });
//   const { url } = await client.startAuth({ aspsp: { name: "Mock ASPSP", country: "NO" }, ... });
//   const session = await client.createSession(code);
//   for await (const page of client.transactionPages(uid, { dateFrom, dateTo })) ...
//
// `fetch` is injectable so tests replay recorded responses offline.
//
// Operational rules this layer owns (research-enable-banking.md):
// - PSU headers are all-or-none: an attended read sends every header the
//   context carries; if Enable Banking refuses them (PSU_HEADER_*) the read is
//   retried once unattended and the caller is told (`psuRefused`).
// - 429 surfaces as RateLimitedError with the bank's Retry-After, so the sync
//   layer can back off (6 h minimum). Nothing here retries a 429.
// - Pagination follows continuation_key with loop guards (repeated key, page
//   cap) — a broken cursor must never spin.
import { loadPrivateKey, tokenSource } from "./jwt";

export const DEFAULT_API_URL = "https://api.enablebanking.com";
/** Longest consent Enable Banking accepts without a bank cutting it short. */
export const MAX_VALID_DAYS = 179;
/** Pages per transaction window; a real statement never needs this many. */
export const MAX_PAGES = 200;

// ----- payload types (the subset we read; raw payloads are kept whole) -----

export interface Amount {
  amount: string;
  currency: string;
}

export interface AccountResource {
  uid?: string;
  identification_hash: string;
  identification_hashes?: string[];
  account_id?: { iban?: string; other?: { identification?: string; scheme_name?: string } };
  all_account_ids?: { identification?: string; scheme_name?: string }[];
  name?: string;
  details?: string;
  product?: string;
  currency?: string;
  cash_account_type?: string;
  [k: string]: unknown;
}

export interface SessionResponse {
  session_id: string;
  accounts: AccountResource[];
  aspsp?: { name?: string; country?: string };
  psu_type?: string;
  access?: { valid_until?: string };
  [k: string]: unknown;
}

export interface SessionData {
  status?: string;
  access?: { valid_until?: string };
  accounts?: string[];
  accounts_data?: { uid?: string; identification_hash?: string }[];
  aspsp?: { name?: string; country?: string };
  [k: string]: unknown;
}

export interface Transaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: Amount;
  credit_debit_indicator?: "CRDT" | "DBIT";
  status?: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  balance_after_transaction?: Amount | null;
  reference_number?: string | null;
  reference_number_schema?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string } | null;
  debtor?: { name?: string } | null;
  [k: string]: unknown;
}

export interface TransactionsPage {
  transactions: Transaction[];
  continuation_key?: string | null;
}

export interface Balance {
  name?: string;
  balance_amount: Amount;
  balance_type: string;
  reference_date?: string | null;
  last_change_date_time?: string | null;
  [k: string]: unknown;
}

export interface Aspsp {
  name: string;
  country: string;
  maximum_consent_validity?: number;
  psu_types?: string[];
  [k: string]: unknown;
}

export interface StartAuthRequest {
  aspsp: { name: string; country: string };
  redirectUrl: string;
  state: string;
  /** Consent end; defaults to now + MAX_VALID_DAYS. */
  validUntil?: Date;
  psuType?: "personal" | "business";
  language?: string;
}

export interface StartAuthResponse {
  url: string;
  authorization_id?: string;
  psu_id_hash?: string;
}

/** The end user's browser context: sent as Psu-* headers on attended reads. */
export interface PsuContext {
  ipAddress: string;
  userAgent?: string;
  referer?: string;
  accept?: string;
  acceptCharset?: string;
  acceptEncoding?: string;
  acceptLanguage?: string;
  geoLocation?: string;
}

// ----- errors -----

export class EnableBankingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "EnableBankingError";
  }
}

/** 429: the bank's quota is spent. `retryAfterSeconds` from Retry-After, if numeric. */
export class RateLimitedError extends EnableBankingError {
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    body: unknown,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(status, code, message, body);
    this.name = "RateLimitedError";
  }
}

/** 401/410: the consent is gone; a new authorization is the only way back. */
export class SessionExpiredError extends EnableBankingError {
  constructor(status: number, code: string | undefined, message: string, body: unknown) {
    super(status, code, message, body);
    this.name = "SessionExpiredError";
  }
}

// ----- client -----

export interface ClientOptions {
  appId: string;
  privateKeyPem: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  now?: () => number;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  psu?: PsuContext;
  /**
   * When the API refuses the PSU headers, retry once without them (default).
   * `false` surfaces the PSU_HEADER_* error instead — the caller decides
   * whether an unattended read is allowed right now.
   */
  psuFallback?: boolean;
}

interface RequestResult<T> {
  data: T;
  /** The PSU headers were sent and refused; the read went out unattended. */
  psuRefused: boolean;
}

function psuHeaders(psu: PsuContext): Record<string, string> {
  const h: Record<string, string> = {};
  const put = (name: string, v: string | undefined) => {
    if (v && /^[\x20-\x7e]{1,1024}$/.test(v)) h[name] = v;
  };
  put("Psu-Ip-Address", psu.ipAddress);
  put("Psu-User-Agent", psu.userAgent);
  put("Psu-Referer", psu.referer);
  put("Psu-Accept", psu.accept);
  put("Psu-Accept-Charset", psu.acceptCharset);
  put("Psu-Accept-Encoding", psu.acceptEncoding);
  put("Psu-Accept-Language", psu.acceptLanguage);
  put("Psu-Geo-Location", psu.geoLocation);
  // All-or-none: the one header every bank requires is the address; without it
  // the rest are meaningless and the read is unattended by definition.
  return h["Psu-Ip-Address"] ? h : {};
}

function retryAfter(res: Response): number | undefined {
  const v = res.headers.get("retry-after")?.trim();
  if (!v || !/^\d+$/.test(v)) return undefined;
  return Math.min(Number(v), 86400);
}

function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class EnableBankingClient {
  readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: () => string;
  private readonly userAgent: string;

  constructor(opts: ClientOptions) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.token = tokenSource(opts.appId, loadPrivateKey(opts.privateKeyPem), undefined, opts.now);
    this.userAgent = opts.userAgent ?? "hovedbok/0.1 (+https://github.com/nytafar/hovedbok)";
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<RequestResult<T>> {
    const url = new URL(this.apiUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
    const psu = opts.psu ? psuHeaders(opts.psu) : {};
    let res = await this.send(method, url, opts.body, psu);
    let psuRefused = false;
    if (Object.keys(psu).length > 0 && (res.status === 400 || res.status === 422)) {
      const body = await res.clone().json().catch(() => undefined) as { error?: string } | undefined;
      if (typeof body?.error === "string" && body.error.startsWith("PSU_HEADER_") && opts.psuFallback !== false) {
        psuRefused = true;
        res = await this.send(method, url, opts.body, {});
      }
    }
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON: keep the text */
    }
    if (res.ok) return { data: body as T, psuRefused };
    const err = body as { error?: string; message?: string } | undefined;
    const code = typeof err?.error === "string" ? err.error : undefined;
    const message = `Enable Banking ${method} ${path} → ${res.status}${code ? ` ${code}` : ""}: ${
      typeof err?.message === "string" ? err.message : text.slice(0, 300)
    }`;
    if (res.status === 429) throw new RateLimitedError(res.status, code, message, body, retryAfter(res));
    if (res.status === 401 || res.status === 410) throw new SessionExpiredError(res.status, code, message, body);
    throw new EnableBankingError(res.status, code, message, body);
  }

  private send(method: string, url: URL, body: unknown, extra: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token()}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...extra,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(url, init);
  }

  // ----- application / ASPSPs -----

  async application(): Promise<Record<string, unknown>> {
    return (await this.request<Record<string, unknown>>("GET", "/application")).data;
  }

  async aspsps(country?: string): Promise<Aspsp[]> {
    const r = await this.request<{ aspsps: Aspsp[] }>("GET", "/aspsps", { query: { country } });
    return r.data.aspsps ?? [];
  }

  // ----- consent -----

  async startAuth(req: StartAuthRequest): Promise<StartAuthResponse> {
    const validUntil = req.validUntil ?? new Date(Date.now() + MAX_VALID_DAYS * 86400_000);
    const r = await this.request<StartAuthResponse>("POST", "/auth", {
      body: {
        access: { valid_until: rfc3339(validUntil) },
        aspsp: req.aspsp,
        state: req.state,
        redirect_url: req.redirectUrl,
        psu_type: req.psuType ?? "business",
        ...(req.language ? { language: req.language } : {}),
      },
    });
    if (!r.data.url) throw new Error("Enable Banking POST /auth returned no redirect url");
    return r.data;
  }

  async createSession(code: string): Promise<SessionResponse> {
    const r = await this.request<SessionResponse>("POST", "/sessions", { body: { code } });
    if (!r.data.session_id) throw new Error("Enable Banking POST /sessions returned no session_id");
    return r.data;
  }

  async session(sessionId: string): Promise<SessionData> {
    return (await this.request<SessionData>("GET", `/sessions/${encodeURIComponent(sessionId)}`)).data;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`);
  }

  // ----- account data (the bank-side reads the quota applies to) -----

  async accountDetails(uid: string, psu?: PsuContext, psuFallback = true): Promise<RequestResult<AccountResource>> {
    return this.request<AccountResource>("GET", `/accounts/${encodeURIComponent(uid)}/details`, { psu, psuFallback });
  }

  async balances(uid: string, psu?: PsuContext, psuFallback = true): Promise<RequestResult<Balance[]>> {
    const r = await this.request<{ balances: Balance[] }>(
      "GET",
      `/accounts/${encodeURIComponent(uid)}/balances`,
      { psu, psuFallback },
    );
    return { data: r.data.balances ?? [], psuRefused: r.psuRefused };
  }

  async transactionsPage(
    uid: string,
    q: { dateFrom?: string; dateTo?: string; continuationKey?: string; strategy?: "default" | "longest" },
    psu?: PsuContext,
    psuFallback = true,
  ): Promise<RequestResult<TransactionsPage>> {
    const r = await this.request<TransactionsPage>(
      "GET",
      `/accounts/${encodeURIComponent(uid)}/transactions`,
      {
        query: {
          date_from: q.dateFrom,
          date_to: q.dateTo,
          continuation_key: q.continuationKey,
          strategy: q.strategy,
        },
        psu,
        psuFallback,
      },
    );
    return { data: { ...r.data, transactions: r.data.transactions ?? [] }, psuRefused: r.psuRefused };
  }

  /**
   * Every transaction in the window, following continuation_key until the API
   * stops sending one. Guards: a repeated key or more than MAX_PAGES pages
   * ends the walk with `truncated: true` (and a warning through `onWarning`).
   * A transaction with an entry_reference seen twice across pages is yielded
   * once; keyless rows are never collapsed — two identical payloads can be
   * two real movements, and the sync numbers them.
   */
  async transactions(
    uid: string,
    q: { dateFrom?: string; dateTo?: string; strategy?: "default" | "longest" },
    opts: { psu?: PsuContext; psuFallback?: boolean; onWarning?: (msg: string) => void } = {},
  ): Promise<{ transactions: Transaction[]; pages: number; psuRefused: boolean; truncated: boolean }> {
    const out: Transaction[] = [];
    const seenKeys = new Set<string>();
    const seenRefs = new Set<string>();
    let continuationKey: string | undefined;
    let pages = 0;
    let psuRefused = false;
    let truncated = false;
    let psu = opts.psu;
    for (;;) {
      if (pages >= MAX_PAGES) {
        opts.onWarning?.(`account ${uid}: stopped after ${MAX_PAGES} pages (continuation_key never ended)`);
        truncated = true;
        break;
      }
      const r = await this.transactionsPage(uid, { ...q, continuationKey }, psu, opts.psuFallback);
      pages++;
      if (r.psuRefused) {
        psuRefused = true;
        psu = undefined; // the rest of this walk is unattended, consistently
      }
      for (const tx of r.data.transactions) {
        const ref = (tx.entry_reference ?? "").trim();
        if (ref) {
          const id = `${ref}\x1f${tx.transaction_amount?.amount ?? ""}\x1f${tx.status ?? ""}`;
          if (seenRefs.has(id)) continue;
          seenRefs.add(id);
        }
        out.push(tx);
      }
      const next = r.data.continuation_key || undefined;
      if (!next) break;
      if (seenKeys.has(next)) {
        opts.onWarning?.(`account ${uid}: continuation_key ${next} repeated; stopping pagination`);
        truncated = true;
        break;
      }
      seenKeys.add(next);
      continuationKey = next;
    }
    return { transactions: out, pages, psuRefused, truncated };
  }
}
