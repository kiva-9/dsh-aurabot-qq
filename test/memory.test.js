// Pure retrieval behavior remains independently tested; global JSON behavior was unsafe.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tokenize,buildIndex,search,similarity,retention,shouldForget,whenText,memoryLine} from '../src/features/memory.js'
import {normalize} from '../src/core/config.js'

test('Chinese bigrams, exact identifiers, and independent multi-speaker weighting', () => {
  assert.deepEqual(tokenize('喜欢吃白米饭'),['喜欢','欢吃','吃白','白米','米饭'])
  assert.ok(tokenize('QQ12345 GPT-4 2026-10-28').includes('qq12345'))
  const index=buildIndex([
    {id:'a',text:'阿花喜欢白米饭',about:'u1',at:Date.now(),importance:0.8},
    {id:'b',text:'小明在学吉他',about:'u2',at:Date.now(),importance:0.5},
    {id:'c',text:'天气预报',at:Date.now(),importance:0.5},
  ])
  assert.equal(search(index,'中午吃米饭')[0].it.id,'a')
  assert.deepEqual(search(index,'今天怎么样',{about:['u1','u2']}).map(h=>h.it.id).sort(),['a','b'])
  assert.deepEqual(search(index,'量子力学'),[])
  assert.ok(similarity('主人最爱吃白米饭','主人最爱吃白米饭了')>0.6)
})
test('retention helpers do not themselves delete storage or raw evidence', () => {
  const now=Date.now(), old={source:'auto',importance:0.4,at:now-90*86400000}
  assert.equal(shouldForget(old,now),true)
  assert.equal(shouldForget({...old,source:'event'},now),false)
  assert.ok(retention({...old,hitDays:5,lastHit:now-86400000},now)>0.9)
})
test('dates retain old formatting helper and recall lines add absolute source dates', () => {
  const now=new Date(2026,9,25,12).getTime()
  assert.equal(whenText(now,now),'今天')
  assert.equal(whenText(now-86400000,now),'昨天')
  const line=memoryLine({text:'周五见面',eventTime:now,status:'active',modality:'plan',sources:[{id:'e1',messageId:'m1',kind:'message',speakerId:'u1',scope:{chat:'group:1'}}]})
  assert.match(line,/2026-10-25/)
  assert.match(line,/m1@group:1\/u1/)
  assert.match(line,/plan/)
})
test('incremental configuration preserves count/time thresholds and removes daily cleanup switches', () => {
  const config=normalize({memory:{consolidateAt:'03:30',dailyConsolidate:true,extraction:{minMessages:7,intervalMs:120000,maxBatchMessages:12}}}).memory
  assert.equal(config.extraction.minMessages,7)
  assert.equal(config.extraction.intervalMs,120000)
  assert.equal(config.extraction.maxBatchMessages,12)
  assert.equal(config.consolidateAt,undefined)
  assert.equal(config.dailyConsolidate,undefined)
})
