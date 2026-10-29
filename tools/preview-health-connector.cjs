// PRIVATE local integration preview. No network and no production credentials.
const fs=require('node:fs'),path=require('node:path'),{createLocalBridge}=require('./health-connector-local.cjs');
(async()=>{
 const [payloadFile,manifestFile,configFile,destination]=process.argv.slice(2);
 if(!destination)throw Error('arguments_required');
 fs.mkdirSync(destination,{recursive:true,mode:0o700});fs.chmodSync(destination,0o700);
 const raw=fs.readFileSync(payloadFile,'utf8'),manifest=JSON.parse(fs.readFileSync(manifestFile)),config=JSON.parse(fs.readFileSync(configFile));
 const local=await createLocalBridge(config,{archiveDirectory:path.join(destination,'local-archives')});
 try{
  const first=await local.submit(raw,manifest,'private-preview-first');
  const second=first.status==='completed'?await local.submit(raw,manifest,'private-preview-second'):null;
  const db=(await local.pg.query(`select (select count(*)::int from health_workouts) workouts,
   (select count(*)::int from health_metric_observations) observations,(select count(*)::int from health_workout_observation_links) links,
   (select count(*)::int from health_workout_derived) derived,
   (select count(*)::int from health_sync_runs where status='succeeded') succeeded_runs,
   (select count(*)::int from health_private.connector_parts) staged_parts_remaining`)).rows[0];
  const report={environment:'isolated local PostgreSQL; fake pg_net and local filesystem Storage; no cloud upload',
   extraction_metadata_origin:'separate caller-provided manifest; not inferred from raw file',first,second,database:db,archive_objects:local.objects.size,
   replay_has_no_new_records:second?.workouts_inserted===0&&second?.observations_inserted===0};
  fs.writeFileSync(path.join(destination,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify(report,null,2));if(first.status!=='completed'||!report.replay_has_no_new_records)process.exitCode=1;
 }finally{await local.pg.close();}
})().catch(()=>{console.error('Private local preview failed; source records were not logged.');process.exitCode=1});
