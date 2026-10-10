-- upsert_account / upsert_party (#5): the reference-data commands, same jsonb
-- SECURITY DEFINER style as post_voucher (0006) and bootstrap_entity (0012).
-- Thin: each column resolves as payload key if present (an explicit null
-- clears the column), else the existing row's value, else the standard
-- chart's default where there is one.
--
-- upsert_account payload: {
--   "entity": "999888777", "code": "1921",
--   "name": "Bank, sparekonto",           -- required unless code is a standard account
--   "std_account": "1920",                -- SAF-T standard account; defaults to code when standard
--   "grouping": "1900",                   -- SAF-T grouping code; derived from std_account or the range
--   "default_vat": "1", "control": "customer" | "supplier" | null,
--   "opened": "2026-01-01", "closed": null
-- }
-- returns {"entity": ..., "code": ..., "created": true}
create function upsert_account(p jsonb) returns jsonb
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

  -- std_account: payload, else existing, else the code itself when standard
  v_std := case when p ? 'std_account' then p ->> 'std_account'
                when cur.code is not null then cur.std_account
                else v_code end;
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

-- upsert_party payload: {
--   "entity": "999888777", "id": "K0001", "name": "Kunde AS",   -- name required on insert
--   "orgnr": "987654321", "country": "NO", "address": {...},
--   "customer": true, "supplier": false, "owner": false, "senior_employee": false,
--   "peppol_id": "0192:987654321"
-- }
-- returns {"entity": ..., "id": ..., "created": true}
create function upsert_party(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity  text := p ->> 'entity';
  v_id      text := p ->> 'id';
  cur       party%rowtype;
  v_name    text;
  v_orgnr   text;
  v_address jsonb;
  v_created boolean;
begin
  if v_entity is null or v_id is null then
    raise exception 'entity and id are required';
  end if;
  perform 1 from entity where orgnr = v_entity;
  if not found then
    raise exception 'entity % does not exist (bootstrap_entity creates it)', v_entity
      using errcode = 'foreign_key_violation';
  end if;
  select * into cur from party where entity = v_entity and id = v_id;

  v_name := case when p ? 'name' then p ->> 'name' else cur.name end;
  if v_name is null then
    raise exception 'name is required for a new party';
  end if;
  v_orgnr := case when p ? 'orgnr' then p ->> 'orgnr' else cur.orgnr end;
  if v_orgnr is not null and v_orgnr !~ '^\d{9}$' then
    raise exception 'orgnr % must be 9 digits', v_orgnr;
  end if;
  if p ? 'address' then
    if jsonb_typeof(p -> 'address') not in ('object', 'null') then
      raise exception 'address must be a JSON object';
    end if;
    v_address := case when jsonb_typeof(p -> 'address') = 'object' then p -> 'address' else '{}' end;
  else
    v_address := coalesce(cur.address, '{}');
  end if;

  insert into party (entity, id, name, orgnr, country, address,
                     customer, supplier, owner, senior_employee, peppol_id)
  values (v_entity, v_id, v_name, v_orgnr,
          case when p ? 'country' then coalesce(p ->> 'country', 'NO') else coalesce(cur.country, 'NO') end,
          v_address,
          case when p ? 'customer' then coalesce((p ->> 'customer')::boolean, false) else coalesce(cur.customer, false) end,
          case when p ? 'supplier' then coalesce((p ->> 'supplier')::boolean, false) else coalesce(cur.supplier, false) end,
          case when p ? 'owner' then coalesce((p ->> 'owner')::boolean, false) else coalesce(cur.owner, false) end,
          case when p ? 'senior_employee' then coalesce((p ->> 'senior_employee')::boolean, false) else coalesce(cur.senior_employee, false) end,
          case when p ? 'peppol_id' then p ->> 'peppol_id' else cur.peppol_id end)
  on conflict (entity, id) do update set
    name = excluded.name, orgnr = excluded.orgnr, country = excluded.country,
    address = excluded.address, customer = excluded.customer, supplier = excluded.supplier,
    owner = excluded.owner, senior_employee = excluded.senior_employee,
    peppol_id = excluded.peppol_id
  returning (xmax = 0) into v_created;

  return jsonb_build_object('entity', v_entity, 'id', v_id, 'created', v_created);
end
$$;

-- grants, 0008 style
revoke all on function upsert_account(jsonb) from public;
revoke all on function upsert_party(jsonb) from public;
grant execute on function upsert_account(jsonb) to hovedbok_app;
grant execute on function upsert_party(jsonb) to hovedbok_app;
