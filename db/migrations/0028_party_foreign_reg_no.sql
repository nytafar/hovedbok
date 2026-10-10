-- SAF-T export (#9): a party's RegistrationNumber is its Norwegian orgnr, or
-- the registration number of its home country when it has none. The orgnr
-- column is (and stays) 9 digits; a foreign number lives in its own column so
-- the exporter (src/saft.ts) can emit it without weakening the orgnr check.
-- Golden fixture: supplier L001 Vendor Ltd, RegistrationNumber IE1234567A.
alter table party add column foreign_reg_no text
  check (foreign_reg_no is null or foreign_reg_no ~ '^\S{1,35}$');
-- one registration number per party: Norwegian or foreign, not both
alter table party add constraint party_one_registration
  check (orgnr is null or foreign_reg_no is null);

-- upsert_party (0016) with foreign_reg_no; otherwise verbatim.
-- payload adds: "foreign_reg_no": "IE1234567A"   -- optional, excludes orgnr
create or replace function upsert_party(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity  text := p ->> 'entity';
  v_id      text := p ->> 'id';
  cur       party%rowtype;
  v_name    text;
  v_orgnr   text;
  v_foreign text;
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
  v_foreign := case when p ? 'foreign_reg_no' then p ->> 'foreign_reg_no' else cur.foreign_reg_no end;
  if v_foreign is not null and v_foreign !~ '^\S{1,35}$' then
    raise exception 'foreign_reg_no % must be 1-35 characters without whitespace', v_foreign;
  end if;
  if v_orgnr is not null and v_foreign is not null then
    raise exception 'a party has either an orgnr or a foreign_reg_no, not both';
  end if;
  if p ? 'address' then
    if jsonb_typeof(p -> 'address') not in ('object', 'null') then
      raise exception 'address must be a JSON object';
    end if;
    v_address := case when jsonb_typeof(p -> 'address') = 'object' then p -> 'address' else '{}' end;
  else
    v_address := coalesce(cur.address, '{}');
  end if;

  insert into party (entity, id, name, orgnr, foreign_reg_no, country, address,
                     customer, supplier, owner, senior_employee, peppol_id)
  values (v_entity, v_id, v_name, v_orgnr, v_foreign,
          case when p ? 'country' then coalesce(p ->> 'country', 'NO') else coalesce(cur.country, 'NO') end,
          v_address,
          case when p ? 'customer' then coalesce((p ->> 'customer')::boolean, false) else coalesce(cur.customer, false) end,
          case when p ? 'supplier' then coalesce((p ->> 'supplier')::boolean, false) else coalesce(cur.supplier, false) end,
          case when p ? 'owner' then coalesce((p ->> 'owner')::boolean, false) else coalesce(cur.owner, false) end,
          case when p ? 'senior_employee' then coalesce((p ->> 'senior_employee')::boolean, false) else coalesce(cur.senior_employee, false) end,
          case when p ? 'peppol_id' then p ->> 'peppol_id' else cur.peppol_id end)
  on conflict (entity, id) do update set
    name = excluded.name, orgnr = excluded.orgnr, foreign_reg_no = excluded.foreign_reg_no,
    country = excluded.country, address = excluded.address,
    customer = excluded.customer, supplier = excluded.supplier,
    owner = excluded.owner, senior_employee = excluded.senior_employee,
    peppol_id = excluded.peppol_id
  returning (xmax = 0) into v_created;

  return jsonb_build_object('entity', v_entity, 'id', v_id, 'created', v_created);
end
$$;

-- grants, 0008 style (replaced function keeps its grants; repeated anyway)
revoke all on function upsert_party(jsonb) from public;
grant execute on function upsert_party(jsonb) to hovedbok_app;
