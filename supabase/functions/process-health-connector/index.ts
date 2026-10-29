import {HealthRepository} from '../import-health/repository.mjs';
import {hash} from '../import-health/parser.mjs';
import {createConnectorWorker} from './worker.mjs';
declare const EdgeRuntime: {waitUntil(promise:Promise<unknown>):void};
const PROJECT='armhlqarrdzioobepcng';
let key='';
try{key=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')??'{}').default??'';}catch{/* Legacy platform credential fallback. */}
key=key||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const url=Deno.env.get('SUPABASE_URL')??'';
class ConnectorRepository extends HealthRepository {
 async verifyArchive(path:string,checksum:string){
  const encoded=path.split('/').map(encodeURIComponent).join('/');
  const bytes=new Uint8Array(await(await this.request('/storage/v1/object/authenticated/health-raw/'+encoded)).arrayBuffer());
  if(await hash(bytes)!==checksum)throw Error('archive_checksum_mismatch');
 }
}
const repo=new ConnectorRepository({url,key});
const handler=createConnectorWorker({repository:repo,defer:(promise:Promise<unknown>)=>EdgeRuntime.waitUntil(promise)});
Deno.serve(req=>url===`https://${PROJECT}.supabase.co`&&key?handler(req):new Response('Worker unavailable',{status:503}));
