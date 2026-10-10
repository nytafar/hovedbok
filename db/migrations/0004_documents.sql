-- Documentation (bilag), BL § 10: immutable, content-addressed. Blob bytes live
-- on disk at documents/<aa>/<sha256>; the row is the fact. voucher_document is
-- the two-way audit trail (BL § 4 nr. 7).

create table document (
  sha256     text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
  media_type text not null,
  bytes      bigint not null check (bytes > 0),
  origin     text not null
             check (origin in ('receipt', 'invoice', 'einvoice', 'bank', 'contract', 'other')),
  note       text not null default '',
  created_at timestamptz not null default now()
);

create table voucher_document (
  entity text not null,
  year   smallint not null,
  nr     integer not null,
  sha256 text not null references document,
  primary key (entity, year, nr, sha256),
  foreign key (entity, year, nr) references voucher
);

create trigger document_append_only before update or delete on document
for each statement execute function forbid_change();
create trigger voucher_document_append_only before update or delete on voucher_document
for each statement execute function forbid_change();
