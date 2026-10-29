// 插件配置：默认值 + 归一化 + 读写。配置文件 ~/.dsh/plugins-data/aurabot/config.json

import { dataDir, readJson, writeJson } from './store.js'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS, PROFILE_PERM_KEYS, PROFILE_PERM_LEVELS, profilePermDefault } from '../chat/access.js'
import { normalizeChatModels } from '../chat/chat-model.js'
import { legacyTtsMapping, TTS_PROVIDERS } from '../voice/tts.js'
import { SEARCH_DEFAULTS, searchConfig } from '../search/config.js'
import { DEFAULT_LEARNING, settings as learningSettings } from '../learning/contracts.js'
import { normalizeShareGroups } from '../domain/scope.js'
import { DEFAULT_PARTICIPATION_CONFIG, normalizeParticipationConfig } from '../runtime/participation.js'
import { DEFAULT_MEDIA_MEMORY, mediaMemorySettings } from '../runtime/media-analysis.js'
import { RETRIEVAL_DEFAULTS, RETRIEVAL_SECRET_FIELDS, normalizeRetrievalConfig, runtimeRetrievalConfig } from '../memory/vector/integration/module-config.js'

export const DEFAULTS = {
  schemaVersion: 2,
  policyRevision: 0,
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  profilePerms: { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', qqFriendRequest: 'owner', whitelist: 'owner' }, // 改资料类操作的权限：off 关 / owner 仅主人私聊 / all 所有人
  toolCallsPerTurn: 6, // 一轮里最多调用几次插件工具（防止模型反复自我唤醒、烧额度）；DSH 自带的电脑工具不算
  conversation: { maxTurns: 48, maxContextTokens: 48000, maxAgeMinutes: 480, followupSeconds: 90 },
  longTasks: false, // 长任务模式：主人私聊（完整权限）额外挂 dsh-tool-jobs + dsh-tool-schedule，会多一点工具定义、稍慢
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随 DSH 启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 插件自动生成并保存（第一次启动 SnowLuma 时）；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  model: { provider: '', model: '', reasoningEffort: 'low', vision: 'auto' }, // 留空 = 跟随 DSH 默认；vision: auto/on/off
  // 各个后台角色用哪个模型；留空 = 用上面的全局模型。replyer 留空 = 不另外改写（聊天会话直接写最终回复）
  roles: {
    replyer: { provider: '', model: '', reasoningEffort: '' },
    vision: { provider: '', model: '', reasoningEffort: '' },
    memory: { provider: '', model: '', reasoningEffort: '' },
    learning: { provider: '', model: '', reasoningEffort: '' },
    judge: { provider: '', model: '', reasoningEffort: '' },
  },
  // 按聊天选模型（主人在面板「模型」页设）：私聊 QQ 号 > 群号 > 所有私聊 / 所有群默认 > 上面的全局模型；没写的一级退到下一级
  chatModels: { privateDefault: { provider: '', model: '', reasoningEffort: '' }, groupDefault: { provider: '', model: '', reasoningEffort: '' }, privates: {}, groups: {} },
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15, mentionWaitSec: 1.5, mediaExtraSec: 3 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐；被 @ 时最多等 mentionWaitSec；图片 / 语音还没处理完最多再等 mediaExtraSec
  imageGen: {
    enabled: false,
    // 生图服务可以配好几个，每个是一种协议：openai 兼容 / gemini 原生 / comfyui 工作流 / http 自己配的映射
    // capabilities 是主人声明的能力（模式、最多几张输入图、尺寸），和适配器自己能做的取交集
    profiles: [],
    defaultProfile: '',
    size: '1024x1024',
    stylePrompt: '', // 每次生图自动加在前面的风格描述
    ownerOnly: true, // 只有主人能让她画
    quota: { perUserPerDay: 20, perChatPerDay: 100, perProviderPerDay: 500, ownerUnlimited: true },
    waitInputSec: 30, // 参考图还没下载好时最多等多久
  },
  persona: { current: 'dafeiyu' },
  group: { ...DEFAULT_GROUP_POLICY, overrides: {} },
  participation: { ...DEFAULT_PARTICIPATION_CONFIG },
  mediaMemory: { ...DEFAULT_MEDIA_MEMORY },
  voice: {
    enabled: true,
    // 语音合成走外部接口：none 没配 / openai 兼容 OpenAI 的 /audio/speech / http 自己配的固定映射（CosyVoice、GPT-SoVITS 用它的预设）
    provider: 'none',
    openai: { baseUrl: '', apiKey: '', model: 'tts-1', voice: 'alloy', format: 'mp3' },
    httpApi: { method: 'POST', url: '', headers: {}, bodyType: 'json', body: '', response: 'audio', jsonPath: '', audioFormat: 'auto', sampleRate: 24000, apiKey: '' },
    defaultVoice: '', // 人设没指定音色时用这个
    speed: 1,
    autoChance: 0.15, // 短回复自动变语音的概率
    groupAutoChance: 0, // 群聊默认保留文字；明确请求及 voice 标记仍生效
    autoMaxChars: 80,
    asr: true, // 听语音
  },
  stickers: {
    enabled: true,
    libraryScope: 'account', // 同一机器人账号共用图库；chat 保留按聊天隔离。
    autoReview: true, // 新素材经完整模型分析明确 approve 后自动可用。
    autoChance: 0.35, // 文字回复自动配一张表情的概率
    collect: true, // 偷表情
    fromGroups: true,
    fromPrivate: true,
    maxPerHour: 20,
    maxLibrary: 300, // 达到图库容量后暂停接收；不自动删除已审核素材。
    caption: true, // 用视觉模型起备注
  },
  // 本地接口：数据目录 local/ 里的脚本接管这几项（文件要在、开关要开）
  local: { tts: false, image: false, song: false, asr: false },
  bili: {
    enabled: false,
    sessdata: '', // B 站 Cookie 里的 SESSDATA（登录凭证）
    biliJct: '', // B 站 Cookie 里的 bili_jct（发评论要用）。两个都不填也能看视频，只是不能评论
    cookie: '', // 由上面两个拼出来给接口用；老配置的整串会自动拆到上面两个里
    autoBrowse: true, // 定时自己去刷
    intervalHours: 4, // 多久刷一轮
    maxRunsPerDay: 3,
    perRun: 3, // 一轮看几个视频
    keywords: [], // 额外想让她搜的方向（另外还会参考她的兴趣和记忆里你喜欢的东西）
    minViews: 5000, // 播放量门槛
    maxAgeDays: 60, // 只看最近多少天发的
    comment: true, // 自己发评论
    maxCommentsPerDay: 3,
    reply: true, // 回别人回她的评论
    maxRepliesPerDay: 6,
    shareToOwner: true, // 看到好玩的私聊分享给主人
    like: false, // 顺手点赞
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 4,
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  mood: { enabled: true, baseline: 60, halfLifeHours: 3, judge: false, judgeIntervalMs: 60000 },
  learning: { ...DEFAULT_LEARNING },
  memory: { enabled: true, recallCount: 6, shareGroups: [], extraction: { minMessages: 20, intervalMs: 1800000, maxBatchMessages: 100, maxChars: 12000 } },
  search: { ...SEARCH_DEFAULTS },
  retrieval: { ...RETRIEVAL_DEFAULTS },
  song: {
    enabled: false,
    root: '', // 翻唱环境目录，留空 = 自动（老安装 C:\Aurabot\rvc，新安装在用户目录下）
    voice: '', // 用哪个音色（models 目录里的 .pth 文件名），留空 = 第一个
    pitch: 0, // 默认变调（半音）；她点歌时会按原唱是男声还是女声自己定
    neteaseCookie: '', // 网易云 Cookie（MUSIC_U），下会员歌用
    separatorModel: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt', // 人声分离模型
    maxVoiceSec: 120, // 语音条最长多少秒，歌更长就截一段
    clipStart: 'auto', // auto = 从副歌附近截；head = 从头截
    vocalVolume: 1,
    instVolume: 0.8,
    ownerOnly: true, // 只有主人能点歌
    keepWork: false, // 留着中间文件（调试用）
    pypiMirror: 'auto', // 安装时用的下载源：auto = 先测一下，官方源慢就用国内镜像；cn = 一直用国内镜像；off = 只用官方源
  },
  tabs: {}, // 面板记住的小偏好
  // 模块：内置的和数据目录 modules/ 里自己写的。{ 模块id: { enabled, useBuiltin } }，没写的算开着
  // useBuiltin：自己写了同名模块，但想先用回内置的
  modules: {},
  safeMode: false, // 安全模式：自己写的模块一个都不加载（排查问题用）
  ext: {}, // 自己写的模块的设置：{ 模块id: {...} }
  // 联动：让别的程序、DSH 里别的会话和插件也能用她
  bridge: {
    dshTools: false, // DSH 里别的会话（比如你平时写代码的会话）能用工具让她发 QQ、查记忆
    http: false, // 开放 HTTP 接口（要带密钥）
    token: '', // 第一次打开时自动生成
    allowTargets: 'whitelist', // 外部能发给谁：whitelist = 白名单里的人和群；owner = 只能发给主人
  },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]
const hhmm = (v, d) => (/^\d{1,2}:\d{2}$/.test(String(v)) ? String(v) : d)

export function normalize(raw) {
  if (Number(raw?.schemaVersion) > 2) throw new Error('配置版本高于当前插件，请先升级插件')
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  // 视觉能力：auto = 问 DSH 的模型元数据；on / off = 主人手动声明（覆盖元数据）
  c.model.vision = c.model.vision === 'on' || c.model.vision === 'off' ? c.model.vision : 'auto'
  for (const k of Object.keys(DEFAULTS.roles)) {
    const x = isObj(c.roles[k]) ? c.roles[k] : {}
    c.roles[k] = { provider: String(x.provider || ''), model: String(x.model || ''), reasoningEffort: String(x.reasoningEffort || '') }
    if (!c.roles[k].provider || !c.roles[k].model) c.roles[k] = { provider: '', model: '', reasoningEffort: '' }
  }
  for (const k of Object.keys(c.roles)) if (!(k in DEFAULTS.roles)) delete c.roles[k]
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.longTasks = bool(c.longTasks, false)
  c.retrieval = normalizeRetrievalConfig(c.retrieval)
  c.participation = normalizeParticipationConfig(c.participation)
  c.mediaMemory = mediaMemorySettings(c)
  c.toolCallsPerTurn = num(c.toolCallsPerTurn, 6, 1, 30)
  c.chatModels = normalizeChatModels(c.chatModels)
  c.profilePerms = Object.fromEntries(PROFILE_PERM_KEYS.map((k) => [k, PROFILE_PERM_LEVELS.includes(c.profilePerms?.[k]) ? c.profilePerms[k] : profilePermDefault(k)]))
  c.allow = { private: qqList(c.allow.private), groups: qqList(c.allow.groups) }
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.cooldownSec = num(g.cooldownSec, 90, 0, 86400)
  g.maxPerHour = num(g.maxPerHour, 6, 0, 120)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, 100)
  g.activeWindowSec = num(g.activeWindowSec, 300, 30, 86400)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  c.voice.autoChance = num(c.voice.autoChance, 0.15, 0, 1)
  c.voice.groupAutoChance = num(c.voice.groupAutoChance, 0, 0, 1)
  c.voice.autoMaxChars = num(c.voice.autoMaxChars, 80, 1, 500)
  c.stickers.autoChance = num(c.stickers.autoChance, 0.35, 0, 1)
  c.stickers.libraryScope = c.stickers.libraryScope === 'chat' ? 'chat' : 'account'
  c.stickers.autoReview = bool(c.stickers.autoReview, true)
  c.stickers.maxPerHour = num(c.stickers.maxPerHour, 20, 0, 200)
  c.stickers.maxLibrary = num(c.stickers.maxLibrary, 300, 20, 2000)
  c.speakUp.idleMinutes = num(c.speakUp.idleMinutes, 40, 5, 1440)
  c.speakUp.nudge = bool(c.speakUp.nudge, true)
  c.speakUp.minIntervalMinutes = num(c.speakUp.minIntervalMinutes, 90, 5, 1440)
  c.speakUp.maxIntervalMinutes = Math.max(c.speakUp.minIntervalMinutes, num(c.speakUp.maxIntervalMinutes, 240, 5, 2880))
  c.speakUp.maxPerDay = num(c.speakUp.maxPerDay, 3, 0, 20)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.25, 72)
  c.mood.judge = bool(c.mood.judge, false)
  c.mood.baseline = num(c.mood.baseline, 60, 30, 80)
  c.mood.judgeIntervalMs = num(c.mood.judgeIntervalMs, 60000, 1000, 86400000)
  c.learning = learningSettings(c)
  c.schemaVersion = 2
  c.policyRevision = Math.max(0, Math.floor(Number(c.policyRevision)||0))
  c.memory.shareGroups = normalizeShareGroups(c.memory.shareGroups)
  for (const k of ['tts', 'image', 'song', 'asr']) c.local[k] = bool(c.local[k], false)
  const b = c.bili
  Object.assign(b, splitBiliCookie(b))
  for (const k of ['enabled', 'autoBrowse', 'comment', 'reply', 'shareToOwner', 'like']) b[k] = bool(b[k], DEFAULTS.bili[k])
  b.intervalHours = num(b.intervalHours, 4, 1, 48)
  b.maxRunsPerDay = num(b.maxRunsPerDay, 3, 0, 24)
  b.perRun = num(b.perRun, 3, 1, 8)
  b.minViews = num(b.minViews, 5000, 0, 1e8)
  b.maxAgeDays = num(b.maxAgeDays, 60, 0, 3650)
  b.maxCommentsPerDay = num(b.maxCommentsPerDay, 3, 0, 50)
  b.maxRepliesPerDay = num(b.maxRepliesPerDay, 6, 0, 100)
  b.keywords = (Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[\n,，]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 30)
  delete c.mood.maxInjectPerDay // 旧版的「每天最多提醒几次」，现在心情明显时每轮都会带上
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
  // 增量提炼替代定时全量扫描；保留原始消息和失败检查点。
  delete c.memory.consolidateAt
  delete c.memory.consolidateTimes
  delete c.memory.dailyConsolidate
  c.memory.enabled = bool(c.memory.enabled, true)
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, 20)
  c.memory.extraction.minMessages = num(c.memory.extraction.minMessages, 20, 1, 1000)
  c.memory.extraction.intervalMs = num(c.memory.extraction.intervalMs, 1800000, 60000, 86400000)
  c.memory.extraction.maxBatchMessages = num(c.memory.extraction.maxBatchMessages, 100, 1, 1000)
  c.memory.extraction.maxChars = num(c.memory.extraction.maxChars, 12000, 1000, 50000)
  if (!Array.isArray(c.memory.shareGroups)) c.memory.shareGroups = []
  c.search = searchConfig(c.search)
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  c.merge.enabled = bool(c.merge.enabled, true)
  c.conversation.maxTurns = num(c.conversation.maxTurns, 48, 8, 200)
  c.conversation.maxContextTokens = num(c.conversation.maxContextTokens, 48000, 8000, 200000)
  c.conversation.maxAgeMinutes = num(c.conversation.maxAgeMinutes, 480, 30, 1440)
  c.conversation.followupSeconds = num(c.conversation.followupSeconds, 90, 15, 180)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, 60))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, 60)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, 120))
  c.merge.mentionWaitSec = num(c.merge.mentionWaitSec, 1.5, 0, 30)
  c.merge.mediaExtraSec = num(c.merge.mediaExtraSec, 3, 0, 60)
  g.burstMax = num(g.burstMax, 8, 1, 50)
  g.burstWindowSec = num(g.burstWindowSec, 120, 10, 3600)
  // 旧设置（engine = cosyvoice / gptsovits / http）第一次读到时换成新的 http 映射；edge-tts、Windows 语音已不再支持
  if (!raw?.voice?.provider) {
    const mapped = legacyTtsMapping(raw?.voice || {})
    if (mapped) { c.voice.provider = 'http'; c.voice.httpApi = { ...DEFAULTS.voice.httpApi, ...mapped } }
  }
  if (!TTS_PROVIDERS.includes(c.voice.provider)) c.voice.provider = 'none'
  const ha = c.voice.httpApi
  ha.method = ha.method === 'GET' ? 'GET' : 'POST'
  if (!['none', 'json', 'form'].includes(ha.bodyType)) ha.bodyType = 'json'
  if (!['audio', 'json-base64', 'json-url'].includes(ha.response)) ha.response = 'audio'
  if (!['auto', 'pcm_s16le'].includes(ha.audioFormat)) ha.audioFormat = 'auto'
  ha.sampleRate = num(ha.sampleRate, 24000, 8000, 48000)
  if (!isObj(ha.headers)) ha.headers = {}
  c.voice.speed = num(c.voice.speed, 1, 0.5, 2)
  // 旧设置只有一个 OpenAI 兼容服务：第一次读到时变成一个 profile（旧版只会文生图）
  if (!Array.isArray(raw?.imageGen?.profiles) && raw?.imageGen?.baseUrl) {
    c.imageGen.profiles = [{ id: 'default', name: '原来的生图服务', protocol: 'openai', baseUrl: raw.imageGen.baseUrl, apiKey: raw.imageGen.apiKey || '', model: raw.imageGen.model || '', capabilities: { modes: ['text'] }, extra: {} }]
    c.imageGen.defaultProfile = 'default'
  }
  c.imageGen.profiles = normalizeImageProfiles(c.imageGen.profiles)
  if (!c.imageGen.profiles.some((p) => p.id === c.imageGen.defaultProfile)) c.imageGen.defaultProfile = c.imageGen.profiles[0]?.id || ''
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model']) delete c.imageGen[k]
  if (!isObj(c.imageGen.quota)) c.imageGen.quota = {}
  c.imageGen.quota.perUserPerDay = num(c.imageGen.quota.perUserPerDay, 20, 0, 1000)
  c.imageGen.quota.ownerUnlimited = bool(c.imageGen.quota.ownerUnlimited, true)
  c.imageGen.quota.perChatPerDay = num(c.imageGen.quota.perChatPerDay, 100, 0, 10000)
  c.imageGen.quota.perProviderPerDay = num(c.imageGen.quota.perProviderPerDay, 500, 0, 10000)
  c.imageGen.waitInputSec = num(c.imageGen.waitInputSec, 30, 5, 300)
  c.imageGen.enabled = bool(c.imageGen.enabled, false)
  c.imageGen.ownerOnly = bool(c.imageGen.ownerOnly, true)
  if (!/^\d{3,4}x\d{3,4}$/.test(String(c.imageGen.size))) c.imageGen.size = '1024x1024'
  c.song.enabled = bool(c.song.enabled, false)
  c.song.ownerOnly = bool(c.song.ownerOnly, true)
  c.song.pitch = num(c.song.pitch, 0, -24, 24)
  c.song.maxVoiceSec = num(c.song.maxVoiceSec, 120, 15, 600)
  c.song.vocalVolume = num(c.song.vocalVolume, 1, 0.2, 2)
  c.song.instVolume = num(c.song.instVolume, 0.8, 0.1, 2)
  if (!['auto', 'head'].includes(c.song.clipStart)) c.song.clipStart = 'auto'
  // 老配置：'' 是以前的默认（没开），改成自动；tuna 是以前的「用镜像」
  c.song.pypiMirror = { '': 'auto', tuna: 'cn' }[c.song.pypiMirror] ?? c.song.pypiMirror
  if (!['auto', 'cn', 'off'].includes(c.song.pypiMirror)) c.song.pypiMirror = 'auto'
  c.song.root = String(c.song.root || '').trim()
  if (!isObj(c.modules)) c.modules = {}
  for (const [id, m] of Object.entries(c.modules)) {
    if (!isObj(m)) { delete c.modules[id]; continue }
    m.enabled = bool(m.enabled, true)
    m.useBuiltin = bool(m.useBuiltin, false)
  }
  if (!isObj(c.ext)) c.ext = {}
  for (const k of Object.keys(c.ext)) if (!isObj(c.ext[k])) delete c.ext[k] // 传 null = 删掉这个模块的设置
  c.safeMode = bool(c.safeMode, false)
  c.bridge.dshTools = bool(c.bridge.dshTools, false)
  c.bridge.http = bool(c.bridge.http, false)
  c.bridge.token = String(c.bridge.token || '')
  if (!['whitelist', 'owner'].includes(c.bridge.allowTargets)) c.bridge.allowTargets = 'whitelist'
  return c
}

// 面板里不回传原文的字段：路径（几层都行）
const IMAGE_PROTOCOLS = ['openai', 'gemini', 'comfyui', 'http']
const IMAGE_MODES = ['text', 'reference', 'edit', 'mask']
/** 生图服务列表归一化：ID 唯一且合法，协议认识，能力字段规整。 */
export function normalizeImageProfiles(list) {
  const out = []
  const seen = new Set()
  for (const p of Array.isArray(list) ? list : []) {
    if (!isObj(p)) continue
    const id = String(p.id || '').trim()
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seen.has(id)) continue
    seen.add(id)
    const caps = isObj(p.capabilities) ? p.capabilities : {}
    out.push({
      id,
      name: String(p.name || id).slice(0, 40),
      protocol: IMAGE_PROTOCOLS.includes(p.protocol) ? p.protocol : 'openai',
      baseUrl: String(p.baseUrl || '').trim(),
      apiKey: String(p.apiKey || ''),
      model: String(p.model || '').trim(),
      capabilities: {
        modes: (Array.isArray(caps.modes) ? caps.modes : ['text']).filter((m) => IMAGE_MODES.includes(m)),
        maxInputs: num(caps.maxInputs, 4, 0, 16),
        sizes: (Array.isArray(caps.sizes) ? caps.sizes : []).map(String).filter((s) => /^\d{3,4}x\d{3,4}$/.test(s)).slice(0, 12),
      },
      extra: isObj(p.extra) ? p.extra : {},
    })
  }
  return out
}

const SECRETS = [['voice', 'openai', 'apiKey'], ['voice', 'httpApi', 'apiKey'], ['search', 'apiKey'], ['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken'], ['song', 'neteaseCookie'], ['bili', 'cookie'], ['bili', 'sessdata'], ['bili', 'biliJct'], ['bridge', 'token']]
// 扩展模块设置里的密码类字段（模块加载时登记）：['ext', 模块id, 字段]
const extraSecrets = new Map()
export function registerSecretField(path) { extraSecrets.set(path.join('\u0000'), path) }
const allSecrets = () => [...SECRETS, ...RETRIEVAL_SECRET_FIELDS.map(path=>path.split('.')), ...extraSecrets.values()]
const parentOf = (obj, path, create) => {
  let cur = obj
  for (const k of path.slice(0, -1)) {
    if (!isObj(cur[k])) { if (!create) return null; cur[k] = {} }
    cur = cur[k]
  }
  return cur
}
const getAt = (obj, path) => { const p = parentOf(obj, path, false); return p ? p[path.at(-1)] : undefined }
// 这些密钥在面板里显示结尾几位（「已保存（结尾 …a1b2）」），方便认出存的是哪一份；完整值不回传
const HINTED = [['bili', 'sessdata'], ['bili', 'biliJct']]
const HIDDEN_HEADER = '[已保存，原样保留]'
function hideHeaders(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'headers' && isObj(child)) {
      for (const name of Object.keys(child)) if (child[name] && !/^(content-type|accept|user-agent)$/i.test(name)) child[name] = HIDDEN_HEADER
    } else hideHeaders(child)
  }
}
function restoreHeaders(value, previous) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const [i, child] of value.entries()) restoreHeaders(child, child?.id ? previous?.find?.(p => p.id === child.id) : previous?.[i]); return }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'headers' && isObj(child)) {
      for (const name of Object.keys(child)) {
        if (child[name] === HIDDEN_HEADER) {
          if (previous?.headers?.[name] === undefined) throw new Error('请求头占位符没有对应的已保存值，请重新填写 ' + name)
          child[name] = previous.headers[name]
        } else if (child[name] === null) delete child[name]
      }
    } else restoreHeaders(child, previous?.[key])
  }
}

/** 从一串 Cookie 里取某个值（「SESSDATA=xxx; bili_jct=yyy」）。 */
export function cookieValue(raw, key) {
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim()
  }
  return ''
}

/**
 * B 站 Cookie 整理成两个值：粘了整串 / 带了「SESSDATA=」前缀的都认得；老配置只有整串的拆开。
 * 返回 {sessdata, biliJct, cookie}，cookie 是拼好给接口用的。
 */
export function splitBiliCookie({ sessdata = '', biliJct = '', cookie = '' } = {}) {
  const a = String(sessdata || '').trim()
  const b = String(biliJct || '').trim()
  // 框里粘的是「xxx=…」这种整串或带前缀的：从里面取；纯值原样用
  const isRaw = (v) => /(^|;\s*)(SESSDATA|bili_jct)=/.test(v)
  let s = isRaw(a) ? '' : a
  let j = isRaw(b) ? '' : b
  for (const v of [a, b]) {
    if (!isRaw(v)) continue
    s = cookieValue(v, 'SESSDATA') || s
    j = cookieValue(v, 'bili_jct') || j
  }
  if (!s && !j && cookie) {
    s = cookieValue(cookie, 'SESSDATA')
    j = cookieValue(cookie, 'bili_jct')
  }
  return { sessdata: s, biliJct: j, cookie: [s && `SESSDATA=${s}`, j && `bili_jct=${j}`].filter(Boolean).join('; ') }
}

const FILE = () => dataDir('config.json')

/** 在某次更新里新增、会替她公开发东西的功能。以后再加这类功能，把配置键名加到这里。 */
export const OPT_IN_ON_UPDATE = ['bili']

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  // 更新插件后新增的、会公开发东西的功能：老用户先关着，等他们自己在面板里打开（新安装照常默认开）
  if (raw && raw.setupDone) for (const k of OPT_IN_ON_UPDATE) if (raw[k] === undefined) raw[k] = { enabled: false }
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}

/** 给面板看的版本：密码 / token 不回传原文，只告诉有没有填。 */
export function publicConfig(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of HINTED) c[g][`${k}Hint`] = c[g][k] ? '…' + String(c[g][k]).slice(-4) : ''
  for (const path of allSecrets()) {
    const p = parentOf(c, path, false)
    if (!p) continue
    const k = path.at(-1)
    p[`${k}Set`] = Boolean(p[k])
    p[k] = ''
  }
  // 生图服务的密钥在数组里：同样只告诉面板有没有填
  for (const p of c.imageGen?.profiles || []) { p.apiKeySet = Boolean(p.apiKey); p.apiKey = '' }
  hideHeaders(c)
  return c
}

/** 面板保存时：没改的密码字段（空串）保留原值。 */
export function mergeFromPanel(current, incoming) {
  if (incoming?.stickers?.libraryScope !== undefined && !['account', 'chat'].includes(incoming.stickers.libraryScope)) throw new Error('表情图库范围只能是 account 或 chat')
  if(incoming?.retrieval?.roles!==undefined) {
    if(!isObj(incoming.retrieval.roles))throw new Error('检索模型配置必须是对象')
    for(const [role,value] of Object.entries(incoming.retrieval.roles)) {
      if(!['text','image','joint'].includes(role)||!isObj(value))throw new Error('检索角色配置不合法')
      for(const key of ['space','mapping','samples'])if(value[key]!==undefined&&!isObj(value[key]))throw new Error(`检索 ${role}.${key} 必须是合法 JSON 对象`)
      if(value.alignmentPairs!==undefined&&!Array.isArray(value.alignmentPairs))throw new Error('联合空间校验样本必须是 JSON 数组')
    }
  }
  if (incoming?.memory?.shareGroups !== undefined) {
    const groups=incoming.memory.shareGroups, normalized=normalizeShareGroups(groups)
    if(!Array.isArray(groups)||normalized.length!==groups.length||new Set(groups.map(g=>g.id)).size!==groups.length)throw new Error('共享组需要唯一 ID、至少两个有效聊天以及至少一种共享类别')
    for(let i=0;i<groups.length;i++)if(normalized[i].chats.length!==groups[i].chats.length||normalized[i].categories.length!==groups[i].categories.length)throw new Error('共享组包含重复或无效的聊天/类别')
  }
  // 面板错误必须留在草稿里，不能经归一化悄悄删掉一个服务后告诉用户保存成功。
  if (incoming?.imageGen?.profiles !== undefined) {
    if (!Array.isArray(incoming.imageGen.profiles)) throw new Error('生图服务必须是列表')
    const ids = new Set()
    for (const p of incoming.imageGen.profiles) {
      if (!p || !/^[A-Za-z0-9_-]{1,40}$/.test(p.id || '')) throw new Error('生图服务 ID 只能用 1–40 位字母、数字、下划线或连字符')
      if (ids.has(p.id)) throw new Error(`生图服务 ID 重复：${p.id}`)
      ids.add(p.id)
      if (!IMAGE_PROTOCOLS.includes(p.protocol)) throw new Error(`不支持的生图协议：${p.protocol}`)
      if (!isObj(p.extra ?? {})) throw new Error(`「${p.name || p.id}」的协议配置必须是 JSON 对象`)
      for (const key of ['workflow', 'bindings', 'submit', 'response', 'status', 'cancel', 'headers']) {
        if (p.extra?.[key] != null && !isObj(p.extra[key])) throw new Error(`「${p.name || p.id}」的 ${key} 必须是合法 JSON 对象`)
      }
    }
  }
  const next = deepMerge(current, incoming || {})
  if(incoming?.retrieval?.roles!==undefined)next.retrieval.roles=structuredClone(incoming.retrieval.roles)
  for (const path of allSecrets()) {
    const v = getAt(incoming || {}, path)
    const p = parentOf(next, path, v !== undefined)
    if (!p) continue
    const k = path.at(-1)
    if (v === null) p[k] = '' // 明确传 null = 清空
    else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
    delete p[`${k}Set`]
    delete p[`${k}Hint`]
  }
  // 生图服务列表整张替换；没改的密钥（空串）按服务 ID 保留原值，null = 清空
  if (Array.isArray(incoming?.imageGen?.profiles)) {
    const old = new Map((current.imageGen?.profiles || []).map((p) => [p.id, p]))
    next.imageGen.profiles = incoming.imageGen.profiles.map((p) => {
      const q = { ...p }
      if (q.apiKey === null) q.apiKey = ''
      else if (!q.apiKey) q.apiKey = old.get(q.id)?.apiKey || ''
      delete q.apiKeySet
      return q
    })
  }
  // 联动密钥只由插件生成，面板不能改
  next.bridge.token = current.bridge?.token || ''
  // B 站：只改了其中一个值时，另一个保留；整串粘进来的会在 normalize 里拆开
  if (incoming?.bili && (incoming.bili.sessdata || incoming.bili.biliJct)) next.bili.cookie = ''
  if (incoming?.group?.overrides) next.group.overrides = incoming.group.overrides
  // 按聊天选模型：两张表整张替换（deepMerge 会让删掉的条目又回来）
  if (incoming?.chatModels?.privates) next.chatModels.privates = incoming.chatModels.privates
  if (incoming?.chatModels?.groups) next.chatModels.groups = incoming.chatModels.groups
  if (incoming?.allow) next.allow = { ...current.allow, ...incoming.allow }
  restoreHeaders(next, current)
  const normalized=normalize(next)
  if(incoming?.retrieval && normalized.retrieval.enabled)runtimeRetrievalConfig(normalized.retrieval,'panel-validation.sqlite')
  return normalized
}
