-- journal (0007) exposes posting.vat_amount (0026, ADR-0012) so readers of the
-- flat journal — the SAF-T exporter among them — see the stated VAT without
-- joining posting. create or replace view may only append columns, so it sits
-- last; everything before it is 0007 verbatim.
create or replace view journal as
select v.entity, v.year, v.nr, p.line,
       v.posting_date, v.document_date, v.period,
       v.description as voucher_description, v.source, v.external_ref,
       p.account, a.name as account_name,
       p.amount, p.ccy, p.ccy_amount, p.ccy_rate,
       p.vat_code, p.vat_base, p.party, p.dim,
       p.description as line_description,
       v.reverses_year, v.reverses_nr, v.created_at, v.created_by,
       p.vat_amount
  from voucher v
  join posting p using (entity, year, nr)
  join account a on a.entity = v.entity and a.code = p.account;

-- grants, 0008 style (the replaced view keeps its grants; repeated anyway)
grant select on journal to hovedbok_app, hovedbok_ro;
