#!/usr/bin/env node
// Source checkout CLI; package.json currently does not ship scripts/.
import { prepareRestore } from '../src/migrate/restore.js'

const help = `Aurabot offline restore preparation (isolation only)

Usage:
  node scripts/restore-aurabot.mjs --current <current.sqlite> --backup <backup.sqlite> --output <new-directory> --offline

Stop DSH and all child hosts first. --offline asserts that you have done so; it
does not detect processes. Use explicit paths. Output must be new and outside
both database directories. No default real-user paths are read.

Copies current SQLite bytes and WAL/SHM/journal first, then the backup, verifies
both, merges known deletion/recall barriers into a separate candidate, isolates
restored memory and disables automatic work in a new credential-free config.
Historical queued deliveries/calls become unknown; never blindly retry them.

Exit 0 = isolated candidate prepared, NOT approval or activation. There is no
switch/force/install flag. report.json always says switchAllowed:false and
deletionHistoryComplete:false. Read the report and review sources/evidence
before designing any activation procedure. Unknown/purged deletion records
cannot be recovered by this tool. It never restores media, vector databases,
JSON libraries, external config, DSH profiles or installed modules. Snapshot
copies retain database contents, including embedded job configurations/secrets;
only the newly generated config is credential-free.

Exit 1 = refused/error; copies and diagnostic report are retained when created.
The original current database and original backup are never opened for writing
or replaced. This current-database safety copy is not a full installation backup.

Programmatic API (no import-time IO):
  import { prepareRestore } from './src/migrate/restore.js'
  await prepareRestore({currentDb, backupDb, outputDir, offline:true})
  // optional assertOffline(phase) -> true | Promise<true>, checked at boundaries
`

try {
  const args=process.argv.slice(2)
  if(args.length===1 && ['--help','-h'].includes(args[0])) {
    process.stdout.write(help)
  } else {
    const values={}, names={'--current':'currentDb','--backup':'backupDb','--output':'outputDir'}
    for(let i=0;i<args.length;i++) {
      const flag=args[i], name=names[flag] || (flag==='--offline'?'offline':null)
      if(!name || Object.hasOwn(values,name)) throw Object.assign(new Error(`Unknown or duplicate option: ${flag}`),{code:'INVALID_ARGUMENT'})
      if(flag==='--offline') values.offline=true
      else {
        const value=args[++i]
        if(!value || value.startsWith('--')) throw Object.assign(new Error(`Missing value for ${flag}`),{code:'INVALID_ARGUMENT'})
        values[name]=value
      }
    }
    if(!values.currentDb || !values.backupDb || !values.outputDir || values.offline!==true)
      throw Object.assign(new Error('Required: --current, --backup, --output, --offline. Use --help.'),{code:'INVALID_ARGUMENT'})
    const result=await prepareRestore(values)
    process.stdout.write(JSON.stringify({state:result.state,switchAllowed:result.switchAllowed,deletionHistoryComplete:result.deletionHistoryComplete,
      candidateDb:result.candidateDb,configPath:result.configPath,reportPath:result.reportPath,counts:result.counts},null,2)+'\n')
  }
} catch(error) {
  process.stderr.write(JSON.stringify({state:'refused',code:error.code||'RESTORE_FAILED',message:error.message,
    reportPath:error.reportPath||null,outputDir:error.outputDir||null,switchAllowed:false})+'\n')
  process.exitCode=1
}
