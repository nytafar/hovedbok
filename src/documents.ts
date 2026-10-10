// Documentation (bilag), BL § 10: immutable, content-addressed blobs.
//
// The bytes live on disk at <root>/<aa>/<sha256> (aa = first two hex chars);
// the `document` row is the fact. `voucher_document` is the two-way audit
// trail (BL § 4 nr. 7). Bytes are stored verbatim — e-invoice XML and bank
// files included — so a retrieve returns exactly what was stored, and every
// read recomputes the hash.
//
//   const docs = documentStore(sql);              // root: $DOCUMENTS_DIR or ./documents
//   const doc = await docs.store(bytes, { mediaType: "application/xml", origin: "einvoice" });
//   await docs.link(doc.sha256, { entity, year, nr });
//   const { data } = await docs.retrieve(doc.sha256);
//
// Pass a transaction as `sql` to make the row inserts part of a larger unit;
// a blob written for a rolled-back row is a harmless orphan (same content,
// same name) that the next store of those bytes reuses.
import type { SQL } from "bun";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type Origin = "receipt" | "invoice" | "einvoice" | "bank" | "contract" | "other";

export interface DocumentMeta {
  mediaType: string;
  origin: Origin;
  note?: string;
}

export interface Document {
  sha256: string;
  mediaType: string;
  bytes: number;
  origin: Origin;
  note: string;
  createdAt: Date;
}

export interface VoucherRef {
  entity: string;
  year: number;
  nr: number;
}

export interface DocumentStore {
  /** The blob path for a hash. */
  path(sha256: string): string;
  /**
   * Stores bytes verbatim and records the document row. Storing content that
   * already exists is a no-op returning the existing row (first metadata wins).
   */
  store(data: Uint8Array | ArrayBuffer, meta: DocumentMeta): Promise<Document>;
  /** Attaches a stored document to a voucher. Idempotent. */
  link(sha256: string, voucher: VoucherRef): Promise<void>;
  /** Reads the blob and its row; throws if the bytes no longer hash to `sha256`. */
  retrieve(sha256: string): Promise<Document & { data: Uint8Array }>;
}

export class DocumentIntegrityError extends Error {
  constructor(
    readonly sha256: string,
    readonly actual: string,
  ) {
    super(`document ${sha256}: blob on disk hashes to ${actual}`);
    this.name = "DocumentIntegrityError";
  }
}

const SHA = /^[0-9a-f]{64}$/;

function sha256Hex(data: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function checkSha(sha256: string): void {
  if (!SHA.test(sha256)) throw new Error(`not a sha256 hex digest: ${JSON.stringify(sha256)}`);
}

type Row = {
  sha256: string;
  media_type: string;
  bytes: string | number | bigint;
  origin: Origin;
  note: string;
  created_at: Date;
};

function toDocument(r: Row): Document {
  return {
    sha256: r.sha256,
    mediaType: r.media_type,
    bytes: Number(r.bytes),
    origin: r.origin,
    note: r.note,
    createdAt: r.created_at,
  };
}

export function documentStore(
  sql: SQL,
  root: string = process.env.DOCUMENTS_DIR ?? "documents",
): DocumentStore {
  const path = (sha256: string) => {
    checkSha(sha256);
    return join(root, sha256.slice(0, 2), sha256);
  };

  async function readVerified(sha256: string): Promise<Uint8Array> {
    const file = Bun.file(path(sha256));
    if (!(await file.exists())) throw new Error(`document ${sha256}: blob missing on disk`);
    const data = await file.bytes();
    const actual = sha256Hex(data);
    if (actual !== sha256) throw new DocumentIntegrityError(sha256, actual);
    return data;
  }

  async function row(sha256: string): Promise<Document | undefined> {
    const [r] = await sql`
      select sha256, media_type, bytes, origin, note, created_at
        from document where sha256 = ${sha256}`;
    return r ? toDocument(r as Row) : undefined;
  }

  return {
    path,

    async store(input, meta) {
      const data = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (data.byteLength === 0) throw new Error("document: empty content");
      const sha256 = sha256Hex(data);
      const target = path(sha256);

      if (await Bun.file(target).exists()) {
        // Never overwrite: an existing blob that fails its hash is evidence.
        await readVerified(sha256);
      } else {
        await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
        // Write-then-rename so a crash never leaves a partial blob under the
        // final name; concurrent writers of the same content rename identical bytes.
        const tmp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
        try {
          await Bun.write(tmp, data);
          await rename(tmp, target);
        } catch (e) {
          await rm(tmp, { force: true });
          throw e;
        }
      }

      await sql`
        insert into document (sha256, media_type, bytes, origin, note)
        values (${sha256}, ${meta.mediaType}, ${data.byteLength}, ${meta.origin}, ${meta.note ?? ""})
        on conflict (sha256) do nothing`;
      const doc = await row(sha256);
      if (!doc) throw new Error(`document ${sha256}: row missing after insert`);
      return doc;
    },

    async link(sha256, v) {
      checkSha(sha256);
      await sql`
        insert into voucher_document (entity, year, nr, sha256)
        values (${v.entity}, ${v.year}, ${v.nr}, ${sha256})
        on conflict do nothing`;
    },

    async retrieve(sha256) {
      checkSha(sha256);
      const doc = await row(sha256);
      if (!doc) throw new Error(`document ${sha256}: not found`);
      const data = await readVerified(sha256);
      return { ...doc, data };
    },
  };
}
