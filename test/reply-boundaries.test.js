import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { compactShortReplies, parseReply, replySourceRefs, createReplySource, capItems } from '../src/chat/reply.js'
import { publicReply } from '../src/chat/public-reply.js'
import { rewriteReply, REPLY_SCHEMA, REPLY_VERSION } from '../src/chat/replyer.js'
import { createHub } from '../src/chat/hub.js'
import { createStorage } from '../src/storage/index.js'
import { normalize } from '../src/core/config.js'

const reported = '认识认识 主人！|||刚才被他们绕晕了嘛'
const values = items => items.map(item => item.value)
const rendered = text => compactShortReplies(parseReply(text).items)

test('the reported explicit split survives short-text compaction and repeated compaction', () => {
  const items = parseReply(reported).items, before = values(items)
  const result = compactShortReplies(items)
  assert.deepEqual(values(result), ['认识认识 主人！', '刚才被他们绕晕了嘛'])
  assert.deepEqual(values(compactShortReplies(result)), values(result))
  assert.deepEqual(values(items), before)
  assert.deepEqual(result.flatMap(replySourceRefs).map(ref => ref.raw), before)
})

test('ordinary line breaks can compact on either side without erasing the explicit boundary', () => {
  const source = '第一行\n第二行|||第三行\n第四行'
  const result = rendered(source)
  assert.deepEqual(values(result), ['第一行\n第二行', '第三行\n第四行'])
  assert.deepEqual(values(compactShortReplies(result)), values(result))
  assert.equal(result.flatMap(replySourceRefs).map(ref => ref.raw).join(''), source.replace('|||', ''))
  // The existing per-turn bubble cap still applies; no content is discarded.
  assert.deepEqual(values(capItems(rendered('一|||二|||三|||四'), 3)), ['一', '二', '三\n四'])
  assert.deepEqual(values(capItems(rendered('甲\n乙\n丙\n丁|||戊|||己'), 3)), ['甲\n乙\n丙\n丁', '戊', '己'])
})

test('public corrections retain explicit splits, code literals, media and quoted examples', () => {
  assert.equal(publicReply(reported).text, reported)
  const code = '```js\nconst marker = "|||";\n```'
  const original = '轻松接一句就好。|||' + code + '|||我已经画好了。|||继续聊'
  const result = publicReply(original, { jobs: [{ kind: 'image', state: 'running' }] })
  assert.equal(result.removedNotes, 1)
  assert.equal(result.correctedClaims, 1)
  assert.equal(result.text, code + '|||图片任务已提交，还在处理中，完成后会发送。|||继续聊')
  assert.equal(rendered(result.text)[0].value, code)
  for (const literal of ['「轻松接一句就好|||已经画好了」', '~~~text\n轻松接一句就好|||已经画好了\n~~~',
    '<voice>原文|||保留</voice>', 'https://example.org/a?x=|||literal']) {
    assert.equal(publicReply('轻松接一句就好。|||' + literal).text, literal)
  }
  assert.equal(publicReply('轻松接一句就好。|||<reply:7>好呀|||<sticker:开心>').text, '<reply:7>好呀|||<sticker:开心>')
})

test('removing a quoted writing note does not quote the following text or media', () => {
  for (const tail of ['这句不引用', '<sticker:开心>', '![图](https://example.org/a.png)']) {
    const result = publicReply('<reply:7>轻松接一句就好。|||' + tail)
    assert.equal(result.removedNotes, 1)
    assert.equal(result.text, tail)
    assert.ok(parseReply(result.text).items.every(item => item.replyTo == null))
  }
  assert.equal(publicReply('<reply:7>轻松接一句就好。\n这句不引用').text, '这句不引用')
  assert.equal(publicReply('<reply:7>|||正常引用').text, '<reply:7>正常引用')
})

test('an inline protected fragment does not hide a separate false completion claim on the same line', () => {
  for (const prefix of ['参数用 `seed`。', '参数见 [说明](https://example.org)。', '链接 https://example.org 。']) {
    const result = publicReply(prefix + '图片已经画好了。', { jobs: [{ kind: 'image', state: 'running' }] })
    assert.equal(result.correctedClaims, 1)
    assert.equal(result.text, prefix + '图片任务已提交，还在处理中，完成后会发送。')
  }
  assert.equal(publicReply('`图片已经画好了。`|||普通文字', { jobs: [{ kind:'image',state:'running' }] }).correctedClaims, 0)
})

test('a validated Replyer plan retains the explicit split in the final compacted output', async () => {
  const r = await rewriteReply(reported, { ask: async () => ({ schema: REPLY_SCHEMA, version: REPLY_VERSION,
    blocks: createReplySource(reported).blocks.map(b => ({ type: b.type, ref: b.id })) }) })
  assert.equal(r.rewritten, true)
  assert.deepEqual(values(compactShortReplies(r.reply.items)), ['认识认识 主人！', '刚才被他们绕晕了嘛'])
})

test('hub delivers the reported reply as two ordered gateway sends with two confirmed outbox rows', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aurabot-reply-boundaries-')), previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = root
  const storage = createStorage({ file: ':memory:', filesDir: join(root, 'assets') })
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001',
    allow: { groups: ['62001'] }, voice: { enabled: false }, stickers: { enabled: false } })
  const sends = []
  const hub = createHub({ storage, dsh: {}, getConfig: () => cfg, log: { info() {}, warn() {}, debug() {}, error() {} },
    onebot: { async call(action, params) {
      assert.equal(action, 'send_group_msg')
      assert.equal(params.group_id, 62001)
      sends.push(params.message)
      return { message_id: 1000 + sends.length }
    } } })
  t.after(async () => {
    await hub.dispose(); storage.close()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR; else process.env.AURABOT_DATA_DIR = previous
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.match(root, /aurabot-reply-boundaries-/)
    rmSync(root, { recursive: true, force: true })
  })
  const result = await hub.deliver('group:62001', reported)
  assert.equal(result.complete, true)
  assert.deepEqual(sends.map(segments => segments.map(s => s.data.text).join('')), ['认识认识 主人！', '刚才被他们绕晕了嘛'])
  const rows = storage.db.all('SELECT seq,state,platform_msg_id FROM outbox ORDER BY seq')
  assert.deepEqual(rows.map(r => [r.seq, r.state, r.platform_msg_id]), [[0, 'delivered', '1001'], [1, 'delivered', '1002']])
})
