// Isolated PostgreSQL engine. No network, real Auth users, or health records.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const pg=new PGlite(),owner='11111111-1111-1111-1111-111111111111',other='22222222-2222-2222-2222-222222222222';
 const {project,hash}=await import('../supabase/functions/import-health/parser.mjs');
 try{
 await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;
 insert into auth.users values('${owner}'),('${other}');
 create schema storage;grant usage on schema storage to anon,authenticated;create table storage.objects(id text,bucket_id text);alter table storage.objects enable row level security;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
 await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase.sql'),'utf8'));
 await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261015050259_apple_health_import.sql'),'utf8'));
 const rpc=async(name,args)=> (await pg.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;
 const register=async(payload)=>rpc('health_register_batch',[JSON.stringify({user_id:owner,payload_sha256:await hash(JSON.stringify(payload)),storage_path:owner+'/synthetic.json',bytes:100,data_families:Object.keys(payload.data),aggregation_info:{}})]);
 const makeWorkout=(id,start,name='Traditional Strength Training')=>({id,name,start,end:start.replace('09:30','10:30').replace('09:32','10:32'),duration:3600});
 await pg.exec(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
 const session={id:'lift',date:'2026-10-10',type:'Pull',status:'completed',startedAt:Date.parse('2026-10-10T16:30:00Z'),endedAt:Date.parse('2026-10-12T16:30:00Z'),entries:[]};
 await rpc('ledger_write',['sessions','lift',JSON.stringify(session),null]);
 await pg.exec(`reset role;set request.jwt.claim.sub='';set role service_role;`);
 let payload={data:{workouts:[makeWorkout('synthetic','2026-10-10 09:30:00 -0700')],metrics:[{name:'brand_new_metric',units:'custom',data:[{date:'2026-10-10 09:30:01 -0700',qty:42,source:'synthetic',unknown:{retained:true}}]}]}};
 const rows=await project(payload),batch=await register(payload);
 assert.equal((await rpc('health_commit_projection',[batch.id,owner,JSON.stringify(rows)])).status,'completed');
 assert.equal((await pg.query('select match_status,session_id,offset_sec from public.health_workout_matches')).rows[0].session_id,'lift');
 await rpc('health_commit_projection',[batch.id,owner,JSON.stringify(rows)]);
 assert.equal((await pg.query('select count(*)::int n from public.health_metric_observations')).rows[0].n,1);
 assert.equal((await pg.query('select value_numeric,value_jsonb from public.health_metric_observations where metric_name=$1',['brand_new_metric'])).rows[0].value_jsonb.unknown.retained,true);
 // Unknown metric round-trip through raw JSON and projection requires no schema update.
 payload=JSON.parse(JSON.stringify(payload));const batch2=await register({...payload,extra:'new archive version'});
 await rpc('health_commit_projection',[batch2.id,owner,JSON.stringify(await project(payload))]);
 assert.equal((await pg.query('select count(*)::int n from public.health_metric_observations')).rows[0].n,1);
 // Transaction failure cannot leave half of a projection committed.
 const bad=await register({data:{future:[]}});
 await assert.rejects(()=>rpc('health_commit_projection',[bad.id,owner,JSON.stringify({...rows,observations:[{...rows.observations[0],metric_name:null,fingerprint:'bad'}]})]));
 assert.equal((await pg.query('select processing_status from public.health_import_batches where id=$1',[bad.id])).rows[0].processing_status,'accepted');
 // A later Ledger session causes reconciliation; close starts remain ambiguous.
 await pg.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}';`);
 await rpc('ledger_write',['sessions','close',JSON.stringify({...session,id:'close',startedAt:session.startedAt+120000}),null]);
 await pg.exec('reset role;');
 assert.equal((await pg.query('select match_status from public.health_workout_matches')).rows[0].match_status,'review');
 // Preserve manual rejection across recurring import reconciliation.
 await pg.query("update public.health_workout_matches set match_status='rejected',match_method='manual',session_id=null");
 await rpc('health_reconcile',[owner]);assert.equal((await pg.query('select match_status from public.health_workout_matches')).rows[0].match_status,'rejected');
 // Health-first ordering reconciles when the completed session arrives later.
 const later={data:{workouts:[makeWorkout('later','2026-10-11 09:30:00 -0700')]}};
 const b3=await register(later);await rpc('health_commit_projection',[b3.id,owner,JSON.stringify(await project(later))]);
 await pg.exec(`set role authenticated;set request.jwt.claim.sub='${owner}';`);
 await rpc('ledger_write',['sessions','later',JSON.stringify({...session,id:'later',date:'2026-10-11',startedAt:session.startedAt+86400000}),null]);
 assert.equal((await pg.query("select match_status from public.health_workout_matches where session_id='later'")).rows[0].match_status,'matched');
 await assert.rejects(()=>rpc('health_requeue_batch',[batch.id,owner]),/permission denied/);
 const tables=['health_import_batches','health_workouts','health_metric_observations','health_workout_series','health_events','health_workout_matches'];
 for(const table of tables){
   await assert.rejects(()=>pg.exec(`delete from public.${table}`),/permission denied/);
   await assert.rejects(()=>pg.exec(`update public.${table} set user_id='${other}'`),/permission denied/);
 }
 await assert.rejects(()=>rpc('health_import_rate',[owner]),/permission denied/);
 await assert.rejects(()=>rpc('health_commit_projection',[batch.id,owner,JSON.stringify(rows)]),/permission denied/);
 await pg.exec(`set request.jwt.claim.sub='${other}';`);
 for(const table of tables)assert.equal((await pg.query(`select * from public.${table}`)).rows.length,0);
 await pg.exec('reset role;set role anon;');
 for(const table of tables)await assert.rejects(()=>pg.query(`select * from public.${table}`),/permission denied/);
 await pg.exec('reset role;');
 await pg.exec(`grant select,insert on storage.objects to anon,authenticated;
 create policy broad_test_policy on storage.objects for all to anon,authenticated using(true) with check(true);
 insert into storage.objects values('private','health-raw'),('ordinary','other-bucket');
 set role authenticated;set request.jwt.claim.sub='${owner}';`);
 assert.deepEqual((await pg.query('select id from storage.objects')).rows.map(r=>r.id),['ordinary']);
 await assert.rejects(()=>pg.query("insert into storage.objects values('spoof','health-raw')"),/row-level security/);
 await pg.exec('reset role;set role anon;');
 assert.deepEqual((await pg.query('select id from storage.objects')).rows.map(r=>r.id),['ordinary']);
 await pg.exec('reset role;set role service_role;');
 for(let i=0;i<60;i++)assert.equal(await rpc('health_import_rate',[owner]),true);
 assert.equal(await rpc('health_import_rate',[owner]),false);
 await rpc('health_requeue_batch',[batch.id,owner]);
 assert.equal((await rpc('health_commit_projection',[batch.id,owner,JSON.stringify(rows)])).status,'completed');
 await pg.exec('reset role;');
 assert.equal((await pg.query("select public from storage.buckets where id='health-raw'")).rows[0].public,false);
 assert.deepEqual((await pg.query("select data from public.sessions where id='lift'")).rows[0].data,session);
 console.log('PASS: atomic projections, new metric without migration, replay deduplication, owner RLS, client write denial, private bucket, conservative matching, late ends, manual preservation, both arrival orders, Ledger data intact.');
 }finally{await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
