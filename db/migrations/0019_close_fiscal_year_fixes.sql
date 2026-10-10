-- close_fiscal_year: review fixes (#5). Same contract and chain as 0015
-- (3000-8799 -> 8800 -> 8960/8990 -> equity, in period 13), with:
--   - zero-amount lines (8800 on exact break-even, equity when 89xx
--     dispositions cover the whole result) are left out instead of failing;
--   - a step whose idempotency key already exists raises: a pre-existing
--     close:<year>:* voucher would otherwise be taken as the step's own and
--     period 13 closed over books that were never balanced out;
--   - before closing period 13, every 3000-8999 account must sum to zero for
--     the year, asserted on the postings themselves;
--   - p_equity_account must be an equity account (2000-2099);
--   - the next fiscal year is opened before this year's rows are locked, so a
--     client transaction already holding next-year rows cannot deadlock here.
create or replace function close_fiscal_year(p_entity text, p_year integer, p_equity_account text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_open     text;
  v_result   bigint;
  v_transfer text;
  v_equity   text;
  v_lines    jsonb;
  v_nrs      integer[] := '{}';
  v_posted   jsonb;
  v_acct     text;
  v_date     date := make_date(p_year, 12, 31);
  v_bad      record;
begin
  if p_equity_account is not null and p_equity_account not between '2000' and '2099' then
    raise exception 'equity account % is not an equity account (2000-2099)', p_equity_account;
  end if;
  perform 1 from fiscal_year where entity = p_entity and year = p_year;
  if not found then
    raise exception 'fiscal year % does not exist for %', p_year, p_entity;
  end if;
  perform ensure_fiscal_year(p_entity, (p_year + 1)::smallint);

  perform 1 from fiscal_year where entity = p_entity and year = p_year for update;
  perform 1 from period where entity = p_entity and year = p_year for update;

  select string_agg(nr::text, ', ' order by nr) into v_open
    from period
   where entity = p_entity and year = p_year and nr between 1 and 12 and status = 'open';
  if v_open is not null then
    raise exception 'period(s) % of % for % are still open; close_period() each of 1-12 before closing the year',
      v_open, p_year, p_entity;
  end if;
  perform 1 from period
   where entity = p_entity and year = p_year and nr = 13 and status = 'open';
  if not found then
    raise exception 'period %/13 for % is not open: the year is already closed', p_year, p_entity;
  end if;
  foreach v_acct in array array['result', 'transfer', 'equity'] loop
    perform 1 from voucher
     where entity = p_entity and idempotency_key = format('close:%s:%s', p_year, v_acct);
    if found then
      raise exception 'voucher with idempotency key close:%:% already exists for %; the year-end close cannot post over it',
        p_year, v_acct, p_entity;
    end if;
  end loop;

  -- 1. result: 3000-8799 -> 8800
  select jsonb_agg(jsonb_build_object('account', account, 'amount', -balance,
                                      'description', 'Avslutning ' || account)
                   order by account),
         coalesce(sum(balance), 0)
    into v_lines, v_result
    from (select account, sum(amount) as balance
            from posting
           where entity = p_entity and year = p_year
             and account between '3000' and '8799'
           group by account
          having sum(amount) <> 0) b;
  v_equity := coalesce(p_equity_account, case when v_result > 0 then '2080' else '2050' end);
  v_transfer := case when v_result > 0 then '8990' else '8960' end;
  foreach v_acct in array array['8800', v_transfer, v_equity] loop
    perform 1 from account where entity = p_entity and code = v_acct;
    if not found then
      raise exception 'account % is not in the chart of entity %; the year-end close needs it (upsert_account adds it)',
        v_acct, p_entity using errcode = 'foreign_key_violation';
    end if;
  end loop;
  if v_lines is not null then
    if v_result <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account', '8800', 'amount', v_result, 'description', 'Årsresultat'));
    end if;
    v_nrs := v_nrs || close_fiscal_year_post(p_entity, v_date,
      format('Årsavslutning %s: resultat til 8800', p_year),
      format('close:%s:result', p_year), v_lines);
  end if;

  -- 2. transfer: whatever 8800 holds -> 8960/8990
  select coalesce(sum(amount), 0) into v_result
    from posting where entity = p_entity and year = p_year and account = '8800';
  if v_result <> 0 then
    v_nrs := v_nrs || close_fiscal_year_post(p_entity, v_date,
      format('Årsavslutning %s: årsresultat overført %s', p_year, v_transfer),
      format('close:%s:transfer', p_year),
      jsonb_build_array(
        jsonb_build_object('account', '8800', 'amount', -v_result, 'description', 'Årsresultat'),
        jsonb_build_object('account', v_transfer, 'amount', v_result,
                           'description', case when v_result > 0 then 'Udekket tap' else 'Overført annen egenkapital' end)));
  end if;

  -- 3. disposition: every 8800-8999 balance -> equity
  select jsonb_agg(jsonb_build_object('account', account, 'amount', -balance,
                                      'description', 'Disponering ' || account)
                   order by account),
         coalesce(sum(balance), 0)
    into v_lines, v_result
    from (select account, sum(amount) as balance
            from posting
           where entity = p_entity and year = p_year
             and account between '8800' and '8999'
           group by account
          having sum(amount) <> 0) b;
  if v_lines is not null then
    if v_result <> 0 then
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account', v_equity, 'amount', v_result, 'description', 'Årets resultat disponert'));
    end if;
    v_nrs := v_nrs || close_fiscal_year_post(p_entity, v_date,
      format('Årsavslutning %s: disponering til %s', p_year, v_equity),
      format('close:%s:equity', p_year), v_lines);
  end if;

  -- the books, not the arithmetic above, decide whether the year may close
  select account, sum(amount) as balance into v_bad
    from posting
   where entity = p_entity and year = p_year and account between '3000' and '8999'
   group by account having sum(amount) <> 0
   order by account limit 1;
  if found then
    raise exception 'account % still holds % øre for % after the closing vouchers; the year cannot close',
      v_bad.account, v_bad.balance, p_year;
  end if;

  perform close_period(p_entity, p_year::smallint, 13::smallint);

  select coalesce(sum(amount), 0) into v_result
    from posting p join voucher v using (entity, year, nr)
   where p.entity = p_entity and p.year = p_year
     and v.idempotency_key = format('close:%s:result', p_year)
     and p.account = '8800';
  return jsonb_build_object('entity', p_entity, 'year', p_year,
                            'result', v_result, 'equity_account', v_equity,
                            'vouchers', to_jsonb(v_nrs), 'period_13', 'closed');
end
$$;

-- One closing voucher through post_voucher; an idempotent answer means the
-- key existed, which the caller checked for — treat it as the error it is.
create function close_fiscal_year_post(p_entity text, p_date date, p_description text, p_key text, p_lines jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb;
begin
  r := post_voucher(jsonb_build_object(
    'entity', p_entity, 'posting_date', p_date, 'period', 13,
    'description', p_description, 'idempotency_key', p_key, 'lines', p_lines));
  if (r ->> 'idempotent')::boolean then
    raise exception 'voucher with idempotency key % already exists for %; the year-end close cannot post over it',
      p_key, p_entity;
  end if;
  return (r ->> 'nr')::integer;
end
$$;

-- grants, 0008 style; the helper is owner-only (called from the definer)
revoke all on function close_fiscal_year(text, integer, text) from public;
grant execute on function close_fiscal_year(text, integer, text) to hovedbok_app;
revoke all on function close_fiscal_year_post(text, date, text, text, jsonb) from public;
