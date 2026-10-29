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
  const result=await local.submit(text,manifest,'synthetic-first');assert.equal(result.status,'completed',JSON.stringify(local.errors));assert.equal(result.workouts_inserted,1);assert.equal(result.observations_inserted,5);
  assert.equal(local.objects.size,2);assert.equal((await local.pg.query('select count(*)::int n from health_private.connector_parts')).rows[0].n,0);
  const d=(await local.pg.query('select * from health_workout_derived')).rows[0];assert.equal(d.sample_count,3);assert.equal(d.hr_max_bpm,120);assert.equal(d.elapsed_sec,120);assert.equal(d.duration_sec,100);assert.equal(d.estimated_paused_sec,20);assert.equal(d.pace_moving_sec_per_km,250);assert.equal(d.heart_rate_recovery_1min_bpm,30);assert.ok(d.coverage_ratio<0.8);
  const w=(await local.pg.query('select active_energy,reported_workout_energy_kcal from health_workouts')).rows[0];assert.equal(w.active_energy,null);assert.equal(w.reported_workout_energy_kcal,20);
  const replay=await local.submit(text,manifest,'synthetic-second');assert.equal(replay.status,'completed');assert.equal(replay.workouts_inserted,0);assert.equal(replay.workouts_unchanged,1);assert.equal(replay.observations_inserted,0);
  assert.equal((await local.pg.query('select count(*)::int n from health_metric_observations')).rows[0].n,5);
  assert.equal((await local.pg.query("select count(*)::int n from health_sync_runs where status='succeeded'")).rows[0].n,2);
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
test('newer corrections retain originals but supersede old readings; older corrections do not overwrite',async()=>{
 const local=await createLocalBridge(config);try{
  const {data,manifest}=fixture();assert.equal((await local.submit(JSON.stringify(data),manifest,'initial')).status,'completed');
  data.heartRate[0].value=105;data.workout[0].total_energy_kcal=21;
  const newer={...manifest,extracted_at:'2026-10-30T08:00:00Z'};const changed=await local.submit(JSON.stringify(data),newer,'corrected');assert.equal(changed.status,'completed');assert.equal(changed.workouts_updated,1);
  assert.equal((await local.pg.query('select count(*)::int n from health_workouts')).rows[0].n,1);
  assert.equal((await local.pg.query("select count(*)::int n from health_metric_observations where provenance_jsonb ? 'superseded_by'")).rows[0].n,1);
  assert.equal((await local.pg.query('select count(*)::int n from health_workout_observation_links')).rows[0].n,5);
  data.heartRate[0].value=99;data.workout[0].total_energy_kcal=19;const stale=await local.submit(JSON.stringify(data),manifest,'stale');assert.equal(stale.status,'retryable');
  assert.equal((await local.pg.query('select reported_workout_energy_kcal v from health_workouts')).rows[0].v,21);
 }finally{await local.pg.close();}
});
module.exports={fixture,config};

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
  assert.equal((await local.pg.query("select count(*)::int n from health_metric_observations where metric_name='futureRelevantMetric'")).rows[0].n,1);
  assert.equal((await local.pg.query("select count(*)::int n from health_connector_workout_points where metric_name='stepCount'")).rows[0].n,0);
  assert.equal((await local.pg.query("select provenance_jsonb->>'association' a from health_metric_observations where metric_name='stepCount'")).rows[0].a,'coarse_unattributable');
  assert.equal((await local.pg.query("select is_aggregated from health_metric_observations where metric_name='walkingHeartRateAverage'")).rows[0].is_aggregated,true);
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
