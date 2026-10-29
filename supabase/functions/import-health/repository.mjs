import {hash} from './parser.mjs';
export class HealthRepository {
  constructor({url,key,fetcher=fetch}){this.url=url.replace(/\/$/,'');this.key=key;this.fetcher=fetcher;}
  async request(path,{method='GET',body,headers={}}={}){
    const response=await this.fetcher(this.url+path,{method,headers:{apikey:this.key,...(this.key.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${this.key}`}),...headers},
      ...(body===undefined?{}:{body}),signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw new Error('backend_request_failed'); // Never log response bodies containing health data.
    return response;
  }
  async rpc(name,args){return(await this.request('/rest/v1/rpc/'+name,{method:'POST',body:JSON.stringify(args),headers:{'Content-Type':'application/json'}})).json();}
  async authenticate(tokenHash){return this.rpc('health_authenticate_import',{p_token_hash:tokenHash});}
  async rateLimit(owner){return this.rpc('health_import_rate',{p_owner:owner});}
  async findBatch(owner,checksum){return(await(await this.request(`/rest/v1/health_import_batches?user_id=eq.${owner}&payload_sha256=eq.${checksum}&select=id,processing_status,counts,aggregation_info&limit=1`)).json())[0]??null;}
  async verifyNativeSource(owner,source){
    const batch=await this.findBatch(owner,source.manifest_sha256);
    if(batch?.processing_status!=='completed'||batch.aggregation_info?.native_kind!=='manifest'||batch.aggregation_info.export_id!==source.export_id)throw Error('native_archive_not_ready');
  }
  async verifyNativeManifest(owner,manifest){
    const expected=new Map();
    for(const file of manifest.files)for(const part of file.parts){
      const value={file_sha256:file.sha256,compressed_sha256:file.compressed_sha256,index:part.index,count:file.parts.length,chunk_sha256:part.chunk_sha256,chunk_bytes:part.bytes};
      const prior=expected.get(part.payload_sha256);
      if(prior&&JSON.stringify(prior)!==JSON.stringify(value))throw Error('native_part_conflict');
      expected.set(part.payload_sha256,value);
    }
    const hashes=[...expected.keys()];
    for(let i=0;i<hashes.length;i+=40){
      const page=hashes.slice(i,i+40);
      const rows=await(await this.request(`/rest/v1/health_import_batches?user_id=eq.${owner}&payload_sha256=in.(${page.join(',')})&select=payload_sha256,processing_status,aggregation_info&limit=40`)).json();
      if(rows.length!==page.length)throw Error('native_parts_missing');
      for(const row of rows){const e=expected.get(row.payload_sha256),info=row.aggregation_info;
        if(row.processing_status!=='completed'||info?.native_kind!=='chunk'||Object.entries(e).some(([k,v])=>info[k]!==v))throw Error('native_part_mismatch');}
    }
  }
  async archive(path,bytes,checksum){
    const encoded=path.split('/').map(encodeURIComponent).join('/');
    try{await this.request('/storage/v1/object/health-raw/'+encoded,{method:'POST',body:bytes,headers:{'Content-Type':'application/json','x-upsert':'false'}});}
    catch{
      // A lost response or concurrent upload can already have stored this immutable object.
      const existing=new Uint8Array(await(await this.request('/storage/v1/object/authenticated/health-raw/'+encoded)).arrayBuffer());
      if(await hash(existing)!==checksum)throw new Error('archive_checksum_mismatch');
    }
  }
  async register(row){return this.rpc('health_register_batch',{p_batch:row});}
  async commit(batch,owner,rows){return this.rpc('health_commit_projection',{p_batch:batch,p_owner:owner,p_rows:rows});}
  async failed(batch,owner,reason){await this.rpc('health_fail_batch',{p_batch:batch,p_owner:owner,p_reason:reason});}
}
