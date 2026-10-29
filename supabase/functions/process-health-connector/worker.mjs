import {hash} from '../import-health/parser.mjs';
import {projectConnector} from './adapter.mjs';
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
const uuid=s=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s??'');
export function createConnectorWorker({repository,defer}){
 return async req=>{
  if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
  const token=req.headers.get('x-health-job-token');if(!/^[0-9a-f]{64}$/.test(token??''))return json(401,{error:'unauthorized'});
  let input,claim;
  try{
   const reader=req.body?.getReader();if(!reader)throw Error();let text='',bytes=0;const decoder=new TextDecoder('utf8',{fatal:true});
   for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024){await reader.cancel();throw Error();}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
   input=JSON.parse(text);if(!uuid(input.job_id))throw Error();
  }catch{return json(400,{error:'invalid_job_request'});}
  try{claim=await repository.rpc('health_connector_claim',{p_job:input.job_id,p_token_hash:await hash(token)});}catch{return json(401,{error:'invalid_dispatch'});}
  if(claim.state==='completed')return json(200,{status:'completed',replay:true,result:claim.result});
  if(claim.state==='busy')return json(202,{status:'processing'});
  async function process(){
   try{
    const raw=new TextEncoder().encode(claim.payload_text),m=claim.manifest;
    if(raw.length!==m.payload_bytes||await hash(raw)!==m.payload_sha256)throw Error('staging_integrity_mismatch');
    const rows=await projectConnector(JSON.parse(claim.payload_text),m,claim.config,claim.owner,claim.context);
    const path=`${claim.owner}/chatgpt-native/${m.payload_sha256}.json`;
    const manifestBytes=new TextEncoder().encode(claim.manifest_text);
    if(await hash(manifestBytes)!==claim.manifest_sha256)throw Error('manifest_integrity_mismatch');
    const manifestPath=`${claim.owner}/chatgpt-native/${m.payload_sha256}.${claim.manifest_sha256}.manifest.json`;
    await repository.archive(path,raw,m.payload_sha256);
    await repository.archive(manifestPath,manifestBytes,claim.manifest_sha256);
    // Verify successful uploads too, not only a duplicate/lost-response fallback.
    await repository.verifyArchive(path,m.payload_sha256);
    await repository.verifyArchive(manifestPath,claim.manifest_sha256);
    const batch=await repository.register({user_id:claim.owner,payload_sha256:m.payload_sha256,storage_path:path,bytes:raw.length,
     data_families:Object.keys(m.record_counts),export_version:'chatgpt-health-v1',aggregation_info:{connector:'chatgpt_health_native',manifest_path:manifestPath,projection_mode:'summary_only'},processing_status:'accepted'});
    const result=await repository.rpc('health_connector_commit',{p_job:input.job_id,p_lease:claim.lease,p_batch:batch.id,p_rows:rows});
    if(result.status!=='completed')throw Error('commit_not_complete');
    return result;
   }catch(e){
    const code=['correction_requires_newer_verified_extraction','missing_metric_unit','workout_scope_or_source','extraction_count_mismatch','staging_integrity_mismatch','manifest_integrity_mismatch'].includes(e.message)?e.message:'processing_failed';
    try{await repository.rpc('health_connector_fail',{p_job:input.job_id,p_lease:claim.lease,p_code:code});}catch{/* Expired/replaced leases cannot change a newer attempt. SQL status remains authoritative. */}
    return {status:'retryable',error:code};
   }
  }
  if(defer){defer(process());return json(202,{job_id:input.job_id,status:'processing'});}
  const result=await process();return json(result.status==='completed'?200:503,result);
 };
}
