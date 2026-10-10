-- The journal: two fact tables, append-only, natural keys (ADR-0001, -0002, -0006).
-- A voucher is identified as entity/year/nr; nr is gapless per entity+year.

create table voucher (
  entity          text not null,
  year            smallint not null,
  nr              integer not null check (nr > 0),
  document_date   date not null,
  posting_date    date not null,
  period          smallint not null,
  description     text not null,
  source          text not null default 'agent'
                  check (source in ('agent', 'bank', 'woocommerce', 'import', 'manual')),
  external_ref    text,
  idempotency_key text not null,
  -- corrections are reversals (BF § 5-12); a voucher reverses at most one and
  -- is reversed at most once
  reverses_year   smallint,
  reverses_nr     integer,
  created_at      timestamptz not null default now(),
  created_by      text not null default current_user,
  primary key (entity, year, nr),
  foreign key (entity, year) references fiscal_year,
  foreign key (entity, year, period) references period (entity, year, nr),
  foreign key (entity, reverses_year, reverses_nr) references voucher (entity, year, nr),
  unique (entity, reverses_year, reverses_nr),
  constraint voucher_idem unique (entity, idempotency_key),
  check ((reverses_year is null) = (reverses_nr is null))
);

create table posting (
  entity      text not null,
  year        smallint not null,
  nr          integer not null,
  line        smallint not null check (line > 0),
  account     text not null,
  -- signed NOK øre: positive = debit, negative = credit (ADR-0003)
  amount      bigint not null check (amount <> 0),
  -- original currency when foreign (BF § 4-2); ledger truth stays NOK
  ccy         text check (ccy ~ '^[A-Z]{3}$' and ccy <> 'NOK'),
  ccy_amount  bigint,
  ccy_rate    numeric(18, 8),
  vat_code    text references vat_code,
  vat_base    bigint,
  party       text,
  dim         jsonb not null default '{}',
  description text not null default '',
  primary key (entity, year, nr, line),
  foreign key (entity, year, nr) references voucher,
  foreign key (entity, account) references account (entity, code),
  foreign key (entity, party) references party (entity, id),
  check ((ccy is null) = (ccy_amount is null)),
  check ((ccy is null) = (ccy_rate is null))
);

create index posting_by_account on posting (entity, account, year);
create index posting_by_party on posting (entity, party) where party is not null;

-- ---------------------------------------------------------------------------
-- Invariant 1: append-only. REVOKE in 0008 is the wall; this catches everyone,
-- including the owner.
create function forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only; corrections are reversal vouchers (ADR-0001)',
    tg_table_name;
end
$$;

create trigger voucher_append_only before update or delete on voucher
for each statement execute function forbid_change();
create trigger posting_append_only before update or delete on posting
for each statement execute function forbid_change();

-- ---------------------------------------------------------------------------
-- Invariant 2: the voucher's period exists, is open, covers posting_date,
-- and the fiscal year matches the posting date.
create function check_voucher_period() returns trigger
language plpgsql as $$
begin
  if new.year <> extract(year from new.posting_date)::smallint then
    raise exception 'fiscal year % does not match posting_date %', new.year, new.posting_date;
  end if;
  perform 1 from period p
   where p.entity = new.entity and p.year = new.year and p.nr = new.period
     and p.status = 'open'
     and new.posting_date between p.date_from and p.date_to;
  if not found then
    raise exception 'period %/% is missing, closed, or does not cover % (BL § 9)',
      new.year, new.period, new.posting_date;
  end if;
  return new;
end
$$;

create trigger voucher_period before insert on voucher
for each row execute function check_voucher_period();

-- ---------------------------------------------------------------------------
-- Invariant 3 (line level): control accounts require a party with the matching
-- role; a vat code must have a rate valid on the posting date.
create function check_posting() returns trigger
language plpgsql as $$
declare
  ctl text;
  ok boolean;
  d date;
begin
  select control into ctl from account
   where entity = new.entity and code = new.account;
  if ctl is not null then
    if new.party is null then
      raise exception 'account % is a % control account; party is required (BF § 3-1)',
        new.account, ctl;
    end if;
    if ctl = 'customer' then
      select customer into ok from party where entity = new.entity and id = new.party;
    else
      select supplier into ok from party where entity = new.entity and id = new.party;
    end if;
    if not ok then
      raise exception 'party % does not have the % role', new.party, ctl;
    end if;
  end if;
  if new.vat_code is not null then
    select posting_date into d from voucher
     where entity = new.entity and year = new.year and nr = new.nr;
    perform 1 from vat_rate
     where code = new.vat_code and valid_from <= d;
    if not found then
      raise exception 'vat code % has no rate valid on %', new.vat_code, d;
    end if;
  end if;
  return new;
end
$$;

create trigger posting_checks before insert on posting
for each row execute function check_posting();

-- ---------------------------------------------------------------------------
-- Invariant 4: every voucher balances to zero and has at least two lines.
-- Deferred to commit so the whole voucher is visible.
create function check_voucher_balance() returns trigger
language plpgsql as $$
declare
  s bigint;
  c integer;
begin
  select coalesce(sum(amount), 0), count(*) into s, c
    from posting
   where entity = new.entity and year = new.year and nr = new.nr;
  if c < 2 then
    raise exception 'voucher %/% for % needs at least 2 lines', new.year, new.nr, new.entity;
  end if;
  if s <> 0 then
    raise exception 'voucher %/% for % does not balance: % øre', new.year, new.nr, new.entity, s;
  end if;
  return null;
end
$$;

create constraint trigger voucher_balanced
after insert on posting
deferrable initially deferred
for each row execute function check_voucher_balance();

-- ---------------------------------------------------------------------------
-- Invariant 5: a reversal negates its original exactly (multiset comparison,
-- both directions). Deferred so the reversal's postings exist.
create function check_reversal() returns trigger
language plpgsql as $$
declare
  diff integer;
begin
  if new.reverses_nr is null then
    return null;
  end if;
  select count(*) into diff from (
    (select account, -amount as amount, coalesce(vat_code, '') as vc,
            coalesce(-vat_base, 0) as vb, coalesce(party, '') as pt
       from posting
      where entity = new.entity and year = new.reverses_year and nr = new.reverses_nr
     except all
     select account, amount, coalesce(vat_code, ''), coalesce(vat_base, 0), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.year and nr = new.nr)
    union all
    (select account, amount, coalesce(vat_code, ''), coalesce(vat_base, 0), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.year and nr = new.nr
     except all
     select account, -amount, coalesce(vat_code, ''), coalesce(-vat_base, 0), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.reverses_year and nr = new.reverses_nr)
  ) d;
  if diff <> 0 then
    raise exception 'voucher %/% does not exactly negate %/% (BF § 5-12)',
      new.year, new.nr, new.reverses_year, new.reverses_nr;
  end if;
  return null;
end
$$;

create constraint trigger voucher_reversal_exact
after insert on voucher
deferrable initially deferred
for each row execute function check_reversal();

-- ---------------------------------------------------------------------------
-- Composability: consumers LISTEN hovedbok for new facts (ADR-0009).
create function notify_voucher() returns trigger
language plpgsql as $$
begin
  perform pg_notify('hovedbok', jsonb_build_object(
    'table', 'voucher', 'entity', new.entity, 'year', new.year, 'nr', new.nr)::text);
  return null;
end
$$;

create trigger voucher_notify after insert on voucher
for each row execute function notify_voucher();
