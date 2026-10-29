-- SQL-only client bridge: administrative staging -> one-shot pg_net -> private worker.
-- No recurring job is created. Apply only after deployment approval.
begin;
set local lock_timeout='5s';
create extension if not exists pg_net;
revoke all on all tables in schema net from public,anon,authenticated;
revoke execute on all functions in schema net from public,anon,authenticated;
grant usage on schema net to service_role;
grant select on net._http_response to service_role;
grant execute on function net.http_post(text,jsonb,jsonb,jsonb,integer) to service_role;

create table health_private.connector_jobs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.health_sync_config(user_id),
 request_key text not null check(length(request_key) between 1 and 100),
 manifest jsonb not null,
 manifest_sha256 text not null,
 payload_sha256 text not null check(payload_sha256 ~ '^[0-9a-f]{64}$'),
 expected_bytes integer not null check(expected_bytes between 1 and 1572864),
 expected_parts integer not null check(expected_parts between 1 and 96),
 state text not null default 'collecting' check(state in('collecting','queued','processing','retryable','completed','cancelled')),
 run_id uuid not null,
 payload_text text,
 dispatch_token_hash text,
 dispatch_expires_at timestamptz,
 request_id bigint,
 lease_hash text,
 lease_until timestamptz,
 context_revision text,
 config_revision text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 result jsonb not null default '{}',
 error_code text,
 unique(user_id,request_key),
 foreign key(user_id,run_id) references public.health_sync_runs(user_id,id)
);
create index health_connector_jobs_run on health_private.connector_jobs(user_id,run_id);
create table health_private.connector_parts (
 job_id uuid not null references health_private.connector_jobs(id),
 part_index integer not null check(part_index between 0 and 95),
 body text not null check(octet_length(body) between 1 and 32768),
 primary key(job_id,part_index)
);
alter table health_private.connector_jobs enable row level security;
alter table health_private.connector_parts enable row level security;
revoke all on health_private.connector_jobs,health_private.connector_parts from public,anon,authenticated;
grant all on health_private.connector_jobs,health_private.connector_parts to service_role;
create policy health_connector_job_service on health_private.connector_jobs for all to service_role using(true) with check(true);
create policy health_connector_part_service on health_private.connector_parts for all to service_role using(true) with check(true);

create function health_private.connector_context_revision(p_owner uuid,p_start timestamptz,p_end timestamptz) returns text
language sql stable security invoker set search_path='' as $$
 select md5(coalesce(string_agg(value,'|' order by value),'')) from(
  select w.workout_key||':'||w.provenance_jsonb::text value from public.health_workouts w
   where user_id=p_owner and provenance_jsonb->>'connector'='chatgpt_health_native'
    and start_at<p_end+interval '30 minutes' and end_at>=p_start-interval '30 minutes'
  union all
  select o.fingerprint||':'||o.provenance_jsonb::text from public.health_metric_observations o
   where user_id=p_owner and provenance_jsonb->>'connector'='chatgpt_health_native'
    and observed_at<p_end+interval '30 minutes' and coalesce(end_at,observed_at)>=p_start-interval '30 minutes'
 ) context
$$;

create function health_private.connector_begin(p_owner uuid,p_manifest jsonb,p_request_key text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; r uuid; first_at timestamptz; last_at timestamptz; c public.health_sync_config;
begin
 select * into strict c from public.health_sync_config where user_id=p_owner;
 if p_manifest->>'schema_version' is distinct from '1' or p_manifest->>'complete' is distinct from 'true'
  or p_manifest->>'omitted' is distinct from '0' or p_manifest->>'timezone' is distinct from c.timezone
  or jsonb_typeof(p_manifest->'record_counts') is distinct from 'object' or jsonb_typeof(p_manifest->'units') is distinct from 'object'
  or coalesce(p_manifest->>'payload_sha256','') !~ '^[0-9a-f]{64}$' then raise exception 'invalid_extraction_manifest'; end if;
 first_at:=(p_manifest->>'window_start')::timestamptz; last_at:=(p_manifest->>'window_end')::timestamptz;
 if first_at is null or last_at is null or first_at < (c.cutoff_local_date::timestamp at time zone c.timezone)
  or last_at<=first_at or last_at-first_at>interval '8 days' then raise exception 'invalid_extraction_window'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,43));
 select * into j from health_private.connector_jobs where user_id=p_owner and request_key=p_request_key;
 if found then
  if j.manifest<>p_manifest then raise exception 'request_key_conflict'; end if;
  return jsonb_build_object('job_id',j.id,'state',j.state,'result',j.result,'replay',true);
 end if;
 insert into public.health_sync_runs(user_id,trigger_type,requested_start_at,requested_end_at,algorithm_version)
  values(p_owner,'manual',first_at,last_at,c.algorithm_version) returning id into r;
 insert into health_private.connector_jobs(user_id,request_key,manifest,manifest_sha256,payload_sha256,expected_bytes,expected_parts,run_id)
 values(p_owner,p_request_key,p_manifest,encode(sha256(convert_to(p_manifest::text,'UTF8')),'hex'),p_manifest->>'payload_sha256',
  (p_manifest->>'payload_bytes')::integer,(p_manifest->>'part_count')::integer,r) returning * into j;
 return jsonb_build_object('job_id',j.id,'state',j.state,'part_bytes_limit',32768);
end $$;

create function health_private.connector_append(p_job uuid,p_index integer,p_chunk text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; prior text; bytes bigint; n integer;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.state<>'collecting' or p_index<0 or p_index>=j.expected_parts or octet_length(p_chunk) not between 1 and 32768 then raise exception 'invalid_staging_part'; end if;
 select body into prior from health_private.connector_parts where job_id=p_job and part_index=p_index;
 if found and prior<>p_chunk then raise exception 'staging_part_conflict'; end if;
 insert into health_private.connector_parts values(p_job,p_index,p_chunk) on conflict do nothing;
 select count(*),sum(octet_length(body)) into n,bytes from health_private.connector_parts where job_id=p_job;
 if bytes>j.expected_bytes then raise exception 'staging_size_exceeded'; end if;
 return jsonb_build_object('job_id',p_job,'parts_received',n,'bytes_received',bytes);
end $$;

create function health_private.connector_dispatch(p_job uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; token text; request bigint; r uuid;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.state='completed' then return jsonb_build_object('job_id',j.id,'state',j.state,'result',j.result,'replay',true); end if;
 if j.state='cancelled' or j.payload_text is null then raise exception 'job_not_ready'; end if;
 if j.state='processing' and j.lease_until>now() then raise exception 'worker_lease_active'; end if;
 if j.state='queued' and j.updated_at>now()-interval '2 minutes' then return jsonb_build_object('job_id',j.id,'state','queued'); end if;
 if j.state in ('processing','queued','retryable') then
  update public.health_sync_runs set status='failed',finished_at=clock_timestamp(),errors_redacted='["worker_retry_requested"]' where id=j.run_id and status='running';
  insert into public.health_sync_runs(user_id,trigger_type,requested_start_at,requested_end_at,algorithm_version)
   select user_id,'manual',requested_start_at,requested_end_at,algorithm_version from public.health_sync_runs where id=j.run_id returning id into r;
 else r:=j.run_id; end if;
 token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 request:=net.http_post(url:='https://armhlqarrdzioobepcng.supabase.co/functions/v1/process-health-connector',
  body:=jsonb_build_object('job_id',j.id),headers:=jsonb_build_object('Content-Type','application/json','x-health-job-token',token),timeout_milliseconds:=30000);
 update health_private.connector_jobs set state='queued',run_id=r,dispatch_token_hash=encode(sha256(convert_to(token,'UTF8')),'hex'),
  dispatch_expires_at=now()+interval '15 minutes',request_id=request,lease_hash=null,lease_until=null,error_code=null,updated_at=clock_timestamp() where id=j.id;
 return jsonb_build_object('job_id',j.id,'state','queued','request_id',request);
end $$;

create function health_private.connector_finish(p_job uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; text_body text; n integer;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.state<>'collecting' then return health_private.connector_dispatch(j.id); end if;
 select count(*),string_agg(body,'' order by part_index) into n,text_body from health_private.connector_parts where job_id=p_job;
 if n<>j.expected_parts or octet_length(text_body)<>j.expected_bytes
  or encode(sha256(convert_to(text_body,'UTF8')),'hex')<>j.payload_sha256 then raise exception 'staging_integrity_mismatch'; end if;
 if jsonb_typeof(text_body::jsonb)<>'object' then raise exception 'invalid_native_json'; end if;
 update health_private.connector_jobs set payload_text=text_body where id=p_job;
 return health_private.connector_dispatch(p_job);
end $$;

-- These public-schema RPCs are solely for the service-key-authenticated worker.
create function public.health_connector_claim(p_job uuid,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; c public.health_sync_config; lease text; ws jsonb; obs jsonb; first_at timestamptz; last_at timestamptz; revision text;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.dispatch_token_hash is distinct from p_token_hash or j.dispatch_expires_at<now() then raise exception 'invalid_worker_dispatch'; end if;
 if j.state='completed' then return jsonb_build_object('state','completed','result',j.result); end if;
 if j.state='processing' and j.lease_until>now() then return jsonb_build_object('state','busy'); end if;
 if j.state<>'queued' then raise exception 'job_not_queued'; end if;
 select * into strict c from public.health_sync_config where user_id=j.user_id;
 first_at:=(j.manifest->>'window_start')::timestamptz;last_at:=(j.manifest->>'window_end')::timestamptz;
 select coalesce(jsonb_agg(to_jsonb(w)),'[]') into ws from(select * from public.health_workouts where user_id=j.user_id
  and provenance_jsonb->>'connector'='chatgpt_health_native' and start_at<last_at+interval '30 minutes' and end_at>=first_at-interval '30 minutes' limit 101) w;
 select coalesce(jsonb_agg(to_jsonb(o)),'[]') into obs from(select * from public.health_metric_observations where user_id=j.user_id
  and provenance_jsonb->>'connector'='chatgpt_health_native' and observed_at<last_at+interval '30 minutes' and coalesce(end_at,observed_at)>=first_at-interval '30 minutes' limit 20001) o;
 if jsonb_array_length(ws)>100 or jsonb_array_length(obs)>20000 then raise exception 'context_limit_split_window'; end if;
 lease:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 revision:=health_private.connector_context_revision(j.user_id,first_at,last_at);
 update health_private.connector_jobs set state='processing',lease_hash=encode(sha256(convert_to(lease,'UTF8')),'hex'),lease_until=now()+interval '5 minutes',
  context_revision=revision,config_revision=md5(to_jsonb(c)::text),updated_at=clock_timestamp() where id=p_job;
 return jsonb_build_object('state','processing','job_id',j.id,'owner',j.user_id,'lease',lease,'payload_text',j.payload_text,'manifest',j.manifest,
  'manifest_sha256',j.manifest_sha256,'manifest_text',j.manifest::text,'config',to_jsonb(c),'context',jsonb_build_object('workouts',ws,'observations',obs));
end $$;

create function public.health_connector_commit(p_job uuid,p_lease text,p_batch uuid,p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; c public.health_sync_config; b public.health_import_batches; x jsonb; native_rows jsonb;
 inserted integer; updated integer; unchanged integer; observations_new integer; finished timestamptz; v_counts jsonb; raw_path text; manifest_path text;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.lease_hash is distinct from encode(sha256(convert_to(p_lease,'UTF8')),'hex') or j.lease_until<now() then raise exception 'invalid_worker_lease'; end if;
 if j.state='completed' then return j.result; end if;
 if j.state<>'processing' then raise exception 'job_not_processing'; end if;
 perform pg_advisory_xact_lock(hashtextextended(j.user_id::text,42));
 select * into strict c from public.health_sync_config where user_id=j.user_id;
 if j.config_revision<>md5(to_jsonb(c)::text) or j.context_revision<>health_private.connector_context_revision(j.user_id,(j.manifest->>'window_start')::timestamptz,(j.manifest->>'window_end')::timestamptz) then raise exception 'context_changed_retry'; end if;
 raw_path:=j.user_id::text||'/chatgpt-native/'||j.payload_sha256||'.json';
 manifest_path:=j.user_id::text||'/chatgpt-native/'||j.payload_sha256||'.'||j.manifest_sha256||'.manifest.json';
 select * into strict b from public.health_import_batches where id=p_batch and user_id=j.user_id;
 if b.payload_sha256<>j.payload_sha256 or b.bytes<>j.expected_bytes or b.storage_path<>raw_path
  or not exists(select 1 from storage.objects where bucket_id='health-raw' and name=raw_path)
  or not exists(select 1 from storage.objects where bucket_id='health-raw' and name=manifest_path) then raise exception 'raw_archive_not_verified'; end if;
 select count(*) filter(where old.id is null),count(*) filter(where old.id is not null and old.provenance_jsonb->>'record_fingerprint' is distinct from r->'provenance_jsonb'->>'record_fingerprint'),
  count(*) filter(where old.id is not null and old.provenance_jsonb->>'record_fingerprint'=r->'provenance_jsonb'->>'record_fingerprint')
 into inserted,updated,unchanged from jsonb_array_elements(p_rows->'workouts') r
 left join public.health_workouts old on old.user_id=j.user_id and old.workout_key=r->>'workout_key';
 select count(*) into observations_new from jsonb_array_elements(p_rows->'observations') r where not exists(select 1 from public.health_metric_observations o where o.user_id=j.user_id and o.fingerprint=r->>'fingerprint');
 for x in select value from jsonb_array_elements(p_rows->'superseded') loop
  update public.health_metric_observations set provenance_jsonb=provenance_jsonb||jsonb_build_object('superseded_by',x->>'replacement'),updated_at=now()
   where user_id=j.user_id and fingerprint=x->>'fingerprint';
 end loop;
 delete from public.health_workout_observation_links where user_id=j.user_id and workout_key in(select jsonb_array_elements_text(p_rows->'recompute_keys'));
 delete from public.health_workout_derived where user_id=j.user_id and algorithm_version=c.algorithm_version and workout_key in(select jsonb_array_elements_text(p_rows->'recompute_keys'));
 native_rows:=p_rows||jsonb_build_object(
  'workouts',(select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(p_rows->'workouts') r where not exists(select 1 from public.health_workouts w where w.user_id=j.user_id and w.workout_key=r->>'workout_key' and w.provenance_jsonb->>'record_fingerprint'=r->'provenance_jsonb'->>'record_fingerprint')),
  'observations',(select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(p_rows->'observations') r where not exists(select 1 from public.health_metric_observations o where o.user_id=j.user_id and o.fingerprint=r->>'fingerprint')));
 update public.health_import_batches set processing_status='accepted' where id=p_batch;
 perform public.health_commit_projection(p_batch,j.user_id,native_rows);
 update public.health_workouts w set reported_workout_energy_kcal=(r->>'reported_workout_energy_kcal')::float8
  from jsonb_array_elements(p_rows->'workouts') r where w.user_id=j.user_id and w.workout_key=r->>'workout_key';
 for x in select value from jsonb_array_elements(p_rows->'links') loop
  insert into public.health_workout_observation_links(user_id,workout_key,observation_id,association,quality_flags)
   select j.user_id,x->>'workout_key',id,x->>'association',array(select jsonb_array_elements_text(x->'quality_flags'))
   from public.health_metric_observations where user_id=j.user_id and fingerprint=x->>'fingerprint';
  if not found then raise exception 'link_observation_missing'; end if;
 end loop;
 insert into public.health_workout_derived select (jsonb_populate_record(null::public.health_workout_derived,value||jsonb_build_object('user_id',j.user_id,'computed_at',now()))).*
  from jsonb_array_elements(p_rows->'derived');
 update public.health_workouts w set hr_avg=d.hr_avg_bpm,hr_max=d.hr_max_bpm from public.health_workout_derived d
  where w.user_id=j.user_id and d.user_id=w.user_id and d.workout_key=w.workout_key and d.algorithm_version=c.algorithm_version
   and w.workout_key in(select jsonb_array_elements_text(p_rows->'recompute_keys'));
 if inserted+updated+unchanged<>(j.manifest->'record_counts'->>'workout')::integer
  or exists(select 1 from jsonb_array_elements(p_rows->'workouts') r where not exists(select 1 from public.health_workouts w where w.user_id=j.user_id and w.workout_key=r->>'workout_key' and w.provenance_jsonb->>'record_fingerprint'=r->'provenance_jsonb'->>'record_fingerprint'))
  or (select count(*) from public.health_workout_observation_links where user_id=j.user_id and workout_key in(select jsonb_array_elements_text(p_rows->'recompute_keys')))<>jsonb_array_length(p_rows->'links')
  then raise exception 'projection_readback_failed'; end if;
 v_counts:=(p_rows->'counts')||jsonb_build_object('workouts_inserted',inserted,'workouts_updated',updated,'workouts_unchanged',unchanged,'observations_inserted',observations_new,'links',jsonb_array_length(p_rows->'links'),'derived',jsonb_array_length(p_rows->'derived'));
 finished:=clock_timestamp();
 update public.health_import_batches set counts=v_counts||jsonb_build_object('native_connector',true),aggregation_info=aggregation_info||jsonb_build_object('manifest_path',manifest_path),processing_status='completed',processed_at=finished where id=p_batch;
 update public.health_sync_runs set status='succeeded',finished_at=finished,last_successful_at=finished,result_complete=true,
  workouts_seen=inserted+updated+unchanged,workouts_inserted=inserted,workouts_updated=updated,workouts_unchanged=unchanged,
  observations_seen=(v_counts->>'observations_seen')::integer,observations_inserted=observations_new,errors_redacted='[]',
  import_batches=jsonb_build_array(p_batch),verification_jsonb=jsonb_build_object('database_readback_verified',true,'raw_archives_verified',true,'excluded',v_counts->'excluded') where id=j.run_id;
 update health_private.connector_jobs set state='completed',result=v_counts||jsonb_build_object('batch_id',p_batch,'status','completed'),payload_text=null,updated_at=finished where id=p_job;
 delete from health_private.connector_parts where job_id=p_job;
 return v_counts||jsonb_build_object('batch_id',p_batch,'status','completed');
end $$;

create function public.health_connector_fail(p_job uuid,p_lease text,p_code text) returns void
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.lease_hash is distinct from encode(sha256(convert_to(p_lease,'UTF8')),'hex') then raise exception 'invalid_worker_lease'; end if;
 if j.state='completed' then return; end if;
 update health_private.connector_jobs set state='retryable',error_code=case when p_code in ('correction_requires_newer_verified_extraction','missing_metric_unit','workout_scope_or_source','extraction_count_mismatch','staging_integrity_mismatch','manifest_integrity_mismatch') then p_code else 'processing_failed' end,lease_until=null,updated_at=clock_timestamp() where id=p_job;
 update public.health_sync_runs set status='failed',finished_at=clock_timestamp(),errors_redacted='["processing_failed"]' where id=j.run_id;
end $$;

create function health_private.connector_status(p_job uuid) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('job_id',j.id,'state',j.state,'result',j.result,'error',j.error_code,'run_id',j.run_id,
  'retry_allowed',j.state='retryable' or(j.state='queued' and j.updated_at<=now()-interval '2 minutes') or(j.state='processing' and j.lease_until<=now()),
  'parts_received',(select count(*) from health_private.connector_parts where job_id=j.id),
  'transport',(select jsonb_build_object('status_code',status_code,'timed_out',timed_out) from net._http_response where id=j.request_id order by created desc limit 1))
 from health_private.connector_jobs j where id=p_job
$$;

create function health_private.connector_cancel(p_job uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs;
begin
 select * into strict j from health_private.connector_jobs where id=p_job for update;
 if j.state='completed' then raise exception 'completed_job_cannot_cancel'; end if;
 update health_private.connector_jobs set state='cancelled',payload_text=null,dispatch_token_hash=null,lease_hash=null,lease_until=null,error_code='cancelled_by_owner',updated_at=clock_timestamp() where id=p_job;
 delete from health_private.connector_parts where job_id=p_job;
 update public.health_sync_runs set status='cancelled',finished_at=clock_timestamp(),errors_redacted='["cancelled_by_owner"]' where id=j.run_id;
end $$;

revoke all on function health_private.connector_context_revision(uuid,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function health_private.connector_begin(uuid,jsonb,text) from public,anon,authenticated;
revoke all on function health_private.connector_append(uuid,integer,text) from public,anon,authenticated;
revoke all on function health_private.connector_dispatch(uuid) from public,anon,authenticated;
revoke all on function health_private.connector_finish(uuid) from public,anon,authenticated;
revoke all on function health_private.connector_status(uuid) from public,anon,authenticated;
revoke all on function health_private.connector_cancel(uuid) from public,anon,authenticated;
revoke all on function public.health_connector_claim(uuid,text) from public,anon,authenticated;
revoke all on function public.health_connector_commit(uuid,text,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.health_connector_fail(uuid,text,text) from public,anon,authenticated;
grant execute on function health_private.connector_context_revision(uuid,timestamptz,timestamptz),health_private.connector_begin(uuid,jsonb,text),health_private.connector_append(uuid,integer,text),health_private.connector_dispatch(uuid),health_private.connector_finish(uuid),health_private.connector_status(uuid),health_private.connector_cancel(uuid),public.health_connector_claim(uuid,text),public.health_connector_commit(uuid,text,uuid,jsonb),public.health_connector_fail(uuid,text,text) to service_role;
commit;
