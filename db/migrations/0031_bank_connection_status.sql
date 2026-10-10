-- Consent status for operators and agents (#10/#11): one row per
-- bank_connection with its accounts, the unattended fetch budget and the
-- 429 backoff, read from bank_fetch exactly as src/bank/sync.ts counts them
-- (MAX_UNATTENDED_PER_DAY = 4 per rolling 24 h; runs that reached the bank,
-- i.e. not 'deferred'). Leaves out session_id and auth_state: the session
-- handle and the pending consent's CSRF state are not status.
create view bank_connection_status as
select c.entity, c.id, c.aspsp_name, c.aspsp_country, c.status, c.valid_until,
       c.created_at, c.last_synced_at, c.backoff_until,
       coalesce(c.backoff_until > now(), false) as backing_off,
       (select count(*)::int from bank_account a where a.connection_id = c.id) as accounts,
       u.n as unattended_24h,
       greatest(4 - u.n, 0) as unattended_left,
       -- when an unattended run may reach the bank again; null = now
       greatest(
         case when c.backoff_until > now() then c.backoff_until end,
         case when u.n >= 4 then u.oldest + interval '24 hours' end
       ) as unattended_resume_at,
       lf.started_at as last_fetch_at, lf.attended as last_fetch_attended,
       lf.outcome as last_fetch_outcome, lf.detail as last_fetch_detail
  from bank_connection c
  cross join lateral (
        select count(*)::int as n, min(f.started_at) as oldest
          from bank_fetch f
         where f.connection_id = c.id and not f.attended and f.outcome <> 'deferred'
           and f.started_at > now() - interval '24 hours') u
  left join lateral (
        select f.started_at, f.attended, f.outcome, f.detail
          from bank_fetch f
         where f.connection_id = c.id
         order by f.started_at desc, f.id desc
         limit 1) lf on true;

-- grants, 0008 style
grant select on bank_connection_status to hovedbok_app, hovedbok_ro;
