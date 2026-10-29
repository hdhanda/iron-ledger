// Local-only PostgreSQL sizing sample. Reads private staging via Python, never prints records.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const prepared=process.argv[2],total=Number(process.argv[3]);if(!prepared||!Number.isSafeInteger(total)||total<1)throw Error('arguments');
 const sample=JSON.parse(execFileSync('python3',['-c',`
import sqlite3,json,gzip,sys
from pathlib import Path
c=sqlite3.connect('file:'+str(Path(sys.argv[1])/'staging.sqlite3')+'?mode=ro',uri=True)
rows=c.execute('select point_json from observations where rowid%211=0 limit 2000').fetchall()
print(json.dumps([json.loads(gzip.decompress(r[0])) for r in rows]))
`,prepared],{encoding:'utf8',maxBuffer:16*1024*1024}));
 if(sample.length<100)throw Error('sample_too_small');
 const {project}=await import('../supabase/functions/import-health/parser.mjs');
 const groups=new Map();for(const point of sample){const name=point.native.attributes.type,unit=point.units,key=JSON.stringify([name,unit]);if(!groups.has(key))groups.set(key,{name,units:unit,data:[]});groups.get(key).data.push(point);}
 const rows=await project({data:{metrics:[...groups.values()]}},{nativeSource:{format:'apple-health-xml-v1',export_id:'0'.repeat(64),manifest_sha256:'0'.repeat(64),batch_index:0}});
 const pg=new PGlite(),owner='11111111-1111-1111-1111-111111111111';
 try{
  await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select null::uuid$$;insert into auth.users values('${owner}');create schema storage;create table storage.objects(id text,bucket_id text);create table storage.buckets(id text,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase.sql'),'utf8'));
  await pg.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261015051442_apple_health_import.sql'),'utf8'));
  const size=async()=>Number((await pg.query("select pg_total_relation_size('public.health_metric_observations') as bytes")).rows[0].bytes);
  const before=await size();
  const batch=(await pg.query("insert into public.health_import_batches(user_id,data_families,payload_sha256,storage_path,bytes,processing_status) values($1,array['metrics'],$2,'local-sizing-only',1,'accepted') returning id",[owner,'0'.repeat(64)])).rows[0].id;
  await pg.query('select public.health_commit_projection($1,$2,$3::jsonb)',[batch,owner,JSON.stringify(rows)]);
  const delta=await size()-before,per=delta/rows.observations.length;
  const ordinary={sample_rows:rows.observations.length,sample_table_and_indexes_bytes:delta,estimated_bytes_per_reading:Math.round(per),estimated_all_readings_bytes:Math.ceil(per*total)};
  await pg.exec(`create table compact_contexts(id int primary key,definition jsonb not null);
  create table compact_readings(context_id int not null references compact_contexts(id),fingerprint bytea not null,start_at timestamptz,end_at timestamptz,created_at timestamptz,value_numeric double precision,value_original text,start_offset smallint,end_offset smallint,file_id int,xml_index int,detail jsonb,primary key(context_id,fingerprint));
  create index compact_reading_time on compact_readings(context_id,start_at);`);
  const contexts=new Map(),compact=[];
  for(const [i,p] of sample.entries()){
   const a=p.native.attributes,common=[],detail=[];
   for(const child of p.native.children||[]){if(child.tag==='MetadataEntry'&&['HKTimeZone','HKWasUserEntered','HKMetadataKeyHeartRateMotionContext'].includes(child.attributes.key))common.push(child);else detail.push(child);}
   const definition={attributes:Object.fromEntries(Object.entries(a).filter(([k])=>!['startDate','endDate','creationDate','value'].includes(k)).map(([k,v])=>[k,k==='device'?v.replace(/HKDevice: 0x[0-9a-f]+/gi,'HKDevice: <address>'):v])),common_metadata:common,...(p.qty===undefined?{category_value:a.value}:{})};
   const key=JSON.stringify(definition);if(!contexts.has(key))contexts.set(key,contexts.size+1);
   compact.push({context_id:contexts.get(key),fingerprint:Buffer.from(p.id.split(':')[1],'hex'),start:rows.observations[i]?.observed_at??null,end:rows.observations[i]?.end_at??null,created:null,numeric:p.qty??null,original:p.qty===undefined?null:a.value,detail:detail.length?detail:null,index:p.native_index});
  }
  for(const [definition,id] of contexts)await pg.query('insert into compact_contexts values($1,$2::jsonb)',[id,definition]);
  const beforeCompact=Number((await pg.query("select pg_total_relation_size('compact_readings') as bytes")).rows[0].bytes);
  for(const r of compact)await pg.query('insert into compact_readings values($1,$2,$3,$4,$5,$6,$7,0,0,1,$8,$9::jsonb) on conflict do nothing',[r.context_id,r.fingerprint,r.start,r.end,r.created,r.numeric,r.original,r.index,JSON.stringify(r.detail)]);
  const compactBytes=Number((await pg.query("select pg_total_relation_size('compact_readings') as bytes")).rows[0].bytes)-beforeCompact;
  console.log(JSON.stringify({current_schema:ordinary,compact_prototype:{sample_rows:compact.length,contexts:contexts.size,estimated_bytes_per_reading:Math.round(compactBytes/compact.length),estimated_all_readings_bytes:Math.ceil(compactBytes/compact.length*total)},estimate_only:true}));
 }finally{await pg.close();}
})().catch(()=>{console.error('Local sizing failed; no record content was logged.');process.exitCode=1});
