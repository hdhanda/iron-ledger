// Privileged operator tool for an explicitly configured project and owner. Supply credentials privately through environment, never command arguments.
import {HealthRepository} from '../supabase/functions/import-health/repository.mjs';
import {hash,project,validateEnvelope,checkComplexity} from '../supabase/functions/import-health/parser.mjs';
const {SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:legacyKey,SUPABASE_SECRET_KEY:secretKey,HEALTH_OWNER_ID:owner,HEALTH_PROJECT_REF:projectRef}=process.env;
const key=secretKey||legacyKey;
const batchId=process.argv[2],uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
try{
 if(!projectRef||url!==`https://${projectRef}.supabase.co`||!key||!uuid.test(owner??'')||!uuid.test(batchId??''))throw Error('configuration');
 const repository=new HealthRepository({url,key});
 const rows=await(await repository.request(`/rest/v1/health_import_batches?id=eq.${batchId}&user_id=eq.${owner}&select=*`)).json();
 if(rows.length!==1)throw Error('missing');const batch=rows[0];
 if(!batch.storage_path.startsWith(owner+'/export/')||batch.storage_path.includes('..')||!batch.storage_path.endsWith('/'+batch.payload_sha256+'.json'))throw Error('path');
 const encoded=batch.storage_path.split('/').map(encodeURIComponent).join('/');
 const bytes=new Uint8Array(await(await repository.request('/storage/v1/object/authenticated/health-raw/'+encoded)).arrayBuffer());
 if(await hash(bytes)!==batch.payload_sha256)throw Error('checksum');
 const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));checkComplexity(payload);validateEnvelope(payload);
 const projections=await project(payload,{aggregation:batch.aggregation_info.level,automationId:batch.automation_id,exportVersion:batch.export_version});
 await repository.rpc('health_requeue_batch',{p_batch:batchId,p_owner:owner});
 try{
  const result=await repository.commit(batchId,owner,projections);
  console.log(JSON.stringify({batch_id:batchId,status:result.status,counts:result.counts}));
 }catch{await repository.failed(batchId,owner,'projection_failed');throw Error('projection');}
}catch{
 // Never print SDK errors, request objects, payloads or credentials.
 console.error('Reprocessing failed. Verify explicit project/owner configuration, batch ownership, checksum and parser support privately.');process.exitCode=1;
}
