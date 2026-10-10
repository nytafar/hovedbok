-- VAT coding lives on the base line; MVA figures derive from it (ADR-0011).
-- Review of a8e0adf (#5): the 0013 rule "VAT-account lines must carry a code"
-- made VAT settlement (2700 -> 2740) unpostable. Replaced, not weakened: the
-- same hole (VAT booked with no coded base) is now guarded from the
-- derivation side. Also: the same-transaction fence on postings compares a
-- stored xid8 instead of reconstructing the epoch from xmin.

-- ---------------------------------------------------------------------------
-- 1. Fence, wraparound-proof: the voucher stores the top-level transaction id
-- that created it (pg_current_xact_id() is the top-level xid even inside a
-- subtransaction, and xid8 never wraps). A posting may only join a voucher
-- whose created_xid is the current transaction's.
alter table voucher add column created_xid xid8 not null default pg_current_xact_id();

create or replace function check_voucher_period() returns trigger
language plpgsql as $$
begin
  new.created_xid := pg_current_xact_id();
  if new.year <> extract(year from new.posting_date)::smallint then
    raise exception 'fiscal year % does not match posting_date %', new.year, new.posting_date;
  end if;
  perform 1 from period p
   where p.entity = new.entity and p.year = new.year and p.nr = new.period
     and p.status = 'open'
     and new.posting_date between p.date_from and p.date_to
     for share;
  if not found then
    raise exception 'period %/% is missing, closed, or does not cover % (BL § 9)',
      new.year, new.period, new.posting_date;
  end if;
  if new.period = 13 and new.posting_date <> make_date(new.year, 12, 31) then
    raise exception 'period 13 (year-end closing) does not cover %: it only takes posting_date %',
      new.posting_date, make_date(new.year, 12, 31);
  end if;
  if new.period between 1 and 12 and new.period <> extract(month from new.posting_date) then
    raise exception 'period % does not cover %: periods 1-12 are the posting month',
      new.period, new.posting_date;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Line rules (ADR-0011). As 0013 for control accounts and rate validity;
-- the VAT rules become:
--   - a line on a VAT account (std_account.vat_side) carries no vat_code;
--   - a coded line carries vat_base (the grunnlag); vat_base needs a code;
--   - kind vs account where unambiguous: input/import_input and the purchase
--     regimes (import_base, reverse_charge) never on revenue (3xxx).
create or replace function check_posting() returns trigger
language plpgsql as $$
declare
  v      record;
  acc    record;
  ok     boolean;
  v_kind text;
  cls    text := left(new.account, 1);
begin
  select posting_date, created_xid into v from voucher
   where entity = new.entity and year = new.year and nr = new.nr;
  if not found then
    raise exception 'voucher %/% does not exist for %', new.year, new.nr, new.entity
      using errcode = 'foreign_key_violation';
  end if;
  if v.created_xid <> pg_current_xact_id() then
    raise exception 'voucher %/% for % was posted in an earlier transaction and takes no new lines; correct it with reverse_voucher() and a new post_voucher() (ADR-0001)',
      new.year, new.nr, new.entity;
  end if;

  select a.control, a.std_account, s.vat_side into acc
    from account a
    left join std_account s on s.code = a.std_account
   where a.entity = new.entity and a.code = new.account;
  if not found then
    raise exception 'account % is not in the chart of entity % (upsert_account adds it)',
      new.account, new.entity using errcode = 'foreign_key_violation';
  end if;

  if acc.control is not null then
    if new.party is null then
      raise exception 'account % is a % control account; party is required (BF § 3-1)',
        new.account, acc.control;
    end if;
    if acc.control = 'customer' then
      select customer into ok from party where entity = new.entity and id = new.party;
    else
      select supplier into ok from party where entity = new.entity and id = new.party;
    end if;
    if not ok then
      raise exception 'party % does not have the % role', new.party, acc.control;
    end if;
  end if;

  if new.vat_code is not null then
    perform 1 from vat_rate
     where code = new.vat_code and valid_from <= v.posting_date;
    if not found then
      raise exception 'vat code % has no rate valid on %', new.vat_code, v.posting_date;
    end if;
    if acc.vat_side is not null then
      raise exception 'account % is an %-VAT account; VAT-account lines carry no vat_code — code the base line and let the VAT derive from it (ADR-0011)',
        new.account, acc.vat_side;
    end if;
    if new.vat_base is null then
      raise exception 'vat code % on account % needs vat_base (the grunnlag the VAT derives from, ADR-0011)',
        new.vat_code, new.account;
    end if;
    select kind into v_kind from vat_code where code = new.vat_code;
    if v_kind in ('input', 'import_input') and cls = '3' then
      raise exception 'vat code % is input VAT; it cannot go on revenue account %',
        new.vat_code, new.account;
    end if;
    if v_kind in ('import_base', 'reverse_charge') and cls = '3' then
      raise exception 'vat code % is a purchase regime (kind %); it cannot go on revenue account %',
        new.vat_code, v_kind, new.account;
    end if;
  elsif new.vat_base is not null then
    raise exception 'vat_base on account % needs a vat_code', new.account;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Voucher rule (deferred, ADR-0011): a voucher that touches a VAT account
-- must have every P&L line (3xxx-8xxx) coded — code 0 for a line that is
-- genuinely outside VAT — so VAT can never be booked against an uncoded base.
-- Clearing and payment vouchers (2700 -> 2740, 2740 -> 1920) have no P&L lines
-- and pass. Runs once per inserted posting at commit; the check is per voucher.
create function check_voucher_vat() returns trigger
language plpgsql as $$
declare
  vat_acct text;
  bad      record;
begin
  select p.account into vat_acct
    from posting p
    join account a on a.entity = p.entity and a.code = p.account
    join std_account s on s.code = a.std_account
   where p.entity = new.entity and p.year = new.year and p.nr = new.nr
     and s.vat_side is not null
   limit 1;
  if vat_acct is null then
    return null;
  end if;
  select line, account into bad
    from posting
   where entity = new.entity and year = new.year and nr = new.nr
     and account between '3000' and '8999' and vat_code is null
   order by line limit 1;
  if found then
    raise exception 'voucher %/% for % books VAT on % but line % (account %) carries no vat_code; code every P&L line of a VAT voucher (code 0 if not taxable) (ADR-0011)',
      new.year, new.nr, new.entity, vat_acct, bad.line, bad.account;
  end if;
  return null;
end
$$;

create constraint trigger voucher_vat_coded
after insert on posting
deferrable initially deferred
for each row execute function check_voucher_vat();

-- ---------------------------------------------------------------------------
-- 4. vat_summary, derived (same name and columns as 0012):
--   base        sum of vat_base on the code's lines (grunnlag)
--   output_vat  derived output VAT, signed like the ledger (credit = negative)
--   input_vat   derived input VAT (debit = positive)
--   vat         output_vat + input_vat
-- Per line: vat = round(vat_base * rate / 100), half up on the absolute value
-- (Postgres round(numeric) is half away from zero), rate valid on the posting
-- date. Regime by kind: output -> output_vat = vat; input, import_input ->
-- input_vat = vat; import_base, reverse_charge -> output_vat = -vat and, when
-- deductible, input_vat = vat (both effects from the one coded line); other
-- kinds report base only.
create or replace view vat_summary as
with coded as (
  select v.entity, v.year, v.period, p.vat_code, c.kind, c.deductible,
         p.vat_base,
         round(p.vat_base * (select r.rate from vat_rate r
                              where r.code = p.vat_code and r.valid_from <= v.posting_date
                              order by r.valid_from desc limit 1) / 100)::bigint as vat
    from voucher v
    join posting p using (entity, year, nr)
    join vat_code c on c.code = p.vat_code
   where p.vat_code is not null
), per_line as (
  select entity, year, period, vat_code, vat_base,
         case when kind = 'output' then vat
              when kind in ('import_base', 'reverse_charge') then -vat
              else 0 end as output_vat,
         case when kind in ('input', 'import_input') then vat
              when kind in ('import_base', 'reverse_charge') and deductible then vat
              else 0 end as input_vat
    from coded
)
select entity, year, period, vat_code,
       sum(vat_base) as base,
       sum(output_vat) + sum(input_vat) as vat,
       sum(output_vat) as output_vat,
       sum(input_vat) as input_vat
  from per_line
 group by entity, year, period, vat_code;

-- Control: derived VAT vs what was booked on the VAT accounts, per period.
-- A difference is a signal (rounding, settlement vouchers moving 27xx to
-- 2740, hand corrections), not a blocker.
create view vat_control as
with derived as (
  select entity, year, period, sum(output_vat) as output_vat, sum(input_vat) as input_vat
    from vat_summary
   group by entity, year, period
), booked as (
  select v.entity, v.year, v.period,
         coalesce(sum(p.amount) filter (where s.vat_side = 'output'), 0) as output_vat,
         coalesce(sum(p.amount) filter (where s.vat_side = 'input'), 0) as input_vat
    from voucher v
    join posting p using (entity, year, nr)
    join account a on a.entity = p.entity and a.code = p.account
    join std_account s on s.code = a.std_account
   where s.vat_side is not null
   group by v.entity, v.year, v.period
)
select entity, year, period,
       coalesce(d.output_vat, 0) as derived_output_vat,
       coalesce(b.output_vat, 0) as booked_output_vat,
       coalesce(b.output_vat, 0) - coalesce(d.output_vat, 0) as output_difference,
       coalesce(d.input_vat, 0) as derived_input_vat,
       coalesce(b.input_vat, 0) as booked_input_vat,
       coalesce(b.input_vat, 0) - coalesce(d.input_vat, 0) as input_difference
  from derived d
  full join booked b using (entity, year, period);

-- grants, 0008 style (the replaced view keeps its grants; repeated anyway)
grant select on vat_summary, vat_control to hovedbok_app, hovedbok_ro;
