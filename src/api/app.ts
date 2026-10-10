// HTTP adapter (#11): one Hono app, 1:1 onto the SQL commands and views
// (ADR-0009). The adapter adds no logic: it parses, calls the function or
// selects from the view, and serialises. Command results and view rows are
// serialised by Postgres itself (`::text` of the jsonb, `json_agg` of the
// rows), so bigint øre and numerics reach the client exactly as stored.
//
// Errors: a Postgres error becomes a 4xx with the database's own message
// (written for agents) and its SQLSTATE; see `statusFor`. The non-SQL
// builders (MVA-melding, SAF-T, the document store) throw plain Errors with
// messages written the same way; those become 422 (404 for a missing
// document, 500 for a blob that no longer matches its hash).
//
// Auth: bearer tokens, one listener. The read-write token runs on a
// connection whose login is a member of hovedbok_app; the read-only token runs
// on a hovedbok_ro connection and gets GET/HEAD only. /openapi.json and the
// bank consent callback (a browser redirect from the bank, authenticated by
// its `state` inside completeConsent) take no token; the callback runs on the
// read-write connection.
//
// Enable Banking (#10): the bank routes call src/bank/sync.ts as the CLI does.
// The client is built on the first bank route that needs it, from
// ENABLE_BANKING_APP_ID/ENABLE_BANKING_KEY_FILE (src/bank/env.ts) unless
// `bank.client` is injected, so the API serves without that env until then
// (503 naming the missing variables). PSU_IP_ADDRESS (+ PSU_USER_AGENT) make a
// run attended: the consent backfill always when set, a sync only when the
// request asks for it.
//
//   const app = createApi({ rw, ro, rwToken, roToken, documentsDir });
//   Bun.serve({ fetch: app.fetch });
import type { SQL } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { EnableBankingClient, EnableBankingError, type PsuContext } from "../bank/client";
import { clientFromEnv } from "../bank/env";
import { ConsentRaceError, completeConsent, startConsent, syncConnection, type SyncResult } from "../bank/sync";
import { DocumentIntegrityError, documentStore, type Origin } from "../documents";
import { buildMvaMelding, readMvaTerm } from "../mva";
import { buildSaft, type SaftVersion } from "../saft";
import { openapi } from "./openapi";

export type Access = "rw" | "ro";

export interface ApiOptions {
  /** Connection for the read-write token: a login in role hovedbok_app. */
  rw: SQL;
  /** Connection for the read-only token: a login in role hovedbok_ro. */
  ro?: SQL;
  rwToken: string;
  /** Omit to disable read-only access. */
  roToken?: string;
  /** Blob root for the document store; default $DOCUMENTS_DIR or ./documents. */
  documentsDir?: string;
  /** Enable Banking; every field defaults from the environment, read lazily. */
  bank?: BankOptions;
}

export interface BankOptions {
  /** Builds the client once, on first use; default clientFromEnv(env). */
  client?: () => EnableBankingClient | Promise<EnableBankingClient>;
  /**
   * Default process.env: ENABLE_BANKING_APP_ID, ENABLE_BANKING_KEY_FILE,
   * ENABLE_BANKING_API_URL, ENABLE_BANKING_REDIRECT_URL, PSU_IP_ADDRESS,
   * PSU_USER_AGENT.
   */
  env?: Record<string, string | undefined>;
  /** The 19xx account each consented bank account feeds; default 1920 (as the CLI). */
  ledgerAccount?: string;
}

type Env = { Variables: { sql: SQL; access: Access } };
type Handler = (c: Context<Env>) => Promise<Response> | Response;
type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface Route {
  method: Method;
  /** Hono path pattern, e.g. /vouchers/:year/:nr/reverse. */
  path: string;
  /**
   * OpenAPI operationId (unique): the SQL function/view or TS builder the
   * route is 1:1 with; a second method on the same operation gets a suffix.
   */
  operationId: string;
  /** Accepted query parameters (read routes). */
  query?: string[];
  /** No bearer token required. */
  public?: boolean;
}

// ---------------------------------------------------------------------------
// Errors

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface PgError {
  errno: string;
  message: string;
  detail?: string;
  hint?: string;
}

function isPgError(e: unknown): e is PgError {
  return (
    e instanceof Error &&
    e.name === "PostgresError" &&
    typeof (e as Partial<PgError>).errno === "string"
  );
}

/**
 * SQLSTATE → HTTP status. Class 22 (bad input: casts, malformed JSON) 400;
 * 42501 (a grant says no) 403; 23505 and serialisation/lock failures 409
 * (a retry or a different key resolves them); other integrity violations and
 * every RAISE from the commands (P0001) 422; anything else 500.
 */
export function statusFor(sqlstate: string): number {
  if (sqlstate.startsWith("22")) return 400;
  if (sqlstate === "42501") return 403;
  if (sqlstate === "23505" || sqlstate.startsWith("40") || sqlstate === "55P03") return 409;
  if (sqlstate.startsWith("23") || sqlstate === "P0001" || sqlstate === "P0002") return 422;
  return 500;
}

function errorResponse(e: unknown): Response {
  if (isPgError(e)) {
    const body: Record<string, string> = { error: e.message, sqlstate: e.errno };
    if (e.detail) body.detail = e.detail;
    if (e.hint) body.hint = e.hint;
    return Response.json(body, { status: statusFor(e.errno) });
  }
  if (e instanceof HttpError) return Response.json({ error: e.message, sqlstate: null }, { status: e.status });
  if (e instanceof EnableBankingError) {
    return Response.json({ error: `Enable Banking: ${e.message}`, sqlstate: null }, { status: 502 });
  }
  if (e instanceof ConsentRaceError) return Response.json({ error: e.message, sqlstate: null }, { status: 409 });
  if (e instanceof DocumentIntegrityError) {
    return Response.json({ error: e.message, sqlstate: null }, { status: 500 });
  }
  const message = e instanceof Error ? e.message : String(e);
  return Response.json({ error: message, sqlstate: null }, { status: 422 });
}

// ---------------------------------------------------------------------------
// Parsing helpers (shape only; the database judges content)

function jsonText(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
}

async function jsonObject(c: Context<Env>): Promise<Record<string, unknown>> {
  let b: unknown;
  try {
    b = await c.req.json();
  } catch {
    throw new HttpError(400, "request body must be a JSON object");
  }
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return b as Record<string, unknown>;
}

function requireFields(b: Record<string, unknown>, names: string[]): void {
  const missing = names.filter((n) => b[n] === undefined || b[n] === null);
  if (missing.length) throw new HttpError(400, `missing required field(s): ${missing.join(", ")}`);
}

/** A JSON scalar as the text Postgres casts; objects/arrays are refused. */
function scalar(name: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") throw new HttpError(400, `field ${name} must be a string or number`);
  return String(v);
}

/** A path parameter (always present on the routes that read it). */
function param(c: Context<Env>, name: string): string {
  return c.req.param(name) ?? "";
}

type Arg = [name: string, value: string | undefined, cast: string];

/**
 * select fn(name => $1::cast, ...)::text — arguments left undefined are
 * omitted, so the function's own defaults apply. Names and casts are static.
 */
async function callFn(sql: SQL, fn: string, args: Arg[]): Promise<string> {
  const present = args.filter((a) => a[1] !== undefined);
  const list = present.map(([n, , cast], i) => `${n} => $${i + 1}::${cast}`).join(", ");
  const [row] = await sql.unsafe(`select ${fn}(${list})::text as r`, present.map((a) => a[1]));
  return row.r as string;
}

/** A jsonb command: the raw body goes to the function verbatim. */
function jsonbCommand(fn: string): Handler {
  return async (c) => {
    const body = await c.req.text();
    const [row] = await c.var.sql.unsafe(`select ${fn}($1::text::jsonb)::text as r`, [body]);
    return jsonText(row.r as string);
  };
}

// ---------------------------------------------------------------------------
// Read routes: equality/range filters over a view, rows as Postgres's JSON.

interface Filter {
  param: string;
  column: string;
  op: "=" | ">=" | "<=";
  cast: "text" | "integer" | "date";
}

interface ViewRead {
  view: string;
  filters: Filter[];
  order: string[];
}

const eq = (param: string, cast: Filter["cast"] = "text", column = param): Filter => ({ param, column, op: "=", cast });
const ge = (param: string, column: string, cast: Filter["cast"]): Filter => ({ param, column, op: ">=", cast });
const le = (param: string, column: string, cast: Filter["cast"]): Filter => ({ param, column, op: "<=", cast });

/** Every view read takes entity (required), these filters, and limit/offset. */
const VIEWS: Record<string, ViewRead & { path: string }> = {
  journal: {
    path: "/journal",
    view: "journal",
    filters: [eq("year", "integer"), eq("period", "integer"), eq("nr", "integer"), eq("account"), eq("party"),
      eq("vat_code"), ge("from", "posting_date", "date"), le("to", "posting_date", "date")],
    order: ["year", "nr", "line"],
  },
  account_balance: {
    path: "/account-balance",
    view: "account_balance",
    filters: [eq("account")],
    order: ["account"],
  },
  account_year_balance: {
    path: "/account-year-balance",
    view: "account_year_balance",
    filters: [eq("year", "integer"), eq("account")],
    order: ["year", "account"],
  },
  saldobalanse: {
    path: "/saldobalanse",
    view: "saldobalanse",
    filters: [eq("year", "integer"), eq("period_from", "integer"), eq("period_to", "integer"), eq("account")],
    order: ["year", "period_from", "period_to", "account"],
  },
  kontospesifikasjon: {
    path: "/kontospesifikasjon",
    view: "kontospesifikasjon",
    filters: [eq("year", "integer"), eq("account"), eq("party"), ge("period_from", "period", "integer"),
      le("period_to", "period", "integer")],
    order: ["account", "year", "period", "posting_date", "nr", "line"],
  },
  bokforingsspesifikasjon: {
    path: "/bokforingsspesifikasjon",
    view: "bokforingsspesifikasjon",
    filters: [eq("year", "integer"), eq("nr", "integer"), ge("period_from", "period", "integer"),
      le("period_to", "period", "integer"), ge("from", "posting_date", "date"), le("to", "posting_date", "date")],
    order: ["year", "nr", "line"],
  },
  kundespesifikasjon: {
    path: "/kundespesifikasjon",
    view: "kundespesifikasjon",
    filters: [eq("year", "integer"), eq("period_from", "integer"), eq("period_to", "integer"), eq("party")],
    order: ["year", "period_from", "period_to", "party", "account"],
  },
  leverandorspesifikasjon: {
    path: "/leverandorspesifikasjon",
    view: "leverandorspesifikasjon",
    filters: [eq("year", "integer"), eq("period_from", "integer"), eq("period_to", "integer"), eq("party")],
    order: ["year", "period_from", "period_to", "party", "account"],
  },
  resultat: {
    path: "/resultat",
    view: "resultat",
    filters: [eq("year", "integer"), eq("period_from", "integer"), eq("period_to", "integer")],
    order: ["year", "period_from", "period_to", "class", "grouping"],
  },
  balanse: {
    path: "/balanse",
    view: "balanse",
    filters: [eq("year", "integer"), eq("period", "integer")],
    order: ["year", "period", "class", "grouping"],
  },
  vat_summary: {
    path: "/vat-summary",
    view: "vat_summary",
    filters: [eq("year", "integer"), eq("period", "integer"), eq("vat_code")],
    order: ["year", "period", "vat_code", "rate"],
  },
  vat_control: {
    path: "/vat-control",
    view: "vat_control",
    filters: [eq("year", "integer"), eq("period", "integer")],
    order: ["year", "period"],
  },
  mva_term: {
    path: "/mva-term",
    view: "mva_term",
    filters: [eq("year", "integer"), eq("term", "integer"), eq("vat_code")],
    order: ["year", "term", "vat_code", "rate"],
  },
  voucher_without_document: {
    path: "/voucher-without-document",
    view: "voucher_without_document",
    filters: [eq("year", "integer"), eq("period", "integer")],
    order: ["year", "nr"],
  },
  account: {
    path: "/accounts",
    view: "account",
    filters: [eq("code")],
    order: ["code"],
  },
  party: {
    path: "/parties",
    view: "party",
    filters: [eq("id")],
    order: ["id"],
  },
  unmatched_bank: {
    path: "/bank/unmatched",
    view: "unmatched_bank",
    filters: [ge("from", "booking_date", "date"), le("to", "booking_date", "date")],
    order: ["booking_date", "id_hash", "dedup_key"],
  },
  bank_reconciliation: {
    path: "/bank/reconciliation",
    view: "bank_reconciliation",
    filters: [eq("ledger_account")],
    order: ["ledger_account", "id_hash"],
  },
  bank_connection_status: {
    path: "/bank/connections",
    view: "bank_connection_status",
    filters: [eq("id", "integer"), eq("status")],
    order: ["id"],
  },
};

const PAGING = ["limit", "offset"];

/** The query parameters a view route accepts, in OpenAPI order. */
export function viewParams(v: ViewRead): string[] {
  return ["entity", ...v.filters.map((f) => f.param), ...PAGING];
}

function checkQuery(c: Context<Env>, allowed: string[], required: string[]): Record<string, string> {
  const q = c.req.query();
  const unknown = Object.keys(q).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new HttpError(400, `unknown query parameter(s): ${unknown.join(", ")}; accepted: ${allowed.join(", ")}`);
  }
  const missing = required.filter((k) => !q[k]);
  if (missing.length) throw new HttpError(400, `missing required query parameter(s): ${missing.join(", ")}`);
  return q;
}

function viewHandler(v: ViewRead): Handler {
  const allowed = viewParams(v);
  return async (c) => {
    const q = checkQuery(c, allowed, ["entity"]);
    const params: string[] = [q.entity!];
    const where = ["entity = $1"];
    for (const f of v.filters) {
      const value = q[f.param];
      if (value === undefined) continue;
      params.push(value);
      where.push(`${f.column} ${f.op} $${params.length}::${f.cast}`);
    }
    const order = v.order.join(", ");
    let paging = "";
    for (const p of PAGING) {
      if (q[p] === undefined) continue;
      params.push(q[p]!);
      paging += ` ${p} $${params.length}::bigint`;
    }
    const [row] = await c.var.sql.unsafe(
      `select coalesce(json_agg(t), '[]')::text as body
         from (select * from ${v.view} where ${where.join(" and ")} order by ${order}${paging}) t`,
      params,
    );
    return jsonText(row.body as string);
  };
}

// ---------------------------------------------------------------------------
// Auth

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function tokenMatches(given: string, expected: string | undefined): boolean {
  return expected !== undefined && expected !== "" && timingSafeEqual(digest(given), digest(expected));
}

// ---------------------------------------------------------------------------

export function createApi(opts: ApiOptions) {
  if (!opts.rwToken) throw new Error("createApi: rwToken is required");
  if (opts.roToken !== undefined && opts.roToken === opts.rwToken) {
    throw new Error("createApi: the read-only token must differ from the read-write token");
  }
  if (opts.roToken && !opts.ro) throw new Error("createApi: a read-only token needs a read-only connection");

  const app = new Hono<Env>();
  const routes: Route[] = [];
  const add = (route: Route, handler: Handler) => {
    routes.push(route);
    app.on(route.method, route.path, async (c) => {
      try {
        return await handler(c);
      } catch (e) {
        return errorResponse(e);
      }
    });
  };

  // auth first: an unauthenticated caller learns nothing, not even 404 vs 405
  app.use("*", async (c, next) => {
    const pub = routes.some((r) => r.public && r.method === c.req.method && pathMatches(r.path, c.req.path));
    if (pub) return next();
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const given = m?.[1];
    let access: Access | undefined;
    if (given && tokenMatches(given, opts.rwToken)) access = "rw";
    else if (given && tokenMatches(given, opts.roToken)) access = "ro";
    if (!access) {
      return Response.json(
        { error: "missing or invalid bearer token (Authorization: Bearer <API_TOKEN or API_RO_TOKEN>)", sqlstate: null },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="hovedbok"' } },
      );
    }
    if (access === "ro" && c.req.method !== "GET" && c.req.method !== "HEAD") {
      return Response.json(
        { error: `the read-only token allows GET only; ${c.req.method} needs the read-write token`, sqlstate: null },
        { status: 403 },
      );
    }
    c.set("access", access);
    c.set("sql", access === "rw" ? opts.rw : opts.ro!);
    await next();
  });

  // --- commands --------------------------------------------------------------
  add({ method: "POST", path: "/entities", operationId: "bootstrap_entity" }, jsonbCommand("bootstrap_entity"));
  add({ method: "PUT", path: "/accounts", operationId: "upsert_account" }, jsonbCommand("upsert_account"));
  add({ method: "POST", path: "/accounts", operationId: "upsert_account_post" }, jsonbCommand("upsert_account"));
  add({ method: "PUT", path: "/parties", operationId: "upsert_party" }, jsonbCommand("upsert_party"));
  add({ method: "POST", path: "/parties", operationId: "upsert_party_post" }, jsonbCommand("upsert_party"));
  add({ method: "POST", path: "/vouchers", operationId: "post_voucher" }, jsonbCommand("post_voucher"));

  add({ method: "POST", path: "/vouchers/:year/:nr/reverse", operationId: "reverse_voucher" }, async (c) => {
    const b = await jsonObject(c);
    requireFields(b, ["entity"]);
    return jsonText(await callFn(c.var.sql, "reverse_voucher", [
      ["p_entity", scalar("entity", b.entity), "text"],
      ["p_year", param(c, "year"), "smallint"],
      ["p_nr", param(c, "nr"), "integer"],
      ["p_posting_date", scalar("posting_date", b.posting_date), "date"],
      ["p_description", scalar("description", b.description), "text"],
    ]));
  });

  add({ method: "POST", path: "/periods/close", operationId: "close_period" }, async (c) => {
    const b = await jsonObject(c);
    requireFields(b, ["entity", "year", "period"]);
    return jsonText(await callFn(c.var.sql, "close_period", [
      ["p_entity", scalar("entity", b.entity), "text"],
      ["p_year", scalar("year", b.year), "integer"],
      ["p_period", scalar("period", b.period), "integer"],
    ]));
  });

  add({ method: "POST", path: "/fiscal-years/close", operationId: "close_fiscal_year" }, async (c) => {
    const b = await jsonObject(c);
    requireFields(b, ["entity", "year"]);
    return jsonText(await callFn(c.var.sql, "close_fiscal_year", [
      ["p_entity", scalar("entity", b.entity), "text"],
      ["p_year", scalar("year", b.year), "integer"],
      ["p_equity_account", scalar("equity_account", b.equity_account), "text"],
    ]));
  });

  // --- documents (src/documents.ts) -------------------------------------------
  const docs = (c: Context<Env>) => documentStore(c.var.sql, opts.documentsDir);

  add({ method: "POST", path: "/documents", operationId: "store_document", query: ["origin", "note"] }, async (c) => {
    const q = checkQuery(c, ["origin", "note"], ["origin"]);
    const mediaType = c.req.header("content-type");
    if (!mediaType) throw new HttpError(400, "Content-Type is required: it is stored as the document's media type");
    if (/^multipart\//i.test(mediaType)) {
      throw new HttpError(400, "send the document's bytes as the raw request body (Content-Type = its media type), not multipart");
    }
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.byteLength === 0) throw new HttpError(400, "request body is empty: send the document's bytes");
    const doc = await docs(c).store(data, { mediaType, origin: q.origin as Origin, note: q.note });
    return c.json(doc);
  });

  add({ method: "GET", path: "/documents/:sha256", operationId: "retrieve_document" }, async (c) => {
    const sha = param(c, "sha256");
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, `not a sha256 hex digest: ${JSON.stringify(sha)}`);
    let doc;
    try {
      doc = await docs(c).retrieve(sha);
    } catch (e) {
      if (e instanceof Error && !isPgError(e) && e.message === `document ${sha}: not found`) {
        throw new HttpError(404, e.message);
      }
      throw e;
    }
    return new Response(doc.data, {
      headers: {
        "content-type": doc.mediaType,
        "content-length": String(doc.bytes),
        etag: `"${doc.sha256}"`,
        "x-document-origin": doc.origin,
      },
    });
  });

  add({ method: "POST", path: "/vouchers/:year/:nr/documents", operationId: "link_document" }, async (c) => {
    const b = await jsonObject(c);
    requireFields(b, ["entity", "sha256"]);
    const year = param(c, "year");
    const nr = param(c, "nr");
    if (!/^\d{1,9}$/.test(year) || !/^\d{1,9}$/.test(nr)) throw new HttpError(400, "year and nr must be integers");
    const ref = { entity: scalar("entity", b.entity)!, year: Number(year), nr: Number(nr) };
    const sha256 = scalar("sha256", b.sha256)!;
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, `not a sha256 hex digest: ${JSON.stringify(sha256)}`);
    await docs(c).link(sha256, ref);
    return c.json({ ...ref, sha256 });
  });

  // --- reads -------------------------------------------------------------------
  for (const [operationId, v] of Object.entries(VIEWS)) {
    add({ method: "GET", path: v.path, operationId, query: viewParams(v) }, viewHandler(v));
  }

  const mvaQuery = ["entity", "reference", "format"];
  add({ method: "GET", path: "/mva-melding/:year/:term", operationId: "mva_melding", query: mvaQuery }, async (c) => {
    const q = checkQuery(c, mvaQuery, ["entity"]);
    if (q.format && q.format !== "xml" && q.format !== "json") throw new HttpError(400, "format must be xml or json");
    const year = Number(param(c, "year"));
    const term = Number(param(c, "term"));
    if (!Number.isInteger(year) || !Number.isInteger(term)) throw new HttpError(400, "year and term must be integers");
    const t = await readMvaTerm(c.var.sql, q.entity!, year, term);
    const m = buildMvaMelding({
      orgnr: q.entity!, year, vatTerm: t.vatTerm, term,
      reference: q.reference ?? `hovedbok:${q.entity}:${year}-${term}`,
      rows: t.rows,
    });
    if (q.format === "json") return c.json(m);
    return new Response(m.xml, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-disposition": `attachment; filename="mva-melding_${q.entity}_${year}-${term}.xml"`,
      },
    });
  });

  const saftQuery = ["entity", "year", "from", "to", "version"];
  add({ method: "GET", path: "/saf-t", operationId: "saf_t", query: saftQuery }, async (c) => {
    const q = checkQuery(c, saftQuery, ["entity"]);
    if (q.year && (q.from || q.to)) throw new HttpError(400, "give either year or from and to, not both");
    if (!q.year && !(q.from && q.to)) throw new HttpError(400, "give year, or from and to (YYYY-MM-DD)");
    if (q.year && !/^\d{4}$/.test(q.year)) throw new HttpError(400, "year must be YYYY");
    const s = await buildSaft(c.var.sql, {
      entity: q.entity!,
      from: q.from ?? `${q.year}-01-01`,
      to: q.to ?? `${q.year}-12-31`,
      version: q.version as SaftVersion | undefined,
    });
    return new Response(s.xml, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "content-disposition": `attachment; filename="${s.filename}"`,
      },
    });
  });

  // --- bank (src/bank/sync.ts, #10) ----------------------------------------------
  const bankOpts = opts.bank ?? {};
  const bankVars = bankOpts.env ?? process.env;
  const envVar = (name: string) => bankVars[name]?.trim() || undefined;
  let bankClientP: Promise<EnableBankingClient> | undefined;
  const bankClient = async (): Promise<EnableBankingClient> => {
    if (!bankClientP) {
      const p = Promise.resolve().then(() => (bankOpts.client ? bankOpts.client() : clientFromEnv(bankVars)));
      bankClientP = p;
      p.catch(() => {
        if (bankClientP === p) bankClientP = undefined; // retry after the env is fixed
      });
    }
    try {
      return await bankClientP;
    } catch (e) {
      throw new HttpError(503, `Enable Banking is not configured: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const configuredPsu = (userAgent?: string): PsuContext | undefined => {
    const ipAddress = envVar("PSU_IP_ADDRESS");
    return ipAddress ? { ipAddress, userAgent: envVar("PSU_USER_AGENT") ?? userAgent } : undefined;
  };

  add({ method: "POST", path: "/bank/consents", operationId: "start_consent" }, async (c) => {
    const b = await jsonObject(c);
    requireFields(b, ["entity", "aspsp"]);
    const aspsp = b.aspsp as Record<string, unknown>;
    if (typeof aspsp !== "object" || Array.isArray(aspsp) || typeof aspsp.name !== "string") {
      throw new HttpError(400, "field aspsp must be an object {name, country?}");
    }
    const redirectUrl = scalar("redirect_url", b.redirect_url) ?? envVar("ENABLE_BANKING_REDIRECT_URL");
    if (!redirectUrl) {
      throw new HttpError(400, "redirect_url is required: pass it, or set ENABLE_BANKING_REDIRECT_URL on the server");
    }
    const validUntilText = scalar("valid_until", b.valid_until);
    const validUntil = validUntilText === undefined ? undefined : new Date(validUntilText);
    if (validUntil && Number.isNaN(validUntil.getTime())) {
      throw new HttpError(400, `valid_until is not a date-time: ${JSON.stringify(validUntilText)}`);
    }
    const client = await bankClient();
    return c.json(await startConsent(c.var.sql, client, {
      entity: scalar("entity", b.entity)!,
      aspsp: { name: aspsp.name, country: scalar("aspsp.country", aspsp.country) },
      redirectUrl,
      validUntil,
      psuType: scalar("psu_type", b.psu_type) as "personal" | "business" | undefined,
      language: scalar("language", b.language),
    }));
  });

  // The bank redirects the owner's browser here: plain text back, not JSON.
  const callbackQuery = ["code", "state", "error", "error_description"];
  add({ method: "GET", path: "/bank/consent-callback", operationId: "complete_consent", query: callbackQuery, public: true },
    async (c) => {
      const text = (status: number, body: string) =>
        new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
      try {
        const q = c.req.query();
        if (q.error) {
          throw new HttpError(400, `the bank reported ${q.error}${q.error_description ? ` (${q.error_description})` : ""}; start the consent again`);
        }
        if (!q.code || !q.state) throw new HttpError(400, "the callback carries no code and state");
        const r = await completeConsent(opts.rw, await bankClient(), {
          state: q.state,
          code: q.code,
          ledgerAccount: () => bankOpts.ledgerAccount ?? "1920",
          psu: configuredPsu(c.req.header("user-agent")),
        });
        const lines = [
          `Bank connection ${r.connectionId} authorized${r.validUntil ? `, valid until ${r.validUntil}` : ""}.`,
          ...r.accounts.map((a) => `Account ${a.iban ?? a.bban ?? a.idHash} -> ${a.ledgerAccount ?? "not booked"}`),
          ...(r.superseded.length ? [`Superseded connection(s): ${r.superseded.join(", ")}`] : []),
          r.backfill
            ? `Backfill: ${r.backfill.outcome}, ${r.backfill.accounts.reduce((n, a) => n + a.inserted, 0)} new transaction(s)` +
              (r.backfill.detail ? ` (${r.backfill.detail})` : "")
            : "Backfill: not run",
          ...(r.backfill?.warnings ?? []).map((w) => `Warning: ${w}`),
          "You can close this window.",
        ];
        return text(200, lines.join("\n"));
      } catch (e) {
        const res = errorResponse(e);
        const body = (await res.json()) as { error: string };
        return text(res.status, `Bank consent failed: ${body.error}`);
      }
    });

  add({ method: "POST", path: "/bank/sync", operationId: "sync_connection" }, async (c) => {
    const raw = await c.req.text();
    let b: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        b = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "request body must be a JSON object (or empty)");
      }
      if (b === null || typeof b !== "object" || Array.isArray(b)) {
        throw new HttpError(400, "request body must be a JSON object (or empty)");
      }
    }
    const id = scalar("connection_id", b.connection_id);
    const entity = scalar("entity", b.entity);
    if (id !== undefined && entity !== undefined) throw new HttpError(400, "give connection_id or entity, not both");
    if (id !== undefined && !/^\d{1,18}$/.test(id)) throw new HttpError(400, "connection_id must be an integer");
    if (b.attended !== undefined && typeof b.attended !== "boolean") throw new HttpError(400, "attended must be a boolean");
    let psu: PsuContext | undefined;
    if (b.attended === true) {
      // Enable Banking tells attended from unattended by the Psu-* headers
      // alone; never send a placeholder address to dodge the unattended budget.
      psu = configuredPsu();
      if (!psu) throw new HttpError(503, "attended sync needs PSU_IP_ADDRESS (the public address of the person syncing) set on the server");
    }
    const client = await bankClient();
    if (id !== undefined) return c.json([await syncConnection(c.var.sql, client, Number(id), { psu })]);

    const targets = (await c.var.sql`
      select id from bank_connection
       where status = 'authorized' and (${entity ?? null}::text is null or entity = ${entity ?? null}::text)
       order by id`).map((r: { id: number | string }) => Number(r.id));
    const results: (SyncResult | { connectionId: number; outcome: "error"; attended: boolean; accounts: []; warnings: []; detail: string })[] = [];
    for (const connectionId of targets) {
      try {
        results.push(await syncConnection(c.var.sql, client, connectionId, { psu }));
      } catch (e) {
        // logged in bank_fetch as 'error'; the other connections still run
        const detail = e instanceof Error ? e.message : String(e);
        results.push({ connectionId, outcome: "error", attended: !!psu, accounts: [], warnings: [], detail });
      }
    }
    return c.json(results);
  });

  add({ method: "POST", path: "/bank/matches", operationId: "match_bank" }, jsonbCommand("match_bank"));
  add({ method: "DELETE", path: "/bank/matches", operationId: "unmatch_bank" }, jsonbCommand("unmatch_bank"));

  // --- meta --------------------------------------------------------------------
  add({ method: "GET", path: "/openapi.json", operationId: "openapi", public: true }, (c) => c.json(openapi));

  // unmatched: 405 when the path exists under another method, else 404
  app.notFound((c) => {
    const allow: string[] = [...new Set(routes.filter((r) => pathMatches(r.path, c.req.path)).map((r) => r.method))];
    if (allow.length) {
      if (allow.includes("GET")) allow.push("HEAD");
      return Response.json(
        { error: `method ${c.req.method} not allowed on ${c.req.path}; allowed: ${allow.join(", ")}`, sqlstate: null },
        { status: 405, headers: { allow: allow.join(", ") } },
      );
    }
    return Response.json({ error: `no route ${c.req.path}; see /openapi.json`, sqlstate: null }, { status: 404 });
  });
  app.onError((e) => errorResponse(e));

  return Object.assign(app, { routeTable: routes as readonly Route[] });
}

function pathMatches(pattern: string, path: string): boolean {
  const body = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const re = new RegExp(`^${body}/?$`);
  return re.test(path);
}
