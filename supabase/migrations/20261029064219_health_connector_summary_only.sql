-- Native Health summary-only projection. No tables, columns, triggers or data are removed.
-- Deploy only after owner approval; pair with the summary-only worker.
begin;
set local lock_timeout='5s';

create or replace function health_private.connector_context_revision(p_owner uuid,p_start timestamptz,p_end timestamptz) returns text
language sql stable security invoker set search_path='' as $$
 select md5(coalesce(string_agg(w.workout_key||':'||w.provenance_jsonb::text,'|' order by w.workout_key),''))
 from public.health_workouts w where user_id=p_owner and provenance_jsonb->>'connector'='chatgpt_health_native'
  and start_at<p_end+interval '30 minutes' and end_at>=p_start-interval '30 minutes'
$$;

create or replace function public.health_connector_claim(p_job uuid,p_token_hash text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; c public.health_sync_config; lease text; ws jsonb; first_at timestamptz; last_at timestamptz; revision text;
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
 if jsonb_array_length(ws)>100 then raise exception 'context_limit_split_window'; end if;
 lease:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
 revision:=health_private.connector_context_revision(j.user_id,first_at,last_at);
 update health_private.connector_jobs set state='processing',lease_hash=encode(sha256(convert_to(lease,'UTF8')),'hex'),lease_until=now()+interval '5 minutes',
  context_revision=revision,config_revision=md5(to_jsonb(c)::text),updated_at=clock_timestamp() where id=p_job;
 return jsonb_build_object('state','processing','job_id',j.id,'owner',j.user_id,'lease',lease,'payload_text',j.payload_text,'manifest',j.manifest,
  'manifest_sha256',j.manifest_sha256,'manifest_text',j.manifest::text,'config',to_jsonb(c),'context',jsonb_build_object('workouts',ws,'observations','[]'::jsonb));
end $$;

create or replace function public.health_connector_commit(p_job uuid,p_lease text,p_batch uuid,p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare j health_private.connector_jobs; c public.health_sync_config; b public.health_import_batches; native_rows jsonb;
 inserted integer; updated integer; unchanged integer; observations_before bigint; links_before bigint; finished timestamptz; v_counts jsonb; raw_path text; manifest_path text;
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
 -- Summary-only is a backend contract, not a client toggle. Reject older workers
 -- rather than accepting any point/event/series writes through this native RPC.
 if p_rows->>'projection_mode' is distinct from 'summary_only'
  or p_rows->'observations' is distinct from '[]'::jsonb
  or p_rows->'links' is distinct from '[]'::jsonb
  or p_rows->'superseded' is distinct from '[]'::jsonb
  or p_rows->'events' is distinct from '[]'::jsonb
  or p_rows->'series' is distinct from '[]'::jsonb
  or jsonb_typeof(p_rows->'workouts') is distinct from 'array'
  or jsonb_typeof(p_rows->'derived') is distinct from 'array'
  or jsonb_typeof(p_rows->'recompute_keys') is distinct from 'array'
  then raise exception 'summary_only_projection_required'; end if;
 if jsonb_array_length(p_rows->'workouts')<>(j.manifest->'record_counts'->>'workout')::integer
  or jsonb_array_length(p_rows->'derived')<>jsonb_array_length(p_rows->'workouts')
  or jsonb_array_length(p_rows->'recompute_keys')<>jsonb_array_length(p_rows->'workouts')
  or (select count(distinct r->>'workout_key') from jsonb_array_elements(p_rows->'workouts') r)<>jsonb_array_length(p_rows->'workouts')
  or (select count(distinct r->>'workout_key') from jsonb_array_elements(p_rows->'derived') r)<>jsonb_array_length(p_rows->'workouts')
  or exists(select 1 from jsonb_array_elements(p_rows->'derived') d where d->>'algorithm_version' is distinct from c.algorithm_version
    or not exists(select 1 from jsonb_array_elements(p_rows->'workouts') w where w->>'workout_key'=d->>'workout_key'))
  or exists(select 1 from jsonb_array_elements_text(p_rows->'recompute_keys') k where not exists(
    select 1 from jsonb_array_elements(p_rows->'workouts') w where w->>'workout_key'=k))
  then raise exception 'summary_projection_scope_mismatch'; end if;
 select count(*) into observations_before from public.health_metric_observations where user_id=j.user_id;
 select count(*) into links_before from public.health_workout_observation_links where user_id=j.user_id;
 delete from public.health_workout_derived where user_id=j.user_id and algorithm_version=c.algorithm_version
  and workout_key in(select r->>'workout_key' from jsonb_array_elements(p_rows->'workouts') r);
 native_rows:=jsonb_build_object(
  'workouts',(select coalesce(jsonb_agg(r),'[]') from jsonb_array_elements(p_rows->'workouts') r where not exists(select 1 from public.health_workouts w where w.user_id=j.user_id and w.workout_key=r->>'workout_key' and w.provenance_jsonb->>'record_fingerprint'=r->'provenance_jsonb'->>'record_fingerprint')),
  'observations','[]'::jsonb,'events','[]'::jsonb,'series','[]'::jsonb,'unknown_families','[]'::jsonb,'warnings','[]'::jsonb);
 update public.health_import_batches set processing_status='accepted' where id=p_batch;
 perform public.health_commit_projection(p_batch,j.user_id,native_rows);
 update public.health_workouts w set reported_workout_energy_kcal=(r->>'reported_workout_energy_kcal')::float8,
  provenance_jsonb=r->'provenance_jsonb',raw_batch_id=p_batch,raw_json_path=r->>'raw_json_path',updated_at=now()
  from jsonb_array_elements(p_rows->'workouts') r where w.user_id=j.user_id and w.workout_key=r->>'workout_key';
 insert into public.health_workout_derived select (jsonb_populate_record(null::public.health_workout_derived,value||jsonb_build_object('user_id',j.user_id,'computed_at',now()))).*
  from jsonb_array_elements(p_rows->'derived');
 update public.health_workouts w set hr_avg=d.hr_avg_bpm,hr_max=d.hr_max_bpm from public.health_workout_derived d
  where w.user_id=j.user_id and d.user_id=w.user_id and d.workout_key=w.workout_key and d.algorithm_version=c.algorithm_version
   and w.workout_key in(select jsonb_array_elements_text(p_rows->'recompute_keys'));
 if inserted+updated+unchanged<>(j.manifest->'record_counts'->>'workout')::integer
  or exists(select 1 from jsonb_array_elements(p_rows->'workouts') r where not exists(select 1 from public.health_workouts w where w.user_id=j.user_id and w.workout_key=r->>'workout_key' and w.provenance_jsonb->>'record_fingerprint'=r->'provenance_jsonb'->>'record_fingerprint'))
  or exists(select 1 from jsonb_array_elements(p_rows->'derived') d where not exists(
    select 1 from public.health_workout_derived actual where actual.user_id=j.user_id
     and actual.workout_key=d->>'workout_key' and actual.algorithm_version=c.algorithm_version
     and to_jsonb(actual)-'user_id'-'computed_at' =
      to_jsonb(jsonb_populate_record(null::public.health_workout_derived,d))-'user_id'-'computed_at'))
  or (select count(*) from public.health_metric_observations where user_id=j.user_id)<>observations_before
  or (select count(*) from public.health_workout_observation_links where user_id=j.user_id)<>links_before
  then raise exception 'projection_readback_failed'; end if;
 v_counts:=(p_rows->'counts')||jsonb_build_object('workouts_inserted',inserted,'workouts_updated',updated,'workouts_unchanged',unchanged,'projection_mode','summary_only','observations_inserted',0,'links',0,'derived',jsonb_array_length(p_rows->'derived'));
 finished:=clock_timestamp();
 update public.health_import_batches set counts=v_counts||jsonb_build_object('native_connector',true),aggregation_info=aggregation_info||jsonb_build_object('manifest_path',manifest_path,'projection_mode','summary_only'),processing_status='completed',processed_at=finished where id=p_batch;
 update public.health_sync_runs set status='succeeded',finished_at=finished,last_successful_at=finished,result_complete=true,
  workouts_seen=inserted+updated+unchanged,workouts_inserted=inserted,workouts_updated=updated,workouts_unchanged=unchanged,
  observations_seen=(v_counts->>'observations_seen')::integer,observations_inserted=0,errors_redacted='[]',
  import_batches=jsonb_build_array(p_batch),verification_jsonb=jsonb_build_object('database_readback_verified',true,'raw_archives_verified',true,'projection_mode','summary_only','historical_samples_untouched',true,'excluded',v_counts->'excluded') where id=j.run_id;
 update health_private.connector_jobs set state='completed',result=v_counts||jsonb_build_object('batch_id',p_batch,'status','completed'),payload_text=null,updated_at=finished where id=p_job;
 delete from health_private.connector_parts where job_id=p_job;
 return v_counts||jsonb_build_object('batch_id',p_batch,'status','completed');
end $$;

-- CREATE OR REPLACE retains existing grants; make the service-only contract explicit.
revoke all on function health_private.connector_context_revision(uuid,timestamptz,timestamptz),public.health_connector_claim(uuid,text),public.health_connector_commit(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function health_private.connector_context_revision(uuid,timestamptz,timestamptz),public.health_connector_claim(uuid,text),public.health_connector_commit(uuid,text,uuid,jsonb) to service_role;
commit;
