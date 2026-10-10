-- The statutory specifications (#7; BL § 5, BF § 3-1, research-norsk-compliance
-- §4). Named after the statutory artifacts they are (ADR-0005: these ARE the
-- report headings), ASCII identifiers. All derive from voucher/posting (plus
-- the reference data that names things); all disposable. Views only: reads
-- are views (ADR-0009) and hovedbok_ro executes no function.
--
-- Amounts are signed øre (+debit/-credit) except the debit and credit columns,
-- which present each side as a non-negative number. Sums are cast back to
-- bigint so readers get integers, not numerics.
--
-- Period ranges. A view takes no parameters, so the range is part of the key:
-- the specifications over a range (saldobalanse, kunde-/leverandorspesifikasjon,
-- resultat) have a row per (period_from, period_to) pair within a fiscal year
-- (1 <= from <= to <= 13; 13 is the year-end closing period). One period is
-- period_from = period_to.
--   select * from saldobalanse
--    where entity = '987654321' and year = 2026 and period_from = 7 and period_to = 8;
-- opening = every posting in earlier years and in the year's periods before
-- period_from; closing = every posting up to and including period_to. Opening
-- balances come from posted history alone: once close_fiscal_year (0015) has
-- posted the year's closing vouchers in period 13, P&L accounts open the next
-- year at zero; before that they carry, as the ledger says.
-- The per-period layers underneath (account_period_balance,
-- control_account_balance) are dense: one row per period of every fiscal year
-- for everything ever posted, so a quiet period still shows what it carries.

-- Per account and period: opening, the period's debit and credit, closing,
-- and the year-to-date debit/credit through the period (for range folding).
create view account_period_balance as
with movement as (
  select p.entity, v.year, v.period, p.account,
         coalesce(sum(p.amount) filter (where p.amount > 0), 0)::bigint as debit,
         coalesce(-sum(p.amount) filter (where p.amount < 0), 0)::bigint as credit,
         sum(p.amount)::bigint as net
    from posting p
    join voucher v using (entity, year, nr)
   group by p.entity, v.year, v.period, p.account
), scope as (
  select pe.entity, pe.year, pe.nr as period, a.account
    from period pe
    join (select distinct entity, account from posting) a using (entity)
)
select s.entity, s.year, s.period, s.account,
       coalesce(sum(m.net) over (w rows between unbounded preceding and 1 preceding), 0)::bigint as opening,
       coalesce(m.debit, 0) as debit,
       coalesce(m.credit, 0) as credit,
       coalesce(sum(m.net) over (w rows between unbounded preceding and current row), 0)::bigint as closing,
       coalesce(sum(m.debit) over (y rows between unbounded preceding and current row), 0)::bigint as debit_ytd,
       coalesce(sum(m.credit) over (y rows between unbounded preceding and current row), 0)::bigint as credit_ytd
  from scope s
  left join movement m using (entity, year, period, account)
window w as (partition by s.entity, s.account order by s.year, s.period),
       y as (partition by s.entity, s.account, s.year order by s.period);

-- saldobalanse: per account over a period range. Accounts with nothing to
-- show (zero opening, no movement) are left out.
create view saldobalanse as
select f.entity, f.year, f.period as period_from, t.period as period_to,
       f.account, a.name as account_name,
       f.opening,
       t.debit_ytd - f.debit_ytd + f.debit as debit,
       t.credit_ytd - f.credit_ytd + f.credit as credit,
       t.closing
  from account_period_balance f
  join account_period_balance t
    on t.entity = f.entity and t.year = f.year and t.account = f.account and t.period >= f.period
  join account a on a.entity = f.entity and a.code = f.account
 where f.opening <> 0 or t.debit_ytd - f.debit_ytd + f.debit <> 0
                      or t.credit_ytd - f.credit_ytd + f.credit <> 0;

-- kontospesifikasjon: every posting line per account, in order of
-- (year, period, posting date, voucher, line), with the running balance around
-- it (all-time, so balance accounts carry across years) and the counter-info:
-- the voucher's other accounts. For a range, read the lines with period in the
-- range; its opening/closing are balance_before of the first line and
-- balance_after of the last, or, for every account at once (including accounts
-- with no lines in the range), opening/closing in saldobalanse.
create view kontospesifikasjon as
select p.entity, p.year, v.period, p.account, a.name as account_name,
       p.nr, p.line, v.posting_date, v.document_date,
       v.description as voucher_description, p.description as line_description,
       greatest(p.amount, 0) as debit, greatest(-p.amount, 0) as credit, p.amount,
       coalesce(sum(p.amount) over (w rows between unbounded preceding and 1 preceding), 0)::bigint as balance_before,
       sum(p.amount) over (w rows between unbounded preceding and current row)::bigint as balance_after,
       array(select distinct q.account from posting q
              where q.entity = p.entity and q.year = p.year and q.nr = p.nr
                and q.account <> p.account
              order by 1) as counter_accounts,
       p.vat_code, p.vat_base, p.party, pt.name as party_name,
       v.reverses_year, v.reverses_nr
  from posting p
  join voucher v using (entity, year, nr)
  join account a on a.entity = p.entity and a.code = p.account
  left join party pt on pt.entity = p.entity and pt.id = p.party
window w as (partition by p.entity, p.account
             order by p.year, v.period, v.posting_date, p.nr, p.line);

-- bokforingsspesifikasjon: the journal in voucher order, every line with its
-- voucher header (dates, description, origin, reversal link, who and when) and
-- its documentation (BL § 4 nr. 7 audit trail: document sha256s). Order by
-- (entity, year, nr, line); a view cannot promise it.
create view bokforingsspesifikasjon as
select v.entity, v.year, v.nr, p.line, v.period,
       v.document_date, v.posting_date,
       v.description as voucher_description, v.source, v.external_ref,
       array(select d.sha256 from voucher_document d
              where d.entity = v.entity and d.year = v.year and d.nr = v.nr
              order by d.sha256) as documents,
       p.account, a.name as account_name,
       greatest(p.amount, 0) as debit, greatest(-p.amount, 0) as credit, p.amount,
       p.ccy, p.ccy_amount, p.ccy_rate,
       p.vat_code, p.vat_base, p.party, pt.name as party_name, p.dim,
       p.description as line_description,
       v.reverses_year, v.reverses_nr, v.created_at, v.created_by
  from voucher v
  join posting p using (entity, year, nr)
  join account a on a.entity = p.entity and a.code = p.account
  left join party pt on pt.entity = p.entity and pt.id = p.party;

-- Party balances on the control accounts (account.control: 1500/2400 in the
-- standard chart) per period, dense like account_period_balance, one row per
-- (control account, party) ever posted. The subledger under kunde- and
-- leverandorspesifikasjon (and SAF-T's Customer/Supplier BalanceAccount).
create view control_account_balance as
with movement as (
  select p.entity, v.year, v.period, p.account, p.party,
         coalesce(sum(p.amount) filter (where p.amount > 0), 0)::bigint as debit,
         coalesce(-sum(p.amount) filter (where p.amount < 0), 0)::bigint as credit,
         sum(p.amount)::bigint as net
    from posting p
    join voucher v using (entity, year, nr)
    join account a on a.entity = p.entity and a.code = p.account
   where a.control is not null
   group by p.entity, v.year, v.period, p.account, p.party
), scope as (
  select pe.entity, pe.year, pe.nr as period, x.account, x.party
    from period pe
    join (select distinct entity, account, party from movement) x using (entity)
)
select s.entity, s.year, s.period, s.account, a.control, s.party,
       coalesce(sum(m.net) over (w rows between unbounded preceding and 1 preceding), 0)::bigint as opening,
       coalesce(m.debit, 0) as debit,
       coalesce(m.credit, 0) as credit,
       coalesce(sum(m.net) over (w rows between unbounded preceding and current row), 0)::bigint as closing,
       coalesce(sum(m.debit) over (y rows between unbounded preceding and current row), 0)::bigint as debit_ytd,
       coalesce(sum(m.credit) over (y rows between unbounded preceding and current row), 0)::bigint as credit_ytd
  from scope s
  left join movement m using (entity, year, period, account, party)
  join account a on a.entity = s.entity and a.code = s.account
window w as (partition by s.entity, s.account, s.party order by s.year, s.period),
       y as (partition by s.entity, s.account, s.party, s.year order by s.period);

-- kundespesifikasjon: per customer (code + name) on customer control accounts,
-- over a period range; parties with nothing to show are left out.
create view kundespesifikasjon as
select f.entity, f.year, f.period as period_from, t.period as period_to,
       f.party, pt.name, pt.orgnr, f.account,
       f.opening,
       t.debit_ytd - f.debit_ytd + f.debit as debit,
       t.credit_ytd - f.credit_ytd + f.credit as credit,
       t.closing
  from control_account_balance f
  join control_account_balance t
    on t.entity = f.entity and t.year = f.year and t.account = f.account
   and t.party = f.party and t.period >= f.period
  join party pt on pt.entity = f.entity and pt.id = f.party
 where f.control = 'customer'
   and (f.opening <> 0 or t.debit_ytd - f.debit_ytd + f.debit <> 0
                       or t.credit_ytd - f.credit_ytd + f.credit <> 0);

-- leverandorspesifikasjon: per supplier (code, name and orgnr, BF § 3-1) on
-- supplier control accounts, over a period range. orgnr is null for a foreign
-- supplier without a Norwegian one; country says where it is.
create view leverandorspesifikasjon as
select f.entity, f.year, f.period as period_from, t.period as period_to,
       f.party, pt.name, pt.orgnr, pt.country, f.account,
       f.opening,
       t.debit_ytd - f.debit_ytd + f.debit as debit,
       t.credit_ytd - f.credit_ytd + f.credit as credit,
       t.closing
  from control_account_balance f
  join control_account_balance t
    on t.entity = f.entity and t.year = f.year and t.account = f.account
   and t.party = f.party and t.period >= f.period
  join party pt on pt.entity = f.entity and pt.id = f.party
 where f.control = 'supplier'
   and (f.opening <> 0 or t.debit_ytd - f.debit_ytd + f.debit <> 0
                       or t.credit_ytd - f.credit_ytd + f.credit <> 0);

-- resultat + balanse, by account class (first digit, NS 4102) and SAF-T
-- grouping (account.grouping; its category from grouping_range, 0011). A
-- grouping that spans classes (7700 can hold 6550 and 7770) yields one row per
-- class; sum by grouping to drop the class. accounts lists who contributes.
--
-- resultat: movement over a period range on 3000-8799 (income through tax;
-- 8800 and the 89xx transfers are the result's disposition, not the result).
-- close_fiscal_year's result voucher (idempotency key close:<year>:result,
-- 0015) is left out, or a closed year would report a zero result; hand-booked
-- period-13 adjustments stay in. The range's result is -sum(amount) (profit
-- positive).
create view resultat as
with movement as (
  select p.entity, v.year, v.period, p.account, sum(p.amount)::bigint as amount
    from posting p
    join voucher v using (entity, year, nr)
   where p.account between '3000' and '8799'
     and v.idempotency_key <> format('close:%s:result', v.year)
   group by p.entity, v.year, v.period, p.account
)
select m.entity, m.year, f.nr as period_from, t.nr as period_to,
       left(m.account, 1) as class, g.category as grouping_category, a.grouping,
       sum(m.amount)::bigint as amount,
       array_agg(distinct m.account order by m.account) as accounts
  from period f
  join period t on t.entity = f.entity and t.year = f.year and t.nr >= f.nr
  join movement m on m.entity = f.entity and m.year = f.year and m.period between f.nr and t.nr
  join account a on a.entity = m.entity and a.code = m.account
  left join lateral (select min(r.category) as category
                       from grouping_range r where r.code = a.grouping) g on true
 group by m.entity, m.year, f.nr, t.nr, left(m.account, 1), g.category, a.grouping;

-- balanse: closing balances of the balance accounts (1xxx-2xxx) at the end of
-- each period (a point, not a range). Until the year is closed the year's
-- result still sits on the P&L accounts, so assets + liabilities + equity sum
-- to minus the unclosed result, not zero.
create view balanse as
select b.entity, b.year, b.period, left(b.account, 1) as class,
       g.category as grouping_category, a.grouping,
       sum(b.closing)::bigint as amount,
       array_agg(b.account order by b.account) as accounts
  from account_period_balance b
  join account a on a.entity = b.entity and a.code = b.account
  left join lateral (select min(r.category) as category
                       from grouping_range r where r.code = a.grouping) g on true
 where b.account < '3000'
 group by b.entity, b.year, b.period, left(b.account, 1), g.category, a.grouping;

-- grants, 0008 style: no default privileges, so repeat them here
grant select on account_period_balance, saldobalanse, kontospesifikasjon,
               bokforingsspesifikasjon, control_account_balance,
               kundespesifikasjon, leverandorspesifikasjon, resultat, balanse
   to hovedbok_app, hovedbok_ro;
