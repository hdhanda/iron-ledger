// Synthetic data only, isolated PostgreSQL. Never reads real Health payloads or credentials.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const pg=new PGlite(),owner='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
 try{
  await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;
   create schema auth;create table auth.users(id uuid primary key);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth,public to authenticated,anon,service_role;
   grant execute on function auth.uid() to authenticated,anon,service_role;
   insert into auth.users values('${owner}'),('${other}');
   create schema storage;create table storage.objects(id text,bucket_id text);
   create table storage.buckets(id text,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  for(const file of ['supabase.sql','supabase/migrations/20261015051442_apple_health_import.sql','supabase/migrations/20261015051937_health_import_credentials.sql'])
   await pg.exec(fs.readFileSync(path.join(__dirname,'..',file),'utf8'));
  await pg.query('insert into sessions(user_id,id,data) values($1,$2,$3::jsonb)',[owner,'synthetic-lift',JSON.stringify({startedAt:Date.parse('2026-10-28T16:00:00Z'),entries:[{exercise:'synthetic',reps:5}]})]);
  const legacy=await pg.query("select data from sessions where id='synthetic-lift'");
  const functionsBefore=await pg.query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname like 'ledger_%' order by proname");
  const triggersBefore=await pg.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='sessions'::regclass and not tgisinternal order by tgname");
  await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261029040928_chatgpt_health_connector_v1.sql'),'utf8'));
  assert.deepEqual(await pg.query("select data from sessions where id='synthetic-lift'"),legacy);
  assert.deepEqual(await pg.query("select proname,pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname like 'ledger_%' order by proname"),functionsBefore);
  assert.deepEqual(await pg.query("select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='sessions'::regclass and not tgisinternal order by tgname"),triggersBefore);
  const config=(await pg.query('select * from health_sync_config')).rows[0];
  assert.equal(config.automation_enabled,false);assert.equal(config.include_coarse_buckets,false);
  assert.equal(config.post_workout_hr_minutes,5);assert.deepEqual(config.source_policy.workout_source_allowlist,[]);
  assert.equal((await pg.query("select '2026-09-01 00:00'::timestamp at time zone 'America/Los_Angeles' = '2026-09-01T07:00Z'::timestamptz ok")).rows[0].ok,true);
  assert.equal((await pg.query("select '2026-11-02 00:00'::timestamp at time zone 'America/Los_Angeles' = '2026-11-02T08:00Z'::timestamptz ok")).rows[0].ok,true);
  const batch=(await pg.query("insert into health_import_batches(user_id,data_families,payload_sha256,storage_path,bytes,processing_status) values($1,array['workout'],$2,'synthetic-private-archive',10,'completed') returning id",[owner,'a'.repeat(64)])).rows[0].id;
  async function workout(key,start,end,activity='Running'){
   await pg.query(`insert into health_workouts(user_id,raw_batch_id,raw_json_path,workout_key,activity_type,start_at,end_at,duration_sec,distance_m,
    reported_workout_energy_kcal,energy_unit,source,route_present,provenance_jsonb)
    values($1,$2,'/workout/0',$3,$4,$5,$6,1800,null,200,'kcal','Synthetic Watch',false,$7::jsonb)`,
    [owner,batch,key,activity,start,end,JSON.stringify({connector:'chatgpt_health_native',source_bundle_identifier:'synthetic.watch'})]);
  }
  await workout('run','2026-10-28T16:00Z','2026-10-28T16:35Z');
  assert.deepEqual((await pg.query("select duration_sec,distance_m,active_energy,reported_workout_energy_kcal from health_workouts where workout_key='run'")).rows[0],{duration_sec:1800,distance_m:null,active_energy:null,reported_workout_energy_kcal:200});
  let seq=0;
  async function observation(metric='heartRate',start='2026-10-28T16:01Z',end=start,source='Synthetic Watch',extra={}){
   return (await pg.query(`insert into health_metric_observations(user_id,raw_batch_id,raw_json_path,fingerprint,metric_name,observed_at,end_at,
    value_numeric,unit,source,value_jsonb,provenance_jsonb,aggregation_level) values($1,$2,'/samples/0',$3,$4,$5,$6,120,'count/min',$7,$8::jsonb,$9::jsonb,$10) returning id`,
    [owner,batch,(++seq).toString(16).padStart(64,'0'),metric,start,end,source,JSON.stringify({metric,source_name:source}),JSON.stringify({connector:'chatgpt_health_native',...extra}),extra.aggregation_level??null])).rows[0].id;
  }
  async function link(id,association='within_workout',key='run'){
   return pg.query('insert into health_workout_observation_links(user_id,workout_key,observation_id,association) values($1,$2,$3,$4)',[owner,key,id,association]);
  }
  const point=await observation();
  await assert.rejects(()=>link(point),/verified_workout_source_required/);
  await pg.query("update health_sync_config set source_policy=jsonb_set(source_policy,'{workout_source_allowlist}','[\"synthetic.watch\"]') where user_id=$1",[owner]);
  await link(point);
  await pg.query("insert into health_workout_observation_links select * from health_workout_observation_links where observation_id=$1 on conflict do nothing",[point]);
  assert.equal((await pg.query('select count(*)::int n from health_connector_workout_points')).rows[0].n,1);
  await assert.rejects(()=>pg.query("update health_workout_observation_links set association='post_workout_recovery' where observation_id=$1",[point]),/invalid_recovery_window/);
  await assert.rejects(()=>link(point),/duplicate key/);
  for(const metric of ['stepCount','distanceWalkingRunning','activeEnergyBurned','basalEnergyBurned','flightsClimbed']){
   const id=await observation(metric);await assert.rejects(()=>link(id),/coarse_samples_cannot_link/);
  }
  for(const source of ['WHOOP','Oura']){const id=await observation('heartRate',undefined,undefined,source);await assert.rejects(()=>link(id),/excluded_connector_source/);}
  const sleep=await observation('sleepAnalysis');await assert.rejects(()=>link(sleep),/metric_not_enabled/);
  const hourly=await observation('heartRate',undefined,undefined,undefined,{aggregation_level:'hourly'});await assert.rejects(()=>link(hourly),/coarse_samples_cannot_link/);
  const environment=await observation('environmentalAudioExposure');await assert.rejects(()=>link(environment),/optional_environment_disabled/);
  const gait=await observation('walkingSpeed');await assert.rejects(()=>link(gait),/gait_requires_walking_workout/);
  const outside=await observation('heartRate','2026-10-28T15:59Z');await assert.rejects(()=>link(outside),/sample_not_within_workout/);
  const boundary=await observation('heartRate','2026-10-28T15:59Z','2026-10-28T16:01Z');await link(boundary,'overlaps_workout');
  await assert.rejects(()=>link(boundary,'within_workout'),/sample_not_within_workout/);
  const context=await observation('vo2Max','2026-10-28T16:40Z');await link(context,'near_workout_context');
  const recovery=await observation('heartRate','2026-10-28T16:36Z');await link(recovery,'post_workout_recovery');
  const late=await observation('heartRate','2026-10-28T16:41Z');await assert.rejects(()=>link(late,'post_workout_recovery'),/invalid_recovery_window/);
  await workout('overlap','2026-10-28T16:10Z','2026-10-28T16:20Z');
  const ambiguous=await observation('heartRate','2026-10-28T16:10Z');await assert.rejects(()=>link(ambiguous),/ambiguous_workout_association/);
  await workout('old','2026-09-01T06:59Z','2026-09-01T07:30Z');
  const old=await observation('heartRate','2026-09-01T07:01Z');await assert.rejects(()=>link(old,'within_workout','old'),/connector_scope_required/);
  await pg.query("insert into health_workout_derived(user_id,workout_key,algorithm_version,source_policy,coverage_ratio) values($1,'run','chatgpt-health-v1','watch-primary-v1',0.5)",[owner]);
  await assert.rejects(()=>pg.query("update health_workout_derived set coverage_ratio=1.1"),/check constraint/);
  await assert.rejects(()=>pg.query("update health_workout_derived set hr_avg_bpm='NaN'::float8"),/check constraint/);
  await assert.rejects(()=>pg.query("update health_workout_derived set hr_zone_seconds='{\"zone1\":5}'"),/check constraint/);
  const run=(await pg.query("insert into health_sync_runs(user_id,trigger_type,requested_start_at,requested_end_at) values($1,'verification','2026-10-28T00:00Z','2026-10-29T00:00Z') returning id",[owner])).rows[0].id;
  await assert.rejects(()=>pg.query("update health_sync_runs set status='succeeded',finished_at=now() where id=$1",[run]),/check constraint/);
  await pg.query("update health_sync_runs set status='partial',finished_at=now(),errors_redacted='[\"connector_incomplete\"]' where id=$1",[run]);
  assert.equal((await pg.query('select needs_attention from health_connector_sync_status')).rows[0].needs_attention,true);
  await pg.query("update health_sync_runs set status='succeeded',result_complete=true,errors_redacted='[]',finished_at=now(),last_successful_at=now(),verification_jsonb='{\"database_readback_verified\":true,\"raw_archives_verified\":true}' where id=$1",[run]);
  assert.equal((await pg.query('select needs_attention from health_connector_sync_status')).rows[0].needs_attention,false);
  const newTables=['health_sync_config','health_sync_runs','health_workout_derived','health_workout_observation_links'];
  const views=['health_connector_sync_status','health_connector_workout_summary','health_connector_workout_points'];
  await pg.exec(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
  for(const table of [...newTables,...views])assert.ok((await pg.query(`select count(*)::int n from public.${table}`)).rows[0].n>0);
  for(const table of newTables){
   await assert.rejects(()=>pg.exec(`delete from public.${table}`),/permission denied/);
   await assert.rejects(()=>pg.exec(`update public.${table} set user_id='${other}'`),/permission denied/);
  }
  await pg.exec(`set request.jwt.claim.sub='${other}';`);
  for(const table of [...newTables,...views])assert.equal((await pg.query(`select count(*)::int n from public.${table}`)).rows[0].n,0);
  await pg.exec('reset role;set role anon;');
  for(const table of [...newTables,...views])await assert.rejects(()=>pg.exec(`select * from public.${table}`),/permission denied/);
  await pg.exec('reset role;set role service_role;');
  const servicePoint=await observation('heartRate','2026-10-28T16:25Z');await link(servicePoint);
  assert.equal((await pg.query('select count(*)::int n from health_connector_workout_points')).rows[0].n,5);
  console.log('PASS: connector schema, source/cutoff/association guards, replay, energy semantics, sync completeness, RLS and legacy preservation.');
 }finally{await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
