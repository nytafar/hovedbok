-- Company profile (#15): the entity's SAF-T Header/Company data as policy-as-
-- data on the entity, so GET /saf-t serves a schema-valid file without the
-- caller supplying it. The shape mirrors buildSaft's opts.company
-- (src/saft.ts SaftCompany) minus name, which stays entity.name:
--
--   {
--     "address": {"street", "number", "city", "postalCode", "country"},
--     "contact": {"firstName", "lastName", "telephone", "email"},
--     "bankAccounts": [{"number", "ledgerAccount", "currency"}]
--   }
--
-- Every key is optional here; '{}' is "no profile". What a SAF-T export needs
-- (contact firstName/lastName/telephone, address city/postalCode) buildSaft
-- checks when it builds the file and names what is missing. Absent
-- bankAccounts: the entity's bank_account rows. The shape check is a CHECK
-- constraint, so every write path (bootstrap_entity, set_company_profile,
-- direct UPDATE by hovedbok_app) gets the same agent-readable refusal; string
-- lengths are the v1.30/v1.40 XSD's, so a stored profile always serialises
-- into a valid Header.

-- one object of string fields: known keys (in the order given, which the
-- messages list), non-blank strings within the XSD's max lengths, required keys
create function company_profile_fields(o jsonb, what text, keys text[], max_len int[], required text[])
returns void language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k text;
  v jsonb;
  n integer;
begin
  if jsonb_typeof(o) is distinct from 'object' then
    raise exception 'company_profile.% must be an object with %', what, array_to_string(keys, ', ');
  end if;
  for k, v in select key, value from jsonb_each(o) loop
    n := array_position(keys, k);
    if n is null then
      raise exception 'company_profile.%: unknown key %; allowed: %', what, k, array_to_string(keys, ', ');
    end if;
    if jsonb_typeof(v) is distinct from 'string' or btrim(v #>> '{}') = '' then
      raise exception 'company_profile.%.% must be a non-empty string', what, k;
    end if;
    if length(v #>> '{}') > max_len[n] then
      raise exception 'company_profile.%.% is longer than % characters (SAF-T limit)', what, k, max_len[n];
    end if;
  end loop;
  foreach k in array required loop
    if not o ? k then
      raise exception 'company_profile.% needs %', what, k;
    end if;
  end loop;
end
$$;

create function company_profile_valid(p jsonb) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare
  k text;
  b jsonb;
  i integer := 0;
begin
  if jsonb_typeof(p) is distinct from 'object' then
    raise exception 'company_profile must be a JSON object {address, contact, bankAccounts}';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('address', 'contact', 'bankAccounts') then
      raise exception 'company_profile: unknown key %; allowed: address, contact, bankAccounts', k;
    end if;
  end loop;

  if p ? 'address' then
    perform company_profile_fields(p -> 'address', 'address',
      '{street,number,city,postalCode,country}', '{256,70,256,70,2}', '{}');
    if p #>> '{address,country}' !~ '^[A-Z]{2}$' then
      raise exception 'company_profile.address.country must be an ISO 3166-1 alpha-2 code (e.g. NO)';
    end if;
  end if;

  if p ? 'contact' then
    perform company_profile_fields(p -> 'contact', 'contact',
      '{firstName,lastName,telephone,email}', '{35,70,18,70}', '{firstName,lastName}');
  end if;

  if p ? 'bankAccounts' then
    if jsonb_typeof(p -> 'bankAccounts') is distinct from 'array' then
      raise exception 'company_profile.bankAccounts must be an array of {number, ledgerAccount, currency}';
    end if;
    for b in select * from jsonb_array_elements(p -> 'bankAccounts') loop
      perform company_profile_fields(b, format('bankAccounts[%s]', i),
        '{number,ledgerAccount,currency}', '{35,70,3}', '{number,ledgerAccount}');
      if b ->> 'ledgerAccount' !~ '^\d{4}$' then
        raise exception 'company_profile.bankAccounts[%].ledgerAccount must be a 4-digit account code', i;
      end if;
      if b ->> 'currency' !~ '^[A-Z]{3}$' then
        raise exception 'company_profile.bankAccounts[%].currency must be an ISO 4217 code (e.g. NOK)', i;
      end if;
      i := i + 1;
    end loop;
  end if;
  return true;
end
$$;

alter table entity add column company_profile jsonb not null default '{}'
  constraint entity_company_profile_check check (company_profile_valid(company_profile));

-- set_company_profile: replace the entity's company profile as a whole (an
-- absent key is removed; {} clears it). Same SECURITY DEFINER style as the
-- other commands.
--
-- payload: {"entity": "999888777", "company_profile": {...}}
-- returns: {"entity": ..., "company_profile": {...}}
create function set_company_profile(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity  text := p ->> 'entity';
  v_profile jsonb := p -> 'company_profile';
begin
  if v_entity is null or v_profile is null or v_profile = 'null' then
    raise exception 'entity and company_profile are required';
  end if;
  update entity set company_profile = v_profile where orgnr = v_entity;
  if not found then
    raise exception 'entity % does not exist (bootstrap_entity creates it)', v_entity
      using errcode = 'foreign_key_violation';
  end if;
  return jsonb_build_object('entity', v_entity, 'company_profile', v_profile);
end
$$;

-- bootstrap_entity (0012) with an optional company_profile; otherwise
-- verbatim. Non-destructive as before: a new entity gets the payload's
-- profile; an existing one gets it only while it has none ({}), so a re-run
-- fills a missing profile but never overwrites a stored one
-- (set_company_profile replaces). The result carries the profile now stored.
--
-- payload: {
--   "orgnr": "999888777", "name": "Demo AS",
--   "vat_registered": true,        -- optional, default false
--   "vat_term": "bimonthly",       -- optional: monthly | bimonthly | yearly
--   "year": 2026,                  -- optional, default the current year
--   "company_profile": {...}       -- optional, see the top of this file
-- }
-- returns: {"entity": ..., "created": true, "accounts_added": 745, "year": 2026,
--           "company_profile": {...}}
create or replace function bootstrap_entity(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_orgnr   text := p ->> 'orgnr';
  v_name    text := p ->> 'name';
  v_year    smallint := coalesce((p ->> 'year')::smallint,
                                 extract(year from current_date)::smallint);
  v_profile jsonb := nullif(p -> 'company_profile', 'null');
  v_created boolean;
  v_added   integer;
  v_stored  jsonb;
begin
  if v_orgnr is null or v_name is null then
    raise exception 'orgnr and name are required';
  end if;

  -- defaults mirror the entity table's (0002, 0032)
  insert into entity (orgnr, name, vat_registered, vat_term, company_profile)
  values (v_orgnr, v_name,
          coalesce((p ->> 'vat_registered')::boolean, false),
          coalesce(p ->> 'vat_term', 'bimonthly'),
          coalesce(v_profile, '{}'))
  on conflict (orgnr) do nothing;
  v_created := found;

  if not v_created and v_profile is not null then
    update entity set company_profile = v_profile
     where orgnr = v_orgnr and company_profile = '{}';
  end if;
  select company_profile into v_stored from entity where orgnr = v_orgnr;

  insert into account (entity, code, name, std_account, grouping, default_vat, control)
  select v_orgnr, s.code, s.name, s.code, s.grouping_code, s.default_vat, s.control
    from std_account s
  on conflict (entity, code) do nothing;
  get diagnostics v_added = row_count;

  perform ensure_fiscal_year(v_orgnr, v_year);

  return jsonb_build_object('entity', v_orgnr, 'created', v_created,
                            'accounts_added', v_added, 'year', v_year,
                            'company_profile', v_stored);
end
$$;

-- grants, 0008 style. entity's table-level select/insert/update (0008) cover
-- the new column. The check constraint runs company_profile_valid as the
-- writing role, so hovedbok_app needs EXECUTE on it (and its helper).
revoke all on function company_profile_fields(jsonb, text, text[], int[], text[]) from public;
revoke all on function company_profile_valid(jsonb) from public;
revoke all on function set_company_profile(jsonb) from public;
revoke all on function bootstrap_entity(jsonb) from public;
grant execute on function company_profile_fields(jsonb, text, text[], int[], text[]) to hovedbok_app;
grant execute on function company_profile_valid(jsonb) to hovedbok_app;
grant execute on function set_company_profile(jsonb) to hovedbok_app;
grant execute on function bootstrap_entity(jsonb) to hovedbok_app;
