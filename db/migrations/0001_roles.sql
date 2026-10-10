-- Roles are cluster-level; create idempotently. These are NOLOGIN group roles:
-- deploy grants them to actual login users. See ADR-0009.
do $$
begin
  if not exists (select from pg_roles where rolname = 'hovedbok_app') then
    create role hovedbok_app nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'hovedbok_ro') then
    create role hovedbok_ro nologin;
  end if;
end
$$;
