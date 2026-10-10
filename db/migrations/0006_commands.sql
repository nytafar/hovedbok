-- Commands: the write path (ADR-0009). SECURITY DEFINER functions are the only
-- way into the journal; HTTP/MCP adapters translate payloads onto these 1:1.
-- Payloads are jsonb mirroring the HTTP bodies, so `select post_voucher('{...}')`
-- from psql is the same operation an HTTP client performs.

create function ensure_fiscal_year(p_entity text, p_year smallint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into fiscal_year (entity, year) values (p_entity, p_year)
  on conflict do nothing;
  -- months 1-12
  insert into period (entity, year, nr, date_from, date_to)
  select p_entity, p_year, m,
         make_date(p_year, m, 1),
         (make_date(p_year, m, 1) + interval '1 month - 1 day')::date
    from generate_series(1, 12) m
  on conflict do nothing;
  -- 13: year-end closing (31.12-31.12)
  insert into period (entity, year, nr, date_from, date_to)
  values (p_entity, p_year, 13, make_date(p_year, 12, 31), make_date(p_year, 12, 31))
  on conflict do nothing;
end
$$;

-- post_voucher: the heart of the system. Validates, allocates the gapless nr
-- under row lock, inserts voucher + lines + document links + bank matches in
-- one transaction. Idempotent on (entity, idempotency_key).
--
-- payload: {
--   "entity": "999888777", "posting_date": "2026-01-15",
--   "document_date": "2026-01-15",            -- optional, defaults to posting_date
--   "period": 13,                             -- optional, defaults to month(posting_date)
--   "description": "...", "source": "agent",  -- source optional
--   "external_ref": "...",                    -- optional
--   "idempotency_key": "...",
--   "reverses": {"year": 2026, "nr": 12},     -- set by reverse_voucher()
--   "lines": [{"account": "1920", "amount": 12500, "description": "...",
--              "vat_code": "3", "vat_base": -10000, "party": "K0001",
--              "ccy": "EUR", "ccy_amount": 1000, "ccy_rate": 11.65,
--              "dim": {"project": "x"}}, ...],
--   "documents": ["<sha256>", ...],           -- optional, rows must exist
--   "matches": [{"id_hash": "...", "dedup_key": "...", "line": 1}, ...]  -- optional
-- }
-- returns: {"entity": ..., "year": ..., "nr": ..., "idempotent": false}
create function post_voucher(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_entity text := p ->> 'entity';
  v_pdate  date := (p ->> 'posting_date')::date;
  v_key    text := p ->> 'idempotency_key';
  v_year   smallint;
  v_period smallint;
  v_nr     integer;
  v_sum    bigint;
  v_count  integer;
  existing record;
  l        record;
  i        smallint := 0;
begin
  if v_entity is null or v_pdate is null or v_key is null then
    raise exception 'entity, posting_date and idempotency_key are required';
  end if;
  select coalesce(sum((x ->> 'amount')::bigint), 0), count(*)
    into v_sum, v_count
    from jsonb_array_elements(p -> 'lines') x;
  if v_count < 2 then
    raise exception 'a voucher needs at least 2 lines';
  end if;
  if v_sum <> 0 then
    raise exception 'lines do not balance: % øre', v_sum;
  end if;

  select entity, year, nr into existing
    from voucher where entity = v_entity and idempotency_key = v_key;
  if found then
    return jsonb_build_object('entity', existing.entity, 'year', existing.year,
                              'nr', existing.nr, 'idempotent', true);
  end if;

  v_year   := extract(year from v_pdate)::smallint;
  v_period := coalesce((p ->> 'period')::smallint, extract(month from v_pdate)::smallint);
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
            coalesce(p ->> 'created_by', current_user));
  exception when unique_violation then
    select entity, year, nr into existing
      from voucher where entity = v_entity and idempotency_key = v_key;
    if found then
      return jsonb_build_object('entity', existing.entity, 'year', existing.year,
                                'nr', existing.nr, 'idempotent', true);
    end if;
    raise;
  end;

  for l in
    select * from jsonb_to_recordset(p -> 'lines')
      as x(account text, amount bigint, description text, vat_code text,
           vat_base bigint, party text, ccy text, ccy_amount bigint,
           ccy_rate numeric, dim jsonb)
  loop
    i := i + 1;
    insert into posting (entity, year, nr, line, account, amount, ccy, ccy_amount,
                         ccy_rate, vat_code, vat_base, party, dim, description)
    values (v_entity, v_year, v_nr, i, l.account, l.amount, l.ccy, l.ccy_amount,
            l.ccy_rate, l.vat_code, l.vat_base, l.party,
            coalesce(l.dim, '{}'), coalesce(l.description, ''));
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

-- reverse_voucher: builds the exact negation and posts it through post_voucher,
-- so there is one insertion path. Naturally idempotent via the reverse:Y/N key;
-- the UNIQUE on (entity, reverses_year, reverses_nr) enforces reverse-once.
create function reverse_voucher(
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
           'vat_code', vat_code, 'vat_base', -vat_base, 'party', party,
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

create function close_period(p_entity text, p_year smallint, p_period smallint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update period
     set status = 'closed', closed_at = now(), closed_by = current_user
   where entity = p_entity and year = p_year and nr = p_period and status = 'open';
  if not found then
    raise exception 'period %/% for % is not open', p_year, p_period, p_entity;
  end if;
  return jsonb_build_object('entity', p_entity, 'year', p_year,
                            'period', p_period, 'status', 'closed');
end
$$;
