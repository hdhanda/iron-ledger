const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLocalBridge}=require('../tools/health-connector-local.cjs');
const SOURCE='synthetic.watch',BLUETOOTH='synthetic.bluetooth';
const config={source_policy:{version:'watch-primary-v1',workout_source_allowlist:[SOURCE],primary_hr:'apple_watch'}};
function point(metric,date,value,source=SOURCE,end=date){return {metric,source_bundle_identifier:source,source_name:source===SOURCE?'Synthetic Watch':'Synthetic Bluetooth',kind:'quantity',start_time_ms:Date.parse(date),start_time_local:date,end_time_ms:Date.parse(end),end_time_local:end,value};}
function fixture(){
 const workout={metric:'workout',source_bundle_identifier:SOURCE,source_name:'Synthetic Watch',kind:'workout',start_time_ms:Date.parse('2026-10-28T16:00:00Z'),start_time_local:'2026-10-28T09:00:00-07:00',end_time_ms:Date.parse('2026-10-28T16:02:00Z'),end_time_local:'2026-10-28T09:02:00-07:00',activity:'HKWorkoutActivityType(rawValue: 37)',duration_sec:100,total_energy_kcal:20,total_distance_m:400};
 const data={workout:[workout],heartRate:[point('heartRate','2026-10-28T16:00:00Z',100),point('heartRate','2026-10-28T16:00:05Z',110),point('heartRate','2026-10-28T16:01:55Z',120),point('heartRate','2026-10-28T16:03:00Z',90),point('heartRate','2026-10-28T16:00:00Z',200,BLUETOOTH)],stepCount:[point('stepCount','2026-10-28T16:00:00Z',1000,SOURCE,'2026-10-28T17:00:00Z')]};
 return {data,manifest:{schema_version:1,complete:true,omitted:0,timezone:'America/Los_Angeles',window_start:'2026-10-28T07:00:00Z',window_end:'2026-10-29T07:00:00Z',record_counts:Object.fromEntries(Object.entries(data).map(([k,a])=>[k,a.length])),units:{heartRate:'count/min',stepCount:'count'},extracted_at:'2026-10-29T08:00:00Z',extraction_time_verified:true}};
}
test('SQL staging -> archive -> atomic native projection -> exact replay; caller needs SQL only',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture(),text=JSON.stringify(data);
  const result=await local.submit(text,manifest,'synthetic-first');assert.equal(result.status,'completed',JSON.stringify(local.errors));assert.equal(result.workouts_inserted,1);assert.equal(result.observations_inserted,0);assert.equal(result.links,0);assert.equal(result.projection_mode,'summary_only');
  assert.equal((await local.pg.query('select count(*)::int n from health_workouts')).rows[0].n,1);assert.equal((await local.pg.query('select count(*)::int n from health_workout_derived')).rows[0].n,1);
  assert.equal(local.objects.size,2);assert.equal(Buffer.from([...local.objects.entries()].find(([k])=>!k.endsWith('.manifest.json'))[1]).toString(),text);assert.equal((await local.pg.query('select count(*)::int n from health_private.connector_parts')).rows[0].n,0);
  const d=(await local.pg.query('select * from health_workout_derived')).rows[0];assert.equal(d.sample_count,3);assert.equal(d.hr_max_bpm,120);assert.equal(d.elapsed_sec,120);assert.equal(d.duration_sec,100);assert.equal(d.estimated_paused_sec,20);assert.equal(d.pace_moving_sec_per_km,250);assert.equal(d.heart_rate_recovery_1min_bpm,30);assert.equal(d.coverage_ratio,1/3);assert.equal(d.hr_avg_bpm,110);assert.equal(d.hr_min_bpm,100);assert.equal(d.hr_p50_bpm,110);assert.equal(d.hr_p95_bpm,119);assert.equal(d.pace_elapsed_sec_per_km,300);assert.equal(d.speed_mean_mps,4);assert.equal(d.energy_per_min_kcal,12);assert.equal(d.heart_rate_recovery_2min_bpm,null);assert.deepEqual(d.quality_flags,['sparse_hr_coverage','recovery_2min_unavailable']);assert.equal(d.hr_zone_seconds,null);assert.equal(d.data_sources.hr_primary[0],SOURCE);
  const w=(await local.pg.query('select active_energy,reported_workout_energy_kcal from health_workouts')).rows[0];assert.equal(w.active_energy,null);assert.equal(w.reported_workout_energy_kcal,20);
  const replay=await local.submit(text,manifest,'synthetic-second');assert.equal(replay.status,'completed');assert.equal(replay.workouts_inserted,0);assert.equal(replay.workouts_unchanged,1);assert.equal(replay.observations_inserted,0);
  assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='succeeded'")).rows[0].n,2);
  const verification=(await local.pg.query('select verification_jsonb from health_sync_runs order by started_at desc limit 1')).rows[0].verification_jsonb;assert.equal(verification.raw_archives_verified,true);assert.equal(verification.database_readback_verified,true);assert.equal(verification.projection_mode,'summary_only');
  const archivedManifest=JSON.parse(Buffer.from([...local.objects.entries()].find(([k])=>k.endsWith('.manifest.json'))[1]).toString());assert.deepEqual(archivedManifest.units,manifest.units);assert.deepEqual(archivedManifest.record_counts,manifest.record_counts);
  const again=await local.submit(text,manifest,'synthetic-second');assert.equal(again.replay,true);
 }finally{await local.pg.close();}
});
test('missing/corrupt chunks and incomplete manifests cannot dispatch; frontend cannot stage',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture(),{hash}=await import('../supabase/functions/import-health/parser.mjs'),text=JSON.stringify(data);
  const m={...manifest,payload_sha256:await hash(text),payload_bytes:Buffer.byteLength(text),part_count:2};
  await assert.rejects(()=>local.pg.query('select health_private.connector_begin($1,$2::jsonb,$3)',[local.owner,JSON.stringify({...m,complete:false}),'bad']),/invalid_extraction_manifest/);
  const job=(await local.pg.query('select health_private.connector_begin($1,$2::jsonb,$3) result',[local.owner,JSON.stringify(m),'parts'])).rows[0].result.job_id;
  await local.pg.query('select health_private.connector_append($1,0,$2)',[job,text.slice(0,100)]);
  await assert.rejects(()=>local.pg.query('select health_private.connector_finish($1)',[job]),/staging_integrity_mismatch/);
  await assert.rejects(()=>local.pg.query('select health_private.connector_append($1,0,$2)',[job,'changed']),/staging_part_conflict/);
  await local.pg.exec('set role authenticated;');
  await assert.rejects(()=>local.pg.query('select health_private.connector_status($1)',[job]),/permission denied/);
  await assert.rejects(()=>local.pg.query("select public.health_connector_claim($1,'bad')",[job]),/permission denied/);
  await local.pg.exec('reset role;');
  assert.equal((await local.pg.query('select count(*)::int n from net.http_request_queue')).rows[0].n,0);
 }finally{await local.pg.close();}
});
test('newer corrections refresh summaries and preserve raw versions; older corrections do not overwrite',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();assert.equal((await local.submit(JSON.stringify(data),manifest,'initial')).status,'completed');
  data.heartRate[0].value=105;data.workout[0].total_energy_kcal=21;
  const newer={...manifest,extracted_at:'2026-10-30T08:00:00Z'};const changed=await local.submit(JSON.stringify(data),newer,'corrected');assert.equal(changed.status,'completed');assert.equal(changed.workouts_updated,1);
  assert.equal((await local.pg.query('select count(*)::int n from health_workouts')).rows[0].n,1);
  assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);assert.equal(local.objects.size,4);
  assert.equal((await local.pg.query('select count(*)::int n from health_workout_observation_links')).rows[0].n,0);
  data.heartRate[0].value=99;data.workout[0].total_energy_kcal=19;const stale=await local.submit(JSON.stringify(data),manifest,'stale');assert.equal(stale.status,'retryable');
  assert.equal((await local.pg.query('select reported_workout_energy_kcal v from health_workouts')).rows[0].v,21);
 }finally{await local.pg.close();}
});
module.exports={fixture,config};

async function historicalPoint(local,key,p,fingerprint='a'.repeat(64)){
 const id=(await local.pg.query(`insert into health_metric_observations(user_id,raw_batch_id,raw_json_path,fingerprint,
  metric_name,observed_at,end_at,value_numeric,unit,source,value_jsonb,provenance_jsonb,aggregation_level,is_aggregated)
  select user_id,raw_batch_id,'/historical/0',$2,'heartRate',$3,$3,$4,'count/min',$5,$6::jsonb,$7::jsonb,'native_sample',false
  from health_workouts where workout_key=$1 returning id`,[key,fingerprint,p.start_time_local,p.value,p.source_name,
   JSON.stringify(p),JSON.stringify({connector:'chatgpt_health_native',source_bundle_identifier:SOURCE})])).rows[0].id;
 return id;
}
async function sampleSnapshot(local){
 return {observations:(await local.pg.query('select * from health_metric_observations order by id')).rows,
  links:(await local.pg.query('select * from health_workout_observation_links order by observation_id')).rows};
}
test('reimport preserves historical observations and links byte-for-byte, and owner views remain isolated',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();await local.submit(JSON.stringify(data),manifest,'before-history');
  const w=(await local.pg.query('select * from health_workouts')).rows[0],id=await historicalPoint(local,w.workout_key,data.heartRate[0]);
  await local.pg.query("insert into health_workout_observation_links(user_id,workout_key,observation_id,association) values($1,$2,$3,'within_workout')",[local.owner,w.workout_key,id]);
  // Emulate an existing V1 workout whose provenance predates the summary-only revision.
  await local.pg.query("update health_workouts set provenance_jsonb=provenance_jsonb-'summary_input'");
  const before=await sampleSnapshot(local);
  const result=await local.submit(JSON.stringify(data),manifest,'with-history');assert.equal(result.status,'completed');
  assert.equal(result.workouts_inserted,0);assert.equal(result.observations_inserted,0);assert.equal(result.links,0);
  assert.deepEqual(await sampleSnapshot(local),before);
  assert.equal((await local.pg.query('select count(*)::int n from health_workout_derived')).rows[0].n,1);
  await local.pg.exec(`set role authenticated;set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222'`);
  for(const table of ['health_connector_workout_summary','health_connector_workout_points','health_sync_runs'])assert.equal((await local.pg.query(`select count(*)::int n from ${table}`)).rows[0].n,0);
  await local.pg.exec('reset role');
 }finally{await local.pg.close();}
});
test('October 28 strength ambiguity regression: summaries succeed while the original link guard still rejects ambiguity',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();data.workout[0].activity='HKWorkoutActivityType(rawValue: 50)';
  await local.submit(JSON.stringify(data),manifest,'strength-first');
  const w=(await local.pg.query('select * from health_workouts')).rows[0],id=await historicalPoint(local,w.workout_key,data.heartRate[0]);
  await local.pg.query("insert into health_workout_observation_links(user_id,workout_key,observation_id,association) values($1,$2,$3,'within_workout')",[local.owner,w.workout_key,id]);
  await local.pg.query(`insert into health_workouts(user_id,raw_batch_id,raw_json_path,workout_key,activity_type,start_at,end_at,duration_sec,source,route_present,provenance_jsonb)
   values($1,$2,'/workout/0','synthetic-overlapping-workout','Walking','2026-10-28T15:59Z','2026-10-28T16:01Z',120,'Synthetic Watch',false,$3::jsonb)`,
   [local.owner,w.raw_batch_id,JSON.stringify({connector:'chatgpt_health_native',source_bundle_identifier:SOURCE})]);
  const bad=await historicalPoint(local,w.workout_key,data.heartRate[0],'b'.repeat(64));
  await assert.rejects(()=>local.pg.query("insert into health_workout_observation_links(user_id,workout_key,observation_id,association) values($1,$2,$3,'within_workout')",[local.owner,w.workout_key,bad]),/ambiguous_workout_association/);
  const before=await sampleSnapshot(local);
  // A new input version may legitimately exclude newly ambiguous points.
  const result=await local.submit(JSON.stringify(data),{...manifest,extracted_at:'2026-10-30T08:00:00Z'},'strength-retry');
  assert.equal(result.status,'completed',JSON.stringify(local.errors));assert.equal(result.observations_inserted,0);
  assert.deepEqual(await sampleSnapshot(local),before);
  assert.equal((await local.pg.query('select count(*)::int n from health_workout_derived')).rows[0].n,1);
  assert.equal((await local.pg.query('select sample_count from health_workout_derived')).rows[0].sample_count,1);
 }finally{await local.pg.close();}
});

test('archive failures keep projections empty; dispatch retry completes without losing failure audit',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture(),archive=local.repository.archive;local.repository.archive=async()=>{throw Error('simulated_storage_failure');};
  const result=await local.submit(JSON.stringify(data),manifest,'archive-failure');assert.equal(result.status,'retryable');
  assert.equal((await local.pg.query('select count(*)::int n from health_workouts')).rows[0].n,0);
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='failed'")).rows[0].n,1);
  local.repository.archive=archive;
  await local.pg.query('select health_private.connector_dispatch($1)',[result.job_id]);
  const q=(await local.pg.query('select * from net.http_request_queue order by id desc limit 1')).rows[0];
  const response=await local.worker(new Request('https://local.invalid/',{method:'POST',headers:{'x-health-job-token':q.headers['x-health-job-token']},body:JSON.stringify(q.body)}));
  assert.equal((await response.json()).status,'completed');
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='failed'")).rows[0].n,1);
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='succeeded'")).rows[0].n,1);
  const unauthorized=await local.worker(new Request('https://local.invalid/',{method:'POST',body:JSON.stringify(q.body)}));assert.equal(unauthorized.status,401);
 }finally{await local.pg.close();}
});

test('units required, WHOOP filtered, configurable future metrics and coarse values remain unlinked',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();delete manifest.units.heartRate;
  const missing=await local.submit(JSON.stringify(data),manifest,'no-units');assert.equal(missing.status,'retryable');assert.equal(local.objects.size,0);
  await local.pg.query('select health_private.connector_cancel($1)',[missing.job_id]);
  assert.equal((await local.pg.query('select count(*)::int n from health_private.connector_parts')).rows[0].n,0);
  manifest.units.heartRate='count/min';data.heartRate.push({...data.heartRate[0],source_name:'WHOOP',source_bundle_identifier:'synthetic.whoop'});
  data.futureRelevantMetric=[point('futureRelevantMetric','2026-10-28T16:00:00Z',42)];manifest.units.futureRelevantMetric='custom';manifest.record_counts=Object.fromEntries(Object.entries(data).map(([k,a])=>[k,a.length]));
  data.walkingHeartRateAverage=[point('walkingHeartRateAverage','2026-10-28T16:00:00Z',150)];manifest.units.walkingHeartRateAverage='count/min';manifest.record_counts.walkingHeartRateAverage=1;
  await local.pg.exec("update health_sync_config set enabled_metric_identifiers=enabled_metric_identifiers||array['futureRelevantMetric'],include_coarse_buckets=true");
  const good=await local.submit(JSON.stringify(data),manifest,'new-metric');assert.equal(good.status,'completed');assert.equal(good.excluded.excluded_source,1);
  assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);assert.equal(good.observations_seen,9);
  assert.equal((await local.pg.query("select count(*)::int n from health_connector_workout_points where metric_name='stepCount'")).rows[0].n,0);
  assert.equal((await local.pg.query('select hr_max_bpm from health_workout_derived')).rows[0].hr_max_bpm,120);
  assert.equal(good.excluded.coarse_not_summarized,1);
 }finally{await local.pg.close();}
});

test('a late SQL projection failure rolls back workouts, points, links and derived results together',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture(),rpc=local.repository.rpc;
  local.repository.rpc=async(name,args)=>{if(name==='health_connector_commit')args.p_rows.derived[0].coverage_ratio=2;return rpc(name,args);};
  const failed=await local.submit(JSON.stringify(data),manifest,'atomic-failure');assert.equal(failed.status,'retryable');assert.equal(local.objects.size,2);
  for(const table of ['health_workouts','health_metric_observations','health_workout_observation_links','health_workout_derived'])assert.equal((await local.pg.query(`select count(*)::int n from ${table}`)).rows[0].n,0);
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='succeeded'")).rows[0].n,0);
 }finally{await local.pg.close();}
});

test('native cutoff uses Los Angeles DST and contradictory received timestamps fail',async()=>{
 const {projectConnector}=await import('../supabase/functions/process-health-connector/adapter.mjs');
 const {data,manifest}=fixture(),w=data.workout[0];
 const shift=Date.parse('2026-11-02T08:00:00Z')-w.start_time_ms;
 for(const rows of Object.values(data))for(const p of rows){p.start_time_ms+=shift;p.end_time_ms+=shift;p.start_time_local=new Date(p.start_time_ms).toISOString();p.end_time_local=new Date(p.end_time_ms).toISOString();}
 const cfg={...config,algorithm_version:'chatgpt-health-v1',cutoff_local_date:'2026-11-02',timezone:'America/Los_Angeles',enabled_metric_identifiers:['heartRate','stepCount'],post_workout_hr_minutes:5};
 const m={...manifest,window_start:'2026-11-02T08:00:00Z',window_end:'2026-11-03T08:00:00Z'};
 assert.equal((await projectConnector(data,m,cfg,'11111111-1111-1111-1111-111111111111')).workouts.length,1);
 delete data.workout[0].total_distance_m;data.workout[0].total_energy_kcal=null;
 const missing=await projectConnector(data,m,cfg,'11111111-1111-1111-1111-111111111111');
 assert.equal(missing.workouts[0].distance_m,null);assert.equal(missing.derived[0].pace_moving_sec_per_km,null);assert.equal(missing.derived[0].energy_per_min_kcal,null);
 data.heartRate[0].start_time_ms-=3600000;
 await assert.rejects(()=>projectConnector(data,m,cfg,'11111111-1111-1111-1111-111111111111'),/invalid_point_time/);
});

test('sample-only corrections require a newer verified extraction; summaries never hydrate old points',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();await local.submit(JSON.stringify(data),manifest,'sample-original');
  data.heartRate[0].value=105;
  const stale=await local.submit(JSON.stringify(data),manifest,'sample-stale');assert.equal(stale.status,'retryable');
  assert.equal((await local.pg.query('select hr_min_bpm from health_workout_derived')).rows[0].hr_min_bpm,100);
  const good=await local.submit(JSON.stringify(data),{...manifest,extracted_at:'2026-10-30T08:00:00Z'},'sample-newer');
  assert.equal(good.status,'completed');assert.equal(good.workouts_unchanged,1);
  assert.equal((await local.pg.query('select hr_min_bpm from health_workout_derived')).rows[0].hr_min_bpm,105);
  assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);
 }finally{await local.pg.close();}
});
test('walking metrics, VO2 context, duplicate/conflicting HR and reference units remain explicit',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();data.workout[0].activity='HKWorkoutActivityType(rawValue: 52)';
  data.heartRate.push({...data.heartRate[0]},point('heartRate','2026-10-28T16:00:05Z',115));
  data.walkingSpeed=[point('walkingSpeed','2026-10-28T16:00:10Z',1),point('walkingSpeed','2026-10-28T16:00:20Z',2)];
  data.walkingStepLength=[point('walkingStepLength','2026-10-28T16:00:10Z',0.8),point('walkingStepLength','2026-10-28T16:00:20Z',1,BLUETOOTH)];
  data.vo2Max=[point('vo2Max','2026-10-28T16:10:00Z',42)];
  manifest.record_counts=Object.fromEntries(Object.entries(data).map(([k,a])=>[k,a.length]));
  Object.assign(manifest.units,{walkingSpeed:'m/s',walkingStepLength:'m',vo2Max:'ml/(kg·min)'});manifest.unit_origin='approved_reference_metadata';
  assert.equal((await local.submit(JSON.stringify(data),manifest,'walking')).status,'completed');
  const d=(await local.pg.query('select * from health_workout_derived')).rows[0];
  assert.equal(d.sample_count,2);assert.equal(d.hr_p50_bpm,110);assert.equal(d.walking_gait_summary.walkingSpeed.mean,1.5);
  assert.equal(d.walking_gait_summary.walkingSpeed.min,1);assert.equal(d.walking_gait_summary.walkingSpeed.max,2);assert.equal(d.walking_gait_summary.walkingSpeed.count,2);
  assert.equal(d.walking_gait_summary.walkingStepLength,undefined);assert.equal(d.vo2max_context.value,42);
  for(const flag of ['conflicting_same_source_timestamps_excluded','gait_multiple_sources_or_units_not_combined','units_from_reference_manifest'])assert.ok(d.quality_flags.includes(flag));
  assert.equal(d.hr_max_bpm,120);assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);
 }finally{await local.pg.close();}
});
test('archive verification and exact derived readback must both succeed before sync success',async()=>{
 for(const failure of ['download','missing-object','readback']){
  const local=await createLocalBridge(config);try{
   const {data,manifest}=fixture();
   if(failure==='download')local.repository.verifyArchive=async()=>{throw Error('checksum_mismatch');};
   if(failure==='missing-object'){
    const rpc=local.repository.rpc;local.repository.rpc=async(name,args)=>{if(name==='health_connector_commit')await local.pg.exec('delete from storage.objects');return rpc(name,args);};
   }
   if(failure==='readback')await local.pg.exec(`create function synthetic_tamper() returns trigger language plpgsql as $$begin new.hr_max_bpm:=130;return new;end$$;
    create trigger synthetic_tamper before insert on health_workout_derived for each row execute function synthetic_tamper();`);
   const result=await local.submit(JSON.stringify(data),manifest,'verification-'+failure);assert.equal(result.status,'retryable');
   for(const table of ['health_workouts','health_workout_derived','health_metric_observations','health_workout_observation_links'])assert.equal((await local.pg.query(`select count(*)::int n from ${table}`)).rows[0].n,0);
   assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='succeeded'")).rows[0].n,0);
   if(failure==='readback')assert.ok(local.errors.some(e=>e.message==='projection_readback_failed'));
  }finally{await local.pg.close();}
 }
});
test('native commit rejects point writes and out-of-scope derived records, retaining the service-only interface',async()=>{
 for(const mutation of ['points','scope']){
  const local=await createLocalBridge(config);try{
   const {data,manifest}=fixture(),rpc=local.repository.rpc;
   local.repository.rpc=async(name,args)=>{
    if(name==='health_connector_commit'){
     if(mutation==='points')args.p_rows.observations=[{fingerprint:'a'.repeat(64)}];
     else args.p_rows.derived[0].workout_key='not-a-submitted-workout';
    }
    return rpc(name,args);
   };
   assert.equal((await local.submit(JSON.stringify(data),manifest,mutation)).status,'retryable');
   assert.equal((await local.pg.query('select count(*)::int n from health_workouts')).rows[0].n,0);
   assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,0);
   for(const role of ['anon','authenticated']){
    await local.pg.exec('set role '+role);
    await assert.rejects(()=>local.pg.query("select public.health_connector_commit(null,'bad',null,'{}')"),/permission denied/);
    await local.pg.exec('reset role');
   }
  }finally{await local.pg.close();}
 }
});
test('strength matching and manual rejections survive imports without changing lifting logs or Ledger RPCs',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();data.workout[0].activity='HKWorkoutActivityType(rawValue: 50)';
  await local.pg.query('insert into sessions(user_id,id,data) values($1,$2,$3::jsonb)',[local.owner,'synthetic-lifting-session',JSON.stringify({status:'completed',startedAt:data.workout[0].start_time_ms,entries:[{exercise:'synthetic',reps:5}]})]);
  const before=(await local.pg.query('select * from sessions')).rows;
  const functions=(await local.pg.query("select pg_get_functiondef(oid) def from pg_proc where pronamespace='public'::regnamespace and proname like 'ledger_%' order by proname")).rows;
  assert.equal((await local.submit(JSON.stringify(data),manifest,'match-first')).status,'completed');
  assert.equal((await local.pg.query('select session_id from health_workout_matches')).rows[0].session_id,'synthetic-lifting-session');
  await local.pg.exec("update health_workout_matches set match_method='manual',match_status='rejected',review_notes='preserve this decision'");
  const match=(await local.pg.query('select * from health_workout_matches')).rows;
  assert.equal((await local.submit(JSON.stringify(data),manifest,'match-replay')).status,'completed');
  assert.deepEqual((await local.pg.query('select * from health_workout_matches')).rows,match);
  assert.deepEqual((await local.pg.query('select * from sessions')).rows,before);
  assert.deepEqual((await local.pg.query("select pg_get_functiondef(oid) def from pg_proc where pronamespace='public'::regnamespace and proname like 'ledger_%' order by proname")).rows,functions);
 }finally{await local.pg.close();}
});
test('a single-workout reimport leaves a neighboring workout summary unchanged',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture(),single=structuredClone(data);
  const later=structuredClone(data.workout[0]);
  for(const p of [later,...data.heartRate.map(p=>structuredClone(p))]){
   p.start_time_ms+=600000;p.end_time_ms+=600000;p.start_time_local=new Date(p.start_time_ms).toISOString();p.end_time_local=new Date(p.end_time_ms).toISOString();
   if(p.metric==='heartRate')data.heartRate.push(p);
  }
  data.workout.push(later);manifest.record_counts=Object.fromEntries(Object.entries(data).map(([k,a])=>[k,a.length]));
  assert.equal((await local.submit(JSON.stringify(data),manifest,'both-workouts')).status,'completed');
  const before=(await local.pg.query('select d.* from health_workout_derived d join health_workouts w using(user_id,workout_key) order by w.start_at desc limit 1')).rows[0];
  const result=await local.submit(JSON.stringify(single),{...manifest,record_counts:Object.fromEntries(Object.entries(single).map(([k,a])=>[k,a.length]))},'first-workout-only');
  assert.equal(result.status,'completed');assert.equal(result.derived,1);
  const after=(await local.pg.query('select * from health_workout_derived where workout_key=$1',[before.workout_key])).rows[0];assert.deepEqual(after,before);
 }finally{await local.pg.close();}
});
test('both recovery targets use the selected Watch stream; Bluetooth alone never becomes Watch HR',async()=>{
 const {projectConnector}=await import('../supabase/functions/process-health-connector/adapter.mjs');
 const {data,manifest}=fixture(),c={...config,algorithm_version:'chatgpt-health-v1',cutoff_local_date:'2026-09-01',timezone:'America/Los_Angeles',enabled_metric_identifiers:['heartRate','stepCount'],post_workout_hr_minutes:5};
 data.heartRate.push(point('heartRate','2026-10-28T16:04:00Z',80),point('heartRate','2026-10-28T16:03:00Z',150,BLUETOOTH));manifest.record_counts.heartRate=data.heartRate.length;
 let result=await projectConnector(data,manifest,c,'11111111-1111-1111-1111-111111111111');
 assert.equal(result.derived[0].heart_rate_recovery_1min_bpm,30);assert.equal(result.derived[0].heart_rate_recovery_2min_bpm,40);
 data.heartRate=data.heartRate.filter(p=>p.source_bundle_identifier===BLUETOOTH);manifest.record_counts.heartRate=data.heartRate.length;
 result=await projectConnector(data,manifest,c,'11111111-1111-1111-1111-111111111111');
 const d=result.derived[0];assert.equal(d.sample_count,0);assert.equal(d.hr_avg_bpm,null);assert.equal(d.hr_max_bpm,null);assert.equal(d.coverage_ratio,null);assert.ok(d.quality_flags.includes('no_valid_primary_hr'));
});
