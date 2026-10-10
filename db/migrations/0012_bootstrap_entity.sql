-- bootstrap_entity: one command from nothing to a bookable entity. Creates the
-- entity, copies the standard chart (0011) into its accounts with SAF-T grouping,
-- control flags and VAT defaults, and opens the fiscal year (months 1-12 + 13;
-- MVA terms derive from the months by entity.vat_term).
--
-- Idempotent and non-destructive: an existing entity keeps its name and
-- settings, existing accounts keep every change the entity made; a re-run only
-- adds what is missing (new standard accounts, the requested year).
--
-- payload: {
--   "orgnr": "999888777", "name": "Demo AS",
--   "vat_registered": true,        -- optional, default false
--   "vat_term": "bimonthly",       -- optional: monthly | bimonthly | yearly
--   "year": 2026                   -- optional, default the current year
-- }
-- returns: {"entity": ..., "created": true, "accounts_added": 745, "year": 2026}
create function bootstrap_entity(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_orgnr   text := p ->> 'orgnr';
  v_name    text := p ->> 'name';
  v_year    smallint := coalesce((p ->> 'year')::smallint,
                                 extract(year from current_date)::smallint);
  v_created boolean;
  v_added   integer;
begin
  if v_orgnr is null or v_name is null then
    raise exception 'orgnr and name are required';
  end if;

  -- defaults mirror the entity table's (0002)
  insert into entity (orgnr, name, vat_registered, vat_term)
  values (v_orgnr, v_name,
          coalesce((p ->> 'vat_registered')::boolean, false),
          coalesce(p ->> 'vat_term', 'bimonthly'))
  on conflict (orgnr) do nothing;
  v_created := found;

  insert into account (entity, code, name, std_account, grouping, default_vat, control)
  select v_orgnr, s.code, s.name, s.code, s.grouping_code, s.default_vat, s.control
    from std_account s
  on conflict (entity, code) do nothing;
  get diagnostics v_added = row_count;

  perform ensure_fiscal_year(v_orgnr, v_year);

  return jsonb_build_object('entity', v_orgnr, 'created', v_created,
                            'accounts_added', v_added, 'year', v_year);
end
$$;

-- vat_summary (0007) summed every coded line's amount as "vat", so the README
-- voucher (code 3 on both the revenue line and the 2700 line) reported the
-- revenue as VAT. VAT amounts are now only the postings on VAT accounts,
-- identified through account.std_account -> std_account.vat_side (0011), and
-- split per side so both-effect codes (import 81-85, reverse charge 86-92)
-- show their output and input VAT instead of netting to zero.
--   base        sum of vat_base on the code's lines
--   vat         signed sum on VAT accounts (output + input)
--   output_vat  signed sum on output-VAT accounts (credit = negative)
--   input_vat   signed sum on input-VAT accounts (debit = positive)
create or replace view vat_summary as
select v.entity, v.year, v.period, p.vat_code,
       sum(p.vat_base) as base,
       coalesce(sum(p.amount) filter (where s.vat_side is not null), 0) as vat,
       coalesce(sum(p.amount) filter (where s.vat_side = 'output'), 0) as output_vat,
       coalesce(sum(p.amount) filter (where s.vat_side = 'input'), 0) as input_vat
  from voucher v
  join posting p using (entity, year, nr)
  join account a on a.entity = p.entity and a.code = p.account
  left join std_account s on s.code = a.std_account
 where p.vat_code is not null
 group by v.entity, v.year, v.period, p.vat_code;

-- grants, 0008 style: no default privileges, so repeat them here
grant select on vat_summary to hovedbok_app, hovedbok_ro;
revoke all on function bootstrap_entity(jsonb) from public;
grant execute on function bootstrap_entity(jsonb) to hovedbok_app;
