import {hash,validateEnvelope,checkComplexity,project} from './parser.mjs';
export const MAX_BYTES=2*1024*1024;
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
async function readBounded(req){
  const length=req.headers.get('content-length');if(length&&Number(length)>MAX_BYTES)throw new Error('payload_size');
  const reader=req.body?.getReader();if(!reader)throw new Error('invalid_json');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>MAX_BYTES){await reader.cancel();throw new Error('payload_size');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function createHandler({ownerId,tokenHashes,resolveOwner,repository,now=()=>new Date()}) {
  const validOwner=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value??'');
  const configured=typeof resolveOwner==='function'||(validOwner(ownerId)&&Array.isArray(tokenHashes)&&tokenHashes.length>0&&tokenHashes.every(s=>/^[0-9a-f]{64}$/.test(s)));
  return async req=>{
    if(!configured)return json(503,{error:'import_not_configured'});
    if(req.method!=='POST')return json(405,{error:'method_not_allowed'});
    const token=req.headers.get('x-health-import-token')??'';
    if(token.length<43||token.length>256)return json(401,{error:'unauthorized'});
    const digest=await hash(token);let requestOwner;
    try{requestOwner=resolveOwner?await resolveOwner(digest):tokenHashes.includes(digest)?ownerId:null;}
    catch{return json(503,{error:'authentication_unavailable'});}
    if(!validOwner(requestOwner))return json(401,{error:'unauthorized'});
    if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json(415,{error:'json_required'});
    let bytes,payload,envelope;
    try{bytes=await readBounded(req);payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));checkComplexity(payload);envelope=validateEnvelope(payload);}
    catch(e){return json(e.message==='payload_size'?413:400,{error:['payload_size','payload_complexity','invalid_envelope','invalid_families','invalid_family_shape'].includes(e.message)?e.message:'invalid_json'});}
    const metadata={automationId:req.headers.get('automation-id'),aggregation:req.headers.get('automation-aggregation'),exportVersion:req.headers.get('export-version'),
      vendorSessionId:req.headers.get('session-id'),exportPeriod:req.headers.get('automation-period')};
    if(Object.values(metadata).some(v=>v&&v.length>200))return json(400,{error:'invalid_metadata'});
    const checksum=await hash(bytes),date=now().toISOString();
    // Hash the automation identifier to keep untrusted identifiers out of object paths.
    const automationPath=await hash(metadata.automationId??'unspecified');
    const path=`${requestOwner}/export/${date.slice(0,4)}/${date.slice(5,7)}/${automationPath}/${checksum}.json`;
    let batch;
    try{
      if(!await repository.rateLimit(requestOwner))return json(429,{error:'rate_limited'});
      // Replay lookup is scoped by configured owner, never a payload-supplied user ID.
      batch=await repository.findBatch(requestOwner,checksum);
      if(batch&&['completed','quarantined'].includes(batch.processing_status))return json(200,{batch_id:batch.id,status:batch.processing_status,replay:true,counts:batch.counts});
      if(!batch){
        await repository.archive(path,bytes,checksum);
        batch=await repository.register({user_id:requestOwner,payload_sha256:checksum,storage_path:path,bytes:bytes.length,
          data_families:[...envelope.families,...envelope.unknown],automation_id:metadata.automationId,vendor_session_id:metadata.vendorSessionId,
          export_version:metadata.exportVersion,aggregation_info:{level:metadata.aggregation,period:metadata.exportPeriod},processing_status:'accepted'});
      }
    }catch{return json(503,{error:'durable_acceptance_failed'});}
    try{
      const rows=await project(payload,metadata);
      const result=await repository.commit(batch.id,requestOwner,rows);
      return json(200,{batch_id:batch.id,status:result.status,counts:result.counts});
    }catch{
      try{await repository.failed(batch.id,requestOwner,'projection_failed');}catch{/* raw archive and accepted batch still recoverable */}
      // Non-2xx causes vendor retry; do not disguise a failed projection as successful sync.
      return json(503,{batch_id:batch.id,status:'retryable',error:'projection_failed'});
    }
  };
}
