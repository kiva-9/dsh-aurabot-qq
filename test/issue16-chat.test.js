import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessageEvent, isStickerSegment } from '../src/chat/inbound.js'
import { decideGroupReply } from '../src/chat/group-policy.js'
import qqTools, { decodeIncomingText } from '../src/modules/qq-tools/index.js'

test('mentioning another person suppresses wake word while a direct mention still wins', () => {
  const msg = parseMessageEvent({ message_type:'group', group_id:1, user_id:2, message:[{type:'at',data:{qq:'3'}},{type:'text',data:{text:'大肥鱼'}}] }, '4')
  assert.equal(msg.mentionedOthers, true)
  const p = { policy:{wakeWords:['大肥鱼'],interjectChance:0}, text:msg.text, mentionedOthers:msg.mentionedOthers, now:1 }
  assert.equal(decideGroupReply(p).reply, false)
  assert.equal(decideGroupReply({...p, mentioned:true}).reply, true)
  assert.equal(isStickerSegment({type:'image',data:{sub_type:7,summary:'[笑哭]'}}), true)
  assert.equal(isStickerSegment({type:'image',data:{subType:'7',summary:'[笑哭]'}}), true)
  assert.equal(isStickerSegment({type:'image',data:{sub_type:7}}), false)
  assert.equal(isStickerSegment({type:'image',data:{sub_type:7,summary:'[图片]'}}), false)
})

test('send tool reports unknown and partial deliveries without claiming full success', async () => {
  let factory, result = { confirmed:false, complete:false, deliveries:[{unknown:1,rows:[{state:'unknown'}]}] }
  const cfg = {botQQ:'1',ownerQQ:'2',allow:{groups:[],private:['3']},files:{enabled:false}}
  qqTools.setup({config:()=>cfg,core:{hub:{deliver:async()=>result,turnSendersAllOwner:()=>true},onebot:{},storage:{}},tool:f=>factory=f})
  const tool = factory({chat:{kind:'private',userId:'2',chatId:'private:2'},level:'full',sessionId:'s'}).find(t=>t.name==='qq_send_message')
  assert.equal((await tool.execute({target:'private:3',text:'x'})).status, 'unknown')
  result = {confirmed:true,complete:false,deliveries:[]}
  const partial = await tool.execute({target:'private:3',text:'x'})
  assert.equal(partial.status,'partial'); assert.equal(partial.ok,false)
})

test('timed out system turn cannot complete a later same-name task', async t => {
  const { hubFixture, until } = await import('./helpers/hub-fixture.js')
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const f = await hubFixture(t, { brain: async ({text}) => text === 'first' ? (await firstGate, 'stale') : 'fresh' })
  const first = f.hub.runSystemTurn('isolation', 'test', 'first', { timeoutMs: 30 })
  await until(() => f.fake.agents.size > 0)
  await assert.rejects(first, /等太久/)
  const second = f.hub.runSystemTurn('isolation', 'test', 'second', { timeoutMs: 1000 })
  releaseFirst()
  assert.equal(await second, 'fresh')
})

test('history search stays in scope and requires explicit policy and membership for cross-chat', async t => {
  const { hubFixture, OWNER, BOT, GROUP } = await import('./helpers/hub-fixture.js')
  const f = await hubFixture(t)
  const current = `private:${OWNER}`, target = `group:${GROUP}`, now = Date.now()
  f.storage.messages.ingest({account:BOT,chatId:current,eventKind:'message',authorId:OWNER,platformTime:now,text:'needle private'})
  f.storage.messages.ingest({account:BOT,chatId:target,eventKind:'message',authorId:OWNER,platformTime:now,text:'needle group'})
  let factory, member = false
  const hub = {scopeFor:()=>({persona:'p'}),turnSendersAllOwner:()=>true}
  const onebot = {call:async()=>member ? {user_id:Number(OWNER),group_id:Number(GROUP)} : {}}
  qqTools.setup({config:()=>f.cfg,core:{hub,onebot,storage:f.storage},tool:x=>factory=x})
  const tool = factory({chat:{kind:'private',userId:OWNER,chatId:current},level:'full',sessionId:'s'}).find(x=>x.name==='qq_search_history')
  assert.match((await tool.execute({keyword:'needle'})).message,/private/)
  assert.equal((await tool.execute({keyword:'needle',target})).ok,false)
  f.cfg.crossChatHistory = [{enabled:true,account:BOT,persona:'p',fromChatId:current,targetChatId:target}]
  assert.equal((await tool.execute({keyword:'needle',target})).ok,false)
  member = true
  assert.match((await tool.execute({keyword:'needle',target})).message,/group/)
  f.cfg.crossChatHistory = []
  assert.equal((await tool.execute({target})).ok,false)
})

test('nested forwards retain media occurrence chain and stop cycles', async t => {
  const { hubFixture, BOT, GROUP, until } = await import('./helpers/hub-fixture.js')
  const { png } = await import('./helpers/images.js')
  const calls = [], prompts = []
  const f = await hubFixture(t, {config:{merge:{enabled:false}}, brain:({text})=>{prompts.push(text); return '[沉默]'}, onebot:{call:async (action, args)=>{
    if (action === 'get_group_info') return {group_name:'g'}
    if (action !== 'get_forward_msg') return {}
    calls.push(args.id)
    return args.id === 'outer' ? {messages:[{sender:{user_id:2,nickname:'A'},message:[{type:'forward',data:{id:'inner'}}]}]} : {messages:[{sender:{user_id:3,nickname:'B'},message:[{type:'image',data:{file:'base64://'+png().toString('base64')}},{type:'forward',data:{id:'outer'}}]}]}
  }}})
  await f.hub.onMessage({message_type:'group',group_id:Number(GROUP),user_id:123,self_id:Number(BOT),message_id:773,time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:BOT}},{type:'forward',data:{id:'outer'}}]})
  await until(()=>prompts.length)
  assert.deepEqual(calls,['outer','inner'])
  const row = f.storage.db.get('SELECT remote_json FROM asset_occurrences LIMIT 1')
  assert.deepEqual(JSON.parse(row.remote_json).forward.chain.map(x=>x.id),['outer','inner'])
})


test('incoming text decode handles GB18030, rejects binary and oversized data, and safely clips', () => {
  assert.equal(decodeIncomingText(Buffer.from('d6d0cec4','hex')).text, '中文')
  assert.throws(()=>decodeIncomingText(Buffer.from([65,0,66])))
  assert.throws(()=>decodeIncomingText(Buffer.alloc(2*1024*1024+1,65)))
  const out = decodeIncomingText(Buffer.from('a'.repeat(19999)+'😀'))
  assert.equal(out.truncated,true); assert.equal(out.text.isWellFormed(),true)
})

test('file tool defaults disabled and refuses an ID from another chat', async t => {
  const { hubFixture, OWNER, BOT, GROUP } = await import('./helpers/hub-fixture.js')
  const f = await hubFixture(t)
  f.storage.messages.ingest({account:BOT,chatId:`group:${GROUP}`,eventKind:'message',platformMsgId:'77',authorId:OWNER,platformTime:Date.now(),text:'file',segments:[{type:'file',data:{name:'a.txt',file_id:'x'}}]})
  let factory, calls=0
  qqTools.setup({config:()=>f.cfg,core:{hub:{},onebot:{call:async()=>{calls++;return {}}},storage:f.storage},tool:x=>factory=x})
  const tool=factory({chat:{kind:'private',userId:OWNER,chatId:`private:${OWNER}`},level:'full',sessionId:'s'}).find(x=>x.name==='qq_read_text_file')
  assert.equal((await tool.execute({message_id:'77'})).ok,false)
  f.cfg.incomingFiles={enabled:true}
  assert.equal((await tool.execute({message_id:'77'})).ok,false)
  assert.equal(calls,0)
})

test('private text attachment binds gateway user/hash and rejects deletion or epoch change during URL resolution', async t => {
  const { hubFixture, OWNER, BOT } = await import('./helpers/hub-fixture.js')
  for (const cause of ['delete', 'epoch']) await t.test(cause, async t => {
    const f = await hubFixture(t, { config: { incomingFiles: { enabled: true } } }), chatId = `private:${OWNER}`
    const source = f.storage.messages.ingest({ account: BOT, chatId, eventKind: 'message', platformMsgId: 'file-1', authorId: OWNER,
      platformTime: Date.now(), segments: [{ type: 'file', data: { name: 'a.txt', file_id: 'opaque-file', hash: 'file-hash' } }] })
    let factory
    qqTools.setup({ config: () => f.cfg, tool: fn => { factory = fn }, core: { storage: f.storage, hub: {}, onebot: { call: async (action, params) => {
      assert.equal(action, 'get_private_file_url'); assert.deepEqual(params, { user_id: Number(OWNER), file_id: 'opaque-file', file_hash: 'file-hash' })
      if (cause === 'delete') f.storage.db.run('DELETE FROM messages WHERE id=?', source.id)
      else f.storage.epochs.bump(chatId, 'reset')
      return { url: 'https://must-not-be-downloaded.invalid/a.txt' }
    } } } })
    const tool = factory({ chat: { kind: 'private', userId: OWNER, chatId }, level: 'full', sessionId: 's' }).find(t => t.name === 'qq_read_text_file')
    const result = await tool.execute({ message_id: 'file-1' })
    assert.equal(result.ok, false); assert.match(result.message, /来源已失效/)
  })
})

test('summary material has bounded evidence and cross-chat access audit; revoked policy returns no material', async t => {
  const { hubFixture, OWNER, BOT, GROUP } = await import('./helpers/hub-fixture.js')
  const f = await hubFixture(t), current = `private:${OWNER}`, target = `group:${GROUP}`
  const source = f.storage.messages.ingest({ account: BOT, chatId: target, eventKind: 'message', authorId: OWNER, text: 'real fact', platformTime: Date.now() })
  f.cfg.crossChatHistory = [{ enabled: true, account: BOT, persona: 'p', fromChatId: current, targetChatId: target }]
  let factory, revoke = false
  qqTools.setup({ config: () => f.cfg, tool: fn => { factory = fn }, core: { storage: f.storage,
    hub: { scopeFor: () => ({ persona: 'p' }), turnSendersAllOwner: () => true },
    onebot: { call: async () => { if (revoke) f.cfg.crossChatHistory = []; return { user_id: Number(OWNER) } } } } })
  const tool = factory({ chat: { kind: 'private', userId: OWNER, chatId: current }, level: 'full', sessionId: 's' }).find(t => t.name === 'qq_summarize_history')
  const result = await tool.execute({ target, count: 1 })
  assert.equal(result.sourceChat, target); assert.equal(result.partial, true)
  assert.equal(result.records[0].id, source.id)
  assert.deepEqual(f.storage.meta.get('cross-chat-history:' + BOT)[0].sourceMessageIds, [source.id])
  revoke = true
  assert.equal((await tool.execute({ target })).ok, false)
  assert.equal(f.storage.meta.get('cross-chat-history:' + BOT).length, 1)
})

test('mixed request actors cannot authorize high risk while attribution remains available', async t => {
  const {hubFixture,groupChat,OWNER,until}=await import('./helpers/hub-fixture.js')
  let release; const gate=new Promise(r=>release=r)
  const f=await hubFixture(t,{brain:()=>gate}), chat=groupChat()
  const requests=[OWNER,'30000003'].map((actorId,i)=>{
    const m=f.storage.messages.ingest({account:f.cfg.botQQ,chatId:chat.chatId,eventKind:'message',platformMsgId:String(i+1),authorId:actorId,platformTime:Date.now(),text:'request'})
    return f.storage.requests.create({chatId:chat.chatId,actorId,sourceMessageIds:[m.id],policyRevision:0})
  })
  const turn=f.hub.pushToSession(chat,[{type:'text',text:'requests'}],OWNER,{requests})
  await until(()=>f.hub.sessions()[chat.chatId] && [...f.fake.agents.values()].some(a=>a.status==='running'))
  const sid=f.hub.sessions()[chat.chatId].sessionId
  assert.equal(f.hub.turnSendersAllOwner(sid),false)
  assert.equal(f.hub.turnRequests(sid).length,2)
  assert.match(f.hub.turnActor(sid).error,/for_message/)
  release('[沉默]'); await turn
})

test('source speaker metadata carries actual upstream shape for a trusted owner request', async t => {
  const {hubFixture,privateChat,OWNER,until}=await import('./helpers/hub-fixture.js')
  const f=await hubFixture(t), chat=privateChat()
  await f.hub.pushToSession(chat,[{type:'text',text:'first'}],OWNER)
  await until(()=>f.fake.turns.length)
  const sid=f.hub.sessions()[chat.chatId].sessionId, agent=f.fake.agents.get(sid)
  let captured; agent.followup=async m=>{captured=m}
  const msg=f.storage.messages.ingest({account:f.cfg.botQQ,chatId:chat.chatId,eventKind:'message',authorId:OWNER,platformTime:Date.now(),text:'next'})
  const request=f.storage.requests.create({chatId:chat.chatId,actorId:OWNER,sourceMessageIds:[msg.id],policyRevision:0})
  await f.hub.pushToSession(chat,[{type:'text',text:'next'}],OWNER,{requests:[request]})
  assert.deepEqual(captured.source,{kind:'aurabot',speaker:{role:'owner',chat:'private'}})
})

test('all forward roots share one network-call budget', async t => {
  const {hubFixture,BOT,GROUP,until}=await import('./helpers/hub-fixture.js')
  let calls=0, seen=false
  const f=await hubFixture(t,{config:{merge:{enabled:false}},brain:()=>{seen=true;return '[沉默]'},onebot:{call:async action=>{if(action==='get_forward_msg'){calls++;return {messages:[{sender:{user_id:5,nickname:'n'},message:[{type:'text',data:{text:'x'}}]}]}} return {}}}})
  await f.hub.onMessage({message_type:'group',group_id:Number(GROUP),user_id:123,self_id:Number(BOT),message_id:774,time:Math.floor(Date.now()/1000),message:[{type:'at',data:{qq:BOT}},...Array.from({length:12},(_,i)=>({type:'forward',data:{id:String(i)}}))]})
  await until(()=>seen)
  assert.equal(calls,8)
})
