import {createHandler} from './handler.mjs';
import {HealthRepository} from './repository.mjs';
const PROJECT='armhlqarrdzioobepcng';
export function createRuntimeHandler(env,fetcher=fetch){
 const url=env.get('SUPABASE_URL')??'';let key='';
 try{key=JSON.parse(env.get('SUPABASE_SECRET_KEYS')??'{}').default??'';}catch{/* legacy environment remains supported */}
 key||=env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
 if(url!==`https://${PROJECT}.supabase.co`||!key)return ()=>new Response(JSON.stringify({error:'import_not_configured'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 const repository=new HealthRepository({url,key,fetcher});
 return createHandler({resolveOwner:tokenHash=>repository.authenticate(tokenHash),repository});
}
