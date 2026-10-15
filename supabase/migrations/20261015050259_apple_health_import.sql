-- Additive development migration. Existing Ledger tables/RPCs remain authoritative.
begin;
create schema if not exists health_private;
revoke all on schema health_private from public, anon, authenticated;
create table public.health_import_batches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 data_families text[] not null, automation_id text, vendor_session_id text,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'), storage_path text not null,
 bytes bigint not null check(bytes between 1 and 2097152), export_version text, received_at timestamptz not null default now(),
 processed_at timestamptz, processing_status text not null check(processing_status in ('accepted','completed','retryable','quarantined')),
 counts jsonb not null default '{}', aggregation_info jsonb not null default '{}', schema_version int not null default 1,
 error_reason_redacted text, unique(user_id,payload_sha256), unique(user_id,id)
);
create table public.health_workouts (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 raw_batch_id uuid not null,
 raw_json_path text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,id),
 foreign key(user_id,raw_batch_id) references public.health_import_batches(user_id,id),
 workout_key text not null, external_id text, activity_type text not null,
 start_at timestamptz not null, end_at timestamptz not null, source_timestamp text, source_timezone text,
 duration_sec double precision check(duration_sec>=0), distance_m double precision check(distance_m>=0),
 distance_original double precision, distance_unit text, active_energy double precision, energy_unit text,
 hr_avg double precision, hr_max double precision, source text, route_present boolean not null,
 provenance_jsonb jsonb not null, unique(user_id,workout_key)
);
create table public.health_metric_observations (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 raw_batch_id uuid not null,
 raw_json_path text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,id),
 foreign key(user_id,raw_batch_id) references public.health_import_batches(user_id,id),
 fingerprint text not null, metric_name text not null, observed_at timestamptz, end_at timestamptz,
 source_timestamp text, source_timezone text, value_numeric double precision, unit text,
 source text, source_sample_id text, aggregation_level text, is_aggregated boolean,
 value_jsonb jsonb not null, unique(user_id,fingerprint), provenance_jsonb jsonb not null
);
create table public.health_events (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 raw_batch_id uuid not null,
 raw_json_path text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,id),
 foreign key(user_id,raw_batch_id) references public.health_import_batches(user_id,id),
 data_family text not null, source_event_id text, event_fingerprint text not null,
 start_at timestamptz, end_at timestamptz, source_timestamp text, source_timezone text,
 summary_type text, summary_jsonb jsonb not null, unique(user_id,event_fingerprint)
);
create table public.health_workout_series (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 raw_batch_id uuid not null,
 raw_json_path text not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(user_id,id),
 foreign key(user_id,raw_batch_id) references public.health_import_batches(user_id,id),
 fingerprint text not null, metric_name text not null, observed_at timestamptz, end_at timestamptz,
 source_timestamp text, source_timezone text, value_numeric double precision, unit text,
 source text, source_sample_id text, aggregation_level text, is_aggregated boolean,
 value_jsonb jsonb not null, unique(user_id,fingerprint), workout_key text not null,
 foreign key(user_id,workout_key) references public.health_workouts(user_id,workout_key)
);
create table public.health_workout_matches (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 workout_key text not null, session_id text, match_status text not null check(match_status in ('matched','review','rejected')),
 match_method text not null, offset_sec double precision, review_notes text,
 updated_at timestamptz not null default now(), unique(user_id,workout_key), unique(user_id,session_id),
 foreign key(user_id,workout_key) references public.health_workouts(user_id,workout_key),
 foreign key(user_id,session_id) references public.sessions(user_id,id)
);
create index health_workouts_start on public.health_workouts(user_id,start_at desc);
create index health_workouts_activity on public.health_workouts(user_id,activity_type,start_at desc);
create index health_observations_metric on public.health_metric_observations(user_id,metric_name,observed_at desc);
create index health_series_metric on public.health_workout_series(user_id,workout_key,metric_name,observed_at);
create index health_events_family on public.health_events(user_id,data_family,start_at desc);
create index health_batches_received on public.health_import_batches(user_id,received_at desc);
alter table public.health_import_batches enable row level security;
revoke all on public.health_import_batches from public, anon, authenticated;
grant select on public.health_import_batches to authenticated;
grant all on public.health_import_batches to service_role;
create policy health_owner_read on public.health_import_batches for select to authenticated using ((select auth.uid())=user_id);
alter table public.health_workouts enable row level security;
revoke all on public.health_workouts from public, anon, authenticated;
grant select on public.health_workouts to authenticated;
grant all on public.health_workouts to service_role;
create policy health_owner_read on public.health_workouts for select to authenticated using ((select auth.uid())=user_id);
alter table public.health_metric_observations enable row level security;
revoke all on public.health_metric_observations from public, anon, authenticated;
grant select on public.health_metric_observations to authenticated;
grant all on public.health_metric_observations to service_role;
create policy health_owner_read on public.health_metric_observations for select to authenticated using ((select auth.uid())=user_id);
alter table public.health_events enable row level security;
revoke all on public.health_events from public, anon, authenticated;
grant select on public.health_events to authenticated;
grant all on public.health_events to service_role;
create policy health_owner_read on public.health_events for select to authenticated using ((select auth.uid())=user_id);
alter table public.health_workout_series enable row level security;
revoke all on public.health_workout_series from public, anon, authenticated;
grant select on public.health_workout_series to authenticated;
grant all on public.health_workout_series to service_role;
create policy health_owner_read on public.health_workout_series for select to authenticated using ((select auth.uid())=user_id);
alter table public.health_workout_matches enable row level security;
revoke all on public.health_workout_matches from public, anon, authenticated;
grant select on public.health_workout_matches to authenticated;
grant all on public.health_workout_matches to service_role;
create policy health_owner_read on public.health_workout_matches for select to authenticated using ((select auth.uid())=user_id);
-- No client policies on raw objects: only the trusted server can retrieve archives.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values ('health-raw','health-raw',false,2097152,array['application/json']);
create policy health_raw_client_deny on storage.objects as restrictive for all to anon,authenticated
 using (bucket_id<>'health-raw') with check (bucket_id<>'health-raw');

create table health_private.rate_limits(user_id uuid primary key, window_at timestamptz not null, requests int not null);
grant usage on schema health_private to service_role;
grant all on all tables in schema health_private to service_role;
alter table health_private.rate_limits enable row level security;
create function public.health_import_rate(p_owner uuid) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n int;
begin
 insert into health_private.rate_limits values(p_owner,date_trunc('minute',now()),1)
 on conflict(user_id) do update set
 requests=case when rate_limits.window_at=date_trunc('minute',now()) then rate_limits.requests+1 else 1 end,
 window_at=date_trunc('minute',now()) returning requests into n;
 return n<=60;
end $$;
create function public.health_register_batch(p_batch jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare b public.health_import_batches;
begin
 insert into public.health_import_batches(user_id,data_families,automation_id,vendor_session_id,payload_sha256,storage_path,bytes,export_version,processing_status,aggregation_info)
 values ((p_batch->>'user_id')::uuid,array(select jsonb_array_elements_text(p_batch->'data_families')),p_batch->>'automation_id',p_batch->>'vendor_session_id',p_batch->>'payload_sha256',p_batch->>'storage_path',(p_batch->>'bytes')::bigint,p_batch->>'export_version','accepted',p_batch->'aggregation_info')
 on conflict(user_id,payload_sha256) do nothing;
 select * into strict b from public.health_import_batches where user_id=(p_batch->>'user_id')::uuid and payload_sha256=p_batch->>'payload_sha256';
 return to_jsonb(b);
end $$;
create function public.health_requeue_batch(p_batch uuid,p_owner uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,42));
 update public.health_import_batches set processing_status='accepted',error_reason_redacted=null where id=p_batch and user_id=p_owner;
 if not found then raise exception 'batch not found'; end if;
end $$;
create function public.health_fail_batch(p_batch uuid,p_owner uuid,p_reason text) returns void
language sql security invoker set search_path='' as $$
 update public.health_import_batches set processing_status='retryable',error_reason_redacted='projection_failed'
 where id=p_batch and user_id=p_owner and processing_status not in ('completed','quarantined');
$$;
grant select on public.sessions to service_role;
create function public.health_reconcile(p_owner uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,42));
 delete from public.health_workout_matches where user_id=p_owner and match_method='auto_start';
 with candidates as (
 select w.workout_key,s.id session_id,
 abs(extract(epoch from w.start_at)-(case when jsonb_typeof(s.data->'startedAt')='number' then (s.data->>'startedAt')::double precision/1000 end)) offset_sec
 from public.health_workouts w join public.sessions s on s.user_id=w.user_id
 where w.user_id=p_owner and w.activity_type in ('Traditional Strength Training','Functional Strength Training','Strength Training')
 and s.status in ('completed','deload') and jsonb_typeof(s.data->'startedAt')='number'
 and case when jsonb_typeof(s.data->'startedAt')='number' then (s.data->>'startedAt')::numeric between 0 and 7258118400000 else false end
 and not exists(select 1 from public.health_workout_matches m where m.user_id=p_owner and m.match_method<>'auto_start' and (m.workout_key=w.workout_key or m.session_id=s.id))
 ), nearby as (select * from candidates where offset_sec<=900),
 ranked as (
 select *,row_number() over(partition by workout_key order by offset_sec,session_id) wr,
 lead(offset_sec) over(partition by workout_key order by offset_sec,session_id) next_workout,
 row_number() over(partition by session_id order by offset_sec,workout_key) sr,
 lead(offset_sec) over(partition by session_id order by offset_sec,workout_key) next_session from nearby
 )
 insert into public.health_workout_matches(user_id,workout_key,session_id,match_status,match_method,offset_sec,review_notes)
 select p_owner,workout_key,case when sr=1 and coalesce(next_workout-offset_sec,300)>=300 and coalesce(next_session-offset_sec,300)>=300 then session_id end,
 case when sr=1 and coalesce(next_workout-offset_sec,300)>=300 and coalesce(next_session-offset_sec,300)>=300 then 'matched' else 'review' end,
 'auto_start',offset_sec,'Start-time comparison; session end is not used.' from ranked where wr=1;
end $$;
-- Trigger executes as owner because authenticated Ledger writers cannot mutate health tables.
-- NEW.user_id is constrained by existing sessions RLS. No client parameters or dynamic SQL.
create function health_private.reconcile_session() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (select auth.uid()) is not null and (select auth.uid())<>new.user_id then raise exception 'owner mismatch'; end if;
 perform public.health_reconcile(new.user_id);return new;
end $$;
revoke all on function health_private.reconcile_session() from public,anon,authenticated;
create trigger health_session_reconcile after insert or update on public.sessions for each row execute function health_private.reconcile_session();
create function public.health_commit_projection(p_batch uuid,p_owner uuid,p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare b public.health_import_batches; v_counts jsonb := '{}'; n int;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,42));
 select * into strict b from public.health_import_batches where id=p_batch and user_id=p_owner for update;
 if b.processing_status in ('completed','quarantined') then return jsonb_build_object('status',b.processing_status,'counts',b.counts); end if;
 insert into public.health_workouts(user_id,raw_batch_id,workout_key,external_id,activity_type,start_at,end_at,source_timestamp,source_timezone,duration_sec,distance_m,distance_original,distance_unit,active_energy,energy_unit,hr_avg,hr_max,source,route_present,provenance_jsonb,raw_json_path)
 select p_owner,p_batch,r.workout_key,r.external_id,r.activity_type,r.start_at,r.end_at,r.source_timestamp,r.source_timezone,r.duration_sec,r.distance_m,r.distance_original,r.distance_unit,r.active_energy,r.energy_unit,r.hr_avg,r.hr_max,r.source,r.route_present,r.provenance_jsonb,r.raw_json_path from jsonb_populate_recordset(null::public.health_workouts,p_rows->'workouts') r
 on conflict(user_id,workout_key) do update set external_id=excluded.external_id,activity_type=excluded.activity_type,start_at=excluded.start_at,end_at=excluded.end_at,source_timestamp=excluded.source_timestamp,source_timezone=excluded.source_timezone,duration_sec=excluded.duration_sec,distance_m=excluded.distance_m,distance_original=excluded.distance_original,distance_unit=excluded.distance_unit,active_energy=excluded.active_energy,energy_unit=excluded.energy_unit,hr_avg=excluded.hr_avg,hr_max=excluded.hr_max,source=excluded.source,route_present=excluded.route_present,provenance_jsonb=excluded.provenance_jsonb,raw_json_path=excluded.raw_json_path,raw_batch_id=excluded.raw_batch_id,updated_at=now();
 get diagnostics n = row_count; v_counts=v_counts||jsonb_build_object('workouts',n);
 insert into public.health_metric_observations(user_id,raw_batch_id,fingerprint,metric_name,observed_at,end_at,source_timestamp,source_timezone,value_numeric,unit,source,source_sample_id,aggregation_level,is_aggregated,value_jsonb,provenance_jsonb,raw_json_path)
 select p_owner,p_batch,r.fingerprint,r.metric_name,r.observed_at,r.end_at,r.source_timestamp,r.source_timezone,r.value_numeric,r.unit,r.source,r.source_sample_id,r.aggregation_level,r.is_aggregated,r.value_jsonb,r.provenance_jsonb,r.raw_json_path from jsonb_populate_recordset(null::public.health_metric_observations,p_rows->'observations') r
 on conflict(user_id,fingerprint) do update set metric_name=excluded.metric_name,observed_at=excluded.observed_at,end_at=excluded.end_at,source_timestamp=excluded.source_timestamp,source_timezone=excluded.source_timezone,value_numeric=excluded.value_numeric,unit=excluded.unit,source=excluded.source,source_sample_id=excluded.source_sample_id,aggregation_level=excluded.aggregation_level,is_aggregated=excluded.is_aggregated,value_jsonb=excluded.value_jsonb,provenance_jsonb=excluded.provenance_jsonb,raw_json_path=excluded.raw_json_path,raw_batch_id=excluded.raw_batch_id,updated_at=now();
 get diagnostics n = row_count; v_counts=v_counts||jsonb_build_object('observations',n);
 insert into public.health_events(user_id,raw_batch_id,data_family,source_event_id,event_fingerprint,start_at,end_at,source_timestamp,source_timezone,summary_type,summary_jsonb,raw_json_path)
 select p_owner,p_batch,r.data_family,r.source_event_id,r.event_fingerprint,r.start_at,r.end_at,r.source_timestamp,r.source_timezone,r.summary_type,r.summary_jsonb,r.raw_json_path from jsonb_populate_recordset(null::public.health_events,p_rows->'events') r
 on conflict(user_id,event_fingerprint) do update set data_family=excluded.data_family,source_event_id=excluded.source_event_id,start_at=excluded.start_at,end_at=excluded.end_at,source_timestamp=excluded.source_timestamp,source_timezone=excluded.source_timezone,summary_type=excluded.summary_type,summary_jsonb=excluded.summary_jsonb,raw_json_path=excluded.raw_json_path,raw_batch_id=excluded.raw_batch_id,updated_at=now();
 get diagnostics n = row_count; v_counts=v_counts||jsonb_build_object('events',n);
 insert into public.health_workout_series(user_id,raw_batch_id,fingerprint,metric_name,observed_at,end_at,source_timestamp,source_timezone,value_numeric,unit,source,source_sample_id,aggregation_level,is_aggregated,value_jsonb,workout_key,raw_json_path)
 select p_owner,p_batch,r.fingerprint,r.metric_name,r.observed_at,r.end_at,r.source_timestamp,r.source_timezone,r.value_numeric,r.unit,r.source,r.source_sample_id,r.aggregation_level,r.is_aggregated,r.value_jsonb,r.workout_key,r.raw_json_path from jsonb_populate_recordset(null::public.health_workout_series,p_rows->'series') r
 on conflict(user_id,fingerprint) do update set metric_name=excluded.metric_name,observed_at=excluded.observed_at,end_at=excluded.end_at,source_timestamp=excluded.source_timestamp,source_timezone=excluded.source_timezone,value_numeric=excluded.value_numeric,unit=excluded.unit,source=excluded.source,source_sample_id=excluded.source_sample_id,aggregation_level=excluded.aggregation_level,is_aggregated=excluded.is_aggregated,value_jsonb=excluded.value_jsonb,workout_key=excluded.workout_key,raw_json_path=excluded.raw_json_path,raw_batch_id=excluded.raw_batch_id,updated_at=now();
 get diagnostics n = row_count; v_counts=v_counts||jsonb_build_object('series',n);
 perform public.health_reconcile(p_owner);
 update public.health_import_batches set processing_status=case when jsonb_array_length(p_rows->'unknown_families')>0 or jsonb_array_length(p_rows->'warnings')>0 then 'quarantined' else 'completed' end,
 counts=v_counts,processed_at=now(),error_reason_redacted=null where id=p_batch and user_id=p_owner returning * into b;
 return jsonb_build_object('status',b.processing_status,'counts',b.counts);
end $$;
revoke all on function public.health_import_rate(uuid) from public,anon,authenticated;
grant execute on function public.health_import_rate(uuid) to service_role;
revoke all on function public.health_register_batch(jsonb) from public,anon,authenticated;
grant execute on function public.health_register_batch(jsonb) to service_role;
revoke all on function public.health_fail_batch(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.health_fail_batch(uuid,uuid,text) to service_role;
revoke all on function public.health_reconcile(uuid) from public,anon,authenticated;
grant execute on function public.health_reconcile(uuid) to service_role;
revoke all on function public.health_commit_projection(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.health_commit_projection(uuid,uuid,jsonb) to service_role;
revoke all on function public.health_requeue_batch(uuid,uuid) from public,anon,authenticated;
grant execute on function public.health_requeue_batch(uuid,uuid) to service_role;
commit;
