// Offline Enable Banking: a `fetch` that answers from recorded fixtures
// (test/fixtures/enable-banking) and records every call it saw.
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

const fixtureDir = join(import.meta.dir, "fixtures", "enable-banking");

export async function fixture(name: string): Promise<unknown> {
  return Bun.file(join(fixtureDir, `${name}.json`)).json();
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface Route {
  method: string;
  /** Exact path, or a predicate on the call. */
  path: string | ((call: Call) => boolean);
  /** Fixture name, or an explicit response. */
  reply: string | { status?: number; body?: unknown; headers?: Record<string, string> };
  /** Consumed after one use (default: reusable). */
  once?: boolean;
}

export interface Replay {
  fetch: typeof fetch;
  calls: Call[];
  /** Calls to `/accounts/...` endpoints (the bank-side reads the quota counts). */
  accountCalls(): Call[];
}

export function replay(routes: Route[]): Replay {
  const pending = [...routes];
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body };
    calls.push(call);
    const i = pending.findIndex(
      (r) => r.method === method && (typeof r.path === "string" ? r.path === call.path : r.path(call)),
    );
    if (i < 0) {
      return new Response(JSON.stringify({ message: `no recorded response for ${method} ${url}`, error: "NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const route = pending[i]!;
    if (route.once) pending.splice(i, 1);
    const reply = typeof route.reply === "string" ? { body: await fixture(route.reply) } : route.reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return {
    fetch: impl,
    calls,
    accountCalls: () => calls.filter((c) => c.path.startsWith("/accounts/")),
  };
}

/** A throwaway RSA key pair: the signer is exercised for real, offline. */
export function testKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }) as string;
}
