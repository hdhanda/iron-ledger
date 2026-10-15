import {createHandler} from './handler.mjs';
import {HealthRepository} from './repository.mjs';
const env=Deno.env;
// A separate development project is mandatory for this first release.
// Production activation is a deliberate later release step after owner acceptance.
const url=env.get('SUPABASE_URL')??'';
const development=env.get('HEALTH_ENVIRONMENT')==='development'&&!url.includes('armhlqarrdzioobepcng');
Deno.serve(development ? createHandler({
  ownerId:env.get('HEALTH_OWNER_ID'),
  tokenHashes:(env.get('HEALTH_IMPORT_TOKEN_HASHES')??'').split(',').filter(Boolean),
  repository:new HealthRepository({url,key:env.get('SUPABASE_SERVICE_ROLE_KEY')??''})
}) : ()=>new Response(JSON.stringify({error:'development_configuration_required'}),{status:503,headers:{'Content-Type':'application/json'}}));
