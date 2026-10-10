-- post_voucher: errors written for agents (#5). Same contract as 0006; what
-- changes is the failure path:
--   - required fields are reported together ("missing required field(s): …");
--   - every line is checked for shape before anything is written: which line,
--     which account, and why (unknown account, non-integer or zero amount);
--   - a line the invariant triggers refuse is re-raised as
--     "line N of M (account A, X øre): <reason>", keeping the trigger's own
--     text and SQLSTATE;
--   - period 13 outside 31.12 is refused before a number is touched;
--   - created_by: payload value if the adapter knows the principal, else
--     session_user (the login role), never the SECURITY DEFINER owner.
-- Numbering, idempotency and the single insertion path are unchanged.
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

  i := 0;
  for l in
    select * from jsonb_to_recordset(p -> 'lines')
      as x(account text, amount bigint, description text, vat_code text,
           vat_base bigint, party text, ccy text, ccy_amount bigint,
           ccy_rate numeric, dim jsonb)
  loop
    i := i + 1;
    begin
      insert into posting (entity, year, nr, line, account, amount, ccy, ccy_amount,
                           ccy_rate, vat_code, vat_base, party, dim, description)
      values (v_entity, v_year, v_nr, i, l.account, l.amount, l.ccy, l.ccy_amount,
              l.ccy_rate, l.vat_code, l.vat_base, l.party,
              coalesce(l.dim, '{}'), coalesce(l.description, ''));
    exception when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
      raise exception 'line % of % (account %, % øre): %', i, v_count, l.account, l.amount, v_msg
        using errcode = v_state;
    end;
  end loop;

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

revoke all on function post_voucher(jsonb) from public;
grant execute on function post_voucher(jsonb) to hovedbok_app;
