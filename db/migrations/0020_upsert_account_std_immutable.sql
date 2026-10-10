-- upsert_account: review fix (#5, #3 finding 6). std_account becomes immutable
-- once the account has postings. Otherwise 0016 verbatim.
create or replace function upsert_account(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity   text := p ->> 'entity';
  v_code     text := p ->> 'code';
  cur        account%rowtype;
  s          std_account%rowtype;
  v_name     text;
  v_std      text;
  v_grouping text;
  v_vat      text;
  v_control  text;
  v_opened   date;
  v_closed   date;
  v_created  boolean;
begin
  if v_entity is null or v_code is null then
    raise exception 'entity and code are required';
  end if;
  perform 1 from entity where orgnr = v_entity;
  if not found then
    raise exception 'entity % does not exist (bootstrap_entity creates it)', v_entity
      using errcode = 'foreign_key_violation';
  end if;
  if v_code !~ '^\d{4}$' then
    raise exception 'account code % must be 4 digits (NS 4102)', v_code;
  end if;
  select * into cur from account where entity = v_entity and code = v_code;

  -- std_account: payload, else existing, else the code itself when standard.
  -- Immutable once the account has postings: vat_summary and vat_control
  -- read VAT sides through it, so a re-mapping would rewrite closed history.
  v_std := case when p ? 'std_account' then p ->> 'std_account'
                when cur.code is not null then cur.std_account
                else v_code end;
  if cur.code is not null and v_std is distinct from cur.std_account then
    perform 1 from posting where entity = v_entity and account = v_code limit 1;
    if found then
      raise exception 'account % has postings; its std_account (%) cannot change — open a new account instead',
        v_code, cur.std_account;
    end if;
  end if;
  if v_std is not null then
    select * into s from std_account where code = v_std;
    if not found then
      if p ? 'std_account' then
        raise exception 'std_account % is not a SAF-T standard account', v_std
          using errcode = 'foreign_key_violation';
      end if;
      v_std := null;
    end if;
  end if;

  v_name := case when p ? 'name' then p ->> 'name' else coalesce(cur.name, s.name) end;
  if v_name is null then
    raise exception 'name is required for account % (not a standard account)', v_code;
  end if;
  v_grouping := case when p ? 'grouping' then p ->> 'grouping'
                     when p ? 'std_account' then s.grouping_code
                     else coalesce(cur.grouping, s.grouping_code) end;
  if v_grouping is null and not (p ? 'grouping') then
    select code into v_grouping from grouping_range
     where v_code between from_code and to_code;
  end if;
  if v_std is null and v_grouping is null then
    raise exception 'account % needs a std_account or a grouping (SAF-T mapping)', v_code;
  end if;
  v_vat := case when p ? 'default_vat' then p ->> 'default_vat'
                when cur.code is not null then cur.default_vat
                else s.default_vat end;
  if v_vat is not null then
    perform 1 from vat_code where code = v_vat;
    if not found then
      raise exception 'default_vat % is not a vat code', v_vat
        using errcode = 'foreign_key_violation';
    end if;
  end if;
  v_control := case when p ? 'control' then p ->> 'control'
                    when cur.code is not null then cur.control
                    else s.control end;
  if v_control is not null and v_control not in ('customer', 'supplier') then
    raise exception 'control must be customer, supplier or null, got %', v_control;
  end if;
  v_opened := case when p ? 'opened' then (p ->> 'opened')::date else cur.opened end;
  v_closed := case when p ? 'closed' then (p ->> 'closed')::date else cur.closed end;

  insert into account (entity, code, name, std_account, grouping, default_vat, control, opened, closed)
  values (v_entity, v_code, v_name, v_std, v_grouping, v_vat, v_control, v_opened, v_closed)
  on conflict (entity, code) do update set
    name = excluded.name, std_account = excluded.std_account, grouping = excluded.grouping,
    default_vat = excluded.default_vat, control = excluded.control,
    opened = excluded.opened, closed = excluded.closed
  returning (xmax = 0) into v_created;

  return jsonb_build_object('entity', v_entity, 'code', v_code, 'created', v_created);
end
$$;

revoke all on function upsert_account(jsonb) from public;
grant execute on function upsert_account(jsonb) to hovedbok_app;
