// MCP adapter (#12, ADR-0008): the HTTP API's operations as MCP tools, over
// streamable-http (the services gateway proxies HTTP only).
//
// One definition per operation. Each tool is a route of createApi's route
// table, dispatched in-process through the Hono app's fetch: no socket, but the
// same parsing, the same SQL call and the same error mapping as the HTTP API.
// The tool name is the route's operationId; its input schema is the route's
// OpenAPI path/query parameters and request body (src/api/openapi.ts),
// flattened into one object; its description is src/mcp/descriptions.ts.
// Excluded: public routes (the browser-only consent callback, the OpenAPI
// document itself — tools/list is the MCP equivalent) and aliasOf routes (POST
// on /accounts and /parties: the same operation as the PUT).
//
// Mapping: path parameters fill the path; query parameters (and, on GET, any
// argument the spec does not know, so the API refuses it by name) go to the
// query string; on other methods the remaining arguments are the JSON body,
// verbatim. store_document is the one binary body: content_base64 + media_type.
// A JSON answer is returned as its text (bigint øre exact, as Postgres wrote
// it); an XML or binary answer (mva_melding, saf_t, retrieve_document) as an
// embedded resource; an error status as isError with {status, ...the API's
// error body}.
//
// Auth: one bearer token; the session is the API's read-write token on the rw
// connection (a login in role hovedbok_app). Stateless: every POST /mcp gets a
// fresh Server and transport, so any replica behind the gateway can answer.
//
//   const mcp = createMcp({ rw, token, documentsDir });
//   Bun.serve({ fetch: mcp.fetch });
import type { SQL } from "bun";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createApi, type BankOptions, type Route } from "../api/app";
import { openapi } from "../api/openapi";
import { CONVENTIONS, descriptions } from "./descriptions";

export interface McpOptions {
  /** Read-write connection: a login in role hovedbok_app. */
  rw: SQL;
  /** The bearer token MCP clients send. */
  token: string;
  /** Blob root for the document store; default $DOCUMENTS_DIR or ./documents. */
  documentsDir?: string;
  /** Enable Banking, as for createApi. */
  bank?: BankOptions;
  /** Upper bound on one MCP request body (store_document carries base64); default 64 MiB. */
  maxRequestBodySize?: number;
}

/** The URL path the MCP endpoint answers on. */
export const MCP_PATH = "/mcp";

type Schema = Record<string, unknown>;
type In = "path" | "query" | "body";

interface ToolDef {
  tool: Tool;
  route: Route;
  /** Where each declared argument goes. */
  places: Map<string, In>;
  /** store_document: the binary body. */
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Schemas from the OpenAPI document

const components = openapi.components.schemas as Record<string, Schema>;

/** Inline every #/components/schemas ref (the component graph is acyclic). */
function resolve(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(resolve);
  if (s === null || typeof s !== "object") return s;
  const o = s as Schema;
  if (typeof o.$ref === "string") {
    const name = o.$ref.replace("#/components/schemas/", "");
    const target = components[name];
    if (!target) throw new Error(`openapi: unresolved $ref ${o.$ref}`);
    return resolve(target);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v)]));
}

interface SpecOperation {
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema: Schema }[];
  requestBody?: { required?: boolean; content: Record<string, { schema: Schema }> };
}

function specOperation(operationId: string): SpecOperation {
  for (const methods of Object.values(openapi.paths as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(methods)) {
      if ((op as { operationId?: string }).operationId === operationId) return op as SpecOperation;
    }
  }
  throw new Error(`openapi: no operation ${operationId}`);
}

const BINARY_BODY: Record<string, Schema> = {
  content_base64: { type: "string", contentEncoding: "base64", description: "The document's bytes, base64-encoded." },
  media_type: { type: "string", description: "Its media type, stored with it (e.g. application/pdf, image/jpeg)." },
};

function toolDef(route: Route): ToolDef {
  const op = specOperation(route.operationId);
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  const places = new Map<string, In>();
  const put = (name: string, schema: Schema, where: In, req: boolean) => {
    if (places.has(name)) throw new Error(`mcp: ${route.operationId}: argument ${name} is both ${places.get(name)} and ${where}`);
    places.set(name, where);
    properties[name] = schema;
    if (req) required.push(name);
  };

  for (const p of op.parameters ?? []) {
    const schema = { ...(resolve(p.schema) as Schema), ...(p.description && { description: p.description }) };
    put(p.name, schema, p.in === "path" ? "path" : "query", p.in === "path" || !!p.required);
  }
  let binary = false;
  const content = op.requestBody?.content;
  if (content?.["application/json"]) {
    const body = resolve(content["application/json"].schema) as Schema;
    const req = new Set(op.requestBody?.required ? ((body.required as string[] | undefined) ?? []) : []);
    for (const [name, schema] of Object.entries((body.properties ?? {}) as Record<string, Schema>)) {
      put(name, schema, "body", req.has(name));
    }
  } else if (content) {
    binary = true;
    for (const [name, schema] of Object.entries(BINARY_BODY)) put(name, schema, "body", true);
  }

  const description = descriptions[route.operationId];
  if (!description) throw new Error(`mcp: no description for ${route.operationId}`);
  const tool: Tool = {
    name: route.operationId,
    description,
    inputSchema: { type: "object", properties, ...(required.length && { required }) },
    annotations: { readOnlyHint: route.method === "GET" },
  };
  return { tool, route, places, binary };
}

// ---------------------------------------------------------------------------
// Dispatch: tool arguments → an HTTP request against the API app

class ArgumentError extends Error {}

function scalarArg(name: string, v: unknown): string {
  if (v === null || typeof v === "object") throw new ArgumentError(`argument ${name} must be a string, number or boolean`);
  return String(v);
}

function toRequest(def: ToolDef, args: Record<string, unknown>, token: string): Request {
  const { route, places } = def;
  const consumed = new Set<string>();
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
    consumed.add(name);
    const v = args[name];
    if (v === undefined || v === null) throw new ArgumentError(`missing required argument: ${name}`);
    return encodeURIComponent(scalarArg(name, v));
  });

  const url = new URL(path, "http://hovedbok.internal");
  const body: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(args)) {
    if (consumed.has(name) || v === undefined) continue;
    const where = places.get(name) ?? (route.method === "GET" ? "query" : "body");
    if (where === "query") {
      if (v !== null) url.searchParams.set(name, scalarArg(name, v));
    } else {
      body[name] = v;
    }
  }

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: RequestInit["body"];
  if (def.binary) {
    const { content_base64, media_type, ...rest } = body;
    const unknown = Object.keys(rest);
    if (unknown.length) throw new ArgumentError(`unknown argument(s): ${unknown.join(", ")}`);
    if (typeof content_base64 !== "string") throw new ArgumentError("content_base64 (the document's bytes, base64) is required");
    if (typeof media_type !== "string" || !media_type) throw new ArgumentError("media_type is required");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64.replace(/\s+/g, ""))) {
      throw new ArgumentError("content_base64 is not base64");
    }
    payload = Buffer.from(content_base64, "base64");
    headers["content-type"] = media_type;
  } else if (route.method !== "GET") {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return new Request(url.toString(), { method: route.method, headers, body: payload });
}

function isTextual(mediaType: string): boolean {
  return /^text\/|[/+](json|xml)\b|^application\/(xml|json)/i.test(mediaType);
}

async function toResult(def: ToolDef, res: Response): Promise<CallToolResult> {
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  if (!res.ok) {
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { error: text.trim(), sqlstate: null };
    }
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: res.status, ...body }) }] };
  }
  if (/^application\/json\b/i.test(type)) {
    return { content: [{ type: "text", text: await res.text() }] };
  }

  // XML exports and stored documents: an embedded resource
  const mimeType = type.split(";")[0]!.trim();
  const filename = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  const etag = res.headers.get("etag")?.replaceAll('"', "");
  const name = filename ?? etag ?? def.route.operationId;
  const uri = `hovedbok:///${def.route.operationId}/${encodeURIComponent(name)}`;
  const resource = isTextual(mimeType)
    ? { uri, mimeType, text: await res.text() }
    : { uri, mimeType, blob: Buffer.from(await res.arrayBuffer()).toString("base64") };
  return { content: [{ type: "resource", resource }] };
}

// ---------------------------------------------------------------------------

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

export function createMcp(opts: McpOptions) {
  if (!opts.token) throw new Error("createMcp: token is required");

  // The API answers only this process: a fresh token per instance, never sent anywhere.
  const internalToken = randomBytes(32).toString("hex");
  const api = createApi({ rw: opts.rw, rwToken: internalToken, documentsDir: opts.documentsDir, bank: opts.bank });
  const defs = new Map<string, ToolDef>();
  for (const route of api.routeTable) {
    if (route.public || route.aliasOf) continue;
    defs.set(route.operationId, toolDef(route));
  }
  const tools = [...defs.values()].map((d) => d.tool);

  const callTool = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const def = defs.get(name);
    if (!def) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: 404, error: `no tool ${name}`, sqlstate: null }) }] };
    }
    let req: Request;
    try {
      req = toRequest(def, args, internalToken);
    } catch (e) {
      if (!(e instanceof ArgumentError)) throw e;
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: 400, error: e.message, sqlstate: null }) }] };
    }
    return toResult(def, await api.fetch(req));
  };

  const newServer = () => {
    const server = new Server(
      { name: "hovedbok", version: "1.0.0" },
      {
        capabilities: { tools: {} },
        instructions:
          "hovedbok: an agent-first Norwegian double-entry ledger. Every tool is 1:1 with an HTTP API operation and a SQL " +
          "command or view; the database enforces the bookkeeping law. " + CONVENTIONS,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, (req) => callTool(req.params.name, req.params.arguments));
    return server;
  };

  const fetch = async (req: Request): Promise<Response> => {
    const header = req.headers.get("authorization") ?? "";
    const given = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!given || !timingSafeEqual(digest(given), digest(opts.token))) {
      return Response.json(
        { error: "missing or invalid bearer token (Authorization: Bearer <MCP_TOKEN>)" },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="hovedbok-mcp"' } },
      );
    }
    const path = new URL(req.url).pathname.replace(/\/$/, "");
    if (path !== MCP_PATH) return Response.json({ error: `no route ${path}; MCP is at ${MCP_PATH}` }, { status: 404 });

    const server = newServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
      maxRequestBodySize: opts.maxRequestBodySize ?? 64 * 1024 * 1024,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // JSON responses are complete when handleRequest resolves
      await transport.close();
      await server.close();
    }
  };

  return { fetch, tools: tools as readonly Tool[], callTool, routeTable: api.routeTable };
}
