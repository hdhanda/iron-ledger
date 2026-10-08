// Compare a prepared migration candidate to a full backup from a freshly signed-in
// second preview browser. This proves database readback, not merely local import.
const fs=require('node:fs'),L=require('../ledger-core.js');
const [expectedPath,actualPath]=process.argv.slice(2);
if(!actualPath){console.error('Usage: node tools/verify-import.cjs candidate.json fresh-device-backup.json');process.exit(1);}
const expected=JSON.parse(fs.readFileSync(expectedPath)),actual=JSON.parse(fs.readFileSync(actualPath));
const errors=L.validate(actual),counts={},extra={};
for(const table of L.tables){
 const rows=new Map(actual[table].map(r=>[L.key(table,r),r]));
 counts[table]={expected:expected[table].length,destination:actual[table].length};
 for(const record of expected[table]){
   const dest=rows.get(L.key(table,record));
   if(!dest)errors.push(`Missing ${table}/${L.key(table,record)}`);
   else if(!L.equal(record,dest))errors.push(`Different record ${table}/${L.key(table,record)}`);
 }
 extra[table]=actual[table].filter(r=>!expected[table].some(e=>L.key(table,e)===L.key(table,r))).map(r=>L.key(table,r));
}
const expectedSets=expected.sessions.flatMap(s=>L.setsFor(s)),actualSets=actual.sessions.flatMap(s=>L.setsFor(s));
counts.sets={expected:expectedSets.length,destination:actualSets.length};
counts.working={expected:L.working(expectedSets).length,destination:L.working(actualSets).length};
counts.warmup={expected:expectedSets.filter(s=>s.warmup).length,destination:actualSets.filter(s=>s.warmup).length};
for(const ex of expected.exercises){
 const before=L.records(expected.sessions,ex.id),after=L.records(actual.sessions,ex.id);
 // Additional legitimate sessions can increase records; missing or changed sets were checked above.
 if(after.weight<before.weight||after.e1rm<before.e1rm)errors.push(`PR regression ${ex.id}`);
}
console.log(JSON.stringify({ok:errors.length===0,counts,extra,errors},null,2));
process.exitCode=errors.length?1:0;
