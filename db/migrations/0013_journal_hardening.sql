-- Journal hardening (#5, findings from the #2 invariant suite and the #3 seed
-- review). Everything here is additive or stricter; nothing in 0003-0012 is
-- weakened. Trigger functions are replaced in place, so their triggers stay
-- bound; no new callable function appears, so there are no new grants.

-- ---------------------------------------------------------------------------
-- 1. TRUNCATE was the one mutation path the append-only triggers left the
-- table owner. Same backstop function, same message.
create trigger voucher_no_truncate before truncate on voucher
for each statement execute function forbid_change();
create trigger posting_no_truncate before truncate on posting
for each statement execute function forbid_change();
create trigger document_no_truncate before truncate on document
for each statement execute function forbid_change();
create trigger voucher_document_no_truncate before truncate on voucher_document
for each statement execute function forbid_change();
create trigger bank_transaction_no_truncate before truncate on bank_transaction
for each statement execute function forbid_change();
create trigger bank_balance_no_truncate before truncate on bank_balance
for each statement execute function forbid_change();

-- ---------------------------------------------------------------------------
-- 2. The audit trail names the caller, not the SECURITY DEFINER owner.
-- Inside post_voucher()/close_period() current_user is always the function
-- owner; session_user is the login role the connection authenticated as.
-- An adapter that knows a finer-grained principal passes created_by in the
-- payload (post_voucher keeps that precedence); otherwise session_user.
alter table voucher alter column created_by set default session_user;

-- ---------------------------------------------------------------------------
-- 3. Voucher period: as 0003, plus
--   - the period row is locked FOR SHARE, so close_period() waits for
--     in-flight postings and a posting that waited on an in-flight close
--     re-reads the row and sees it closed (no voucher lands in a period that
--     closed underneath it);
--   - period 13 is the year-end closing period and takes 31.12 only, and
--     periods 1-12 must be the posting month. Both already follow from the
--     period dates ensure_fiscal_year() writes; stating them here makes the
--     rule independent of that data.
create or replace function check_voucher_period() returns trigger
language plpgsql as $$
begin
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
-- 4. Posting lines. As 0003 (control accounts, rate validity), plus:
--
-- a) A posting may only join a voucher born in the same transaction. The
--    balance check (invariant 4) runs at commit per transaction, so a balanced
--    pair appended to a committed voucher in a later transaction used to pass
--    (owner-only, since hovedbok_app cannot insert). The voucher row's xmin is
--    the transaction that inserted it; pg_xact_status() reports 'in progress'
--    exactly when that is the current transaction or one of its
--    subtransactions (post_voucher inserts the header inside one). xmin is a
--    32-bit xid; pg_xact_status takes the 64-bit form, so the epoch is
--    reconstructed from the current xid8: an xmin more than 2^31 ahead of our
--    low 32 bits is from the previous epoch.
--
-- b) VAT. vat_summary (0012) sums VAT from VAT accounts (std_account.vat_side)
--    and only over coded lines, so an uncoded line on a VAT account silently
--    dropped VAT from the return. Now:
--      - a line on a VAT account must carry a vat_code;
--      - vat_base belongs on the base line (revenue/cost/asset), never on the
--        VAT-account line, so a base can never be counted twice;
--      - vat_base needs a vat_code;
--      - code kind vs account, where unambiguous: input VAT (1, 11-15) never on
--        revenue (3xxx) or an output-VAT account; output VAT (3, 31-33) never on
--        an input-VAT account; base-only codes (0, 5-7, 20-22, 51, 52) never
--        on a VAT account; import/reverse-charge codes (81-92) never on
--        revenue. Output codes on cost accounts stay allowed (loss on
--        receivables corrects output VAT from 78xx).
create or replace function check_posting() returns trigger
language plpgsql as $$
declare
  v      record;
  acc    record;
  ok     boolean;
  v_kind text;
  cls    text := left(new.account, 1);
  cur    numeric;
  lo     numeric;
  x      numeric;
  fx     numeric;
begin
  -- a) the voucher exists and was created in this transaction
  select posting_date, xmin as created_xid into v from voucher
   where entity = new.entity and year = new.year and nr = new.nr;
  if not found then
    raise exception 'voucher %/% does not exist for %', new.year, new.nr, new.entity
      using errcode = 'foreign_key_violation';
  end if;
  cur := pg_current_xact_id()::text::numeric;
  lo  := cur % 4294967296;
  x   := v.created_xid::text::numeric;
  fx  := cur - lo + x;
  if x > lo + 2147483648 then
    fx := fx - 4294967296;
  end if;
  if pg_xact_status(fx::text::xid8) is distinct from 'in progress' then
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

  -- control accounts (0003)
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

  -- b) VAT
  if new.vat_code is not null then
    perform 1 from vat_rate
     where code = new.vat_code and valid_from <= v.posting_date;
    if not found then
      raise exception 'vat code % has no rate valid on %', new.vat_code, v.posting_date;
    end if;
    select kind into v_kind from vat_code where code = new.vat_code;
    if v_kind in ('input', 'import_input') and cls = '3' then
      raise exception 'vat code % is input VAT; it cannot go on revenue account %',
        new.vat_code, new.account;
    end if;
    if v_kind in ('input', 'import_input') and acc.vat_side = 'output' then
      raise exception 'vat code % is input VAT; account % is an output-VAT account',
        new.vat_code, new.account;
    end if;
    if v_kind = 'output' and acc.vat_side = 'input' then
      raise exception 'vat code % is output VAT; account % is an input-VAT account',
        new.vat_code, new.account;
    end if;
    if v_kind in ('none', 'zero', 'outside', 'no_turnover') and acc.vat_side is not null then
      raise exception 'vat code % carries no VAT amount (kind %); it belongs on the base line, not on VAT account %',
        new.vat_code, v_kind, new.account;
    end if;
    if v_kind in ('import_base', 'reverse_charge') and cls = '3' then
      raise exception 'vat code % is a purchase regime (kind %); it cannot go on revenue account %',
        new.vat_code, v_kind, new.account;
    end if;
  elsif acc.vat_side is not null then
    raise exception 'account % is an %-VAT account (standard account %); its line must carry a vat_code, or vat_summary will not see the VAT',
      new.account, acc.vat_side, acc.std_account;
  end if;
  if new.vat_base is not null then
    if new.vat_code is null then
      raise exception 'vat_base on account % needs a vat_code', new.account;
    end if;
    if acc.vat_side is not null then
      raise exception 'vat_base belongs on the base line (revenue, cost or asset), not on VAT account %',
        new.account;
    end if;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. close_period: closed_by records the caller (see 2). Same signature, so
-- the 0008 grants carry over; repeated below per the 0008 pattern anyway.
create or replace function close_period(p_entity text, p_year smallint, p_period smallint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update period
     set status = 'closed', closed_at = now(), closed_by = session_user
   where entity = p_entity and year = p_year and nr = p_period and status = 'open';
  if not found then
    raise exception 'period %/% for % is not open', p_year, p_period, p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'year', p_year,
                            'period', p_period, 'status', 'closed');
end
$$;

revoke all on function close_period(text, smallint, smallint) from public;
grant execute on function close_period(text, smallint, smallint) to hovedbok_app;
