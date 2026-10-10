-- Year-end close (#5): ordinary vouchers in period 13, never hidden balance
-- updates (research-norsk-compliance.md: year-end). Opening balances are
-- derived from posted history: after the close every P&L account (3xxx-8xxx)
-- sums to zero over all time, so balance accounts carry and P&L accounts open
-- at zero in the balance views without any snapshot.

-- Balance per account and fiscal year, derived: opening is the sum of every
-- posting in earlier years, movement the year's own, closing their sum. One
-- row per (entity, fiscal year, account) for every account that was ever
-- posted, so an account quiet in a year still shows what it carries.
create view account_year_balance as
with movement as (
  select entity, year, account, sum(amount) as movement
    from posting
   group by entity, year, account
), scope as (
  select fy.entity, fy.year, a.account
    from fiscal_year fy
    join (select distinct entity, account from posting) a using (entity)
)
select s.entity, s.year, s.account,
       coalesce(sum(m.movement) over (partition by s.entity, s.account order by s.year
                                      rows between unbounded preceding and 1 preceding), 0) as opening,
       coalesce(m.movement, 0) as movement,
       coalesce(sum(m.movement) over (partition by s.entity, s.account order by s.year), 0) as closing
  from scope s
  left join movement m using (entity, year, account);

-- close_fiscal_year(entity, year [, equity_account])
--
-- Requires periods 1-12 closed and 13 open. Posts, through post_voucher() in
-- period 13 on 31.12:
--   1. result:      every 3000-8799 account with a balance -> 8800 Årsresultat
--   2. transfer:    8800 -> 8960 Overføringer annen egenkapital (profit)
--                        or 8990 Udekket tap (loss)
--   3. disposition: every 8800-8999 balance -> equity (default 2050 Annen
--                   egenkapital on profit, 2080 Udekket tap on loss; pass
--                   p_equity_account to choose, e.g. 2050 for a loss an ENK
--                   books against its equity)
-- then closes period 13 and opens the next fiscal year. Dispositions already
-- booked in 89xx (8920 dividends ...) ride along in step 3. Vouchers with
-- nothing to move are skipped. All in one transaction; the fiscal_year row and
-- the period rows are locked first, so no posting slips in between the
-- balances being read and the period closing.
--
-- returns {"entity", "year", "result": <signed øre, credit = profit>,
--          "equity_account", "vouchers": [nr, ...], "period_13": "closed"}
-- p_year is integer so `close_fiscal_year('999888777', 2026)` resolves from
-- psql (an integer literal does not implicitly narrow to smallint); smallint
-- callers upcast implicitly.
create function close_fiscal_year(p_entity text, p_year integer, p_equity_account text default null)
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
begin
  perform 1 from fiscal_year where entity = p_entity and year = p_year for update;
  if not found then
    raise exception 'fiscal year % does not exist for %', p_year, p_entity;
  end if;
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

  -- 1. result
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
    v_posted := post_voucher(jsonb_build_object(
      'entity', p_entity, 'posting_date', v_date, 'period', 13,
      'description', format('Årsavslutning %s: resultat til 8800', p_year),
      'idempotency_key', format('close:%s:result', p_year),
      'lines', v_lines || jsonb_build_array(jsonb_build_object(
        'account', '8800', 'amount', v_result, 'description', 'Årsresultat'))));
    v_nrs := v_nrs || (v_posted ->> 'nr')::integer;
  end if;

  -- 2. transfer: whatever 8800 holds (the result, plus anything booked there by hand)
  select coalesce(sum(amount), 0) into v_result
    from posting where entity = p_entity and year = p_year and account = '8800';
  if v_result <> 0 then
    v_posted := post_voucher(jsonb_build_object(
      'entity', p_entity, 'posting_date', v_date, 'period', 13,
      'description', format('Årsavslutning %s: årsresultat overført %s', p_year, v_transfer),
      'idempotency_key', format('close:%s:transfer', p_year),
      'lines', jsonb_build_array(
        jsonb_build_object('account', '8800', 'amount', -v_result, 'description', 'Årsresultat'),
        jsonb_build_object('account', v_transfer, 'amount', v_result,
                           'description', case when v_result > 0 then 'Udekket tap' else 'Overført annen egenkapital' end))));
    v_nrs := v_nrs || (v_posted ->> 'nr')::integer;
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
    v_posted := post_voucher(jsonb_build_object(
      'entity', p_entity, 'posting_date', v_date, 'period', 13,
      'description', format('Årsavslutning %s: disponering til %s', p_year, v_equity),
      'idempotency_key', format('close:%s:equity', p_year),
      'lines', v_lines || jsonb_build_array(jsonb_build_object(
        'account', v_equity, 'amount', v_result, 'description', 'Årets resultat disponert'))));
    v_nrs := v_nrs || (v_posted ->> 'nr')::integer;
  end if;

  perform close_period(p_entity, p_year, 13::smallint);
  perform ensure_fiscal_year(p_entity, (p_year + 1)::smallint);

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

-- close_period with integer literals, for the same reason; delegates to 0013's.
create function close_period(p_entity text, p_year integer, p_period integer)
returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select close_period(p_entity, p_year::smallint, p_period::smallint)
$$;

-- grants, 0008 style
grant select on account_year_balance to hovedbok_app, hovedbok_ro;
revoke all on function close_fiscal_year(text, integer, text) from public;
revoke all on function close_period(text, integer, integer) from public;
grant execute on function close_fiscal_year(text, integer, text) to hovedbok_app;
grant execute on function close_period(text, integer, integer) to hovedbok_app;
