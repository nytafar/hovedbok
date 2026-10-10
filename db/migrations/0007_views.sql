-- Meaning is derived: core views. Reports (saldobalanse with opening balances,
-- kontospesifikasjon, bokføringsspesifikasjon, kunde-/leverandørspesifikasjon,
-- resultat/balanse) build on these; all disposable and rebuildable.

-- The flat journal: the first thing an agent should query.
create view journal as
select v.entity, v.year, v.nr, p.line,
       v.posting_date, v.document_date, v.period,
       v.description as voucher_description, v.source, v.external_ref,
       p.account, a.name as account_name,
       p.amount, p.ccy, p.ccy_amount, p.ccy_rate,
       p.vat_code, p.vat_base, p.party, p.dim,
       p.description as line_description,
       v.reverses_year, v.reverses_nr, v.created_at, v.created_by
  from voucher v
  join posting p using (entity, year, nr)
  join account a on a.entity = v.entity and a.code = p.account;

-- Net movement per account and period.
create view account_activity as
select v.entity, v.year, v.period, p.account,
       sum(p.amount) filter (where p.amount > 0) as debit,
       -sum(p.amount) filter (where p.amount < 0) as credit,
       sum(p.amount) as net
  from voucher v
  join posting p using (entity, year, nr)
 group by v.entity, v.year, v.period, p.account;

-- Current balance per account (all time; opening balances are vouchers too).
create view account_balance as
select entity, account, sum(amount) as balance
  from posting
 group by entity, account;

-- MVA aggregation per code, year and period; terms derive from periods.
create view vat_summary as
select v.entity, v.year, v.period, p.vat_code,
       sum(p.vat_base) as base, sum(p.amount) as vat
  from voucher v
  join posting p using (entity, year, nr)
 where p.vat_code is not null
 group by v.entity, v.year, v.period, p.vat_code;

-- The agent work queue: booked bank facts not yet explained by the ledger.
create view unmatched_bank as
select b.entity, t.*
  from bank_transaction t
  join bank_account b on b.id_hash = t.id_hash
 where not exists (select 1 from match m
                    where m.id_hash = t.id_hash and m.dedup_key = t.dedup_key);

-- Vouchers with no documentation attached (BL § 10 watchlist).
create view voucher_without_document as
select v.*
  from voucher v
 where not exists (select 1 from voucher_document d
                    where d.entity = v.entity and d.year = v.year and d.nr = v.nr);

-- Reconciliation assertion: ledger balance on each bank-linked account vs the
-- most recent closing booked balance snapshot.
create view bank_reconciliation as
select ba.entity, ba.id_hash, ba.ledger_account,
       coalesce(ab.balance, 0) as ledger_balance,
       bb.amount as bank_balance,
       bb.balance_type, bb.reference_date, bb.fetched_at,
       coalesce(ab.balance, 0) - bb.amount as difference
  from bank_account ba
  left join account_balance ab
         on ab.entity = ba.entity and ab.account = ba.ledger_account
  left join lateral (
        select amount, balance_type, reference_date, fetched_at
          from bank_balance
         where id_hash = ba.id_hash and balance_type in ('CLBD', 'XPCD', 'ITAV')
         order by (balance_type = 'CLBD') desc, fetched_at desc
         limit 1
       ) bb on true;
