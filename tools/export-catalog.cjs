// Read the exact app seed definitions without booting the app or touching storage.
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1].split('/* ═══════════════════════════ STATE')[0];
const context={window:{IRON_LEDGER_CONFIG:{}}};vm.createContext(context);
const catalog=vm.runInContext(source+';({exercises:SEED,routines:SEED_ROUTINES})',context);
process.stdout.write(JSON.stringify(catalog,null,2)+'\n');
