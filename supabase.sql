-- Run in a NEW development Supabase project first. No source data is deleted.
begin;
create or replace function public.ledger_revision() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.version := case when TG_OP = 'INSERT' then 1 else old.version + 1 end;
  new.updated_at := clock_timestamp();
  return new;
end $$;

-- Full original records remain in data. Generated, typed columns expose common
-- metadata and nested entries without splitting individual sets into tables.
create table if not exists public.sessions (
  user_id uuid not null references auth.users(id), id text not null,
  data jsonb not null check (jsonb_typeof(data)='object' and data->>'id'=id),
  date text generated always as (data->>'date') stored,
  type text generated always as (data->>'type') stored,
  status text generated always as (data->>'status') stored,
  routine_id text generated always as (data->>'routineId') stored,
  entries jsonb generated always as (data->'entries') stored,
  version bigint not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id,id),
  check (jsonb_typeof(data->'entries')='array'),
  check ((data->>'date') ~ '^\d{4}-\d{2}-\d{2}$')
);
create table if not exists public.exercises (
  user_id uuid not null references auth.users(id), id text not null,
  data jsonb not null check (jsonb_typeof(data)='object' and data->>'id'=id),
  name text generated always as (data->>'name') stored,
  pattern text generated always as (data->>'pattern') stored,
  muscle_group text generated always as (data->>'group') stored,
  anchor boolean generated always as ((data->>'anchor')::boolean) stored,
  version bigint not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id,id)
);
create table if not exists public.routines (
  user_id uuid not null references auth.users(id), id text not null,
  data jsonb not null check (jsonb_typeof(data)='object'),
  routine_id text generated always as (data->>'id') stored,
  split text generated always as (data->>'split') stored,
  name text generated always as (data->>'name') stored,
  version bigint not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id,id), unique(user_id,routine_id,split),
  check (jsonb_typeof(data->'blocks')='array')
);
create table if not exists public.cardio (
  user_id uuid not null references auth.users(id), id text not null,
  data jsonb not null check (jsonb_typeof(data)='object' and data->>'id'=id),
  date text generated always as (data->>'date') stored,
  version bigint not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id,id)
);
create table if not exists public.body (
  user_id uuid not null references auth.users(id), id text not null,
  data jsonb not null check (jsonb_typeof(data)='object' and data->>'id'=id),
  date text generated always as (data->>'date') stored,
  version bigint not null default 1, updated_at timestamptz not null default now(),
  primary key (user_id,id)
);
do $$ declare t text; begin
  foreach t in array array['sessions','exercises','routines','cardio','body'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select, insert, update on public.%I to authenticated',t);
    execute format('drop policy if exists owner_read on public.%I',t);
    execute format('create policy owner_read on public.%I for select to authenticated using ((select auth.uid()) = user_id)',t);
    execute format('drop policy if exists owner_insert on public.%I',t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',t);
    execute format('drop policy if exists owner_update on public.%I',t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',t);
    execute format('drop trigger if exists ledger_revision on public.%I',t);
    execute format('create trigger ledger_revision before insert or update on public.%I for each row execute function public.ledger_revision()',t);
  end loop;
end $$;

-- Atomic compare-and-swap, stable IDs, and payload equality make retries safe even
-- when the response to a successful commit was lost. RLS remains in force.
create or replace function public.ledger_write(p_table text,p_id text,p_data jsonb,p_version bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r record; u uuid := auth.uid();
begin
  if u is null then raise exception 'Sign in required'; end if;
  if p_table not in ('sessions','exercises','routines','cardio','body') then raise exception 'Invalid table'; end if;
  if p_data->>'id' is null or p_id is null then raise exception 'Missing ID'; end if;
  if p_table='routines' then
    if p_id::jsonb <> jsonb_build_array(p_data->>'id',p_data->>'split') then raise exception 'Routine key mismatch'; end if;
  elsif p_id <> p_data->>'id' then raise exception 'ID mismatch'; end if;
  if p_version is null then
    execute format('insert into public.%I (user_id,id,data) values ($1,$2,$3) on conflict (user_id,id) do nothing',p_table) using u,p_id,p_data;
  end if;
  execute format('select id,data,version,updated_at from public.%I where user_id=$1 and id=$2 for update',p_table) into r using u,p_id;
  if r.id is null then raise exception 'Record missing; reload before writing'; end if;
  if r.data = p_data then return jsonb_build_object('ok',true,'row',to_jsonb(r)); end if;
  if p_version is null or r.version <> p_version then
    return jsonb_build_object('ok',false,'conflict',true,'row',to_jsonb(r));
  end if;
  execute format('update public.%I set data=$3 where user_id=$1 and id=$2 returning id,data,version,updated_at',p_table) into r using u,p_id,p_data;
  return jsonb_build_object('ok',true,'row',to_jsonb(r));
end $$;

-- Tiny per-table signatures avoid downloading unchanged history. No timestamp
-- cursor can miss an out-of-order transaction. Deletes are intentionally unsupported.
create or replace function public.ledger_manifest() returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare t text; result jsonb := '{}'::jsonb; signature text;
begin
  foreach t in array array['exercises','routines','sessions','cardio','body'] loop
    execute format('select count(*)::text || '':'' || coalesce(sum(version),0)::text from public.%I where user_id=auth.uid()',t) into signature;
    result := result || jsonb_build_object(t,signature);
  end loop;
  return result;
end $$;
revoke all on function public.ledger_write(text,text,jsonb,bigint) from public, anon;
revoke all on function public.ledger_manifest() from public, anon;
revoke all on function public.ledger_revision() from public, anon;
grant execute on function public.ledger_write(text,text,jsonb,bigint) to authenticated;
grant execute on function public.ledger_manifest() to authenticated;
commit;
