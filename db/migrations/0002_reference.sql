-- Reference data: entities, years/periods, VAT policy, accounts, parties.
-- Policy is data (rates carry validity dates); facts live in 0003/0005.

create table entity (
  orgnr          text primary key check (orgnr ~ '^\d{9}$'),
  name           text not null,
  vat_registered boolean not null default false,
  -- MVA reporting cadence (skattleggingsperiode); bookkeeping periods are always months
  vat_term       text not null default 'bimonthly'
                 check (vat_term in ('monthly', 'bimonthly', 'yearly')),
  created_at     timestamptz not null default now()
);

create table fiscal_year (
  entity          text not null references entity (orgnr),
  year            smallint not null,
  -- the one mutable operational counter: gapless voucher numbering (ADR-0006),
  -- bumped under row lock inside post_voucher()
  last_voucher_nr integer not null default 0,
  primary key (entity, year)
);

-- Bookkeeping periods are months 1-12 plus 13 (year-end closing, 31.12-31.12).
-- MVA terms are derived (bimonthly = ceil(month/2)). Locked periods refuse postings.
create table period (
  entity    text not null,
  year      smallint not null,
  nr        smallint not null check (nr between 1 and 13),
  date_from date not null,
  date_to   date not null,
  status    text not null default 'open' check (status in ('open', 'closed')),
  closed_at timestamptz,
  closed_by text,
  primary key (entity, year, nr),
  foreign key (entity, year) references fiscal_year,
  check (date_from <= date_to)
);

-- BF § 7-6: a closed period must stay closed.
create function period_no_reopen() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' and new.status = 'open' then
    raise exception 'period %/% for % is closed and cannot reopen (BF § 7-6)',
      old.year, old.nr, old.entity;
  end if;
  return new;
end
$$;

create trigger period_no_reopen before update on period
for each row execute function period_no_reopen();

-- SAF-T standard tax codes; semantics ("kind") drive MVA-melding aggregation.
-- Reverse-charge codes produce both output and (when deductible) input VAT.
create table vat_code (
  code           text primary key,
  description    text not null,
  description_nb text not null,
  kind           text not null check (kind in
    ('none', 'input', 'output', 'zero', 'outside', 'no_turnover',
     'import_base', 'import_input', 'reverse_charge')),
  deductible     boolean not null default true,
  report         boolean not null default true
);

-- Rates change by year; every code used on a posting needs a rate valid on the
-- posting date (rateless codes are seeded with rate 0 from 1970-01-01).
create table vat_rate (
  code       text not null references vat_code,
  valid_from date not null,
  rate       numeric(6, 3) not null check (rate >= 0),
  primary key (code, valid_from)
);

create table account (
  entity      text not null references entity (orgnr),
  code        text not null check (code ~ '^\d{4}$'),
  name        text not null,
  -- SAF-T mapping: standard account (2/4 digits) or grouping category, one required
  std_account text,
  grouping    text,
  default_vat text references vat_code,
  -- control accounts (1500/2400) tie postings to the customer/supplier subledgers
  control     text check (control in ('customer', 'supplier')),
  opened      date,
  closed      date,
  primary key (entity, code),
  check (std_account is not null or grouping is not null)
);

create table party (
  entity          text not null references entity (orgnr),
  id              text not null,
  name            text not null,
  orgnr           text check (orgnr ~ '^\d{9}$'),
  country         text not null default 'NO',
  address         jsonb not null default '{}',
  customer        boolean not null default false,
  supplier        boolean not null default false,
  -- BF § 3-1: withdrawals/sales to owners and senior employees must be specifiable
  owner           boolean not null default false,
  senior_employee boolean not null default false,
  peppol_id       text,
  created_at      timestamptz not null default now(),
  primary key (entity, id)
);
