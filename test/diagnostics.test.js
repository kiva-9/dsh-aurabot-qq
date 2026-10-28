import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStorage } from '../src/storage/index.js'
import { createDiagnostics } from '../src/diagnostics/index.js'
import { normalize, publicConfig, mergeFromPanel } from '../src/core/config.js'
import { registerSecret } from '../src/core/redact.js'

test('诊断按账号隔离请求、时间线和群判断；导出不泄露正文和配置凭据',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aurabot-diagnostics-')),s=createStorage({file:join(dir,'db.sqlite'),filesDir:join(dir,'assets')})
  const cfg=normalize({botQQ:'900',ownerQQ:'7',search:{apiKey:'tavily-secret'},voice:{httpApi:{headers:{'X-Private':'header-secret'}}}})
  const d=createDiagnostics({storage:s,getConfig:()=>cfg,modules:()=>null,hub:()=>null,version:'test'})
  t.after(()=>{d.dispose();s.close()})
  registerSecret('fixture-secret')
  const make=account=>{const m=s.messages.ingest({account,chatId:'group:1',authorId:'7',text:'PRIVATE ORIGINAL',eventKind:'message'});return s.requests.create({chatId:'group:1',actorId:'7',sourceMessageIds:[m.id]})}
  const own=make('900'),other=make('901')
  d.record({account:'900',chatId:'group:1',traceId:own.traceId,kind:'群聊决策',payload:{decision:{reply:false,reason:'fixture-secret'}}})
  d.record({account:'901',chatId:'group:1',kind:'群聊决策',payload:{decision:{reply:true}}})
  assert.deepEqual(d.requests().map(x=>x.id),[own.id]);assert.equal(d.decisions().length,1)
  assert.throws(()=>d.timeline(other.id),/当前账号/)
  assert.equal(d.timeline(own.id).events.some(e=>e.kind==='收到消息'),true)
  const output=JSON.stringify(d.export())
  for(const secret of ['fixture-secret','tavily-secret','header-secret','PRIVATE ORIGINAL'])assert.equal(output.includes(secret),false)
})
test('面板脱敏HTTP头按服务ID保留，显式null清除且不存在的占位符拒绝',()=>{
  const current=normalize({voice:{httpApi:{headers:{'X-Private':'secret',Accept:'application/json'}}}})
  const panel=publicConfig(current)
  assert.notEqual(panel.voice.httpApi.headers['X-Private'],'secret')
  assert.equal(mergeFromPanel(current,panel).voice.httpApi.headers['X-Private'],'secret')
  panel.voice.httpApi.headers['X-Private']=null
  assert.equal(mergeFromPanel(current,panel).voice.httpApi.headers['X-Private'],undefined)
})
