-- Invariant 4 hole: voucher_balanced fires per inserted posting, so a voucher
-- inserted with no postings at all was never checked and committed empty
-- (only reachable by the owner; post_voucher pre-checks its lines). Run the same
-- deferred check once per voucher too. Strengthens 0003; weakens nothing.
create constraint trigger voucher_has_lines
after insert on voucher
deferrable initially deferred
for each row execute function check_voucher_balance();
