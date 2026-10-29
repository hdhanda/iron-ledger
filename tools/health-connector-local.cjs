// Isolated bridge harness: PostgreSQL + local fake Storage/pg_net, never network.
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const ROOT=path.join(__dirname,'..');
const OWNER='11111111-1111-1111-1111-111111111111';
async function createLocalBridge(config,{archiveDirectory}={}){
 const pg=new PGlite();
 await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth,public to authenticated,anon,service_role;grant execute on function auth.uid() to authenticated,anon,service_role;
  insert into auth.users values('${OWNER}'),('22222222-2222-2222-2222-222222222222');
  create schema storage;create table storage.objects(id text,bucket_id text,name text,metadata jsonb);
  grant usage on schema storage to service_role;grant select on storage.objects to service_role;
  create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
  create schema net;create table net.http_request_queue(id bigint generated always as identity,headers jsonb,body jsonb);
  create table net._http_response(id bigint,status_code int,timed_out boolean,created timestamptz default now());
  create function net.http_post(url text,body jsonb default '{}',params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 2000) returns bigint language sql as $$insert into net.http_request_queue(headers,body) values(headers,body) returning id$$;
 `);
 for(const filename of ['supabase.sql','supabase/migrations/20261015051442_apple_health_import.sql','supabase/migrations/20261015051937_health_import_credentials.sql','supabase/migrations/20261029040928_chatgpt_health_connector_v1.sql','supabase/migrations/20261029045933_health_connector_sql_bridge.sql']){
  let sql=fs.readFileSync(path.join(ROOT,filename),'utf8');sql=sql.replace('create extension if not exists pg_net;','-- pg_net is mocked in this isolated engine.');await pg.exec(sql);
 }
 // Supabase's live default grants allow the existing reconciler to read sessions.
 // The standalone engine has no Supabase default privileges; emulate that read only.
 await pg.exec('grant select on public.sessions to service_role');
 await pg.query('insert into public.health_sync_config(user_id,source_policy) values($1,$2::jsonb)',[OWNER,JSON.stringify(config.source_policy)]);
 const objects=new Map(),{hash}=await import(path.join(ROOT,'supabase/functions/import-health/parser.mjs'));
 const errors=[];
 const rpc=async(name,args)=>{
  try{await pg.exec('set role service_role');return(await pg.query(`select public.${name}(${Object.keys(args).map((_,i)=>'$'+(i+1)).join(',')}) result`,Object.values(args))).rows[0].result;}
  catch(e){errors.push({rpc:name,message:e.message.split('\n')[0]});throw e;}
  finally{await pg.exec('reset role');}
 };
 const repository={rpc,register:row=>rpc('health_register_batch',{p_batch:row}),
  async archive(name,bytes,checksum){
   if(objects.has(name)&&await hash(objects.get(name))!==checksum)throw Error('archive_collision');
   objects.set(name,new Uint8Array(bytes));
   if(archiveDirectory){fs.mkdirSync(archiveDirectory,{recursive:true,mode:0o700});fs.writeFileSync(path.join(archiveDirectory,path.basename(name)),bytes,{mode:0o600});}
   await pg.query('insert into storage.objects(id,bucket_id,name,metadata) select $1,\'health-raw\',$1,$2::jsonb where not exists(select 1 from storage.objects where name=$1)',[name,JSON.stringify({size:bytes.length})]);
  },
  async verifyArchive(name,checksum){if(!objects.has(name)||await hash(objects.get(name))!==checksum)throw Error('archive_checksum_mismatch');}
 };
 const {createConnectorWorker}=await import(path.join(ROOT,'supabase/functions/process-health-connector/worker.mjs'));
 const worker=createConnectorWorker({repository});
 async function submit(text,manifest,requestKey){
  const chunks=[];let chunk='',size=0;
  for(const ch of text){const bytes=Buffer.byteLength(ch);if(size+bytes>24000){chunks.push(chunk);chunk='';size=0;}chunk+=ch;size+=bytes;}if(chunk)chunks.push(chunk);
  const full={...manifest,schema_version:1,payload_sha256:await hash(text),payload_bytes:Buffer.byteLength(text),part_count:chunks.length};
  const begin=(await pg.query('select health_private.connector_begin($1,$2::jsonb,$3) result',[OWNER,JSON.stringify(full),requestKey])).rows[0].result;
  if(begin.state==='completed')return begin;
  for(const [i,part]of chunks.entries())await pg.query('select health_private.connector_append($1,$2,$3)',[begin.job_id,i,part]);
  await pg.query('select health_private.connector_finish($1)',[begin.job_id]);
  const queue=(await pg.query('select * from net.http_request_queue order by id desc limit 1')).rows[0];
  const response=await worker(new Request('https://local.invalid/',{method:'POST',headers:{'x-health-job-token':queue.headers['x-health-job-token']},body:JSON.stringify(queue.body)}));
  const output=await response.json();return {job_id:begin.job_id,response_status:response.status,...output};
 }
 return {pg,repository,objects,worker,submit,owner:OWNER,errors};
}
module.exports={createLocalBridge,OWNER};
