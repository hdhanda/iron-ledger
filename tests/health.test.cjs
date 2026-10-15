const test=require('node:test'),assert=require('node:assert/strict');
const owner='11111111-1111-1111-1111-111111111111',token='synthetic-import-token-000000000000000000000000000000000';
const date='2026-10-10 09:30:00 -0700';
const workout={id:'synthetic-workout',name:'Running',start:date,end:'2026-10-10 10:00:00 -0700',duration:1800,
 distance:{qty:3,units:'mi'},avgHeartRate:{qty:140,units:'bpm'},route:[{timestamp:date,latitude:0,longitude:0}],
 heartRateData:[{date,Min:120,Avg:140,Max:160,units:'bpm',source:'Synthetic Watch'}],
 futurePower:[{date:'2026-10-10 09:30:01 -0700',qty:200,units:'W',newField:'retained'}],metadata:{future:{x:true}}};
async function setup(){const parser=await import('../supabase/functions/import-health/parser.mjs');const handler=await import('../supabase/functions/import-health/handler.mjs');return {...parser,...handler};}
function memory(){return {archives:new Map(),batches:new Map(),commits:[],writes:0,allow:true,fail:false,
 async rateLimit(){this.writes++;return this.allow},async findBatch(o,h){return this.batches.get(h)},
 async archive(path,bytes){this.archives.set(path,bytes.slice())},async register(row){let b=this.batches.get(row.payload_sha256);if(!b){b={...row,id:'synthetic-batch'};this.batches.set(row.payload_sha256,b)}return b},
 async commit(id,o,rows){if(this.fail)throw Error('private raw error');this.commits.push(rows);const b=[...this.batches.values()][0];b.processing_status=rows.unknown_families.length?'quarantined':'completed';b.counts={observations:rows.observations.length};return {status:b.processing_status,counts:b.counts}},
 async failed(){[...this.batches.values()][0].processing_status='retryable'}};}
function req(body,headers={},secret=token){return new Request('https://synthetic.invalid/import-health',{method:'POST',headers:{'Content-Type':'application/json','x-health-import-token':secret,...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
test('vendor timestamps require offsets; DST describes distinct UTC instants',async()=>{const {instant}=await setup();assert.equal(instant(date),'2026-10-10T16:30:00.000Z');assert.equal(instant('2026-11-01 01:30:00 -0700'),'2026-11-01T08:30:00.000Z');assert.equal(instant('2026-11-01 01:30:00 -0800'),'2026-11-01T09:30:00.000Z');assert.equal(instant('2026-10-10T09:30:00'),null);});
test('all eight families and unknown fields survive raw archive; generic seconds series excludes routes',async()=>{
 const {hash,createHandler}=await setup(),repo=memory(),handler=createHandler({ownerId:owner,tokenHashes:[await hash(token)],repository:repo});
 const payload={user_id:'spoofed',data:{workouts:[workout],metrics:[{name:'never_seen_before',units:'custom',data:[{date,qty:42,source:'Synthetic Watch',future:{a:[1,2]}}]}],
 symptoms:[{start:date,type:'synthetic',future:'retained'}],ecg:[{start:date,voltageMeasurements:[{voltage:0.01,date}]}],heartRateNotifications:[{start:date,heartRate:[]}],stateOfMind:[{start:date,valence:0}],cycleTracking:[{start:date,type:'synthetic'}],medications:[{start:date,name:'synthetic'}]}};
 const original=JSON.stringify(payload,null,2),res=await handler(req(original));assert.equal(res.status,200);assert.equal(new TextDecoder().decode([...repo.archives.values()][0]),original);
 const rows=repo.commits[0];assert.equal(rows.events.length,6);assert.equal(rows.events.find(r=>r.data_family==='symptoms').summary_jsonb.future,'retained');assert.equal(rows.observations[0].metric_name,'never_seen_before');assert.deepEqual(rows.observations[0].value_jsonb.future,{a:[1,2]});
 assert.equal(rows.workouts[0].distance_m,4828.032);assert.equal(rows.workouts[0].route_present,true);assert.equal(rows.workouts[0].hr_avg,140);assert.equal(rows.series.length,2);assert.equal(rows.series[0].value_numeric,140);assert.equal(rows.series[0].value_jsonb.Max,160);assert.equal(rows.series[1].observed_at,'2026-10-10T16:30:01.000Z');
 assert.equal((await handler(req(original))).status,200);assert.equal(repo.commits.length,1);assert.equal([...repo.batches.values()][0].user_id,owner);
});
test('single metric resolution unknown; multi-metric aggregation explicit; source streams stay separate',async()=>{
 const {project}=await setup(),point={date,qty:72,source:'A'},metric={name:'heart_rate',units:'bpm',data:[point]};
 const single=await project({data:{metrics:[metric]}});assert.equal(single.observations[0].is_aggregated,null);
 const multi=await project({data:{metrics:[metric,{name:'new_metric',units:'x',data:[point]}]}});assert.ok(multi.observations.every(r=>r.is_aggregated));
 const sources=await project({data:{metrics:[{...metric,data:[point,{...point,source:'B'}]}]}});assert.equal(new Set(sources.observations.map(r=>r.fingerprint)).size,2);
 const a=await project({data:{metrics:[{...metric,data:[{...point,id:'stable',qty:71}]}]}}),b=await project({data:{metrics:[{...metric,data:[{...point,id:'stable',qty:73}]}]}});assert.equal(a.observations[0].fingerprint,b.observations[0].fingerprint);
});
test('invalid auth/shape/size/depth never writes; rate limiting and storage failure reject acceptance',async()=>{
 const {hash,createHandler,MAX_BYTES}=await setup(),repo=memory(),handler=createHandler({ownerId:owner,tokenHashes:[await hash(token)],repository:repo});
 assert.equal((await handler(req({data:{metrics:[]}}, {},'bad'))).status,401);
 assert.equal((await handler(req({data:{metrics:{}}}))).status,400);
 assert.equal((await handler(req('x'.repeat(MAX_BYTES+1)))).status,413);
 assert.equal((await handler(req('{"data":{"future":'+ '['.repeat(40)+'0'+']'.repeat(40)+'}}'))).status,400);
 assert.equal(repo.writes,0);repo.allow=false;assert.equal((await handler(req({data:{metrics:[]}}))).status,429);
 repo.allow=true;repo.archive=async()=>{throw Error('private')};const res=await handler(req({data:{metrics:[]}}));assert.equal(res.status,503);assert.equal(repo.batches.size,0);assert.doesNotMatch(await res.text(),/private/);
});
test('projection failures retain raw archive and safely retry; unknown families quarantine',async()=>{
 const {hash,createHandler}=await setup(),repo=memory(),handler=createHandler({ownerId:owner,tokenHashes:[await hash(token)],repository:repo});repo.fail=true;
 const payload={data:{metrics:[{name:'new',units:'x',data:[{date,qty:2}]}]}};
 assert.equal((await handler(req(payload))).status,503);assert.equal(repo.archives.size,1);assert.equal([...repo.batches.values()][0].processing_status,'retryable');repo.fail=false;
 assert.equal((await handler(req(payload))).status,200);assert.equal(repo.archives.size,1);
 const r=memory(),h=createHandler({ownerId:owner,tokenHashes:[await hash(token)],repository:r});assert.equal((await (await h(req({data:{futureFamily:{anything:true}}}))).json()).status,'quarantined');
});
module.exports={workout,date};
