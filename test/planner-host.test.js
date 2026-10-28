import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'

let host,fake,mock,lateTool
const until=async fn=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw new Error('condition timeout');await new Promise(r=>setTimeout(r,25))}}
const outgoing=()=>mock.sent('send_private_msg')
before(async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aurabot-planner-host-'));process.env.AURABOT_DATA_DIR=dir;process.env.AURABOT_WORKSPACE=join(dir,'ws')
  mock=await startMockOneBot()
  writeFileSync(join(dir,'config.json'),JSON.stringify({enabled:true,dryRun:false,setupDone:true,botQQ:'20000002',ownerQQ:'10000001',
    snowluma:{autoStart:false,autoAttach:false,httpUrl:mock.httpUrl,wsUrl:mock.wsUrl,httpToken:mock.token,wsToken:mock.token,dir:join(dir,'none')},
    merge:{enabled:false},voice:{enabled:false},stickers:{caption:false,collect:false,autoChance:0},speakUp:{enabled:false}}))
  fake=createFakeDsh({brain:async({text,callTool})=>{
    if(text.includes('【等待条件更新】'))return '等待已结束'
    if(text.includes('SUPPLEMENT')){const r=await callTool('qq_wait',{condition:'request',timeout_ms:30000});assert.equal(r.ok,true);return '等待补充期间不发'}
    if(text.includes('WAIT')){const r=await callTool('qq_wait',{condition:'time',timeout_ms:1000});assert.equal(r.ok,true);return '这句不能发送'}
    if(text.includes('STOP')){const r=await callTool('qq_stop',{reason:'没有后续动作'});assert.equal(r.ok,true);lateTool=await callTool('qq_set_nickname',{name:'禁止改成这个'});return '这句也不能发送'}
    return '普通回复'
  }})
  host=(await import('../src/host.js')).apply(fake.ctx);await host.ready
  await fake.call('/onebot/reconnect');await until(()=>mock.connected()>0)
})
after(async()=>{await fake?.dispose();await mock?.close()})
const push=text=>mock.push({message_type:'private',sub_type:'friend',self_id:20000002,user_id:10000001,message_id:Date.now(),sender:{user_id:10000001,nickname:'fixture'},message:[{type:'text',data:{text}}]})
test('宿主整合（模拟DSH/QQ）：wait停止普通回复并经持久队列只唤醒一次',async()=>{
  push('WAIT');await until(()=>outgoing().some(c=>c.params.message.some(s=>s.data?.text==='等待已结束')))
  assert.equal(outgoing().some(c=>JSON.stringify(c.params).includes('这句不能发送')),false)
  await new Promise(r=>setTimeout(r,1200))
  assert.equal(fake.turns.filter(t=>t.userText.includes('【等待条件更新】')).length,1)
  const r=(await fake.call('/tasks/list?chatId=private:10000001')).json();assert.equal(r.ok,true);assert.equal(r.list.some(t=>t.state==='woken'),true)
})
test('stop禁止迟到工具和回复，不重置会话epoch',async()=>{
  const before=outgoing().length
  push('STOP');await until(()=>lateTool)
  assert.equal(lateTool.code,'PLANNER_STOPPED');await new Promise(r=>setTimeout(r,250))
  assert.equal(outgoing().length,before);assert.equal(mock.sent('set_qq_profile').length,0)
  push('AFTER');await until(()=>outgoing().length>before)
  assert.equal(outgoing().at(-1).params.message.some(s=>s.data?.text==='普通回复'),true)
})

test('等待同一请求者补充时把新来源和正文接回原请求，只有一次新回合',async()=>{
  push('SUPPLEMENT')
  await until(()=>fake.turns.some(t=>t.userText.includes('SUPPLEMENT')))
  await new Promise(r=>setTimeout(r,100))
  const before=fake.turns.length
  push('补充：换成雨天，保留原来的脸')
  await until(()=>fake.turns.length>before)
  assert.match(fake.turns.at(-1).userText,/【等待条件更新】/)
  assert.match(fake.turns.at(-1).userText,/补充：换成雨天/)
  await new Promise(r=>setTimeout(r,800))
  assert.equal(fake.turns.length,before+1)
  const waits=(await fake.call('/tasks/list?chatId=private:10000001')).json().list
  assert.equal(waits.find(w=>w.condition==='request')?.state,'woken')
})
