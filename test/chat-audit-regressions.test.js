import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFollowupTracker, earlierMediaSource } from '../src/chat/followup.js'
import { installSocialScope } from '../src/chat/session-scope.js'
import { publicReply } from '../src/chat/public-reply.js'
import { compactShortReplies } from '../src/chat/reply.js'

test('same-author image/question continues explicit task through cooldown, never other actor/chat/epoch or unrelated banter', () => {
  let now = 100
  const tracker = createFollowupTracker({ now: () => now })
  const s = { account: 'a', chatId: 'group:g', actorId: 'u', epoch: 0, messageId: 'at' }
  assert.equal(tracker.accept({ ...s, direct: true }).followup, false)
  now += 385
  assert.equal(tracker.accept({ ...s, messageId: 'image', media: true }).anchorId, 'at')
  assert.equal(tracker.accept({ ...s, messageId: 'q', text: '为什么任务管理器找不到进程' }).followup, true)
  for (const patch of [{ actorId: 'other' }, { chatId: 'group:other' }, { epoch: 1 }, { account: 'b' }]) assert.equal(tracker.accept({ ...s, ...patch, media: true }).followup, false)
  assert.equal(tracker.accept({ ...s, text: '哈哈哈哈' }).followup, false)
  assert.equal(tracker.accept({ ...s, media: true, stickerOnly: true }).followup, false)
  now += 90001
  assert.equal(tracker.accept({ ...s, text: '为什么' }).followup, false)
})

test('implicit previous-image lookup refuses ambiguous, withdrawn, expired or other-scope image sources', () => {
  const a = { id: 'i', account: 'a', chatId: 'group:g', authorId: 'u', receivedAt: 100, recvSeq: 1, recalledAt: null }
  let rows = [a]
  const storage = { messages: { recent: () => rows }, occurrences: { ofMessage: () => [{ kind: 'image' }] } }
  const query = { account: 'a', chatId: 'group:g', actorId: 'u', before: 5, now: 1000 }
  assert.equal(earlierMediaSource(storage, query).id, 'i')
  rows = [a, { ...a, id: 'ambiguous' }]; assert.equal(earlierMediaSource(storage, query), null)
  for (const patch of [{ account: 'b' }, { chatId: 'private:u' }, { authorId: 'b' }, { recalledAt: 1 }, { receivedAt: -3600000 }]) {
    rows = [{ ...a, ...patch }]; assert.equal(earlierMediaSource(storage, query), null)
  }
})

test('social restriction hides inherited and agent-local host tools and denies execution when not allowlisted or inactive', async () => {
  const filters = [], guards = []; let active = true, suppressed = false
  let assemble, mode
  const agent = { id: 'social', ctx: { on: (name, fn) => { assert.equal(name, 'system-prompt/assemble'); assemble = fn; return () => { assemble = null } }, tools: { presentAs: m => { mode = m; return () => { mode = null } }, restrict: f => { filters.push(f); return () => filters.pop() }, guard: f => { guards.push(f); return () => guards.pop() } },
    systemPrompt: { refreshContext: assembly => assembly, suppressRuntimeContext: () => { suppressed = true; return () => { suppressed = false } } } } }
  const off = installSocialScope(agent, ['qq_chat_history'], () => active)
  assert.deepEqual(filters, [{ allow: [] }]); assert.equal(suppressed, true)
  assert.equal(mode, 'native')
  const final = { tools: [{ name: 'qq_chat_history' }, { name: 'spawn_teammate' }], sections: ['persona'], contexts: [] }
  const assembly = await assemble({}, { scope: agent }, async () => final)
  assert.deepEqual(assembly.tools.map(tool => tool.name), ['qq_chat_history'])
  assert.equal(assembly.sections, final.sections)
  assert.equal(await assemble({}, { scope: { id: 'owner-private' } }, async () => final), final)
  assert.ok(guards[0]({ name: 'spawn_teammate' }))
  assert.ok(guards[0]({ name: 'terminal_send' })); assert.equal(guards[0]({ name: 'qq_chat_history' }), undefined)
  active = false; assert.ok(guards[0]({ name: 'qq_chat_history' }))
  off(); assert.equal(guards.length, 0); assert.equal(suppressed, false); assert.equal(assemble, null); assert.equal(mode, null)
  assert.throws(() => installSocialScope({ ctx: {} }, []), { code: 'SOCIAL_SCOPE_UNAVAILABLE' })
})

test('public replies omit accidental writing notes; do not rewrite quoted examples or code', () => {
  assert.equal(publicReply('轻松接一句就好，不用太在意那些说法。|||大家各司其职。').text, '大家各司其职。')
  const code = '```text\n轻松接一句就好，不用太在意。\n```'
  assert.equal(publicReply(code).text, code)
  assert.equal(publicReply('轻松接一句就好。', { userText: '请解释回复策略' }).removedNotes, 0)
  assert.equal(publicReply('“轻松接一句就好”是引用。').removedNotes, 0)
})

test('unfinished jobs cannot be described as completed artwork, while answers and delivered jobs stay intact', () => {
  const input = 'Python 用 list(dict.fromkeys(xs)) 去重。被抓那格我画得挺传神 hhh。'
  const result = publicReply(input, { jobs: [{ kind: 'image', state: 'running' }] })
  assert.match(result.text, /dict.fromkeys/); assert.doesNotMatch(result.text, /挺传神/); assert.match(result.text, /还在处理中/)
  assert.equal(publicReply(input, { jobs: [{ kind: 'image', state: 'delivered' }] }).text, input)
  assert.match(publicReply('歌曲已经发出来了。', { jobs: [{ kind: 'song', state: 'unknown' }] }).text, /尚未确认成功/)
})

test('live afternoon future-delivery replies keep their wording without bypassing actual completion claims', () => {
  const jobs = [{ kind: 'image', state: 'running' }, { kind: 'song', state: 'running' }]
  for (const text of ['在画了，泡浴缸伸腿的版本，画好直接发出来。', '散步版在画了，画好直接发群里。',
    '画上了，初音那边拿葱应战，画好直接发群里。', '这首歌唱好以后就发给你。']) {
    const result = publicReply(text, { jobs })
    assert.equal(result.text, text)
    assert.equal(result.correctedClaims, 0)
  }
  const result = publicReply('这张已经画好了，画好会发给你。', { jobs })
  assert.equal(result.correctedClaims, 1)
  assert.doesNotMatch(result.text, /已经画好了/)
})

test('short group answers coalesce without losing content, quotations or code boundaries', () => {
  const texts = ['第一句', '第二句', '第三句'].map(value => ({ kind: 'text', value }))
  assert.deepEqual(compactShortReplies(texts), [{ kind: 'text', value: '第一句\n第二句\n第三句' }])
  const protectedItems = [{ kind: 'text', value: '回应', replyTo: '1' }, { kind: 'text', value: '```js\nf()\n```' }, ...texts]
  assert.deepEqual(compactShortReplies(protectedItems).slice(0, 2), protectedItems.slice(0, 2))
})
