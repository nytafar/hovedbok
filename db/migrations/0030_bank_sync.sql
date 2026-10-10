-- Enable Banking sync support (#10): operational sync state on the consent,
-- the fetch log that enforces the ≤4 unattended fetches/day/consent budget
-- and the 6 h backoff on 429, and the matching commands.
--
-- Matching goes through commands (match_bank / unmatch_bank), ADR-0009 style,
-- rather than direct DML on `match`: a command is the one place that resolves
-- the voucher line (the line on the bank's own 19xx account) and names the
-- rule when it refuses. The 0008 insert/delete grant on `match` stays; the
-- strengthened trigger below is the backstop for both paths.

-- --------------------------------------------------------------------------
-- Consent state: where the sync left off, the CSRF state of a pending
-- authorization, and the earliest time an unattended fetch may run again.
alter table bank_connection
  add column auth_state     text unique,
  add column last_synced_at timestamptz,
  add column backoff_until  timestamptz;

-- --------------------------------------------------------------------------
-- Fetch log: one row per sync run per consent. A run reads transactions and
-- balances for every account on the consent once. Unattended runs (no PSU
-- headers) are capped at 4 per rolling 24 h per consent — PSD2's limit, which
-- Norwegian banks enforce (research-enable-banking.md). Deferred runs are
-- logged too, so an operator can see why nothing happened.
create table bank_fetch (
  id            bigint generated always as identity primary key,
  connection_id bigint not null references bank_connection,
  started_at    timestamptz not null default now(),
  attended      boolean not null,
  outcome       text not null
                check (outcome in ('ok', 'rate_limited', 'expired', 'error', 'deferred')),
  detail        text
);
create index bank_fetch_by_connection on bank_fetch (connection_id, started_at);

-- --------------------------------------------------------------------------
-- A match links a bank fact to the voucher line on the ledger account that
-- statement feeds: same entity (0005) and, now, the bank account's own
-- ledger_account. Linking a bank movement to the 7770 cost line instead of
-- the 1920 line made the reconciliation views lie.
create or replace function check_match_entity() returns trigger
language plpgsql as $$
declare
  ba bank_account%rowtype;
  v_account text;
begin
  select * into ba from bank_account where id_hash = new.id_hash;
  if not found then
    raise exception 'bank account % does not exist', new.id_hash
      using errcode = 'foreign_key_violation';
  end if;
  if ba.entity <> new.entity then
    raise exception 'bank account % does not belong to entity %', new.id_hash, new.entity;
  end if;
  select account into v_account from posting
   where entity = new.entity and year = new.year and nr = new.nr and line = new.line;
  if v_account is null then
    raise exception 'posting %/%/%/% does not exist', new.entity, new.year, new.nr, new.line
      using errcode = 'foreign_key_violation';
  end if;
  if v_account <> ba.ledger_account then
    raise exception 'match must link the line on ledger account % (bank account %), not %',
      ba.ledger_account, new.id_hash, v_account;
  end if;
  return new;
end
$$;

-- --------------------------------------------------------------------------
-- match_bank payload: {
--   "id_hash": "...", "dedup_key": "...",   -- the bank transaction
--   "entity": "999888777", "year": 2026, "nr": 12,
--   "line": 1                               -- optional: defaults to the voucher's
--                                           -- single line on the bank's ledger account
-- }
-- returns {"id_hash", "dedup_key", "entity", "year", "nr", "line", "created"}
-- Idempotent: an existing link returns created=false.
create function match_bank(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash   text     := p ->> 'id_hash';
  v_key    text     := p ->> 'dedup_key';
  v_entity text     := p ->> 'entity';
  v_year   smallint := (p ->> 'year')::smallint;
  v_nr     integer  := (p ->> 'nr')::integer;
  v_line   smallint := (p ->> 'line')::smallint;
  ba       bank_account%rowtype;
  n        integer;
  v_created boolean := false;
begin
  if v_hash is null or v_key is null or v_entity is null or v_year is null or v_nr is null then
    raise exception 'id_hash, dedup_key, entity, year and nr are required';
  end if;
  select * into ba from bank_account where id_hash = v_hash;
  if not found then
    raise exception 'bank account % does not exist', v_hash
      using errcode = 'foreign_key_violation';
  end if;
  if ba.entity <> v_entity then
    raise exception 'bank account % does not belong to entity %', v_hash, v_entity;
  end if;
  perform 1 from bank_transaction where id_hash = v_hash and dedup_key = v_key;
  if not found then
    raise exception 'bank transaction %/% does not exist', v_hash, v_key
      using errcode = 'foreign_key_violation';
  end if;
  perform 1 from voucher where entity = v_entity and year = v_year and nr = v_nr;
  if not found then
    raise exception 'voucher %/%/% does not exist', v_entity, v_year, v_nr
      using errcode = 'foreign_key_violation';
  end if;
  if v_line is null then
    select count(*), min(line) into n, v_line from posting
     where entity = v_entity and year = v_year and nr = v_nr and account = ba.ledger_account;
    if n = 0 then
      raise exception 'voucher %/%/% has no line on ledger account %',
        v_entity, v_year, v_nr, ba.ledger_account;
    elsif n > 1 then
      raise exception 'voucher %/%/% has % lines on ledger account %; pass "line"',
        v_entity, v_year, v_nr, n, ba.ledger_account;
    end if;
  end if;
  -- the trigger checks the line's account; this just names a missing line
  perform 1 from posting
   where entity = v_entity and year = v_year and nr = v_nr and line = v_line;
  if not found then
    raise exception 'posting %/%/%/% does not exist', v_entity, v_year, v_nr, v_line
      using errcode = 'foreign_key_violation';
  end if;

  insert into match (id_hash, dedup_key, entity, year, nr, line)
  values (v_hash, v_key, v_entity, v_year, v_nr, v_line)
  on conflict do nothing;
  v_created := found;
  return jsonb_build_object(
    'id_hash', v_hash, 'dedup_key', v_key, 'entity', v_entity,
    'year', v_year, 'nr', v_nr, 'line', v_line, 'created', v_created);
end
$$;

-- unmatch_bank payload: the same keys; "line" optional (omit = every link
-- between that bank transaction and that voucher). Returns {"deleted": n}.
create function unmatch_bank(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_hash   text     := p ->> 'id_hash';
  v_key    text     := p ->> 'dedup_key';
  v_entity text     := p ->> 'entity';
  v_year   smallint := (p ->> 'year')::smallint;
  v_nr     integer  := (p ->> 'nr')::integer;
  v_line   smallint := (p ->> 'line')::smallint;
  n        integer;
begin
  if v_hash is null or v_key is null or v_entity is null or v_year is null or v_nr is null then
    raise exception 'id_hash, dedup_key, entity, year and nr are required';
  end if;
  delete from match
   where id_hash = v_hash and dedup_key = v_key
     and entity = v_entity and year = v_year and nr = v_nr
     and (v_line is null or line = v_line);
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end
$$;

-- grants, 0008 style
grant select on bank_fetch to hovedbok_app, hovedbok_ro;
grant insert on bank_fetch to hovedbok_app;
revoke all on function match_bank(jsonb) from public;
revoke all on function unmatch_bank(jsonb) from public;
grant execute on function match_bank(jsonb) to hovedbok_app;
grant execute on function unmatch_bank(jsonb) to hovedbok_app;
