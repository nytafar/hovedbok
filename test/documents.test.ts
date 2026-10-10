// Document store: content-addressed blobs on disk + document/voucher_document
// rows, exercised as hovedbok_app (the role adapters run as).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentIntegrityError, documentStore, type VoucherRef } from "../src/documents";
import { dropTestDb, freshDb } from "./helper";

const E = "999888777";
const Y = 2026;

let sql: SQL;
let dir: string;

beforeEach(async () => {
  sql = await freshDb();
  dir = await mkdtemp(join(tmpdir(), "hovedbok-docs-"));
  await sql`select bootstrap_entity(${{ orgnr: E, name: "Test AS", year: Y }}::jsonb)`;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterAll(dropTestDb);

/** Runs fn in a transaction as hovedbok_app — the roles are NOLOGIN. */
function asApp<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe("set local role hovedbok_app");
    return fn(tx as unknown as SQL);
  }) as Promise<T>;
}

async function postVoucher(key: string): Promise<VoucherRef> {
  const p = {
    entity: E,
    posting_date: "2026-01-15",
    description: `voucher ${key}`,
    idempotency_key: key,
    lines: [
      { account: "1920", amount: 12500 },
      { account: "3000", amount: -12500 },
    ],
  };
  const [row] = await sql`select post_voucher(${p}::jsonb) as r`;
  const { entity, year, nr } = row.r as VoucherRef;
  return { entity, year, nr };
}

const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

// E-invoice XML with a BOM, CRLF line endings, trailing whitespace and no final
// newline: everything a normaliser would "fix" must survive byte-exact.
const ehf = new TextEncoder().encode(
  '﻿<?xml version="1.0" encoding="UTF-8"?>\r\n<Invoice>  \r\n\t<ID>42</ID>\r\n</Invoice>  ',
);

async function filesUnder(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

describe("documents", () => {
  test("round-trip: store → link → retrieve returns the exact bytes", async () => {
    const v = await postVoucher("v1");
    const doc = await asApp(async (tx) => {
      const docs = documentStore(tx, dir);
      const doc = await docs.store(ehf, { mediaType: "application/xml", origin: "einvoice" });
      await docs.link(doc.sha256, v);
      return doc;
    });

    expect(doc.sha256).toBe(sha(ehf));
    expect(doc.bytes).toBe(ehf.byteLength);
    expect(doc.origin).toBe("einvoice");
    expect(await filesUnder(dir)).toEqual([join(dir, doc.sha256.slice(0, 2), doc.sha256)]);

    const got = await asApp((tx) => documentStore(tx, dir).retrieve(doc.sha256));
    expect(sha(got.data)).toBe(doc.sha256);
    expect(Buffer.from(got.data).equals(Buffer.from(ehf))).toBe(true);
    expect(got.mediaType).toBe("application/xml");

    const links = await sql`select entity, year, nr from voucher_document where sha256 = ${doc.sha256}`;
    expect(links).toEqual([{ entity: v.entity, year: v.year, nr: v.nr }]);
    // and the voucher is no longer in the missing-receipts queue
    const missing = await sql`
      select 1 from voucher_without_document where entity = ${v.entity} and nr = ${v.nr}`;
    expect(missing.length).toBe(0);
  });

  test("duplicate content is one row and one file with many links", async () => {
    const v1 = await postVoucher("v1");
    const v2 = await postVoucher("v2");
    const bank = new TextEncoder().encode("date;amount\n2026-01-15;125,00\n");

    const [a, b] = await asApp(async (tx) => {
      const docs = documentStore(tx, dir);
      const a = await docs.store(bank, { mediaType: "text/csv", origin: "bank" });
      const b = await docs.store(bank.slice().buffer, {
        mediaType: "text/plain",
        origin: "other",
        note: "second upload",
      });
      await docs.link(a.sha256, v1);
      await docs.link(b.sha256, v2);
      await docs.link(b.sha256, v2); // idempotent
      return [a, b];
    });

    expect(b).toEqual(a); // first metadata wins
    expect(a.origin).toBe("bank");
    const [{ n }] = await sql`select count(*)::int as n from document`;
    expect(n).toBe(1);
    expect((await filesUnder(dir)).length).toBe(1);
    const links = await sql`select nr from voucher_document where sha256 = ${a.sha256} order by nr`;
    expect(links.map((r: { nr: number }) => r.nr)).toEqual([v1.nr, v2.nr]);
  });

  test("tampering on disk is detected at read", async () => {
    const doc = await asApp((tx) =>
      documentStore(tx, dir).store(new TextEncoder().encode("kvittering"), {
        mediaType: "text/plain",
        origin: "receipt",
      }),
    );
    const docs = documentStore(sql, dir);
    await writeFile(docs.path(doc.sha256), "kvitterinG");

    await expect(docs.retrieve(doc.sha256)).rejects.toBeInstanceOf(DocumentIntegrityError);
    // re-storing the original bytes must not paper over the evidence
    await expect(
      docs.store(new TextEncoder().encode("kvittering"), { mediaType: "text/plain", origin: "receipt" }),
    ).rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  test("rejects empty content, malformed hashes and unknown documents", async () => {
    const docs = documentStore(sql, dir);
    await expect(docs.store(new Uint8Array(), { mediaType: "text/plain", origin: "other" })).rejects.toThrow(
      "empty content",
    );
    await expect(docs.retrieve("../../etc/passwd")).rejects.toThrow("not a sha256");
    await expect(docs.retrieve("0".repeat(64))).rejects.toThrow("not found");
  });

  test("DOCUMENTS_DIR is the default root", () => {
    const prev = process.env.DOCUMENTS_DIR;
    process.env.DOCUMENTS_DIR = dir;
    try {
      expect(documentStore(sql).path("ab".repeat(32))).toBe(join(dir, "ab", "ab".repeat(32)));
    } finally {
      if (prev === undefined) delete process.env.DOCUMENTS_DIR;
      else process.env.DOCUMENTS_DIR = prev;
    }
  });
});
