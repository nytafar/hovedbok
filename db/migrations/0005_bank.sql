-- The bank layer: the source of truth (ADR-0004). Facts (bank_transaction,
-- bank_balance) are append-only; connections/accounts are operational state;
-- matches are revisable interpretation; pending is a replaceable snapshot.

create table bank_connection (
  id            bigint generated always as identity primary key,
  entity        text not null references entity (orgnr),
  aspsp_name    text not null,
  aspsp_country text not null default 'NO',
  session_id    text,
  valid_until   timestamptz,
  status        text not null default 'pending'
                check (status in ('pending', 'authorized', 'expired', 'revoked')),
  created_at    timestamptz not null default now()
);

create table bank_account (
  -- Enable Banking identification_hash: the only identity stable across consents
  id_hash        text primary key,
  entity         text not null references entity (orgnr),
  connection_id  bigint references bank_connection,
  uid            text, -- session-scoped, refreshed on re-consent
  iban           text,
  bban           text, -- Norwegian kontonummer
  name           text,
  currency       text not null default 'NOK',
  ledger_account text not null, -- the 19xx account this statement feeds
  raw            jsonb not null default '{}',
  foreign key (entity, ledger_account) references account (entity, code)
);

create table bank_transaction (
  id_hash          text not null references bank_account,
  -- entry_reference when the bank provides it, else 'fp:' + content fingerprint
  dedup_key        text not null,
  booking_date     date,
  value_date       date,
  amount           bigint not null, -- signed øre, positive = into the account
  ccy              text not null default 'NOK',
  status           text not null default 'BOOK' check (status = 'BOOK'),
  counterparty     text,
  reference        text,
  reference_schema text, -- NORF = KID
  remittance       text,
  raw              jsonb not null,
  imported_at      timestamptz not null default now(),
  primary key (id_hash, dedup_key)
);

create index bank_transaction_by_date on bank_transaction (id_hash, booking_date);

-- Pending (PDNG) never enters matching; each sync replaces the snapshot wholesale.
create table bank_transaction_pending (
  id_hash   text not null references bank_account,
  seq       smallint not null,
  raw       jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (id_hash, seq)
);

-- Balance snapshots (CLBD etc.) anchor the reconciliation assertion:
-- ledger 19xx balance == closing booked balance.
create table bank_balance (
  id_hash        text not null references bank_account,
  balance_type   text not null,
  reference_date date,
  amount         bigint not null,
  raw            jsonb not null default '{}',
  fetched_at     timestamptz not null default now(),
  primary key (id_hash, balance_type, fetched_at)
);

-- Interpretation, not fact: insert/delete allowed, reconciliation always derived.
create table match (
  id_hash    text not null,
  dedup_key  text not null,
  entity     text not null,
  year       smallint not null,
  nr         integer not null,
  line       smallint not null,
  created_at timestamptz not null default now(),
  primary key (id_hash, dedup_key, entity, year, nr, line),
  foreign key (id_hash, dedup_key) references bank_transaction,
  foreign key (entity, year, nr, line) references posting
);

create function check_match_entity() returns trigger
language plpgsql as $$
begin
  perform 1 from bank_account
   where id_hash = new.id_hash and entity = new.entity;
  if not found then
    raise exception 'bank account % does not belong to entity %', new.id_hash, new.entity;
  end if;
  return new;
end
$$;

create trigger match_same_entity before insert on match
for each row execute function check_match_entity();

create trigger bank_transaction_append_only before update or delete on bank_transaction
for each statement execute function forbid_change();
create trigger bank_balance_append_only before update or delete on bank_balance
for each statement execute function forbid_change();

create function notify_bank_transaction() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hovedbok', jsonb_build_object(
    'table', 'bank_transaction', 'id_hash', new.id_hash, 'dedup_key', new.dedup_key,
    'amount', new.amount, 'booking_date', new.booking_date)::text);
  return null;
end
$$;

create trigger bank_transaction_notify after insert on bank_transaction
for each row execute function notify_bank_transaction();
