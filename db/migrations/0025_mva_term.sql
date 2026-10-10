-- MVA term aggregation (#8): vat_summary rolled up to the entity's VAT term
-- (skattleggingsperiode), the shape the MVA-melding reads.
--
-- 1. vat_summary gains a trailing `rate` column and groups by it. The
--    melding's line is (mvaKode, sats), and a rate change inside a term (it
--    has happened mid-term: 2020-04-01, 2021-10-01) must give two lines, not
--    one line with the wrong sats. Everything else is 0017 verbatim; with one
--    rate per code per period the rows are the same as before.
--
-- 2. mva_term: per entity, year, term, code and rate.
--      vat_term     the entity's cadence (monthly | bimonthly | yearly), read
--                   now: the terms of a year follow the current setting
--      term         monthly: the month (1-12); bimonthly: 1-6 (januar-februar
--                   = 1); yearly: 1. Period 13 (31.12 closing) counts as
--                   December.
--      date_from, date_to   the term's calendar bounds
--      kind, deductible, report   from vat_code (report = false for 0, 7,
--                   20-22: bookkeeping-only codes the melding never carries)
--    Amounts are øre, signed the way the melding reads, not the ledger:
--      base         grunnlag. Sales-side kinds (output, zero, outside,
--                   no_turnover) negate the ledger's credit base, so sales are
--                   positive; purchase-side kinds keep the debit base. A credit
--                   note in excess of sales goes negative (motsatt fortegn).
--      output_vat   beregnet utgående avgift, positive = owed (-vat_summary.output_vat)
--      input_vat    fradrag, negative = deducted (-vat_summary.input_vat)
--      vat          output_vat + input_vat: the code's share of the amount to pay
--    The figures are derived from coded base lines only (ADR-0011): VAT
--    settlement (27xx -> 2740), payment and opening-balance vouchers carry no
--    coded line and never reach a term. Rounding to whole kroner is the
--    melding builder's job (src/mva.ts); the view keeps øre.
create or replace view vat_summary as
with coded as (
  select v.entity, v.year, v.period, p.vat_code, c.kind, c.deductible,
         p.vat_base, r.rate,
         round(p.vat_base * r.rate / 100)::bigint as vat
    from voucher v
    join posting p using (entity, year, nr)
    join vat_code c on c.code = p.vat_code
    left join lateral (
      select vr.rate from vat_rate vr
       where vr.code = p.vat_code and vr.valid_from <= v.posting_date
       order by vr.valid_from desc limit 1) r on true
   where p.vat_code is not null
), per_line as (
  select entity, year, period, vat_code, rate, vat_base,
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
       sum(input_vat) as input_vat,
       rate
  from per_line
 group by entity, year, period, vat_code, rate;

create view mva_term as
with termed as (
  select s.entity, s.year, e.vat_term, s.vat_code, s.rate,
         s.base, s.output_vat, s.input_vat,
         case e.vat_term
           when 'monthly'   then least(s.period, 12)
           when 'bimonthly' then (least(s.period, 12) + 1) / 2
           else 1
         end::smallint as term
    from vat_summary s
    join entity e on e.orgnr = s.entity
), bounds as (
  select t.*,
         case t.vat_term when 'monthly' then t.term when 'bimonthly' then 2 * t.term - 1 else 1 end as first_month,
         case t.vat_term when 'monthly' then t.term when 'bimonthly' then 2 * t.term else 12 end as last_month
    from termed t
)
select b.entity, b.year, b.vat_term, b.term,
       make_date(b.year, b.first_month, 1) as date_from,
       (make_date(b.year, b.last_month, 1) + interval '1 month' - interval '1 day')::date as date_to,
       b.vat_code, c.kind, c.deductible, c.report, b.rate,
       case when c.kind in ('output', 'zero', 'outside', 'no_turnover')
            then -sum(b.base) else sum(b.base) end::bigint as base,
       (-sum(b.output_vat))::bigint as output_vat,
       (-sum(b.input_vat))::bigint as input_vat,
       (-sum(b.output_vat) - sum(b.input_vat))::bigint as vat
  from bounds b
  join vat_code c on c.code = b.vat_code
 group by b.entity, b.year, b.vat_term, b.term, b.first_month, b.last_month,
          b.vat_code, c.kind, c.deductible, c.report, b.rate;

-- grants, 0008 style (the replaced view keeps its grants; repeated anyway)
grant select on vat_summary, mva_term to hovedbok_app, hovedbok_ro;
