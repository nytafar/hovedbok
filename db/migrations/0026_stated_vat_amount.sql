-- The base line may state the booked VAT amount; derivation is the default
-- (ADR-0012, #8).
--
-- posting.vat_amount: the VAT the source document states for this coded line,
-- in signed øre, signed like vat_base (the line's own VAT, before the regime
-- turns it into output and/or input: a purchase line's VAT is positive, a
-- sale line's negative). Null = derive round(vat_base × rate / 100), as
-- before. Reporting reads coalesce(vat_amount, derived) everywhere.
--
-- Rules (check_posting):
--   - vat_amount only together with vat_code and vat_base;
--   - plausibility, against gross errors, not against invoice rounding:
--       derived = 0 (zero-rated / rateless code, or a tiny base):
--         vat_amount must be 0;
--       otherwise: same sign as derived, and
--         |vat_amount - derived| <= max(100 øre, |derived| / 100)
--       i.e. within 1 krone or 1 % of the derived VAT, whichever is larger.
--       1 krone admits per-line rounding on invoices of up to ~200 lines and
--       the enkelt-regnskap oracle's 1 052,64 vs derived 1 052,55 (9 øre);
--       1 % admits the same on large invoices. A decimal-point slip (10×, ÷10)
--       or a gross amount typed as the VAT fails on anything above ~1 krone
--       of VAT. A deviation beyond the bound is not an invoice rounding issue:
--       split the line by rate, or fix the base.
--   - immutable: posting is append-only (ADR-0001); the column inherits it.
-- A reversal must negate vat_amount too (check_reversal), and
-- reverse_voucher() carries it.

alter table posting add column vat_amount bigint;

-- ---------------------------------------------------------------------------
-- check_posting: 0017 verbatim plus the vat_amount rules.
create or replace function check_posting() returns trigger
language plpgsql as $$
declare
  v       record;
  acc     record;
  ok      boolean;
  v_kind  text;
  v_rate  numeric;
  derived bigint;
  bound   bigint;
  cls     text := left(new.account, 1);
begin
  select posting_date, created_xid into v from voucher
   where entity = new.entity and year = new.year and nr = new.nr;
  if not found then
    raise exception 'voucher %/% does not exist for %', new.year, new.nr, new.entity
      using errcode = 'foreign_key_violation';
  end if;
  if v.created_xid <> pg_current_xact_id() then
    raise exception 'voucher %/% for % was posted in an earlier transaction and takes no new lines; correct it with reverse_voucher() and a new post_voucher() (ADR-0001)',
      new.year, new.nr, new.entity;
  end if;

  select a.control, a.std_account, s.vat_side into acc
    from account a
    left join std_account s on s.code = a.std_account
   where a.entity = new.entity and a.code = new.account;
  if not found then
    raise exception 'account % is not in the chart of entity % (upsert_account adds it)',
      new.account, new.entity using errcode = 'foreign_key_violation';
  end if;

  if acc.control is not null then
    if new.party is null then
      raise exception 'account % is a % control account; party is required (BF § 3-1)',
        new.account, acc.control;
    end if;
    if acc.control = 'customer' then
      select customer into ok from party where entity = new.entity and id = new.party;
    else
      select supplier into ok from party where entity = new.entity and id = new.party;
    end if;
    if not ok then
      raise exception 'party % does not have the % role', new.party, acc.control;
    end if;
  end if;

  if new.vat_code is not null then
    select rate into v_rate from vat_rate
     where code = new.vat_code and valid_from <= v.posting_date
     order by valid_from desc limit 1;
    if not found then
      raise exception 'vat code % has no rate valid on %', new.vat_code, v.posting_date;
    end if;
    if acc.vat_side is not null then
      raise exception 'account % is an %-VAT account; VAT-account lines carry no vat_code — code the base line and let the VAT derive from it (ADR-0011)',
        new.account, acc.vat_side;
    end if;
    if new.vat_base is null then
      raise exception 'vat code % on account % needs vat_base (the grunnlag the VAT derives from, ADR-0011)',
        new.vat_code, new.account;
    end if;
    select kind into v_kind from vat_code where code = new.vat_code;
    if v_kind in ('input', 'import_input') and cls = '3' then
      raise exception 'vat code % is input VAT; it cannot go on revenue account %',
        new.vat_code, new.account;
    end if;
    if v_kind in ('import_base', 'reverse_charge') and cls = '3' then
      raise exception 'vat code % is a purchase regime (kind %); it cannot go on revenue account %',
        new.vat_code, v_kind, new.account;
    end if;
    if new.vat_amount is not null then
      derived := round(new.vat_base * v_rate / 100)::bigint;
      if derived = 0 then
        if new.vat_amount <> 0 then
          raise exception 'vat_amount % on account % is implausible: code % at % %% on base % gives no VAT, so the stated amount must be 0 (ADR-0012)',
            new.vat_amount, new.account, new.vat_code, v_rate, new.vat_base;
        end if;
      else
        bound := greatest(100, abs(derived) / 100);
        if sign(new.vat_amount) <> sign(derived) or abs(new.vat_amount - derived) > bound then
          raise exception 'vat_amount % on account % is implausible: code % at % %% on base % derives %; a stated amount must have the same sign and lie within % øre of it (1 krone or 1 %%, ADR-0012)',
            new.vat_amount, new.account, new.vat_code, v_rate, new.vat_base, derived, bound;
        end if;
      end if;
    end if;
  elsif new.vat_base is not null then
    raise exception 'vat_base on account % needs a vat_code', new.account;
  elsif new.vat_amount is not null then
    raise exception 'vat_amount on account % needs a vat_code and vat_base (ADR-0012)', new.account;
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- check_reversal: 0003 plus vat_amount (null and 0 kept apart).
create or replace function check_reversal() returns trigger
language plpgsql as $$
declare
  diff integer;
begin
  if new.reverses_nr is null then
    return null;
  end if;
  select count(*) into diff from (
    (select account, -amount as amount, coalesce(vat_code, '') as vc,
            coalesce(-vat_base, 0) as vb, coalesce((-vat_amount)::text, '') as va,
            coalesce(party, '') as pt
       from posting
      where entity = new.entity and year = new.reverses_year and nr = new.reverses_nr
     except all
     select account, amount, coalesce(vat_code, ''), coalesce(vat_base, 0),
            coalesce(vat_amount::text, ''), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.year and nr = new.nr)
    union all
    (select account, amount, coalesce(vat_code, ''), coalesce(vat_base, 0),
            coalesce(vat_amount::text, ''), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.year and nr = new.nr
     except all
     select account, -amount, coalesce(vat_code, ''), coalesce(-vat_base, 0),
            coalesce((-vat_amount)::text, ''), coalesce(party, '')
       from posting
      where entity = new.entity and year = new.reverses_year and nr = new.reverses_nr)
  ) d;
  if diff <> 0 then
    raise exception 'voucher %/% does not exactly negate %/% (BF § 5-12)',
      new.year, new.nr, new.reverses_year, new.reverses_nr;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- post_voucher: 0018 plus vat_amount in the line payload (validated as an
-- integer number of øre, like amount and vat_base).
create or replace function post_voucher(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity text := p ->> 'entity';
  v_pdate  date;
  v_key    text := p ->> 'idempotency_key';
  v_year   smallint;
  v_period smallint;
  v_nr     integer;
  v_sum    bigint := 0;
  v_count  integer;
  missing  text[] := '{}';
  existing record;
  l        record;
  x        jsonb;
  i        smallint := 0;
  v_msg    text;
  v_state  text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'post_voucher takes a JSON object: {entity, posting_date, idempotency_key, lines: [...]}';
  end if;
  if v_entity is null then missing := array_append(missing, 'entity'); end if;
  if p ->> 'posting_date' is null then missing := array_append(missing, 'posting_date'); end if;
  if v_key is null then missing := array_append(missing, 'idempotency_key'); end if;
  if cardinality(missing) > 0 then
    raise exception 'missing required field(s): %', array_to_string(missing, ', ');
  end if;
  begin
    v_pdate := (p ->> 'posting_date')::date;
  exception when others then
    raise exception 'posting_date % is not a date (YYYY-MM-DD)', p ->> 'posting_date';
  end;
  perform 1 from entity where orgnr = v_entity;
  if not found then
    raise exception 'entity % does not exist (bootstrap_entity creates it)', v_entity
      using errcode = 'foreign_key_violation';
  end if;

  if jsonb_typeof(p -> 'lines') is distinct from 'array' or jsonb_array_length(p -> 'lines') < 2 then
    raise exception 'a voucher needs at least 2 lines (lines: [{account, amount, ...}, ...])';
  end if;
  v_count := jsonb_array_length(p -> 'lines');
  for x in select value from jsonb_array_elements(p -> 'lines') loop
    i := i + 1;
    if jsonb_typeof(x) <> 'object' then
      raise exception 'line % of %: must be an object {account, amount, ...}', i, v_count;
    end if;
    if x ->> 'account' is null then
      raise exception 'line % of %: account is required', i, v_count;
    end if;
    perform 1 from account where entity = v_entity and code = x ->> 'account';
    if not found then
      raise exception 'line % of %: account % is not in the chart of entity % (upsert_account adds it)',
        i, v_count, x ->> 'account', v_entity using errcode = 'foreign_key_violation';
    end if;
    if jsonb_typeof(x -> 'amount') is distinct from 'number' or (x ->> 'amount')::numeric % 1 <> 0 then
      raise exception 'line % of % (account %): amount must be an integer number of øre, got %',
        i, v_count, x ->> 'account', coalesce(x ->> 'amount', 'nothing');
    end if;
    if (x ->> 'amount')::bigint = 0 then
      raise exception 'line % of % (account %): amount must not be zero', i, v_count, x ->> 'account';
    end if;
    if x ? 'vat_base' and x -> 'vat_base' <> 'null'::jsonb
       and (jsonb_typeof(x -> 'vat_base') <> 'number' or (x ->> 'vat_base')::numeric % 1 <> 0) then
      raise exception 'line % of % (account %): vat_base must be an integer number of øre, got %',
        i, v_count, x ->> 'account', x ->> 'vat_base';
    end if;
    if x ? 'vat_amount' and x -> 'vat_amount' <> 'null'::jsonb
       and (jsonb_typeof(x -> 'vat_amount') <> 'number' or (x ->> 'vat_amount')::numeric % 1 <> 0) then
      raise exception 'line % of % (account %): vat_amount must be an integer number of øre, got %',
        i, v_count, x ->> 'account', x ->> 'vat_amount';
    end if;
    v_sum := v_sum + (x ->> 'amount')::bigint;
  end loop;
  if v_sum <> 0 then
    raise exception 'lines do not balance: % øre (debits positive, credits negative, sum must be 0)', v_sum;
  end if;
  for x in select value from jsonb_array_elements(coalesce(p -> 'documents', '[]'::jsonb)) loop
    perform 1 from document where sha256 = x #>> '{}';
    if not found then
      raise exception 'document % is not registered (insert the document row first)', x #>> '{}'
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  select entity, year, nr into existing
    from voucher where entity = v_entity and idempotency_key = v_key;
  if found then
    return jsonb_build_object('entity', existing.entity, 'year', existing.year,
                              'nr', existing.nr, 'idempotent', true);
  end if;

  v_year   := extract(year from v_pdate)::smallint;
  v_period := coalesce((p ->> 'period')::smallint, extract(month from v_pdate)::smallint);
  if v_period = 13 and v_pdate <> make_date(v_year, 12, 31) then
    raise exception 'period 13 (year-end closing) does not cover %: it only takes posting_date %',
      v_pdate, make_date(v_year, 12, 31);
  end if;
  perform ensure_fiscal_year(v_entity, v_year);

  -- counter bump and voucher insert share a subtransaction, so an idempotency
  -- race rolls both back and the numbering stays gapless
  begin
    update fiscal_year set last_voucher_nr = last_voucher_nr + 1
     where entity = v_entity and year = v_year
    returning last_voucher_nr into v_nr;

    insert into voucher (entity, year, nr, document_date, posting_date, period,
                         description, source, external_ref, idempotency_key,
                         reverses_year, reverses_nr, created_by)
    values (v_entity, v_year, v_nr,
            coalesce((p ->> 'document_date')::date, v_pdate), v_pdate, v_period,
            coalesce(p ->> 'description', ''),
            coalesce(p ->> 'source', 'agent'),
            p ->> 'external_ref', v_key,
            (p #>> '{reverses,year}')::smallint, (p #>> '{reverses,nr}')::integer,
            coalesce(p ->> 'created_by', session_user));
  exception when unique_violation then
    select entity, year, nr into existing
      from voucher where entity = v_entity and idempotency_key = v_key;
    if found then
      return jsonb_build_object('entity', existing.entity, 'year', existing.year,
                                'nr', existing.nr, 'idempotent', true);
    end if;
    raise;
  end;

  -- one subtransaction around the whole loop (a per-line one overflowed the
  -- subxid cache past 63 lines; the year-end result voucher is that big);
  -- i and l survive into the handler, so the message still names the line
  i := 0;
  begin
    for l in
      select * from jsonb_to_recordset(p -> 'lines')
        as x(account text, amount bigint, description text, vat_code text,
             vat_base bigint, vat_amount bigint, party text, ccy text, ccy_amount bigint,
             ccy_rate numeric, dim jsonb)
    loop
      i := i + 1;
      insert into posting (entity, year, nr, line, account, amount, ccy, ccy_amount,
                           ccy_rate, vat_code, vat_base, vat_amount, party, dim, description)
      values (v_entity, v_year, v_nr, i, l.account, l.amount, l.ccy, l.ccy_amount,
              l.ccy_rate, l.vat_code, l.vat_base, l.vat_amount, l.party,
              coalesce(l.dim, '{}'), coalesce(l.description, ''));
    end loop;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    raise exception 'line % of % (account %, % øre): %', i, v_count, l.account, l.amount, v_msg
      using errcode = v_state;
  end;

  insert into voucher_document (entity, year, nr, sha256)
  select v_entity, v_year, v_nr, d.sha
    from jsonb_array_elements_text(coalesce(p -> 'documents', '[]'::jsonb)) d(sha);

  insert into match (id_hash, dedup_key, entity, year, nr, line)
  select m.id_hash, m.dedup_key, v_entity, v_year, v_nr, m.line
    from jsonb_to_recordset(coalesce(p -> 'matches', '[]'::jsonb))
      as m(id_hash text, dedup_key text, line smallint);

  return jsonb_build_object('entity', v_entity, 'year', v_year, 'nr', v_nr,
                            'idempotent', false);
end
$$;

-- ---------------------------------------------------------------------------
-- reverse_voucher: 0006 plus vat_amount in the negation.
create or replace function reverse_voucher(
  p_entity text, p_year smallint, p_nr integer,
  p_posting_date date default current_date,
  p_description text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  orig  record;
  lines jsonb;
begin
  select * into orig from voucher
   where entity = p_entity and year = p_year and nr = p_nr;
  if not found then
    raise exception 'voucher %/% not found for %', p_year, p_nr, p_entity;
  end if;
  select jsonb_agg(jsonb_build_object(
           'account', account, 'amount', -amount, 'description', description,
           'vat_code', vat_code, 'vat_base', -vat_base, 'vat_amount', -vat_amount,
           'party', party,
           'ccy', ccy, 'ccy_amount', -ccy_amount, 'ccy_rate', ccy_rate,
           'dim', dim) order by line)
    into lines
    from posting where entity = p_entity and year = p_year and nr = p_nr;
  return post_voucher(jsonb_build_object(
    'entity', p_entity,
    'posting_date', p_posting_date,
    'document_date', orig.document_date,
    'description', coalesce(p_description,
      'Reversering av bilag ' || p_year || '/' || p_nr || ': ' || orig.description),
    'source', orig.source,
    'idempotency_key', 'reverse:' || p_year || '/' || p_nr,
    'reverses', jsonb_build_object('year', p_year, 'nr', p_nr),
    'lines', lines));
end
$$;

-- ---------------------------------------------------------------------------
-- vat_summary: 0025 with the line VAT stated-else-derived. mva_term and
-- vat_control read through it unchanged.
create or replace view vat_summary as
with coded as (
  select v.entity, v.year, v.period, p.vat_code, c.kind, c.deductible,
         p.vat_base, r.rate,
         coalesce(p.vat_amount, round(p.vat_base * r.rate / 100)::bigint) as vat
    from voucher v
    join posting p using (entity, year, nr)
    join vat_code c on c.code = p.vat_code
    left join lateral (
      select vr.rate from vat_rate vr
       where vr.code = p.vat_code and vr.valid_from <= v.posting_date
       order by vr.valid_from desc limit 1) r on true
   where p.vat_code is not null
), per_line as (
  select entity, year, period, vat_code, rate, vat_base,
         case when kind = 'output' then vat
              when kind in ('import_base', 'reverse_charge') then -vat
              else 0 end as output_vat,
         case when kind in ('input', 'import_input') then vat
              when kind in ('import_base', 'reverse_charge') and deductible then vat
              else 0 end as input_vat
    from coded
)
select entity, year, period, vat_code,
       sum(vat_base) as base,
       sum(output_vat) + sum(input_vat) as vat,
       sum(output_vat) as output_vat,
       sum(input_vat) as input_vat,
       rate
  from per_line
 group by entity, year, period, vat_code, rate;

-- grants, 0008 style (replaced functions and views keep theirs; repeated anyway)
revoke all on function post_voucher(jsonb) from public;
revoke all on function reverse_voucher(text, smallint, integer, date, text) from public;
grant execute on function post_voucher(jsonb) to hovedbok_app;
grant execute on function reverse_voucher(text, smallint, integer, date, text) to hovedbok_app;
grant select on vat_summary, mva_term, vat_control to hovedbok_app, hovedbok_ro;
