// MCP server (#12) end to end: a real listener speaking streamable-http on a
// fresh database, driven by the official SDK client the way an agent would —
// list the tools, bootstrap, post a voucher and read it back through the
// journal tool, a refusal carrying the database's message, documents, an XML
// export. The tool set is asserted against the API's route table: same
// operations, minus the browser-only consent callback, plus nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_PATH, createMcp } from "../src/mcp/server";
import { descriptions } from "../src/mcp/descriptions";
import { databaseUrl, dropTestDb, freshDb, testDbName } from "./helper";

const E = "999888777";
const Y = 2026;
const TOKEN = "mcp-token-for-tests";
const rwRole = `hovedbok_mcp_rw_${process.pid}`;

let admin: SQL;
let rw: SQL;
let dir: string;
let mcp: ReturnType<typeof createMcp>;
let server: ReturnType<typeof Bun.serve>;
let client: Client;

function loginUrl(role: string): string {
  const u = new URL(databaseUrl);
  u.username = role;
  u.password = "pw";
  u.pathname = `/${testDbName}`;
  return u.toString();
}

const endpoint = () => new URL(MCP_PATH, server.url);

async function connect(token: string | null): Promise<Client> {
  const c = new Client({ name: "hovedbok-test", version: "0" });
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  await c.connect(new StreamableHTTPClientTransport(endpoint(), { requestInit: { headers } }));
  return c;
}

beforeAll(async () => {
  admin = await freshDb();
  await admin.unsafe(`drop role if exists "${rwRole}"`);
  await admin.unsafe(`create role "${rwRole}" login password 'pw' in role hovedbok_app`);
  rw = new SQL(loginUrl(rwRole), { max: 2 });
  dir = await mkdtemp(join(tmpdir(), "hovedbok-mcp-docs-"));
  mcp = createMcp({ rw, token: TOKEN, documentsDir: dir, bank: { env: {} } });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: mcp.fetch });
  client = await connect(TOKEN);
});

afterAll(async () => {
  await client?.close();
  server?.stop(true);
  await rw?.end();
  await admin?.unsafe(`drop role if exists "${rwRole}"`);
  if (dir) await rm(dir, { recursive: true, force: true });
  await dropTestDb();
});

interface Called {
  isError: boolean;
  text: string;
  json: any;
  result: CallToolResult;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first?.type === "text" ? first.text : "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, text, json, result };
}

const sale = {
  entity: E, posting_date: "2026-01-15", description: "Salg K1", idempotency_key: "sale-1",
  lines: [
    { account: "1500", amount: 12500, party: "K1" },
    { account: "3000", amount: -10000, vat_code: "3", vat_base: -10000 },
    { account: "2700", amount: -2500 },
  ],
};

describe("tool set", () => {
  test("tools/list is the API's operations: route table minus the consent callback (and the spec itself)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    // every operation of the route table, aliases folded onto their operation
    const operations = new Set(mcp.routeTable.map((r) => r.aliasOf ?? r.operationId));
    operations.delete("complete_consent"); // a browser redirect from the bank, not an agent operation
    operations.delete("openapi"); // the HTTP spec document; tools/list is its MCP counterpart
    expect(names).toEqual([...operations].sort());
    expect(names).toContain("post_voucher");
    expect(names).toContain("unmatch_bank");
    expect(names).not.toContain("complete_consent");
    expect(names.some((n) => n.endsWith("_post"))).toBe(false);
  });

  test("every tool has its description, and nothing else does", async () => {
    const { tools } = await client.listTools();
    expect(Object.keys(descriptions).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) expect(t.description).toBe(descriptions[t.name]!);
  });

  test("input schemas come from the OpenAPI payloads", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    const pv = by.post_voucher!.inputSchema as any;
    expect(pv.required.sort()).toEqual(["entity", "idempotency_key", "lines", "posting_date"]);
    expect(pv.properties.lines.items.required).toEqual(["account", "amount"]); // $ref inlined
    expect(pv.properties.lines.items.properties.vat_base.description).toContain("signed");
    const rv = by.reverse_voucher!.inputSchema as any;
    expect(rv.required.sort()).toEqual(["entity", "nr", "year"]); // path parameters + body
    const j = by.journal!.inputSchema as any;
    expect(j.required).toEqual(["entity"]);
    expect(Object.keys(j.properties)).toEqual(
      ["entity", "year", "period", "nr", "account", "party", "vat_code", "from", "to", "limit", "offset"]);
    expect(by.journal!.annotations?.readOnlyHint).toBe(true);
    expect(by.post_voucher!.annotations?.readOnlyHint).toBe(false);
    const sd = by.store_document!.inputSchema as any;
    expect(sd.required.sort()).toEqual(["content_base64", "media_type", "origin"]);
    const sync = by.sync_connection!.inputSchema as any;
    expect(sync.required).toBeUndefined(); // the body may be empty
  });
});

describe("the agent flow over MCP", () => {
  test("bootstrap and reference data", async () => {
    const b = await call("bootstrap_entity", { orgnr: E, name: "Demo AS", vat_registered: true, year: Y });
    expect(b.isError).toBe(false);
    expect(b.json).toEqual({ entity: E, created: true, accounts_added: expect.any(Number), year: Y });
    const p = await call("upsert_party", { entity: E, id: "K1", name: "Kunde AS", customer: true });
    expect(p.json).toEqual({ entity: E, id: "K1", created: true });
  });

  test("post a voucher and read it back through the journal", async () => {
    const posted = await call("post_voucher", sale);
    expect(posted.isError).toBe(false);
    expect(posted.json).toEqual({ entity: E, year: Y, nr: expect.any(Number), idempotent: false });
    const { nr } = posted.json;

    const j = await call("journal", { entity: E, year: Y, nr });
    expect(j.isError).toBe(false);
    expect(j.json.map((r: any) => [r.line, r.account, r.amount, r.vat_code, r.vat_base, r.party])).toEqual([
      [1, "1500", 12500, null, null, "K1"],
      [2, "3000", -10000, "3", -10000, null],
      [3, "2700", -2500, null, null, null],
    ]);
    expect(j.json[0]).toMatchObject({ entity: E, year: Y, nr, posting_date: "2026-01-15", voucher_description: "Salg K1" });

    // the replay returns the same voucher
    const again = await call("post_voucher", sale);
    expect(again.json).toEqual({ entity: E, year: Y, nr, idempotent: true });
  });

  test("a refusal surfaces the database's message and SQLSTATE", async () => {
    const r = await call("post_voucher", {
      entity: E, posting_date: "2026-01-16", idempotency_key: "unbalanced-1",
      lines: [{ account: "1920", amount: 100 }, { account: "3000", amount: -99 }],
    });
    expect(r.isError).toBe(true);
    expect(r.json).toEqual({ status: 422, error: "lines do not balance: 1 øre (debits positive, credits negative, sum must be 0)", sqlstate: "P0001" });

    const vatLine = await call("post_voucher", {
      entity: E, posting_date: "2026-01-16", idempotency_key: "vat-on-vat-line",
      lines: [{ account: "1920", amount: 2500 }, { account: "2700", amount: -2500, vat_code: "3", vat_base: -10000 }],
    });
    expect(vatLine.isError).toBe(true);
    expect(vatLine.json.error).toContain("ADR-0011");

    // adapter-level shape errors read the same way
    const missing = await call("reverse_voucher", { entity: E, year: Y });
    expect(missing.isError).toBe(true);
    expect(missing.json).toEqual({ status: 400, error: "missing required argument: nr", sqlstate: null });
    // an argument a read does not take is refused by name, as over HTTP
    const unknown = await call("journal", { entity: E, colour: "blue" });
    expect(unknown.isError).toBe(true);
    expect(unknown.json.status).toBe(400);
    expect(unknown.json.error).toContain("colour");
    const noTool = await call("drop_ledger", {});
    expect(noTool.isError).toBe(true);
  });

  test("reverse a voucher by path parameters", async () => {
    const r = await call("reverse_voucher", { entity: E, year: Y, nr: 1, posting_date: "2026-01-31" });
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({ entity: E, year: Y, nr: expect.any(Number), idempotent: false });
    const bal = await call("account_balance", { entity: E, account: "1500" });
    expect(bal.json).toEqual([{ entity: E, account: "1500", balance: 0 }]);
  });

  test("documents: store as base64, link, retrieve as an embedded resource", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0x10]);
    const stored = await call("store_document", {
      content_base64: Buffer.from(bytes).toString("base64"), media_type: "application/pdf", origin: "receipt", note: "kvittering",
    });
    expect(stored.isError).toBe(false);
    expect(stored.json).toMatchObject({ mediaType: "application/pdf", bytes: bytes.length, origin: "receipt", note: "kvittering" });
    const sha = stored.json.sha256 as string;

    const linked = await call("link_document", { entity: E, year: Y, nr: 1, sha256: sha });
    expect(linked.json).toEqual({ entity: E, year: Y, nr: 1, sha256: sha });

    const got = await call("retrieve_document", { sha256: sha });
    expect(got.isError).toBe(false);
    const res = got.result.content[0] as any;
    expect(res.type).toBe("resource");
    expect(res.resource.mimeType).toBe("application/pdf");
    expect(res.resource.uri).toBe(`hovedbok:///retrieve_document/${sha}`);
    expect(new Uint8Array(Buffer.from(res.resource.blob, "base64"))).toEqual(bytes);

    const bad = await call("store_document", { content_base64: "not base64!", media_type: "text/plain", origin: "other" });
    expect(bad.json).toEqual({ status: 400, error: "content_base64 is not base64", sqlstate: null });
    const missing = await call("retrieve_document", { sha256: "0".repeat(64) });
    expect(missing.json.status).toBe(404);
  });

  test("an XML export comes back as a named resource", async () => {
    const s = await call("saf_t", { entity: E, year: Y });
    expect(s.isError).toBe(false);
    const res = s.result.content[0] as any;
    expect(res.type).toBe("resource");
    expect(res.resource.mimeType).toBe("application/xml");
    expect(res.resource.uri).toMatch(/^hovedbok:\/\/\/saf_t\/SAF-T%20Financial_999888777_\d{14}_1_1\.xml$/);
    expect(res.resource.text).toContain("<AuditFile xmlns=\"urn:StandardAuditFile-Taxation-Financial:NO\">");

    const m = await call("mva_melding", { entity: E, year: Y, term: 1, format: "json" });
    expect(m.isError).toBe(false);
    // the only sale was reversed: nothing to report, nothing to pay
    expect(m.json).toMatchObject({ lines: [], total: 0, xml: expect.stringContaining("<mvaMeldingDto") });
  });

  test("the bank tools reach the bank layer (unconfigured here: 503 naming it)", async () => {
    const r = await call("sync_connection", {});
    expect(r.isError).toBe(true);
    expect(r.json.status).toBe(503);
    expect(r.json.error).toContain("Enable Banking is not configured");
    const status = await call("bank_connection_status", { entity: E });
    expect(status.json).toEqual([]);
  });
});

describe("auth and transport", () => {
  test("no or a wrong token: 401, and the client cannot connect", async () => {
    for (const authorization of [undefined, "Bearer nope", `Basic ${TOKEN}`]) {
      const res = await fetch(endpoint(), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization && { authorization }) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    await expect(connect("wrong")).rejects.toThrow();
  });

  test("only /mcp answers", async () => {
    const res = await fetch(new URL("/journal", server.url), { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });
});
