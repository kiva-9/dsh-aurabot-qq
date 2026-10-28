// B 站：签名、Cookie / 链接 / 分享卡片解析、刷一轮（评论、分享、记忆）、回复别人、看你发来的视频。用假的 B 站和假的模型测。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let api
let duty
let normalize

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-'))
  api = await import('../src/bili/api.js')
  duty = await import('../src/bili/duty.js')
  ;({ normalize } = await import('../src/core/config.js'))
})

test('WBI 签名和文档里的例子一致', () => {
  const q = api.wbiSign({ foo: '114', bar: '514', zab: 1919810 }, '7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45', 1702204169 * 1000)
  assert.equal(q, 'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4')
})

test('解析：Cookie 只取有用的、认出视频号和短链、QQ 分享卡片', async () => {
  assert.deepEqual(api.parseCookie('SESSDATA=abc; bili_jct=x1; foo=bar; buvid3=b3'), { SESSDATA: 'abc', bili_jct: 'x1', buvid3: 'b3' })
  assert.deepEqual(api.findVideoId('看这个 https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), { bvid: 'BV1GJ411x7h7' })
  assert.deepEqual(api.findVideoId('av170001'), { aid: '170001' })
  assert.deepEqual(api.findVideoId('https://b23.tv/abc123 哈哈'), { short: 'https://b23.tv/abc123' })
  assert.equal(api.findVideoId('没有链接'), null)
  const { cardText } = await import('../src/chat/inbound.js')
  const card = JSON.stringify({ meta: { detail_1: { title: '哔哩哔哩', desc: '猫猫做饭', qqdocurl: 'https://b23.tv/xyz?share=1' } } })
  assert.equal(cardText(card), '[分享卡片（哔哩哔哩）：猫猫做饭 https://b23.tv/xyz]')
  assert.equal(cardText('不是 json'), '[卡片消息]')
})

test('过滤：播放量、发布时间、看过的', () => {
  const now = Date.now()
  const list = [
    { bvid: 'a', play: 100, pubdate: now },
    { bvid: 'b', play: 9000, pubdate: now - 100 * 86400_000 },
    { bvid: 'c', play: 9000, pubdate: now },
    { bvid: 'd', play: 9000, pubdate: now },
  ]
  assert.deepEqual(duty.filterVideos(list, { minViews: 5000, maxAgeDays: 60, seen: new Set(['d']), now }).map((v) => v.bvid), ['c'])
})

function fakes({ decisions, replyText = '是呀 我也觉得', cfgOver = {}, global = {}, postError = null, thinkTimeoutMs } = {}) {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-bili-case-'))
  const posted = []
  const sent = []
  const events = []
  const facts = []
  const reads = [], prompts = []
  let epoch = 0, personaId = 'fish'
  const cfg = normalize({ enabled: true, dryRun: false, botQQ: '90000001', ownerQQ: '10000001', ...global, bili: { enabled: true, cookie: 'SESSDATA=x; bili_jct=y', perRun: 2, maxCommentsPerDay: 1, ...cfgOver } })
  const scope = (chat = 'private:10000001') => ({ account: String(cfg.botQQ), chat, persona: personaId })
  const fakeApi = {
    nav: async () => ({ isLogin: true, uname: '肥鱼小号' }),
    search: async (kw) => [{ bvid: 'BV1aaaaaaaaa', aid: 1, title: kw + ' 视频一', play: 20000, pubdate: Date.now() }, { bvid: 'BV1bbbbbbbbb', aid: 2, title: kw + ' 视频二', play: 30000, pubdate: Date.now() }],
    popular: async () => [],
    view: async ({ bvid }) => ({ bvid: bvid || 'BV1ccccccccc', aid: bvid === 'BV1bbbbbbbbb' ? 2 : 1, cid: 9, title: bvid === 'BV1bbbbbbbbb' ? '猫猫做饭' : '米饭大赛', author: 'UP主', play: 20000, desc: '简介' }),
    subtitle: async () => '大家好今天做饭',
    comments: async () => [{ name: '网友', text: '好香' }],
    postComment: async (aid, message, o) => { if (postError) { posted.push({ failed: true }); throw postError } posted.push({ aid, message, ...(o || {}) }); return { rpid: 1 } },
    likeVideo: async () => {},
    setSign: async (sign) => { posted.push({ sign }) },
    setFace: async (image) => { posted.push({ image }) },
    replyFeed: async () => [{ id: 'f1', name: '路人甲', text: '你也爱吃米饭？', myText: '看饿了', oid: 1, root: 100, parent: 101, title: '米饭大赛', type: 1 }],
    resolveShort: async () => 'https://www.bilibili.com/video/BV1bbbbbbbbb',
  }
  const hub = {
    personaFor: () => ({ personaId, layers: { identity: { name: '小鱼' } } }),
    scopeFor: (chat) => scope(chat),
    runSystemTurn: async (name, title, prompt) => {
      prompts.push(prompt)
      if (prompt.includes('挑 3 个')) return '["米饭","猫咪"]'
      if (prompt.includes('看完说说你的想法')) return JSON.stringify(decisions)
      if (prompt.includes('回复你')) return replyText
      return ''
    },
    sendText: async (chatId, text, _replyId, options) => { sent.push({ chatId, text, options }); return { delivered: 1, messageIds: ['qq-receipt-1'] } },
    logChat: () => {},
  }
  const memory = {
    list: (opts) => { reads.push(opts); return [{ text: '主人喜欢猫', scope: { ...scope(), persona: '' } }] },
    recentEvents: (opts) => { reads.push(opts); return [] },
    addEvent: (e) => { events.push(e); return { ok: true } },
    add: (m) => facts.push(m.text),
  }
  const b = duty.createBili({ getConfig: () => cfg, hub, storage: { epochs: { current: () => epoch } }, memory, log: { info() {}, warn() {}, debug() {} }, api: fakeApi,
    thinkTimeoutMs, think: (prompt) => hub.runSystemTurn('test', 'test', prompt) })
  const context = (chat = 'private:10000001', actorId = cfg.ownerQQ) => ({ scope: scope(chat), personaSnapshot: hub.personaFor(chat), actorId, requestId: 'req:manual', epoch })
  return { b, posted, sent, events, facts, reads, prompts, context, cfg, hub, memory, fakeApi, bump: () => epoch++, persona: (id) => { personaId = id } }
}

test('刷一轮：真实评论/分享回执记经历；资料摘要与 remember 不写事实', async () => {
  const { b, posted, sent, events, facts } = fakes({ decisions: [
    { i: 1, feeling: '米饭好香', comment: '看饿了', share: '', remember: '有个米饭大赛很好玩' },
    { i: 2, feeling: '猫好可爱', comment: '猫猫好会', share: '主人你看这只猫会做饭！', remember: '' },
  ] })
  const r = await b.run({ force: true })
  assert.equal(r.ok, true, r.message)
  assert.equal(r.watched, 2)
  assert.equal(posted.length, 1, '每天最多 1 条，只发了第一条')
  assert.equal(posted[0].message, '看饿了')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].chatId, 'private:10000001')
  assert.match(sent[0].text, /会做饭！\nhttps:\/\/www\.bilibili\.com\/video\/BV1/)
  assert.equal(events.length, 2)
  assert.ok(events.some((e) => e.text.includes('下评论：看饿了') && e.sourceId === 'bili:reply:1'))
  assert.ok(events.every((e) => e.confirmed && e.scope.account === '90000001' && e.scope.chat === 'private:10000001' && e.scope.persona === 'fish'))
  assert.deepEqual(facts, [])
  assert.equal(b.state().comments, 1)
  // 看过的不会再看
  const r2 = await b.run({ force: true })
  assert.equal(r2.ok, false)
})

test('回复别人：带上楼层、按格式回，回过的不再回', async () => {
  const { b, posted, events } = fakes({ decisions: [] })
  const r = await b.checkReplies()
  assert.equal(r.replied, 1)
  assert.deepEqual(posted[0], { aid: 1, message: '回复 @路人甲 :是呀 我也觉得', root: 100, parent: 101 })
  assert.ok(events.some((e) => e.text.includes('在B站回复了 路人甲') && e.sourceId === 'bili:reply:1'))
  assert.equal((await b.checkReplies()).replied, 0)
})

test('看你发来的视频（短链也行）；主人让她评论才发', async () => {
  const { b, posted, context, events } = fakes({ decisions: [] })
  const w = await b.watch('https://b23.tv/abc123', context('group:22'))
  assert.equal(w.ok, true)
  assert.match(w.message, /《猫猫做饭》/)
  assert.match(w.message, /字幕（节选）：大家好今天做饭/)
  assert.equal(w.scope.chat, 'group:22')
  assert.equal(w.confirmed, false)
  assert.equal(events.length, 0)
  const c = await b.comment('BV1bbbbbbbbb', '太会了', context('group:22'))
  assert.equal(c.ok, true)
  assert.deepEqual(posted[0], { aid: 2, message: '太会了' })
  assert.equal(events[0].scope.chat, 'group:22')
  assert.equal((await b.watch('没有链接', context())).ok, false)
  assert.equal((await b.watch('BV1bbbbbbbbb')).code, 'SCOPE_REQUIRED')
})

test('没登录不让她写评论；被风控就当天暂停评论和回复', async () => {
  const d = [{ i: 1, feeling: '好看', comment: '真好', share: '' }, { i: 2, feeling: '可爱', comment: '哈哈', share: '' }]
  const noLogin = fakes({ decisions: d, cfgOver: { cookie: '' } })
  await noLogin.b.run({ force: true })
  assert.equal(noLogin.posted.length, 0)
  const e = Object.assign(new Error('B 站返回 -352：风控校验失败'), { code: -352 })
  const risky = fakes({ decisions: d, cfgOver: { maxCommentsPerDay: 5 }, postError: e })
  await risky.b.run({ force: true })
  assert.equal(risky.posted.length, 1, '第一条失败后不再试第二条')
  assert.match(risky.b.state().pauseReason, /风控/)
  assert.equal(risky.b.state().canPost, false)
  assert.equal((await risky.b.checkReplies()).replied, 0)
  assert.equal(risky.posted.length, 1, '回复也不发了')
})

test('B 站 Cookie 分两个框填：纯值、带前缀、整串都认；老配置自动拆开；面板只看得到结尾几位', async () => {
  const { splitBiliCookie, publicConfig, mergeFromPanel } = await import('../src/core/config.js')
  assert.equal(splitBiliCookie({ sessdata: 'aaa', biliJct: 'bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.equal(splitBiliCookie({ sessdata: 'SESSDATA=aaa', biliJct: 'bili_jct=bbb' }).cookie, 'SESSDATA=aaa; bili_jct=bbb')
  assert.deepEqual(splitBiliCookie({ sessdata: 'buvid3=z; SESSDATA=a%2C1; bili_jct=b; x=1' }), { sessdata: 'a%2C1', biliJct: 'b', cookie: 'SESSDATA=a%2C1; bili_jct=b' })
  const cur = normalize({ bili: { cookie: 'SESSDATA=old1234; bili_jct=jct9876' } })
  assert.equal(cur.bili.sessdata, 'old1234')
  const pub = publicConfig(cur).bili
  assert.equal(pub.sessdataHint, '…1234')
  assert.equal(pub.sessdata + pub.biliJct + pub.cookie, '', '完整值不回传')
  const next = mergeFromPanel(cur, { bili: { sessdata: '', biliJct: 'new0000' } })
  assert.equal(next.bili.cookie, 'SESSDATA=old1234; bili_jct=new0000', '只改一个，另一个保留')
  const cleared = mergeFromPanel(next, { bili: { sessdata: null, biliJct: null, cookie: null } })
  assert.equal(cleared.bili.cookie, '')
})

test('#6 改 B 站签名：发对接口和 csrf；超长 / 空 / 试运行 / 没登录都不发', async () => {
  const reqs = []
  const real = api.createBiliApi({ getCookie: () => 'SESSDATA=x; bili_jct=tok', log: { debug() {}, warn() {} }, fetchImpl: async (url, o) => { reqs.push({ url, ...o }); return { status: 200, json: async () => ({ code: 0, data: {} }) } } })
  await real.setSign('今天也很开心')
  assert.equal(reqs[0].url, 'https://api.bilibili.com/x/member/web/sign/update')
  assert.equal(reqs[0].method, 'POST')
  const form = new URLSearchParams(reqs[0].body)
  assert.equal(form.get('user_sign'), '今天也很开心')
  assert.equal(form.get('csrf'), 'tok')
  await assert.rejects(api.createBiliApi({ getCookie: () => '', log: {} }).setSign('x'), /没登录/)

  const { b, posted, events, context } = fakes({})
  assert.equal((await b.setSign('', context())).ok, false)
  assert.equal((await b.setSign('字'.repeat(71), context())).ok, false)
  const r = await b.setSign('换个签名', context())
  assert.equal(r.ok, true)
  assert.deepEqual(posted, [{ sign: '换个签名' }])
  assert.equal(events.length, 0, '资料接口不提供回执 ID，不能伪造已确认经历')

  const bd = fakes({ global: { dryRun: true } })
  assert.match((await bd.b.setSign('试试', bd.context())).message, /试运行/)
  const bn = fakes({ cfgOver: { cookie: '' } })
  assert.equal((await bn.b.setSign('试试', bn.context())).ok, false)
  assert.equal(bd.posted.length + bn.posted.length, 0)
})

test('#6 换 B 站头像：先下载图片再 multipart 上传到 face/update；超 2MB / 非图片 / 试运行 / 没登录都不发', async () => {
  const reqs = []
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
  const mk = (img) => async (url, o = {}) => {
    reqs.push({ url, ...o })
    if (/^https:\/\/(img\.example|multimedia\.nt\.qq\.com)\//.test(url)) return { ok: true, status: 200, headers: { get: () => img.type }, arrayBuffer: async () => img.buf }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) }
  }
  const real = api.createBiliApi({ getCookie: () => 'SESSDATA=x; bili_jct=tok', log: { debug() {}, warn() {} }, fetchImpl: mk({ type: 'image/png', buf: png.buffer }) })
  await real.setFace('https://img.example/a.png')
  const up = reqs[1]
  assert.equal(up.url, 'https://api.bilibili.com/x/member/web/face/update?csrf=tok')
  assert.equal(up.method, 'POST')
  assert.ok(up.body instanceof FormData)
  assert.equal(up.body.get('dopost'), 'save')
  assert.equal(up.body.get('face').size, png.length)
  assert.equal(up.body.get('face').type, 'image/png')
  const big = api.createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'image/jpeg', buf: new ArrayBuffer(2 * 1024 * 1024 + 1) }) })
  await assert.rejects(big.setFace('https://img.example/b.jpg'), /2MB/)
  const html = api.createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'text/html', buf: new TextEncoder().encode('<html>hi</html>').buffer }) })
  await assert.rejects(html.setFace('https://img.example/c'), /不是图片/)
  // QQ 图床常回 application/octet-stream：按 PNG/JPEG/GIF/WebP 文件头认
  const qq = api.createBiliApi({ getCookie: () => 'bili_jct=tok', log: {}, fetchImpl: mk({ type: 'application/octet-stream', buf: png.buffer }) })
  reqs.length = 0
  await qq.setFace('https://multimedia.nt.qq.com/v1/foo')
  assert.equal(reqs[1].body.get('face').type, 'image/png')
  assert.equal(api.sniffImageType(png), 'image/png')
  assert.equal(api.sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x01])), 'image/jpeg')
  assert.equal(api.sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif')
  assert.equal(api.sniffImageType(new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50])), 'image/webp')
  await assert.rejects(api.createBiliApi({ getCookie: () => '', log: {} }).setFace('https://img.example/a.png'), /没登录/)

  const bd = fakes({ global: { dryRun: true } }), bn = fakes({ cfgOver: { cookie: '' } }), f = fakes()
  assert.match((await bd.b.setAvatar('https://x/a.png', bd.context())).message, /试运行/)
  assert.equal((await bn.b.setAvatar('https://x/a.png', bn.context())).ok, false)
  assert.equal((await f.b.setAvatar('C:\\a.png', f.context())).ok, false)
  assert.equal(bd.posted.length + bn.posted.length + f.posted.length, 0)
  const ok = await f.b.setAvatar('https://x/a.png', f.context())
  assert.equal(ok.ok, true)
  assert.deepEqual(f.posted, [{ image: 'https://x/a.png' }])
  const { normalize: n2 } = await import('../src/core/config.js')
  assert.equal(n2({}).profilePerms.biliAvatar, 'owner')
  assert.equal(n2({ profilePerms: { biliAvatar: 'x' } }).profilePerms.biliAvatar, 'owner')
})

test('自动浏览只读取当前主人私聊/本角色，显式事实 persona 空串；共享策略结果仍过滤', async () => {
  const f = fakes({ decisions: [] })
  f.memory.list = (opts) => {
    f.reads.push(opts)
    return [{ scope: opts.scope, text: 'OWNER_PRIVATE' }, { scope: { ...opts.scope, chat: 'group:22' }, text: 'GROUP_SECRET' },
      { scope: { ...opts.scope, account: '90000002' }, text: 'ACCOUNT_SECRET' }]
  }
  f.memory.recentEvents = (opts) => {
    f.reads.push(opts)
    return [{ scope: opts.scope, text: 'THIS_PERSONA' }, { scope: { ...opts.scope, persona: 'other' }, text: 'PERSONA_SECRET' }]
  }
  await f.b.run({ force: true })
  assert.deepEqual(f.reads.map((o) => o.scope), [
    { account: '90000001', chat: 'private:10000001', persona: '' },
    { account: '90000001', chat: 'private:10000001', persona: 'fish' },
  ])
  assert.match(f.prompts[0], /OWNER_PRIVATE/); assert.match(f.prompts[0], /THIS_PERSONA/)
  assert.doesNotMatch(f.prompts.join('\n'), /GROUP_SECRET|ACCOUNT_SECRET|PERSONA_SECRET/)
})

test('B站未知提交结果持久去重，重复调用不重发；没有 rpid 不记经历', async () => {
  const f = fakes({ postError: new Error('connection reset'), cfgOver: { maxCommentsPerDay: 5 } })
  const first = await f.b.comment('BV1bbbbbbbbb', '评论', f.context())
  assert.equal(first.code, 'DELIVERY_UNKNOWN')
  const second = await f.b.comment('BV1bbbbbbbbb', '评论', f.context())
  assert.equal(second.state, 'unknown'); assert.equal(second.duplicate, true)
  assert.equal(f.posted.length, 1); assert.equal(f.events.length, 0)
  const g = fakes()
  g.fakeApi.postComment = async () => ({})
  assert.equal((await g.b.comment('BV1bbbbbbbbb', '评论', g.context())).code, 'DELIVERY_UNKNOWN')
  assert.equal(g.events.length, 0)
})

test('B站 dryRun 的评论/回复/分享/资料更改都不发、不写真实动作', async () => {
  const f = fakes({ global: { dryRun: true }, decisions: [{ i: 1, comment: '模拟', share: '模拟分享', remember: '不能写' }] })
  await f.b.run({ force: true }); await f.b.checkReplies()
  await f.b.comment('BV1bbbbbbbbb', '模拟', f.context())
  await f.b.setSign('模拟', f.context()); await f.b.setAvatar('https://x/a.png', f.context())
  assert.deepEqual(f.posted, []); assert.deepEqual(f.sent, []); assert.deepEqual(f.events, []); assert.deepEqual(f.facts, [])
  f.cfg.dryRun = false
  assert.equal((await f.b.checkReplies()).replied, 1, '试运行不能消耗真实回复的去重记录')
})

test('B站 await 后 epoch/账号/角色/开关变化立即终止后续副作用', async (t) => {
  for (const change of ['epoch', 'account', 'persona', 'enabled', 'stop']) await t.test(change, async () => {
    const f = fakes(), ctx = f.context()
    f.fakeApi.view = async () => {
      if (change === 'epoch') f.bump()
      if (change === 'account') f.cfg.botQQ = '90000002'
      if (change === 'persona') f.persona('other')
      if (change === 'enabled') f.cfg.enabled = false
      if (change === 'stop') f.b.stop()
      return { bvid: 'BV1bbbbbbbbb', aid: 1, title: 'test' }
    }
    assert.equal((await f.b.comment('BV1bbbbbbbbb', '不应发出', ctx)).code, 'BILI_CANCELED')
    assert.equal(f.posted.length, 0); assert.equal(f.events.length, 0)
  })
})

test('真实评论成功不被记忆写入异常误报为发送未知，也不重复评论', async () => {
  const f = fakes({ cfgOver: { maxCommentsPerDay: 5 } })
  f.memory.addEvent = () => { throw new Error('memory unavailable') }
  const r = await f.b.comment('BV1bbbbbbbbb', '已发', f.context('group:33'))
  assert.equal(r.ok, true); assert.equal(r.rpid, 1)
  const again = await f.b.comment('BV1bbbbbbbbb', '已发', f.context('group:33'))
  assert.equal(again.duplicate, true); assert.equal(f.posted.length, 1)
})

test('B站推理超时保守结束，不被迟到输出驱动写评论/分享/事实', async () => {
  const f = fakes({ thinkTimeoutMs: 10 })
  let finish
  f.hub.runSystemTurn = () => new Promise((resolve) => { finish = resolve })
  assert.equal((await f.b.run({ force: true })).code, 'THINK_TIMEOUT')
  finish('["米饭"]'); await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.posted.length + f.sent.length + f.events.length + f.facts.length, 0)
})
