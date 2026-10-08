// Optional development-only PostgreSQL WASM runner. App has no npm dependencies.
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const pg=new PGlite();
 try{
 await pg.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,public to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
 insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');`);
 const schema=fs.readFileSync(path.join(__dirname,'../supabase.sql'),'utf8');await pg.exec(schema);await pg.exec(schema);
 await pg.exec(`set role authenticated; set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';`);
 const write=async(table,id,data,version=null)=>(await pg.query('select public.ledger_write($1,$2,$3::jsonb,$4) as result',[table,id,JSON.stringify(data),version])).rows[0].result;
 const ex={id:'custom',name:'Custom',pattern:'Other',group:'Other',anchor:false,custom:true};
 let result=await write('exercises','custom',ex);assert.equal(result.ok,true);assert.equal(result.row.version,1);
 result=await write('exercises','custom',ex);assert.equal(result.row.version,1);
 result=await write('exercises','custom',{...ex,name:'New name'},1);assert.equal(result.row.version,2);
 result=await write('exercises','custom',{...ex,name:'Stale name'},1);assert.equal(result.conflict,true);assert.equal(result.row.data.name,'New name');
 for(const split of ['Push','Pull'])assert.equal((await write('routines',JSON.stringify(['ppl-a',split]),{id:'ppl-a',name:'PPL A',split,blocks:[]})).ok,true);
 const session={id:'session',date:'2026-10-07',type:'Push',status:'completed',readiness:{sleep:3},entries:[{exId:'custom',sets:[{id:'set',w:100,r:8,rpe:8,warmup:false}]}]};
 assert.equal((await write('sessions','session',session)).ok,true);
 assert.equal((await pg.query('select entries,date from public.sessions')).rows[0].entries[0].sets[0].id,'set');
 await pg.exec(`set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';`);
 assert.equal((await pg.query('select * from public.sessions')).rows.length,0);
 assert.equal((await write('exercises','custom',ex)).row.version,1);
 const otherUpdate=await pg.query(`update public.exercises set data=$1::jsonb where user_id='11111111-1111-1111-1111-111111111111' returning id`,[JSON.stringify(ex)]);assert.equal(otherUpdate.rows.length,0);
 await assert.rejects(()=>pg.query(`insert into public.body(user_id,id,data) values ('11111111-1111-1111-1111-111111111111','b','{"id":"b"}')`),/row-level security/);
 await pg.exec('reset role; set role anon;');
 await assert.rejects(()=>pg.query('select * from public.sessions'),/permission denied/);
 await assert.rejects(()=>write('exercises','custom',ex),/permission denied/);
 console.log('PASS: SQL applies twice, owner RLS, anonymous denial, routine keys, JSONB readback, idempotency, stale-write conflicts.');
 }finally{await pg.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
