-- The wall (ADR-0002, ADR-0009). hovedbok_app: commands + fact ingestion.
-- hovedbok_ro: SELECT only — safe to hand any agent.
-- NOTE for future migrations: new tables/views/functions must repeat the
-- relevant grants here-style; there are no default privileges on purpose.

grant usage on schema public to hovedbok_app, hovedbok_ro;

-- reads: everything, both roles
grant select on all tables in schema public to hovedbok_app, hovedbok_ro;

-- journal and documents: writes only through the SECURITY DEFINER commands;
-- no direct DML for anyone (append-only triggers are the backstop even for owner)
revoke insert, update, delete, truncate on voucher, posting, fiscal_year, period
  from hovedbok_app, hovedbok_ro;

-- reference data: the app maintains it
grant insert, update on entity, account, party, vat_code, vat_rate to hovedbok_app;

-- documents: immutable inserts (blob bytes live on disk next to the row)
grant insert on document, voucher_document to hovedbok_app;

-- bank: facts are insert-only; operational state is mutable; pending snapshot
-- and matches are replaceable/revisable
grant insert on bank_transaction, bank_balance to hovedbok_app;
grant insert, update on bank_connection, bank_account to hovedbok_app;
grant insert, delete on bank_transaction_pending, match to hovedbok_app;
grant usage, select on all sequences in schema public to hovedbok_app;

-- commands: app only (plpgsql grants EXECUTE to PUBLIC by default — revoke it)
revoke all on function ensure_fiscal_year(text, smallint) from public;
revoke all on function post_voucher(jsonb) from public;
revoke all on function reverse_voucher(text, smallint, integer, date, text) from public;
revoke all on function close_period(text, smallint, smallint) from public;
grant execute on function ensure_fiscal_year(text, smallint) to hovedbok_app;
grant execute on function post_voucher(jsonb) to hovedbok_app;
grant execute on function reverse_voucher(text, smallint, integer, date, text) to hovedbok_app;
grant execute on function close_period(text, smallint, smallint) to hovedbok_app;
