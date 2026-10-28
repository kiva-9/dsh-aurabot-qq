// 消息中枢：QQ 会话 ↔ DSH 会话。
//   收：OneBot 事件 → 白名单 / 群聊策略 → 拼好文案（带发言人、群上下文、图片、语音转写）→ 喂进对应 DSH 会话
//   发：DSH 会话一轮结束 → 取最终正文 → 拆条 / 语音 / 表情 → 发回原来的 QQ 会话
// 每个 QQ 会话一个 DSH 会话，统一放在「Aurabot · QQ」工作区，主人可以在 DSH 侧栏点开看、插手。

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { parseMessageEvent } from './inbound.js'
import { parseReply, bubbleDelay, wantsVoice, capItems } from './reply.js'
import { decideGroupReply, policyFor, topicRelevance } from './group-policy.js'
import { checkAllowed, levelFor, presetFor, isOwner } from './access.js'
import { fetchImage, segmentBytes } from '../core/net.js'
import { toMono16k } from '../voice/wav.js'
import { mimeOf } from './inbound.js'
import { redact } from '../core/redact.js'
import { defaultModel, pickReasoningEffort, canSeeImages } from '../core/llm.js'
import { resolveChatModel } from './chat-model.js'
import { probeAgent } from '../runtime/host-contract.js'
import { createOutbox } from '../delivery/outbox.js'
import { createScheduler } from '../runtime/scheduler.js'
import { createMediaResolver } from '../runtime/media.js'

// QQ 会话的工作区目录，第一次收到消息时自动创建。老安装沿用 C:\Aurabot\qq-chats；新安装放在用户目录下（不用往 C 盘根目录写）
const LEGACY_WORKSPACE = 'C:\\Aurabot\\qq-chats'
export const WORKSPACE_DIR = process.env.AURABOT_WORKSPACE || (existsSync(LEGACY_WORKSPACE) ? LEGACY_WORKSPACE : join(homedir(), 'Aurabot', 'qq-chats'))
export const WORKSPACE_TITLE = 'Aurabot · QQ'
const SOURCE_KIND = 'aurabot'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 音频文件的类型，认不出来就当 wav。 */
const audioMime = (buf) => { const m = mimeOf(buf); return m.startsWith('audio/') ? m : 'audio/wav' }
const sessionKey = (id) => {
  const s = String(id ?? '')
  return s.startsWith('session-') ? s.slice(8) : s
}

/**
 * hooks（扩展模块用，都可以不传）：
 *   message(msg) → true 表示这条消息被模块接管了，她不再处理
 *   reply(text, {chatId}) → 改写她要发的话；返回 null 表示这次不发
 *   deniedTools() → 不许出现在她 QQ 会话里的全局工具名（给其他 DSH 会话用的联动工具）
 *   groupDecide(decision, info) → 改群聊「回不回、怎么回」的决定 { reply, mode, reason }
 *   prompt(content, info) → 改交给她的内容（文字 / 图片块）；返回 null 表示这次不交给她
 *   items(items, info) → 改拆好的回复（每条 { kind: text|voice|sticker|poke|image, value, replyTo }）
 *   send(message, info) → 改最终发出去的 OneBot 消息段；返回 null 表示不发
 *   model(selection, chat) → 这个聊天用哪个模型 { provider, model, reasoningEffort }（同步）；selection 已经按主人「按聊天选模型」的设置算过
 *   poke(event) → true 表示戳一戳被模块接管了
 */
// 模拟测试：这里面发出去的消息只记下来，不真发
const captureStore = new AsyncLocalStorage()
// 工具调用时带的「在执行第几条消息」（群聊里主人和别人混在一轮时，靠它核对是不是主人的要求）
const callRef = new AsyncLocalStorage()
const FOR_MESSAGE = {
  type: 'integer',
  description: '群里这一段不止主人在说话时：执行只有主人能做的操作，写你在执行的那条主人消息的编号（提示词里 [编号]）。其他时候不用填。',
}
/** 群聊会话里的工具多一个可选参数 for_message，执行时记下来，参数本身不交给工具。 */
function withMessageRef(tool) {
  const params = tool.parameters || { type: 'object', properties: {} }
  if (params.properties?.for_message) return tool
  return {
    ...tool,
    parameters: { ...params, properties: { ...(params.properties || {}), for_message: FOR_MESSAGE } },
    execute: (args, exec) => {
      const { for_message: ref, ...rest } = args || {}
      return callRef.run({ forMessage: Number.isInteger(ref) ? ref : Number(ref) || 0 }, () => tool.execute(rest, exec))
    },
  }
}
export function createHub({ dsh, getConfig, log, onebot, storage, personaOf, replyer, stickers, tts, buildTools, contextProviders, onActivity, memoryScore, onCommand, isMuted, moodEffects, localApi, hooks, availableModels }) {
  // 心情对行为的影响（表情 / 语音概率、回复快慢、插话积极程度），没接就是 1
  const mood = () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  const mapFile = () => dataDir('sessions.json')
  const map = () => readJson(mapFile(), () => ({ chats: {} }))
  const saveMap = (m) => writeJson(mapFile(), m)

  const mounted = new WeakMap() // agent → { off: fn[] , chatId }
  const sessionToChat = new Map() // sessionKey → chatId
  const turnState = new Map() // sessionKey → { lastTurn, text, images, senders:Set, system?: {resolve, reject} }
  const groupBuf = new Map() // groupId → [{t, uid, nick, text, at}]
  const groupInterjects = new Map() // groupId → [t]  她主动开口（插话、接话）的时间
  const groupSaid = new Map() // groupId → [t]  她每次在群里说话的时间（刹车用）
  const groupFedAt = new Map() // groupId → 上次把群消息交给她的时间
  const groupRefs = new Map() // groupId → { 编号: QQ 消息 ID }  上一段提示词里的编号，引用回复用
  const groupEngaged = new Map() // groupId → 加入话题到什么时候（毫秒）
  const ENGAGE_MS = 3 * 60_000
  const groupNames = new Map()
  const recentMedia = new Map() // chatId → [{ seg, userId, at, sticker }] 最近发来的图片和表情
  const sentIds = new Set()
  const stats = { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: new Date().toDateString() }
  let selfId = ''
  let lastChatAt = 0
  let lastOwnerChatAt = 0
  let lastBotToOwner = { at: 0, text: '' } // 她在主人私聊里最后说的话
  let agentCaps = null // 第一个会话探出来的会话级能力（宿主契约检查）

  function bump(k) {
    const d = new Date().toDateString()
    if (stats.day !== d) Object.assign(stats, { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: d })
    stats[k]++
  }

  // ---------- 聊天流水（给记忆整理、主动搭话、面板用） ----------
  function logChat(chatId, who, text, uid = '') {
    try {
      const d = new Date()
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const dir = dataDir('chatlog')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify({ t: Date.now(), chatId, who, ...(uid ? { uid: String(uid) } : {}), text: redact(String(text).slice(0, 500)) }) + '\n', 'utf8')
    } catch (error) {}
  }

  /** 有聊天流水的日期（升序）。 */
  function chatLogDays() {
    try {
      return readdirSync(dataDir('chatlog')).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort()
    } catch (error) {
      return []
    }
  }

  function deleteChatLog(day) {
    try { unlinkSync(join(dataDir('chatlog'), `${day}.jsonl`)) } catch (error) {}
  }

  function chatLogOf(day) {
    try {
      const f = join(dataDir('chatlog'), `${day}.jsonl`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch (error) {
      return []
    }
  }

  // ---------- 工作区与会话 ----------
  async function ensureWorkspace() {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    if (!reg) throw new Error('宿主没有 workspaceRegistry')
    mkdirSync(WORKSPACE_DIR, { recursive: true })
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
    let ws = reg.list().find((w) => norm(w.path) === norm(WORKSPACE_DIR))
    if (!ws) {
      ws = await reg.create(WORKSPACE_DIR, WORKSPACE_TITLE)
      log.info('建好了工作区「' + WORKSPACE_TITLE + '」')
    }
    return ws
  }

  function controller() {
    const c = dsh.get('sessionController')
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）')
    return c
  }

  function titleFor(chat) {
    const owner = getConfig().ownerName || '主人'
    if (chat.kind === 'system') return `QQ · ${chat.title || '后台'}`
    if (chat.kind === 'group') return `QQ 群 · ${groupNames.get(chat.groupId) || chat.groupId}`
    return chat.userId === getConfig().ownerQQ ? `QQ · ${owner}私聊` : `QQ 私聊 · ${chat.nickname || chat.userId}`
  }

  async function createSession(chat, level, persona) {
    const ws = await ensureWorkspace()
    const preset = presetFor(level, getConfig())
    const r = await controller().create({ workspaceId: ws.id, agentPreset: preset })
    const sid = String(r.sessionId)
    try {
      await controller().rename({ sessionId: sid, title: titleFor(chat) })
    } catch (error) {
      log.debug('改会话标题失败：', error.message)
    }
    const m = map()
    m.chats[chat.chatId] = { sessionId: sid, preset, level, createdAt: Date.now(), title: titleFor(chat), ...(persona?.personaId ? { personaId: persona.personaId } : {}) }
    saveMap(m)
    log.info(`为 ${chat.chatId} 新建了 DSH 会话 ${sid.slice(-8)}（${preset}）`)
    return sid
  }

  async function resolveAgent(sid) {
    const live = dsh.agents.get(sid) || dsh.agents.get('session-' + sid)
    if (live) return live
    const r = await controller().resolveAgent(sid)
    if (r && r.agent) return r.agent
    const e = r && r.error
    throw Object.assign(new Error(e?.message || '恢复会话失败'), { code: e?.code })
  }

  /** 拿到这个 QQ 会话对应的活 agent（没有就建，权限档位变了就换新会话）。 */
  async function agentFor(chat, persona) {
    const cfg = getConfig()
    const level = chat.kind === 'system' ? (chat.noTools ? 'chat' : 'social') : levelFor(cfg, chat)
    const preset = presetFor(level, cfg)
    const entry = map().chats[chat.chatId]
    let sid = entry && entry.preset === preset && entry.level === level ? entry.sessionId : ''
    // 换了身份（绑定到另一张卡）：开新会话、代次 +1，旧角色没说完的话和习惯不带过来；旧会话归档（侧栏里还能找回）
    if (sid && persona?.personaId && entry.personaId && entry.personaId !== persona.personaId) {
      log.info(`${chat.chatId} 换了人设（${entry.personaId} → ${persona.personaId}），开新会话`)
      switchIdentity(chat.chatId, sid)
      sid = ''
    } else if (sid && persona?.personaId && !entry.personaId) {
      // 老会话还没记人设：记上当前的（不算换身份）
      const m0 = map()
      m0.chats[chat.chatId].personaId = persona.personaId
      saveMap(m0)
    }
    let agent = null
    if (sid) {
      try {
        agent = await resolveAgent(sid)
      } catch (error) {
        log.warn(`会话 ${sid.slice(-8)} 恢复不了（${error.message}），换一个新的`)
        sid = ''
      }
      const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
      if (sid && reg && (reg.archivedSessionIds || []).includes(sid)) {
        log.info(`会话 ${sid.slice(-8)} 被归档了，换一个新的`)
        sid = ''
        agent = null
      }
    }
    if (!sid) {
      sid = await createSession(chat, level, persona)
      agent = await resolveAgent(sid)
    }
    // 模型 / 思考强度和设置不一致就切过去（面板改了模型，下一条消息起生效）
    const target = await resolveTarget(chat)
    const want = keyOf(target)
    const m = map()
    if (want && m.chats[chat.chatId] && m.chats[chat.chatId].model !== want) {
      if (applyModel(agent, target)) {
        m.chats[chat.chatId].model = want
        saveMap(m)
        log.info(`${chat.chatId} 的模型切到 ${want}`)
      }
    }
    sessionToChat.set(sessionKey(sid), chat.chatId)
    if (!agentCaps) {
      agentCaps = probeAgent(agent)
      if (agentCaps.missing.length) log.info('这个版本的 DSH 缺少：' + agentCaps.missing.map((m) => m.what).join('、'))
    }
    mount(agent, chat, level)
    return { agent, sessionId: sid, level }
  }

  /** 这个聊天要用的模型：主人按聊天指定的 > 面板里选的全局模型（或 DSH 默认），扩展模块还可以再按聊天改。 */
  function targetModel(chat) {
    const cfg = getConfig()
    const t = defaultModel(dsh, cfg)
    let sel = t ? { provider: t.provider, model: t.model, reasoningEffort: cfg.model.reasoningEffort || '' } : null
    // 主人按聊天指定的模型（私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认）；没指定或指定的模型已不存在就用上面的
    try {
      const r = resolveChatModel(cfg, chat, typeof availableModels === 'function' ? availableModels() : null)
      if (r) sel = { provider: r.provider, model: r.model, reasoningEffort: r.reasoningEffort || cfg.model.reasoningEffort || '' }
    } catch (error) {}
    if (hooks?.model && chat) {
      try {
        const r = hooks.model(sel, chat)
        if (r && r.provider && r.model) sel = { reasoningEffort: '', ...r }
      } catch (error) {}
    }
    return sel
  }
  /**
   * 想要的思考强度要先按模型能力收敛：没有推理元数据的模型（本地 Ollama、部分手写 provider）
   * 只要收到 reasoningEffort 就会被 DSH 整轮拒掉（UNSUPPORTED_REASONING_EFFORT），
   * 等于这个模型直接没法用。不支持就不传这个参数，让 DSH 用模型自己的默认。
   */
  async function resolveTarget(chat) {
    const t = targetModel(chat)
    if (!t) return null
    const effort = await pickReasoningEffort(dsh, t.provider, t.model, t.reasoningEffort)
    return { provider: t.provider, model: t.model, ...(effort ? { reasoningEffort: effort } : {}) }
  }
  const keyOf = (t) => (t ? `${t.provider}::${t.model}::${t.reasoningEffort || ''}` : '')

  /** 让聊天会话用面板里选的模型和思考强度；只改这个会话，不改 DSH 的默认模型。 */
  function applyModel(agent, target) {
    try {
      if (!target) return false
      const sel = { provider: target.provider, model: target.model }
      if (target.reasoningEffort) sel.reasoningEffort = target.reasoningEffort
      // 活着的会话只认会话控制器内存里的选择：用它的 selectForNextRequest（selectModel 也是调它，
      // 但 selectModel 还会顺手改掉 DSH 的全局默认模型，我们不要）。拿不到就只写持久事件（重启恢复时生效）。
      const agents = controller().agents
      if (agents && typeof agents.selectForNextRequest === 'function') agents.selectForNextRequest(agent, sel)
      else agent.session.append('model/selection', sel)
      return true
    } catch (error) {
      log.debug('设置会话模型失败（用默认）：', error.message)
      return false
    }
  }

  function mount(agent, chat, level) {
    const sid = sessionKey(agent.session?.id ?? agent.id)
    const built = level !== 'chat' && typeof buildTools === 'function' ? buildTools({ chat, level, sessionId: sid }) : []
    const tools = (chat.kind === 'group' ? built.map(withMessageRef) : built).map((t) => withBudget(t, sid))
    const denied = (() => { try { return hooks?.deniedTools?.() || [] } catch (error) { return [] } })()
    const toolsKey = tools.map((t) => t.name).sort().join(',') + '|' + denied.join(',')
    const prev = mounted.get(agent)
    // 工具清单变了（比如面板里开了生图）就整套重挂；没变就别动（改工具会让前缀缓存失效）
    if (prev && prev.chatId === chat.chatId && prev.toolsKey === toolsKey) return
    if (prev) for (const off of prev.offs) { try { if (typeof off === 'function') off() } catch (error) {} }
    const offs = []
    // 联动工具是给 DSH 其他会话用的，她自己的 QQ 会话里不该有（陌生人的会话更不行）
    if (denied.length) {
      try { offs.push(agent.ctx.tools.restrict({ deny: denied })) } catch (error) { log.debug('屏蔽联动工具：', error.message) }
    }
    {
      for (const tool of tools) {
        try {
          offs.push(agent.ctx.tools.register(tool))
        } catch (error) {
          log.warn(`工具 ${tool.name} 挂不上：`, error.message)
        }
      }
    }
    try {
      offs.push(agent.ctx.systemPrompt.context({
        name: 'aurabot-context',
        order: 905,
        text: () => {
          const parts = []
          for (const p of contextProviders || []) {
            try {
              const t = p({ chat, sessionId: sid })
              if (t) parts.push(t)
            } catch (error) {}
          }
          return parts.join('\n\n')
        },
      }))
    } catch (error) {
      log.debug('挂上下文失败：', error.message)
    }
    mounted.set(agent, { chatId: chat.chatId, offs, toolsKey })
  }

  /** 一轮里插件工具的调用次数有上限：到了就告诉模型先把结果说给对方，别再调。 */
  function withBudget(tool, sid) {
    return {
      ...tool,
      execute: (args, exec) => {
        const st = turnState.get(sessionKey(sid))
        const limit = getConfig().toolCallsPerTurn
        if (st) {
          st.toolCalls = (st.toolCalls || 0) + 1
          if (st.toolCalls > limit) {
            log.info(`${chatOfSession(sid)}：这一轮工具调用到上限（${limit} 次），${tool.name} 没执行`)
            return { ok: false, message: `这一轮已经调用了 ${limit} 次工具，先别再调了，把现在的结果告诉对方` }
          }
        }
        return tool.execute(args, exec)
      },
    }
  }

  // ---------- 发到 QQ ----------
  // 所有要发的东西都先进 outbox（落库、按顺序发、每段记回执），这里只有 transmit 真正调网关。
  function targetOf(chatId) {
    const [kind, id] = String(chatId).split(':')
    return kind === 'group' ? { kind: 'group', id } : kind === 'private' ? { kind: 'private', id } : null
  }

  /** 真正发到 QQ。返回网关结果；按设置不发时返回 null；网关出错时抛出（带 outcome，outbox 据此决定重不重发）。 */
  async function transmit(chatId, message, note, { force = false } = {}) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    // 扩展模块最后改一次（加签名、过滤敏感词、转发到别处……）；返回 null 就不发
    if (hooks?.send) {
      try {
        const next = await hooks.send(message, { chatId, note, force })
        if (next === null) { log.info(`扩展模块拦下了 → ${chatId}：${note}`); return null }
        if (Array.isArray(next)) message = next
      } catch (error) {
        log.warn('扩展模块改写发送内容出错：', error.message)
      }
    }
    if (force) {}
    else if (!cfg.enabled) {
      log.info(`总开关关着，没发 → ${chatId}：${note}`)
      return null
    }
    else if (cfg.dryRun) {
      log.info(`试运行（没真发）→ ${chatId}：${note}`)
      return null
    }
    const action = tgt.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = tgt.kind === 'group' ? { group_id: Number(tgt.id), message } : { user_id: Number(tgt.id), message }
    try {
      const r = await onebot.call(action, params)
      if (r && r.message_id !== undefined) {
        sentIds.add(String(r.message_id))
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
      bump('sent')
      return r || {}
    } catch (error) {
      bump('errors')
      throw error
    }
  }

  /** 发送前把引用换成实际内容：asset:ID → 资产文件的 base64；sticker-ref → 表情库里那张。 */
  async function resolveMessage(message) {
    const out = []
    for (const seg of message) {
      if (seg.type === 'sticker-ref') {
        const item = stickers.match(seg.data.md5) || { md5: seg.data.md5, name: seg.data.name }
        const real = stickers.segmentFor(item)
        if (!real) throw Object.assign(new Error('这张表情找不到了'), { outcome: 'rejected' })
        out.push(real)
        continue
      }
      const file = seg.data?.file
      if (typeof file === 'string' && file.startsWith('asset:')) {
        const a = storage.assets.get(file.slice(6))
        if (!a) throw Object.assign(new Error('要发的文件不见了'), { outcome: 'rejected' })
        out.push({ ...seg, data: { ...seg.data, file: 'base64://' + readFileSync(storage.assets.pathOf(a)).toString('base64') } })
        continue
      }
      out.push(seg)
    }
    return out
  }

  const outbox = createOutbox({ storage, send: (chatId, message, info) => transmit(chatId, message, info.note, { force: info.force }), resolve: resolveMessage, log })

  /** 发一组 outbox 段；模拟测试里直接截下来，不落库。返回 outbox 的汇总和每段的结果。 */
  async function sendItems(chatId, items, { epoch, requestId } = {}) {
    const cap = captureStore.getStore()
    if (cap) {
      const rows = []
      for (let i = 0; i < items.length; i++) {
        cap.push({ chatId, note: items[i].note, message: await resolveMessage(items[i].message) })
        rows.push({ seq: i, state: 'delivered', platformMsgId: 'sim-' + cap.length })
      }
      return { delivered: items.length, failed: 0, unknown: 0, canceled: 0, skipped: 0, messageIds: rows.map((r) => r.platformMsgId), rows }
    }
    const batchId = outbox.enqueue({ chatId, requestId, epoch, items })
    const sum = await outbox.deliver(batchId)
    return { ...sum, rows: outbox.rows(batchId) }
  }

  /** 发一条现成的消息（模块、命令回执用）。返回 { message_id }，没发成返回 null。 */
  async function sendSegments(chatId, message, note, { force = false } = {}) {
    if (!targetOf(chatId)) return null
    const r = await sendItems(chatId, [{ kind: 'other', message, note, force }])
    return r.delivered ? { message_id: r.messageIds[0] } : null
  }

  /** replyId：要引用回复的那条 QQ 消息（可选）。 */
  const quote = (replyId) => (replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : [])
  const textItem = (text, replyId) => ({ kind: 'text', message: [...quote(replyId), { type: 'text', data: { text } }], note: (replyId ? '[引用] ' : '') + text.slice(0, 60) })

  async function sendText(chatId, text, replyId) {
    const it = textItem(text, replyId)
    return sendSegments(chatId, it.message, it.note)
  }

  /** 文字转成语音段（先存成资产）。转不出来返回 null。 */
  async function voiceItem(text, profile) {
    try {
      const { file, engine } = await tts.speak(text, profile)
      const buf = readFileSync(file)
      const asset = storage.assets.put(buf, { mime: audioMime(buf), sourceKind: 'generated' })
      return { kind: 'voice', message: [{ type: 'record', data: { file: 'asset:' + asset.id } }], note: `[语音·${engine}] ${text.slice(0, 40)}`, fallbackText: text }
    } catch (error) {
      log.warn('语音没生成出来，改发文字：', error.message)
      return null
    }
  }

  async function sendVoice(chatId, text) {
    const it = await voiceItem(text)
    if (it) {
      const r = await sendItems(chatId, [it])
      if (r.delivered || r.skipped) { bump('voice'); return true }
      log.warn('语音没发出去，改发文字')
    }
    await sendText(chatId, text)
    return false
  }

  /** 戳回去：私聊戳对方，群里戳最近戳她的人（没人戳过就戳这一段最后说话的人）。 */
  async function pokeBack(chatId) {
    const cfg = getConfig()
    const group = chatId.startsWith('group:') ? chatId.slice(6) : ''
    const target = group ? lastPoker.get(chatId) || lastSpeaker.get(chatId) : chatId.slice(8)
    if (!target) return
    if (!cfg.enabled || cfg.dryRun) return log.info(`试运行（没真戳）→ ${chatId}：戳了戳 ${target}`)
    try {
      await onebot.call('send_poke', { user_id: Number(target), ...(group ? { group_id: Number(group) } : {}) }, { timeoutMs: 10000 })
      log.info(`${chatId}：她戳了戳 ${target}`)
    } catch (error) {
      log.debug('戳一戳失败：', error.message)
    }
  }

  /** 把一个音频文件当语音条发出去（翻唱用）。 */
  async function sendVoiceFile(chatId, file, note) {
    const buf = readFileSync(file)
    const asset = storage.assets.put(buf, { mime: audioMime(buf), sourceKind: 'generated' })
    const r = await sendItems(chatId, [{ kind: 'voice', message: [{ type: 'record', data: { file: 'asset:' + asset.id } }], note: note || '[语音]' }])
    if (r.delivered || r.skipped) bump('voice')
    if (!r.delivered && !r.skipped) throw new Error('网关没接受这条语音')
    return r.delivered ? { message_id: r.messageIds[0] } : null
  }

  function stickerItem(query, replyId) {
    const item = query && typeof query === 'object' ? query : stickers.match(query)
    if (!item) {
      log.debug(`没找到「${query}」这张表情，跳过`)
      return null
    }
    return { kind: 'sticker', message: [...quote(replyId), { type: 'sticker-ref', data: { md5: item.md5, name: item.name || '' } }], note: `[表情] ${item.name || item.md5.slice(0, 8)}`, md5: item.md5 }
  }

  async function sendSticker(chatId, query, replyId) {
    const it = stickerItem(query, replyId)
    if (!it) return false
    const r = await sendItems(chatId, [it])
    if (!r.delivered && !r.skipped) return false
    stickers.markUsed?.(it.md5)
    bump('stickers')
    return true
  }

  async function imageItem(src) {
    try {
      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })
      const asset = storage.assets.put(buf, { mime: mimeOf(buf), sourceKind: 'generated' })
      return { kind: 'image', message: [{ type: 'image', data: { file: 'asset:' + asset.id } }], note: `[图片] ${String(src).slice(-40)}` }
    } catch (error) {
      log.warn('图片发不出去：', error.message)
      return null
    }
  }

  async function sendImage(chatId, src) {
    const it = await imageItem(src)
    if (!it) return null
    const r = await sendItems(chatId, [it])
    return r.delivered ? { message_id: r.messageIds[0] } : null
  }

  /**
   * 一轮回复落地：拆条、语音、表情，组成 outbox 段按顺序发。
   * opts.epoch：这一轮开始时的会话代次（换人设 / 重开后迟到的回复会被作废）；opts.requestId：回的是哪个请求。
   */
  async function deliver(chatId, text, opts = {}) {
    const cfg = getConfig()
    if (hooks?.reply) {
      try {
        const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // Replyer：面板里给「回复改写」选了模型时，按人设的说话方式再改一遍措辞（不碰内容和标记，没通过检查就用原文）
    if (typeof replyer === 'function' && !opts.simulate) {
      const rw = await replyer(text, { chatId, persona: opts.persona })
      if (rw?.rewritten) text = rw.text
      else if (rw?.reason && rw.reason !== '没开') log.debug(`${chatId}：回复没改写（${rw.reason}）`)
    }
    const r = parseReply(text)
    if (r.silent) {
      log.info(`${chatId}：她选择不说话`)
      if (chatId.startsWith('group:')) groupEngaged.delete(chatId.slice(6)) // 不想聊就退出这个话题
      return
    }
    let items = r.items
    // 对方明确要语音、她却只打了字：整段改成语音发（模型偶尔会忘，这里兜底）
    if (opts.wantVoice && cfg.voice.enabled && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    // 短回复按概率整条变语音
    const texts = items.filter((i) => i.kind === 'text')
    if (cfg.voice.enabled && items.length === texts.length && texts.length > 0) {
      const all = texts.map((t) => t.value).join('，')
      if (all.length <= cfg.voice.autoMaxChars && Math.random() < cfg.voice.autoChance * mood().voice) items = [{ kind: 'voice', value: all }]
    }
    const inGroup = chatId.startsWith('group:')
    // 群里别刷屏：最多 3 条，多出来的文字合进第 3 条（不丢尾巴）
    if (inGroup && items.length > 3) items = capItems(items, 3)
    // 按概率补一张表情（群里已经有两条以上就不补了）
    if (cfg.stickers.enabled && !items.some((i) => i.kind === 'sticker') && !(inGroup && items.length >= 2) && Math.random() < cfg.stickers.autoChance * mood().sticker) {
      const pick = stickers.pickForReply(texts.map((t) => t.value).join(' '))
      if (pick) items.push({ kind: 'sticker', value: pick })
    }
    if (hooks?.items) {
      try {
        const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (Array.isArray(next)) items = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 引用回复：她写的编号换成那条群消息的 QQ 消息 ID（语音条不能带引用，就不引用了）
    const refs = inGroup ? groupRefs.get(chatId.slice(6)) || {} : {}
    // 组成 outbox 段；戳一戳不是消息：在它的位置先把前面的段发掉再戳
    const groups = [[]]
    for (const it of items) {
      const replyId = it.replyTo ? refs[it.replyTo] : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      let out = null
      if (it.kind === 'text') out = textItem(it.value, replyId)
      else if (it.kind === 'voice') out = cfg.voice.enabled ? (await voiceItem(it.value, opts.persona?.layers?.voice)) || textItem(it.value, replyId) : textItem(it.value, replyId)
      else if (it.kind === 'sticker') out = stickerItem(it.value, replyId)
      else if (it.kind === 'image') out = await imageItem(it.value)
      else if (it.kind === 'poke') { if (!opts.simulate) groups.push('poke', []); continue }
      if (!out) continue
      out.delayMs = opts.simulate ? 0 : Math.round(bubbleDelay(it.kind === 'text' ? it.value : '') * mood().delay)
      groups.at(-1).push(out)
    }
    for (const g of groups) {
      if (g === 'poke') { await pokeBack(chatId); continue }
      if (!g.length) continue
      const res = await sendItems(chatId, g, { epoch: opts.epoch, requestId: opts.requestId })
      for (const row of res.rows) {
        const it = g[row.seq]
        if (!it) continue
        const ok = row.state === 'delivered' || row.state === 'skipped'
        if (it.kind === 'voice' && ok) bump('voice')
        if (it.kind === 'sticker' && ok) { stickers.markUsed?.(it.md5); bump('stickers') }
        // 语音条网关不收：这一段改发文字
        if (it.kind === 'voice' && row.state === 'failed' && it.fallbackText) {
          log.warn('语音没发出去，改发文字')
          await sendItems(chatId, [textItem(it.fallbackText)], { epoch: opts.epoch, requestId: opts.requestId })
        }
      }
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      const said = (groupSaid.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
      said.push(Date.now())
      groupSaid.set(gid, said)
      groupEngaged.set(gid, Date.now() + ENGAGE_MS) // 在群里说了话 = 加入了话题
    }
    logChat(chatId, 'bot', items.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' '))
    lastChatAt = Date.now()
    if (chatId === `private:${cfg.ownerQQ}`) lastBotToOwner = { at: Date.now(), text: items.filter((i) => i.kind === 'text' || i.kind === 'voice').map((i) => i.value).join('\n') }
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
  }

  // ---------- 盯 DSH 会话：一轮结束就发 ----------
  function textOf(message) {
    if (!message || !Array.isArray(message.content)) return ''
    return message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
  }

  function onSessionEvent(session, event) {
    const key = sessionKey(session && session.id)
    const chatId = sessionToChat.get(key)
    if (!chatId || !event) return
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    turnState.set(key, st)
    if (event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const t = textOf(d.message)
      if (t) {
        st.lastTurn = d.turn
        st.text = t
      }
      return
    }
    if (event.type === 'turn/end') {
      running.delete(chatId)
      stopTyping(key)
      const d = event.data || {}
      const completed = d.reason && d.reason.kind === 'completed'
      const text = st.lastTurn === d.turn ? st.text : ''
      const sys = st.system
      const wantVoice = Boolean(st.wantVoice)
      const epoch = st.epoch
      const persona = st.persona
      const requestId = st.requests?.[0]?.id ?? null
      for (const q of st.requests || []) storage.requests.setState(q.id, completed ? 'answered' : 'ended')
      st.text = ''
      st.senders = new Set()
      st.requests = []
      st.system = null
      st.wantVoice = false
      if (sys) {
        if (completed) sys.resolve(text)
        else sys.reject(new Error('这一轮没正常结束：' + (d.reason?.kind || '?')))
        return
      }
      if (!completed) {
        log.warn(`${chatId} 这一轮没正常结束（${d.reason?.kind || '?'}），不发`)
        release(chatId)
        return
      }
      if (!text) return release(chatId)
      // 这一轮开始后换过人设 / 重开过：迟到的回复不发
      if (epoch !== undefined && epoch !== storage.epochs.current(chatId)) {
        log.info(`${chatId}：会话已经换过代次，上一代的回复不发`)
        return release(chatId)
      }
      // 发完再放开：发送期间来的消息也攒到下一段
      deliver(chatId, text, { wantVoice, userText: st.lastText || '', epoch, requestId, persona }).catch((error) => log.warn('发送出错：', error.message)).finally(() => release(chatId))
    }
  }

  // ---------- 收 QQ ----------
  async function groupName(gid) {
    if (groupNames.has(gid)) return groupNames.get(gid)
    try {
      const info = await onebot.call('get_group_info', { group_id: Number(gid) })
      if (info?.group_name) groupNames.set(gid, info.group_name)
    } catch (error) {}
    return groupNames.get(gid) || gid
  }

  async function repliedToBot(replyId) {
    if (!replyId) return false
    if (sentIds.has(replyId)) return true
    try {
      const m = await onebot.call('get_msg', { message_id: Number(replyId) || replyId }, { timeoutMs: 5000 })
      return String(m?.sender?.user_id ?? m?.user_id ?? '') === String(selfId || getConfig().botQQ)
    } catch (error) {
      return false
    }
  }

  /** 一条语音转文字：本地接口 → QQ 自带转写 → DSH 自带识别，依次试。转不出来返回空串。 */
  async function transcribeOne(rec, msg) {
    // 本地接口接管：用用户自己的识别服务（最先试）
    if (localApi?.active('asr')) {
      try {
        const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
        const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024 })
        const dir = localApi.dir() + '/out'
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `asr-${Date.now()}.wav`)
        writeFileSync(file, toMono16k(raw))
        const r = await localApi.call('asr', { file })
        const text = String(typeof r === 'string' ? r : r?.text || '').trim()
        if (text) return text
      } catch (error) {
        log.debug('本地接口语音识别失败：', error.message)
      }
    }
    try {
      const r = await onebot.call('fetch_ptt_text', { message_id: Number(msg.messageId) || msg.messageId }, { timeoutMs: 20000 })
      if (r?.text) return String(r.text)
    } catch (error) {
      log.debug('QQ 语音转文字失败：', error.message)
    }
    try {
      return await localTranscribe(rec)
    } catch (error) {
      log.debug('本地语音识别失败：', error.message)
    }
    return ''
  }

  /**
   * DSH 自带识别（SenseVoice）：resolve({audio}) → transcribe(spec, signal)，音频必须是 16kHz 单声道 PCM16 WAV。
   * QQ 语音是 silk：先让网关 get_record 转成 wav，再重采样。
   */
  async function localTranscribe(rec) {
    const stt = dsh.get('speechToText')
    if (!stt || typeof stt.resolve !== 'function' || typeof stt.transcribe !== 'function') throw new Error('DSH 没开启语音输入')
    // 模型还没下载好：顺手开始准备（下载一次，之后常驻），这一条先算没听清
    const snap = typeof stt.snapshot === 'function' ? stt.snapshot() : null
    const pid = snap?.selection?.providerId
    const prov = snap?.providers?.find((p) => p.id === pid)
    if (prov && prov.preparation && !['ready', 'standby'].includes(prov.preparation.phase)) {
      try { stt.prepare(pid) } catch (error) {}
      throw new Error(`识别模型还在准备（${prov.preparation.phase}）`)
    }
    const info = await onebot.call('get_record', { file: rec.data?.file, out_format: 'wav' }, { timeoutMs: 30000 })
    const raw = info?.base64 ? Buffer.from(info.base64, 'base64') : await fetchImage(info?.file || info?.url, { maxBytes: 30 * 1024 * 1024 })
    const spec = stt.resolve({ audio: new Uint8Array(toMono16k(raw)) })
    const r = await stt.transcribe(spec, AbortSignal.timeout(60000))
    const text = typeof r === 'string' ? r : r?.text || r?.transcript
    return text ? String(text).trim() : ''
  }

  // 入站媒体：消息一到就登记，后台下载 / 转写；处理完叫醒调度器
  const media = createMediaResolver({
    storage,
    fetchBytes: (seg, o) => segmentBytes(seg, onebot, o),
    mimeOf,
    transcribe: (rec, msg) => transcribeOne(rec, msg),
    onSettled: (chatId) => scheduler.mediaSettled(chatId),
    log,
  })

  async function onMessage(event) {
    selfId = String(event.self_id || selfId || getConfig().botQQ)
    const cfg = getConfig()
    const msg = parseMessageEvent(event, selfId)
    if (msg.userId === selfId) return
    // 先登记进主库：重连后网关重放的同一条消息（同一个 QQ 消息 ID）在这里挡掉
    const ing = storage.messages.ingest({
      account: selfId, chatId: msg.chatId, eventKind: event.aurabot_kind || 'message', platformMsgId: msg.messageId,
      authorId: msg.userId, authorName: msg.nickname, platformTime: msg.platformTime, text: msg.text,
      segments: Array.isArray(event.message) ? event.message : [], replyTo: msg.replyId, forwards: msg.forwards, mentioned: msg.mentioned,
    })
    if (ing.duplicate) {
      log.debug(`${msg.chatId}：消息 ${msg.messageId} 收到过了（重放），跳过`)
      return
    }
    const dbId = ing.id
    bump('received')
    const now = Date.now()

    // 群里的每条消息都记进缓冲（给上下文和「群里在不在聊」用）
    if (msg.kind === 'group') {
      const buf = groupBuf.get(msg.groupId) || []
      buf.push({ t: now, uid: msg.userId, nick: msg.nickname, text: msg.text, at: msg.mentioned, mid: msg.messageId, dbId })
      while (buf.length > 40) buf.shift()
      groupBuf.set(msg.groupId, buf)
    }

    const allowed = checkAllowed(cfg, msg)
    // 偷表情：只从白名单里的会话偷
    if (allowed.allowed && msg.stickers.length && cfg.stickers.collect) {
      const okSrc = msg.kind === 'group' ? cfg.stickers.fromGroups : cfg.stickers.fromPrivate
      if (okSrc) for (const s of msg.stickers) stickers.collect(s, msg.chatId).then((r) => { if (!r.ok) log.debug('没收这张表情：', r.reason) }).catch(() => {})
    }
    if (!allowed.allowed) {
      log.debug(`忽略 ${msg.chatId}（${allowed.reason}）`)
      return
    }
    // 最近发来的图片 / 表情记几张（「把刚才那张存下来」时用）
    if (msg.stickers.length || msg.images.length) {
      const list = (recentMedia.get(msg.chatId) || []).filter((x) => now - x.at < 30 * 60_000)
      for (const seg of [...msg.stickers, ...msg.images]) list.push({ seg, userId: msg.userId, at: now, sticker: msg.stickers.includes(seg) })
      recentMedia.set(msg.chatId, list.slice(-6))
    }
    // 主人命令（/silent /active …）：总开关关着也处理，回复直接发
    if (onCommand && isOwner(cfg, msg.userId) && /^\s*[/／]/.test(msg.text)) {
      try {
        const reply = await onCommand(msg)
        if (reply) {
          log.info(`主人命令 ${msg.text.trim().slice(0, 30)} → ${reply.split('\n')[0]}`)
          await sendSegments(msg.chatId, [{ type: 'text', data: { text: reply } }], reply.slice(0, 60), { force: true })
          return
        }
      } catch (error) {
        log.warn('执行命令出错：', error.message)
        await sendSegments(msg.chatId, [{ type: 'text', data: { text: '命令没执行成功：' + error.message } }], '命令出错', { force: true })
        return
      }
    }
    if (!getConfig().enabled) {
      log.info(`总开关关着，收到 ${msg.chatId} 的消息但不处理：${msg.text.slice(0, 30)}`)
      return
    }

    if (isMuted?.(msg.chatId)) {
      log.debug(`${msg.chatId}：主人让她闭嘴中，不回`)
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 扩展模块可以先接管这条消息（关键词回复、转给自己的服务……）
    if (hooks?.message) {
      try {
        if (await hooks.message({ ...msg, raw: event })) {
          logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
          return
        }
      } catch (error) {
        log.warn('扩展模块处理消息出错：', error.message)
      }
    }

    const chat = { chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId, nickname: msg.nickname }
    let mode = 'must'
    if (msg.kind === 'group') {
      const pol0 = policyFor(cfg.group, cfg.group.overrides, msg.groupId)
      // 心情好更爱插话，心情差少插话
      const pol = { ...pol0, interjectChance: Math.min(1, pol0.interjectChance * mood().chatty) }
      // 群里最近在聊的（窗口内最后几条）和她有多相关
      const recentTexts = (groupBuf.get(msg.groupId) || []).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
      let memScore = 0
      try { memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' ')) : 0 } catch (error) {}
      const decision = decideGroupReply({
        policy: pol,
        relevance: topicRelevance(recentTexts, pol.interests, memScore),
        engagedUntil: groupEngaged.get(msg.groupId) || 0,
        mentioned: msg.mentioned,
        repliedToBot: await repliedToBot(msg.replyId),
        fromOwner: isOwner(cfg, msg.userId),
        text: msg.text,
        now,
        hour: new Date().getHours(),
        recentTimes: (groupBuf.get(msg.groupId) || []).map((x) => x.t),
        interjectTimes: groupInterjects.get(msg.groupId) || [],
        botReplyTimes: groupSaid.get(msg.groupId) || [],
      })
      if (hooks?.groupDecide) {
        try {
          const next = await hooks.groupDecide(decision, { msg, policy: pol, recentTexts, memScore })
          if (next && typeof next === 'object') Object.assign(decision, next)
        } catch (error) {
          log.warn('扩展模块改群聊决定出错：', error.message)
        }
      }
      if (!decision.reply) {
        log.debug(`群 ${msg.groupId}：不回（${decision.reason}）`)
        logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
        // 已经有一段在攒着等她回：这条（连同图片）当上下文并进去，但不单独触发、不延长等待
        if (scheduler.hasOpen(msg.chatId)) {
          media.register({ messageId: dbId, msg, account: selfId, wantTranscript: cfg.voice.asr })
          scheduler.add(chat, { messageId: dbId, actorId: msg.userId, mode: 'context', msg })
        }
        return
      }
      mode = decision.mode
      log.info(`群 ${msg.groupId}：${decision.reason} → 交给她`)
    }

    // 合并转发先展开（文字直接改到这条消息上）
    if (msg.forwards?.length) {
      msg.text = await expandForwards(msg, msg.text)
      if (msg.kind === 'group') {
        const last = (groupBuf.get(msg.groupId) || []).find((x) => x.dbId === dbId)
        if (last) last.text = msg.text
      }
    }
    // 引用：找回被引用的那条（原话和里面的图），一起交给她
    const quote = msg.replyId ? await quotedOf(msg.chatId, msg.replyId) : null
    // 图片、语音登记后在后台处理，调度器等它们好了（或等到上限）再交给她
    media.register({ messageId: dbId, msg, account: selfId, wantTranscript: cfg.voice.asr })
    lastChatAt = now
    if (msg.kind === 'private' && msg.userId === cfg.ownerQQ) lastOwnerChatAt = now
    onActivity?.({ kind: 'in', chatId: msg.chatId, userId: msg.userId, nickname: msg.nickname, text: msg.text, direct: msg.kind === 'private' || msg.mentioned || mode === 'must', owner: isOwner(cfg, msg.userId) })

    const stickerOnly = msg.stickers.length > 0 && !msg.images.length && !msg.records.length && !msg.text.replace(/\[[^\]]*\]/g, '').trim()
    scheduler.add(chat, { messageId: dbId, actorId: msg.userId, mentioned: msg.mentioned, stickerOnly, mode, msg, quote, wantVoice: wantsVoice(msg.text) })
  }

  /**
   * 被引用的消息：先查主库，再查她自己发过的（outbox），都没有就问网关要（顺手登记进主库、下载里面的图）。
   * 返回 { messageId, name, text, isBot }；找不到返回 null。
   */
  async function quotedOf(chatId, replyId) {
    try {
      const stored = storage.messages.byPlatformId(chatId, replyId)
      if (stored) return { messageId: stored.id, name: stored.authorName || stored.authorId, text: stored.text, isBot: false }
      const mine = outbox.byPlatformId(chatId, replyId)
      if (mine) {
        const text = (mine.payload.message || []).filter((s) => s.type === 'text').map((s) => s.data.text).join('') || mine.payload.note || ''
        return { messageId: null, name: '你自己', text, isBot: true }
      }
      const raw = await onebot.call('get_msg', { message_id: Number(replyId) || replyId }, { timeoutMs: 8000 })
      if (!raw) return null
      const ev = { message_type: chatId.startsWith('group:') ? 'group' : 'private', group_id: chatId.slice(6), user_id: raw.sender?.user_id ?? raw.user_id, message_id: replyId, time: raw.time, sender: raw.sender || {}, message: raw.message ?? raw.content ?? [] }
      const qm = parseMessageEvent(ev, selfId)
      const isBot = String(qm.userId) === String(selfId)
      if (isBot) return { messageId: null, name: '你自己', text: qm.text, isBot: true }
      const ing = storage.messages.ingest({ account: selfId, chatId, eventKind: 'message', platformMsgId: replyId, authorId: qm.userId, authorName: qm.nickname, platformTime: qm.platformTime, text: qm.text, segments: Array.isArray(ev.message) ? ev.message : [] })
      if (!ing.duplicate) media.register({ messageId: ing.id, msg: { ...qm, chatId }, account: selfId, wantTranscript: false })
      return { messageId: ing.id, name: qm.nickname, text: qm.text, isBot: false }
    } catch (error) {
      log.debug('找不到被引用的消息：', error.message)
      return null
    }
  }

  /** 把消息里的「[合并转发]」换成里面的聊天记录（最多 40 条，嵌套的转发不再展开）。 */
  async function expandForwards(msg, text) {
    let out = text
    for (const id of msg.forwards.slice(0, 2)) {
      let lines = []
      try {
        const r = await onebot.call('get_forward_msg', { id }, { timeoutMs: 15000 })
        for (const node of (r?.messages || []).slice(0, 40)) {
          const who = node.sender?.card || node.sender?.nickname || String(node.sender?.user_id ?? node.user_id ?? '某人')
          const m = parseMessageEvent({ message_type: 'private', user_id: node.sender?.user_id ?? node.user_id, message: node.message ?? node.content ?? [] }, selfId)
          lines.push(`  ${who}：${(m.text || '（图片/表情）').slice(0, 120)}`)
        }
      } catch (error) {
        log.debug('拉合并转发失败：', error.message)
      }
      const body = lines.length ? `[合并转发的聊天记录（${lines.length} 条）]\n${lines.join('\n').slice(0, 2000)}\n[转发结束]` : '[合并转发（内容没拉到）]'
      out = out.replace('[合并转发]', body)
    }
    return out
  }

  // ---------- 戳一戳 ----------
  const lastPoker = new Map() // chatId → 最近戳她的人（她戳回去用）
  const lastSpeaker = new Map() // chatId → 群里最近一段最后说话的人
  const pokeAt = new Map() // chatId → 上次处理戳一戳的时间
  /** 有人戳了她：当成一条对她说的话交给她（群里也一定回），同一个聊天 20 秒内只算一次。 */
  async function onPoke(ev) {
    const self = String(ev.self_id || selfId || getConfig().botQQ)
    if (String(ev.target_id) !== self) return
    if (hooks?.poke) {
      try { if (await hooks.poke(ev)) return } catch (error) {}
    }
    const group = ev.group_id ? String(ev.group_id) : ''
    const poker = String(group ? ev.user_id : ev.sender_id ?? ev.user_id)
    if (!poker || poker === self) return
    const chatId = group ? `group:${group}` : `private:${poker}`
    lastPoker.set(chatId, poker)
    if (Date.now() - (pokeAt.get(chatId) || 0) < 20_000) return
    pokeAt.set(chatId, Date.now())
    let nickname = poker
    try {
      const info = group ? await onebot.call('get_group_member_info', { group_id: Number(group), user_id: Number(poker) }, { timeoutMs: 5000 }) : await onebot.call('get_stranger_info', { user_id: Number(poker) }, { timeoutMs: 5000 })
      nickname = info?.card || info?.nickname || poker
    } catch (error) {}
    log.info(`${chatId}：${nickname} 戳了戳她`)
    await onMessage({
      post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend', aurabot_kind: 'poke',
      self_id: Number(self), user_id: Number(poker), ...(group ? { group_id: Number(group) } : {}), message_id: 0,
      sender: { user_id: Number(poker), nickname, card: nickname },
      message: [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ` [戳了戳你${ev.action ? '：' + ev.action + (ev.suffix || '') : ''}]` } }],
    })
  }

  /** 群聊这一段的提示词：之前的几句当背景，上次交给她之后群里新说的话全部列出来，让她看完整段再回。 */
  async function groupPrompt(chat, mode) {
    const name = await groupName(chat.groupId)
    const buf = groupBuf.get(chat.groupId) || []
    const since = groupFedAt.get(chat.groupId) || 0
    const fresh = buf.filter((x) => x.t > since).slice(-20)
    const older = buf.filter((x) => x.t <= since).slice(-8)
    groupFedAt.set(chat.groupId, Date.now())
    const line = (x) => `${x.nick}(${x.uid})${x.at ? '@了你' : ''}：${x.text || '（图片/表情）'}`
    // 新消息带编号，她想专门回某一条时可以引用；编号 → QQ 消息 ID 记下来，发的时候换成引用
    const refs = {}
    const numbered = fresh.map((x, i) => {
      if (x.mid) refs[i + 1] = x.mid
      return `[${i + 1}] ${line(x)}`
    })
    groupRefs.set(chat.groupId, refs)
    const query = fresh.map((x) => x.text).filter(Boolean).join('\n')
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const text = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '大多数时候直接说就行。只有想专门接其中某一条、而直接说别人会看不出你在回谁时（比如那条已经被后面的话刷上去了、或者你在回某个人随口一提的事），才在那句话开头写 <reply:编号>，会以「引用回复」发出；一次最多引用一条。'
    return { text, query, speakers }
  }

  // ---------- 调度：人常常一口气发好几句，等对方说完再一起交给她，别一句一回 ----------
  // 群聊再加一层：她正在回上一段时，新消息先攒着，等她说完再一起交给她（不会一条消息一轮、挨个回）
  const running = new Set() // chatId → 这一轮还在跑（模型 / 工具还没结束，turn/end 之前）；私聊此时新消息直接 steer 进去
  const scheduler = createScheduler({
    settings: (chat) => {
      const m = getConfig().merge
      const group = chat.kind === 'group'
      return {
        enabled: m.enabled,
        waitMs: (group ? m.groupWaitSec : m.waitSec) * 1000,
        maxMs: (group ? m.groupMaxSec : m.maxSec) * 1000,
        mentionWaitMs: m.mentionWaitSec * 1000,
        mediaExtraMs: m.mediaExtraSec * 1000,
      }
    },
    canSteer: (chatId) => running.has(chatId),
    mediaReady: (e) => media.isReady(e.messageId) && (!e.quote?.messageId || media.isReady(e.quote.messageId)),
    dispatch: (chat, batch, info) => dispatch(chat, batch, info),
    log,
  })

  /** 一条消息交给她时的文字：原文 + 语音转写；图片下载失败的说一声。 */
  function entryText(e, res) {
    let text = e.msg.text
    if (e.quote) {
      const q = String(e.quote.text || '').replace(/\s+/g, ' ').slice(0, 120)
      text = `（回复 ${e.quote.name} 的「${q || '图片'}」）` + text
    }
    const cfg = getConfig()
    if (e.msg.records.length) {
      const voice = res.transcripts.length ? res.transcripts.map((t) => `[语音] ${t}`).join(' ') : cfg.voice.asr ? '[发来一条语音，没听清]' : '[发来一条语音]'
      text = (text ? text + ' ' : '') + voice
    }
    if (res.failedImages) text += `（有 ${res.failedImages} 张图没下载下来）`
    if (res.pending) text += `（有 ${res.pending} 个图片 / 语音还没处理完）`
    return text
  }

  /** 一批消息到期：拼好提示词、给每个提出请求的人登记请求，交给她。 */
  async function dispatch(chat, batch, { steer }) {
    const cfg = getConfig()
    const results = new Map(batch.entries.map((e) => [e.messageId, media.resultsOf(e.messageId)]))
    // 图片按消息顺序收集，最多 4 张
    const images = []
    for (const e of batch.entries) for (const im of results.get(e.messageId).images) if (images.length < 4) images.push({ ...im, messageId: e.msg.messageId })
    // 被引用的那条里的图排在后面（只给提出请求的消息带，当上下文的不带）
    for (const e of batch.entries) {
      if (e.mode === 'context' || !e.quote?.messageId) continue
      for (const im of media.resultsOf(e.quote.messageId).images) if (images.length < 4) images.push({ ...im, messageId: 'quote-' + e.msg.replyId })
    }
    const texts = []
    for (const e of batch.entries) {
      const text = entryText(e, results.get(e.messageId))
      e.finalText = text
      if (chat.kind === 'group') {
        // 群消息的文字在 groupBuf 里：语音转出来的字补进去，拼提示词时才看得到
        const b = (groupBuf.get(chat.groupId) || []).find((x) => x.dbId === e.messageId)
        if (b) b.text = text
      } else {
        texts.push(`【私聊】${e.msg.nickname}(${e.msg.userId})：` + (text || '（没有文字）'))
      }
      if (e.mode !== 'context') logChat(chat.chatId, e.msg.nickname, text, e.msg.userId)
    }
    let content
    let query
    let speakers
    if (chat.kind === 'group') {
      const gid = chat.groupId
      if (batch.mode === 'interject') {
        const arr = (groupInterjects.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
        arr.push(Date.now())
        groupInterjects.set(gid, arr)
      }
      const gp = await groupPrompt(chat, batch.mode)
      const askers = batch.entries.filter((e) => e.mode !== 'context').map((e) => e.actorId)
      if (gp.speakers.length) lastSpeaker.set(chat.chatId, askers.at(-1) || gp.speakers.at(-1))
      content = [{ type: 'text', text: gp.text }]
      query = gp.query
      speakers = gp.speakers
    } else {
      content = [{ type: 'text', text: texts.join('\n') }]
      // 私聊：检索记忆时去掉「【私聊】某某(QQ)：」这个头
      query = batch.entries.map((e) => e.finalText).join('\n')
    }
    if (images.length) {
      // 模型明确不支持看图：硬塞图片块会让整轮请求被拒（她就一个字都回不了），改成一行文字提示
      if ((await canSeeImages(dsh, cfg)) === false) {
        content.push({ type: 'text', text: `（这段里有 ${images.length} 张图片，你现在的模型看不了图，只能知道有这么回事）` })
        log.debug(`模型不支持看图：${chat.chatId} 的 ${images.length} 张图换成文字提示`)
      } else {
        for (let i = 0; i < images.length; i++) content.push({ type: 'image', data: images[i].data, mediaType: images[i].mediaType, name: `qq-${images[i].messageId}-${i + 1}` })
      }
    }
    // 人设：按绑定找这一轮的卡；绑定坏了（卡不存在 / 归档 / 没发布）就不扮演任何角色，只告诉主人
    const persona = typeof personaOf === 'function' ? personaOf(chat) : null
    if (persona?.error) {
      log.error(`${chat.chatId}：${persona.error}，这一轮不交给她`)
      if (chat.kind === 'private' && isOwner(cfg, chat.userId)) await sendText(chat.chatId, `（人设配置有误：${persona.error}。请到面板「人格」页检查）`)
      release(chat.chatId)
      return
    }
    // 请求：每个提出请求的人一份（只当上下文的消息不算），提出者由这里确定，模型和工具改不了
    const byActor = new Map()
    for (const e of batch.entries) {
      if (e.mode === 'context') continue
      if (!byActor.has(e.actorId)) byActor.set(e.actorId, [])
      byActor.get(e.actorId).push(e.messageId)
    }
    const requests = [...byActor.entries()].map(([actorId, ids]) => storage.requests.create({ chatId: chat.chatId, actorId, sourceMessageIds: ids }))
    const actors = [...byActor.keys()]
    await pushToSession(chat, content, actors[0], {
      wantVoice: batch.entries.some((e) => e.wantVoice), extraSenders: actors.slice(1), queryText: query, speakers, steer, requests, persona,
    })
  }

  /** 她这一轮说完了（或者没说）：放开，把这期间攒下的消息交给她。 */
  function release(chatId) {
    running.delete(chatId)
    scheduler.turnEnded(chatId)
  }

  async function admit(agent, content) {
    if (content.length === 1) return content
    const att = dsh.attachments || dsh.get('attachments')
    if (att && typeof att.admitPromptContent === 'function') {
      try {
        return await att.admitPromptContent(content)
      } catch (error) {
        log.warn('图片交给 DSH 没成功（这轮只给文字）：', error.message)
      }
    }
    return content.filter((c) => c.type === 'text')
  }

  // 私聊里等她回复时，在 QQ 上显示「对方正在输入…」（模型慢的时候让人知道她在想）
  const typing = new Map() // sessionKey → timer
  function startTyping(key, chat) {
    const cfg = getConfig()
    if (chat.kind !== 'private' || !cfg.enabled || cfg.dryRun || typing.has(key)) return
    const ping = () => onebot.call('set_input_status', { user_id: Number(chat.userId), event_type: 1 }, { timeoutMs: 5000 }).catch(() => {})
    ping()
    const started = Date.now()
    const t = setInterval(() => {
      if (Date.now() - started > 6 * 60_000) return stopTyping(key)
      ping()
    }, 15_000)
    t.unref?.()
    typing.set(key, t)
  }
  function stopTyping(key) {
    const t = typing.get(key)
    if (t) clearInterval(t)
    typing.delete(key)
  }

  async function pushToSession(chat, content, senderId, opts = {}) {
    if (hooks?.prompt) {
      try {
        const next = await hooks.prompt(content, { chat, senderId, ...opts })
        if (next === null) {
          log.info(`${chat.chatId}：扩展模块决定这次不交给她`)
          if (!opts.steer) release(chat.chatId) // 插话被拦下时，当前这一轮还在跑，不能放开
          return
        }
        if (Array.isArray(next)) content = next
      } catch (error) {
        log.warn('扩展模块改提示词出错：', error.message)
      }
    }
    const { agent, sessionId } = await agentFor(chat, opts.persona)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    // 这一轮用的人设版本在开始时冻结（插话沿用当前这一轮的）；面板改了卡，从下一轮起生效
    if (!opts.steer || !st.persona) st.persona = opts.persona || null
    if (senderId) st.senders.add(String(senderId))
    for (const s of opts.extraSenders || []) st.senders.add(String(s))
    if (!opts.steer) st.toolCalls = 0
    // 这一轮在回哪些请求（插话时追加），以及开始时的会话代次
    st.requests = opts.steer ? [...(st.requests || []), ...(opts.requests || [])] : [...(opts.requests || [])]
    if (!opts.steer || st.epoch === undefined) st.epoch = storage.epochs.current(chat.chatId)
    // 上一句也留着：这一句太短（「嗯嗯」「然后呢」）时一起拿去想起相关的事
    if (st.lastText) st.prevText = st.lastText
    st.lastText = String(opts.queryText ?? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')).slice(-600)
    st.speakers = opts.speakers || (senderId ? [String(senderId), ...(opts.extraSenders || []).map(String)] : [])
    if (opts.wantVoice) st.wantVoice = true
    turnState.set(key, st)
    const admitted = await admit(agent, content)
    startTyping(key, chat)
    const message = { id: randomUUID(), role: 'user', content: admitted, source: { kind: SOURCE_KIND } }
    // 正在跑的这一轮：steer = 下一步就看到这句（DSH 界面插话走的也是它）；空闲时照旧 followup 开新一轮
    if (opts.steer && typeof agent.steer === 'function') {
      log.info(`${chat.chatId}：她还在忙，这句直接插进当前这一轮（steer）`)
      await agent.steer(message)
    } else {
      running.add(chat.chatId)
      await agent.followup(message)
    }
    try {
      if (dsh.sessions && typeof dsh.sessions.flush === 'function') await dsh.sessions.flush(agent.session)
    } catch (error) {}
  }

  /** 后台任务（主动搭话的草稿等）：在专用会话里跑一轮，拿到正文但不自动转发。 */
  async function runSystemTurn(name, title, prompt, { timeoutMs = 180000, noTools = false } = {}) {
    const chat = { chatId: `system:${name}`, kind: 'system', title, noTools: !!noTools }
    const { agent, sessionId } = await agentFor(chat)
    const key = sessionKey(sessionId)
    const st = turnState.get(key) || { lastTurn: -1, text: '', senders: new Set() }
    turnState.set(key, st)
    let timer
    const result = new Promise((resolve, reject) => {
      st.system = { resolve, reject }
      timer = setTimeout(() => {
        st.system = null
        reject(new Error('等太久了'))
      }, timeoutMs)
    }).finally(() => clearTimeout(timer))
    await agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: SOURCE_KIND } })
    return result
  }

  /** 这一轮在回的请求：[{ id, actorId, sourceMessageIds, ... }]。 */
  function turnRequests(sessionId) {
    return turnState.get(sessionKey(sessionId))?.requests || []
  }

  /**
   * 这一轮提出请求的人是不是全是主人（群管、改资料、存表情等主人才能做的事用）。
   * 主人和别人混在同一轮里时不算：主人说一句「你好」不能替旁边群友的「把他禁言」授权。
   * 没有请求记录时（后台任务、模拟测试）退回看这一轮的发言人。
   */
  function turnSendersAllOwner(sessionId) {
    const st = turnState.get(sessionKey(sessionId))
    if (!st) return false
    const cfg = getConfig()
    if (st.requests?.length) {
      if (st.requests.every((q) => isOwner(cfg, q.actorId))) return true
      // 主人和别人混在一轮：工具调用要写明在执行哪一条，那条必须是主人在这一轮里发的
      return ownerMessageRef(chatOfSession(sessionId), st.requests, callRef.getStore()?.forMessage)
    }
    if (!st.senders.size) return false
    return [...st.senders].every((u) => isOwner(cfg, u))
  }

  /** 编号 ref 对应的群消息是不是主人发的、而且属于这一轮主人的请求。 */
  function ownerMessageRef(chatId, requests, ref) {
    if (!ref || !String(chatId).startsWith('group:')) return false
    const mid = (groupRefs.get(chatId.slice(6)) || {})[ref]
    if (!mid) return false
    const cfg = getConfig()
    for (const q of requests) {
      if (!isOwner(cfg, q.actorId)) continue
      if (q.sourceMessageIds.some((id) => storage.messages.get(id)?.platformMsgId === String(mid))) return true
    }
    return false
  }
  // 旧名字：以前是「这一轮里主人说过话」就算，会被同一轮里别人的请求借用权限，现在和上面一样严格
  const turnHasOwner = turnSendersAllOwner

  function chatOfSession(sessionId) {
    return sessionToChat.get(sessionKey(sessionId)) || ''
  }

  /**
   * 放下一个聊天当前的一切：代次 +1（还没发出去的上一代回复作废）、丢掉攒着的消息、
   * 停下正在跑的这一轮。换人设、重开会话时用。
   */
  function abandonChat(chatId, sessionId, reason) {
    try { storage.epochs.bump(chatId, reason) } catch (error) {}
    scheduler.drop(chatId)
    try { outbox.cancelPending(chatId, reason) } catch (error) {}
    if (running.has(chatId) && sessionId) {
      const agent = dsh.agents?.get?.(sessionId) || dsh.agents?.get?.('session-' + sessionId)
      try { agent?.cancel?.({ kind: 'hook', reason }, { keepInbox: false }) } catch (error) { log.debug('停下这一轮失败：', error.message) }
    }
    running.delete(chatId)
  }

  /** 换身份：代次 +1、作废上一代没发出去的段、停下旧会话、归档。攒着的新消息不丢（它们要交给新角色）。 */
  function switchIdentity(chatId, sessionId) {
    try { storage.epochs.bump(chatId, '换人设') } catch (error) {}
    try { outbox.cancelPending(chatId, '换人设') } catch (error) {}
    const agent = dsh.agents?.get?.(sessionId) || dsh.agents?.get?.('session-' + sessionId)
    try { if (agent?.status === 'running') agent.cancel?.({ kind: 'hook', reason: '换人设' }, { keepInbox: false }) } catch (error) {}
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    Promise.resolve(reg?.archiveSession?.(sessionId)).catch((error) => log.debug('归档旧会话失败：', error.message))
    sessionToChat.delete(sessionKey(sessionId))
    turnState.delete(sessionKey(sessionId))
    const m = map()
    delete m.chats[chatId]
    saveMap(m)
  }

  /** 只让一个聊天重新开始：归档它的会话，下一条消息开新会话。 */
  function resetChat(chatId) {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    const e = m.chats[chatId]
    if (!e) return false
    abandonChat(chatId, e.sessionId, '重新开始')
    Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
    sessionToChat.delete(sessionKey(e.sessionId))
    turnState.delete(sessionKey(e.sessionId))
    delete m.chats[chatId]
    saveMap(m)
    log.info(`${chatId} 重新开始`)
    return true
  }

  /** 重新开始：把现有的 QQ 会话都归档（侧栏里还能找回），下一条消息起开新会话。 */
  function resetSessions() {
    const reg = dsh.workspaceRegistry || dsh.get('workspaceRegistry')
    const m = map()
    let n = 0
    for (const [chatId, e] of Object.entries(m.chats)) {
      abandonChat(chatId, e.sessionId, '重新开始所有会话')
      try {
        // 可能返回 Promise：必须接住 rejection，未处理的 rejection 会让 DSH 宿主退出
        Promise.resolve(reg?.archiveSession?.(e.sessionId)).catch((error) => log.debug('归档会话失败：', error.message))
      } catch (error) {
        log.debug('归档会话失败：', error.message)
      }
      sessionToChat.delete(sessionKey(e.sessionId))
      turnState.delete(sessionKey(e.sessionId))
      delete m.chats[chatId]
      n++
    }
    // 专用工作区里其他零散的会话（比如手动点「新会话」留下的空白会话）也一起归档
    try {
      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
      const ws = (reg?.list?.() || []).find((w) => norm(w.path) === norm(WORKSPACE_DIR))
      for (const sid of ws?.sessionIds || []) {
        if ((reg.archivedSessionIds || []).includes(sid)) continue
        Promise.resolve(reg.archiveSession(sid)).catch(() => {})
        n++
      }
    } catch (error) {}
    saveMap(m)
    log.info(`重新开始：归档了 ${n} 个 QQ 会话`)
    return n
  }

  /** 模拟测试：fn 里发出去的消息都记下来不真发，返回 { result, sent }。 */
  async function capture(fn) {
    const sent = []
    const result = await captureStore.run(sent, fn)
    return { result, sent }
  }
  /** 模拟测试：假装这个会话这一轮是谁在说话（工具里的「主人才能用」靠它判断）。 */
  function simulateTurn(sessionId, senders) {
    turnState.set(sessionKey(sessionId), { lastTurn: -1, text: '', senders: new Set(senders.map(String)) })
  }

  return {
    /** 这个聊天最近发来的图片 / 表情（新的在后面），可选只要某人发的 */
    recentMedia: (chatId, userId) => (recentMedia.get(String(chatId)) || []).filter((x) => !userId || x.userId === String(userId)),
    capture,
    simulateTurn,
    onMessage,
    onPoke,
    onSessionEvent,
    deliver,
    sendText,
    sendVoice,
    sendVoiceFile,
    sendSticker,
    sendImage,
    sendSegments,
    pushToSession,
    runSystemTurn,
    turnSendersAllOwner,
    turnHasOwner,
    turnRequests,
    recoverOutbox: (o) => outbox.recover(o),
    resetChat,
    joinTopic: (gid) => groupEngaged.set(String(gid), Date.now() + ENGAGE_MS),
    leaveTopic: (gid) => groupEngaged.delete(String(gid)),
    chatOfSession,
    resetSessions,
    abandonChat,
    lastTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.lastText || '',
    prevTextOf: (sessionId) => turnState.get(sessionKey(sessionId))?.prevText || '',
    speakersOf: (sessionId) => turnState.get(sessionKey(sessionId))?.speakers || [],
    logChat,
    localTranscribe,
    ensureWorkspace,
    chatLogOf,
    chatLogDays,
    deleteChatLog,
    sessions: () => map().chats,
    groupName,
    stats: () => ({ ...stats }),
    get lastChatAt() { return lastChatAt },
    get lastOwnerChatAt() { return lastOwnerChatAt },
    get lastBotToOwner() { return lastBotToOwner },
    get selfId() { return selfId },
    agentCaps: () => agentCaps,
    /** 这个聊天现在会用哪个模型（主人按聊天选的 > 全局 > DSH 默认）。 */
    modelFor: (chat) => targetModel(chat),
    /** 正在跑的这一轮用的人设快照（没在跑返回 null）。 */
    turnPersona: (sessionId) => (running.has(chatOfSession(sessionId)) ? turnState.get(sessionKey(sessionId))?.persona || null : null),
    groupNames,
  }
}
