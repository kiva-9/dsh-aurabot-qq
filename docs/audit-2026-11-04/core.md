# Aurabot 核心层只读审计

> 状态：**最终版（定稿）**。本文档为只读审计的最终交付，不再扩展新条目；保留现有发现、修复建议与回归矩阵。
> 审计范围：`src/host.js`（983 行）、`src/core/*.js`（config/modules/hooks/bridge/llm/net/store/logger/update/ids/redact/approval-notify/open-folder/text）
> 审计方式：静态阅读 + 对纯函数/配置合并/HTTP 读取行为做本地最小复现；未修改任何源码，未连接真实 QQ / SnowLuma / 模型服务。
> 行号基准：当前工作树 HEAD（package version `2.0.0-rc.9`）。

## 0. 结论摘要

核心层整体工程化程度不低：配置有默认值/归一化/密钥掩码，模块有代际、快照、异步清理、路由/工具回收，Hook 有规格、超时、快照和 epoch，bridge 的 HTTP token 使用了 `timingSafeEqual`，Net 的 SSRF 防护有 DNS pinning、重定向复核和 IPv6 特判。**但这套实现的薄弱点集中在“边界和并发”：面板 API 没有鉴权、配置保存是整份覆盖的 last-write-wins、配置损坏会被静默当成默认值、模块 setup 没有超时、若干异步取消只是 Promise.race、以及 host 983 行的上帝对象把这些问题放大。**

最需要先处理的三件事：

1. **面板 API 完全没有鉴权/CSRF 防护**：任何本地网页或本机进程都能改安全开关、拿 bridge token、执行模块工具；这是 P0。
2. **配置写入没有版本/锁，且损坏读取会静默回默认值**：多面板/快速开关会丢改动；一次坏 JSON 可能在下一次保存时覆盖掉所有配置和密钥；这是“会丢数据”。
3. **模块 setup 无超时、dispose 等待无界**：一个用户模块返回永不 resolve 的 Promise 就会让 `modulesReady` 永远为 false、登录缓冲丢失消息、插件退出卡住；这是“会静默失效”。

## 1. 架构与数据流（审计所需最小上下文）

- **装配顺序**（`src/host.js:60-478`）：`loadConfig()` → `createStorage()`（打不开则注册 `/aurabot/api` 的 503 前缀路由并提前返回）→ 人设服务 → `systemPrompt.variable` 注册 → SnowLuma/OneBot → `createHub` → 面板路由 → `createModules` → `createBridge` → `mods.boot()`（内置模块同步启动，用户模块异步加载/3 秒轮询）→ `bridge.refresh()` → watchdog（首 3 秒一次 + 30 秒 `ctx.interval`）。
- **消息数据流**：OneBot WS event → `onEvent`（登录/模块未就绪时进 `loginBuffer`，最多 200 条）→ `dispatchEvent` → `hub.onMessage` → DSH session/agent → `session/event` → `hub.deliver` → outbox（逐段落库、未确认不重发）→ OneBot HTTP/WS 发 QQ。
- **配置数据流**：`config.json` ← `readJson/writeJson`（临时文件 + rename）；`loadConfig → normalize(deepMerge(DEFAULTS, raw))`；面板 `/state` 返回 `publicConfig(cfg)`；面板 `/save` 走 `mergeFromPanel(cfg, body) → normalize → saveConfig → setConfig` 副作用（刷新 bridge、同步模块、危险命令失效等）。
- **模块数据流**：`createModules` 维护 `live/errors/routes/listeners`；用户模块每个版本先复制到 `modules/<id>/.aurabot-cache/<stamp>/` 再 import；`sync()` 按配置和 `stampOf` 启停；`stop()` 撤销路由/监听/定时器/工具并 `drainPending`。
- **Hook 数据流**：`api.on(event, fn)` 进 `listeners` → `hookRuntime.emit/claim/filter/filterSync` 按 phase/priority/模块 ID/注册顺序执行；每个异步 Hook 参数先 `snapshot()` 深拷，超时用 `Promise.race`。
- **桥接三通道**：同进程 `ctx.provide('aurabot', service)`；DSH 全局工具 `tools.register`；HTTP `/aurabot/api/open/*`（Bearer token，`timingSafeEqual`）。面板路由（非 `/open/*`）走另一套裸 `webServer.register`，没有复用 token 校验。
- **LLM 数据流**：`defaultModel`（cfg.model → DSH agentDefaultModel）/`roleModel`（role → global → DSH default）→ `askModel`（AbortController + deadline + `llm.stream()` 增量聚合 + usage 观察者）。
- **Net 数据流**：`fetchImage` → `createSearchHttp.read` → `resolvePublicUrl`（系统 DNS/DoH、地址类别检查、固定 IP lookup）→ 重定向逐跳再解析；本地文件仅在 `allowLocal === true` 时经 `readLocalBytes` 读取。

## 2. 问题清单（按 P0 → P3）

### P0（真实可利用 / 最高优先）

#### P0-1 面板 API 全部无鉴权、无 CSRF/Origin 校验，且多处 GET 有副作用

- **位置**：`src/host.js:383-392`（`route()` 直接 `ctx.webServer.register`，没有任何 auth）；`src/host.js:543-564`（`/save`）；`src/host.js:902-914`（token/开放接口）；`src/host.js:600-603`（SnowLuma 密码/重置）；`src/host.js:836-838`、`851-893`（模块 open/simulate/tool）；`src/host.js:951-972`（头像上传/同步）。
- **代码证据**：
  ```js
  const route = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: PREFIX + path,
    handler: (req, res) => answer(res, () => handler(req, res)),
  }), ...)
  ```
  `readBody()`（`host.js:349-356`）也不检查 `content-type`；`/save` 直接 `setConfig(mergeFromPanel(cfg, body))`（`:549`）。`/bridge/token/reset`（`:903`）会返回新 token；`/snowluma/password`（`:602`）返回明文控制台密码；`/snowluma/reset-password`（`:600`）、`/avatar/sync-qq`（`:965`）等 GET 会直接改状态。**模块路由同样没有鉴权**：所有 `api.route()` 都落到 `host.js:384-392` 的前缀 handler，再经 `modules.js:627-631` 的 `handle()` 仅检查“路由存在且模块在跑”，不检查调用者身份；即模块自己的 `/aurabot/api/ext/<id>/*` 和内置模块路由与核心面板路由处于同一无鉴权平面。
- **触发条件**：面板默认在 `127.0.0.1:<DSH_PORT>`；本机任意进程，或用户浏览器中任意网页用 `fetch`/`<img>` 访问该地址即可。示例链：
  ```bash
  curl -s -X POST http://127.0.0.1:<DSH_PORT>/aurabot/api/save \
    -H 'content-type: application/json' \
    -d '{"enabled":true,"dryRun":false,"ownerQQ":"<attacker_qq>"}'
  curl -s http://127.0.0.1:<DSH_PORT>/aurabot/api/bridge/token/reset
  ```
  随后可调 `/open/send`，或直接调 `/modules/tool` 执行模块工具。GET 侧 `<img src="http://127.0.0.1:<DSH_PORT>/aurabot/api/snowluma/reset-password">` 也可触发。
- **影响**：可关闭试运行、打开总开关、改 ownerQQ、读取/轮换 bridge token、读取 SnowLuma 密码、执行 owner 级模块工具、发 QQ 消息、写头像、启动/停止外部进程。属于**真实可利用**（默认 loopback 场景是本机浏览器 CSRF/本机进程；若 DSH Web 绑定到非 loopback，则变成远程可利用）。
- **修复建议**：面板路由统一接入 DSH `connection.admit`/认证会话，或启动时生成一次性 panel token 并校验 `Origin`/`Host`/`Content-Type`；所有有副作用的路由只允许 POST（或明确的 CSRF token），不要用 GET；`/bridge/token`、`/snowluma/password` 改为一次性、重新鉴权后显示；敏感操作单独二次确认。
- **置信度**：高
- **标签**：真实可利用（本机浏览器 CSRF / 非 loopback 远程）

#### P0-2 `/modules/tool` 与 `/modules/simulate` 默认以 owner/full 权限执行模块工具和命令

- **位置**：`src/host.js:842-848`（`simChat` 的默认 owner）；`src/host.js:851-877`（simulate 执行 `cmd.ext.run`）；`src/host.js:885-893`（tool 执行 `tool.execute`）。
- **代码证据**：
  ```js
  const owner = b.as !== 'other'
  const userId = owner ? cfg.ownerQQ : '10001'
  ...
  const level = owner && chat.kind === 'private' ? 'full' : 'social'
  ...
  const { result, sent } = await hub.capture(() => tool.execute(...))
  ```
  请求体不传 `as` 时默认就是主人私聊（`private:<ownerQQ>`）、`level='full'`；`/modules/tool` 会从 `mods.buildTools` 里找出任意工具并执行。`/modules/simulate` 对扩展命令直接 `cmd.ext.run`。
- **触发条件**：POST `/aurabot/api/modules/tool`，body 为 `{"name":"<任意已注册工具>","args":{...}}`；或 `/modules/simulate` 带一段 `/扩展命令`。无需 `as` 字段。与 P0-1 组合时无需任何面板登录。
- **影响**：owner-only 工具（发消息、管理、写数据等）被非 owner 场景执行；`hub.capture` 只是截获“发送动作”，不能阻止工具自身直接调用 `api.onebot`、写文件、改设置等副作用（代码注释 `host.js:841` 也承认这一点）。属于**真实可利用**的权限提升面。
- **修复建议**：默认 `as='other'`，只有显式选择“主人”且经过重新鉴权才允许 `level='full'`；工具/命令在模拟模式下应使用只读/沙箱能力集，或明确标记 `simulateSafe`；对 `tool.execute` 的 `api.core` 访问做能力裁剪。
- **置信度**：高
- **标签**：真实可利用（权限提升/副作用执行）

### P1（会丢数据 / 会静默失效 / 高风险）

#### P1-1 配置并发保存是整份覆盖的 last-write-wins，快速开关/双面板会丢改动

- **位置**：`src/host.js:543-549`；`src/core/config.js:591-626`；面板侧保存体是整份 draft（`client/client.js:3881-3886`，支持证据）。
- **代码证据**：`/save` 先 `const body = await readBody(req)`，然后 `setConfig(mergeFromPanel(cfg, body))`；`mergeFromPanel` 用 `deepMerge(current, incoming)` 把面板的整份配置递归合并回去。没有 revision/ETag/版本号，也没有串行化。
- **触发条件**：两个面板（或两个快速开关）基于同一份旧配置各自保存：A 改 `enabled=true`，B 改 `dryRun=false`；B 的后写会把 A 的 `enabled` 恢复为旧快照里的 `false`。本地复现：`normalize({botQQ:'1',ownerQQ:'2'})` 作为 current，两个 body 都来自同一份 `publicConfig`，依次 merge 后 `enabled=false, dryRun=false`。
- **影响**：设置被静默回滚、两个操作互相覆盖，最严重可把安全开关（`dryRun`/`enabled`/`security.dangerConfirm`）改回旧值；属于**会丢数据**。
- **修复建议**：`/save` 增加 `configRevision`（每次保存递增）并做 compare-and-swap，过期返回 409 让面板重载；或改成 PATCH 只接受发生变化的字段；进程内用串行队列/互斥；保存后返回新 revision。
- **置信度**：高
- **标签**：会丢数据

#### P1-2 配置 JSON 损坏或不可读时静默回默认值，下一次保存会覆盖原文件

- **位置**：`src/core/store.js:22-29`；`src/core/config.js:514-526`。
- **代码证据**：`readJson()` 对 `readFileSync`/`JSON.parse` 的任何错误直接 `return fallback`（`loadConfig` 调用时 fallback 是 `{}`），没有日志、错误标记、备份或恢复路径；`loadConfig()` 随后 `normalize({})` 得到全套 `DEFAULTS`；`saveConfig()` 直接 `writeJson(FILE(), c)`。
- **触发条件**：`config.json` 被手工改坏、写入中断、权限临时不可读、BOM/编码异常；启动后插件按默认配置运行，用户以为配置还在，随后在面板点一次保存即把坏文件覆盖成默认配置。
- **影响**：全部配置（QQ 号、白名单、模型、B 站/搜索密钥、SnowLuma 密码等）丢失；属于**会丢数据**。
- **修复建议**：区分 `ENOENT`（首次启动）与解析/权限错误；解析失败时把原文件备份为 `config.json.bad-<timestamp>`，进入只读降级模式并显示面板告警；在用户明确“重建配置”前禁止保存覆盖；每次成功保存保留上一版本。
- **置信度**：高
- **标签**：会丢数据

#### P1-3 `schemaVersion` 高于当前版本时在 `apply()` 最前面抛错，插件完全起不来且没有 503 降级

- **位置**：`src/core/config.js:210`；`src/host.js:63`（`let cfg = loadConfig()` 在 storage try 之外）；`src/host.js:94-115`（只有 storage 失败有降级）。
- **代码证据**：
  ```js
  if (Number(raw?.schemaVersion) > 2) throw new Error('配置版本高于当前插件，请先升级插件')
  ```
  该异常从 `loadConfig()` 直接冒泡出 `apply()`；此时还没有注册任何 `/aurabot/api` 路由，panel 只能看到插件加载失败/空白。
- **触发条件**：用户先安装新版（写 `schemaVersion: 3`）再降级，或手工改高版本；也可能是未来迁移脚本先写版本号、后升级代码。
- **影响**：插件彻底无法加载，无法通过面板查看原因或修复；属于**会静默失效**（对用户表现为“插件不见了”）。
- **修复建议**：把 `loadConfig()` 的异常纳入与 storage 相同的降级路径，注册只读 `/aurabot/api` 503/诊断路由并带 `configError`；先备份原文件；提供 `schemaVersion` 逐级迁移或明确的升级提示。
- **置信度**：高
- **标签**：会静默失效

#### P1-4 `normalize()` 直接把二级对象置 null 会崩溃（启动/保存均可能）

- **位置**：`src/core/config.js:211`（`deepMerge(DEFAULTS, raw)`），崩溃点如 `:217`（`c.model.vision`）、`:233`（`c.allow.private`）、`:237`（`c.conversation.seedHistory`）、`:241`（`c.imageGen.shape`）、`:289-290`（`c.bili`/`splitBiliCookie`）、`:393`（`c.bridge.dshTools`）；`c.voice.httpApi` 在 `:342`。
- **代码证据**：`deepMerge` 对 `over[k] === null` 的顶层键执行 `out[k] = null`（`:194-195`），但后续 `normalize` 假定这些键仍是对象。本地复现（当前代码）：`normalize({model:null})` → `Cannot read properties of null (reading 'vision')`；`{allow:null}`、`{conversation:null}`、`{bridge:null}`、`{bili:null}`、`{voice:{httpApi:null}}` 同样抛错。
- **触发条件**：手工编辑/旧版面板把某个对象字段写成 `null`；或插件/模块调用 `setConfig({...cfg, model:null})`。启动时 `loadConfig()` 抛错导致插件不可用；保存时 `/save` 返回 `ok:false`，用户改动无法保存。
- **影响**：配置无法加载或保存，属于**会静默失效**（启动）和阻断保存（运行时）。
- **修复建议**：对每个顶层 section 先 `c.model = isObj(c.model) ? c.model : {}`，再进入子字段归一化；或使用 JSON Schema 校验，`null` 表示“使用 section 默认”而不是直接赋 null；为所有 section 增加 null 回归测试。
- **置信度**：高
- **标签**：会静默失效

#### P1-5 `publicConfig()` 对未登记的模块密码、请求体里的密钥和 `extra` 自由字段会泄漏原文

- **位置**：`src/core/config.js:530-543`（只按 `allSecrets()` 掩码）；`:437-441`（`extraSecrets` 仅在 `registerSecretField()` 时存在）；`src/core/modules.js:355`（只有异步 `start()` 登记密码字段）；`:397-407`（`startSync()` 没有登记）；`src/core/config.js:85`（`voice.httpApi.body` 默认字段）、`:342-349`（normalize 只校验 method/bodyType/response/audioFormat/headers，不处理 body）；`src/core/config.js:427`（`imageGen.profiles[].extra` 原样保留）。
- **代码证据**：
  ```js
  for (const path of allSecrets()) { ... p[`${k}Set`] = Boolean(p[k]); p[k] = '' }
  for (const p of c.imageGen?.profiles || []) { p.apiKeySet = Boolean(p.apiKey); p.apiKey = '' }
  hideHeaders(c)
  ```
  `allSecrets()` 只包含硬编码 SECRETS、retrieval 路径、以及 `extraSecrets`。用户模块如果定义了 `settings: [{key:'apiKey', type:'password'}]`，只有在它真正 `start()` 后才会登记；模块被禁用、被安全模式跳过、或从未启动时，`ext[id].apiKey` 原样进入 `/state` 的 `config`。`voice.httpApi.body`（可含 `{apiKey}` 实际值）和 `imageGen.profiles[].extra`（ComfyUI workflow、提交 body 等）也不会被 `hideHeaders` 处理。
- **触发条件**：GET `/aurabot/api/state`（P0-1 下无需鉴权）；配置中存在禁用用户模块的 password 字段，或 `voice.httpApi.body`/`imageGen.profiles[].extra` 中存有真实密钥。
- **影响**：密钥对面板调用者可见；如果面板 API 无鉴权（P0-1），等价于本机密钥泄漏；属于**会泄漏**。
- **修复建议**：在扫描/加载配置阶段就登记所有模块的 `settings` 密码字段（不依赖启动），或持久化模块 schema 后统一生成 secret 路径；对 `voice.httpApi.body`、`extra` 做“敏感键名/模板变量”白名单或只回传占位符；`publicConfig` 只返回显式声明的安全字段。
- **置信度**：高（`ext` 路径）；中（body/extra 需具体配置）
- **标签**：会泄漏

#### P1-6 `/bridge/examples` 与 `/snowluma/password` 直接返回明文 token/控制台密码

- **位置**：`src/host.js:902-904`；`src/core/bridge.js:260`；`src/host.js:602-603`。
- **代码证据**：
  ```js
  route('/bridge/examples', async (req) => ({ ok: true, ...bridge.examples(String(query(req).base || 'http://127.0.0.1:端口')) }))
  ...
  examples: (base) => examples(base, getConfig().bridge.token)
  ...
  route('/snowluma/password', async () => ({ ok: true, password: snowluma.password(), auto: cfg.snowluma.passwordAuto }))
  ```
  `/bridge/token` 还知道用 `cfg.bridge.http` 控制是否返回（`:902`），但 `/bridge/examples` 没有这个检查；`bridge.examples()` 会把 `getConfig().bridge.token` 拼进 curl/python 示例。`/snowluma/password` 直接返回明文，`publicConfig` 里虽然被掩码，但这条路由绕过了它。
- **触发条件**：GET `/aurabot/api/bridge/examples` 或 `/aurabot/api/snowluma/password`；本机任意进程/同源面板可读，若 P0-1 的 CSRF/无鉴权成立则进一步放大。
- **影响**：bridge token 可用于 `/open/send`、`/open/think`、`/open/call`，等于把插件能力交给持有者；SnowLuma 控制台密码泄露会危及 QQ 网关管理。属于**真实可利用**（配合 P0-1）。
- **修复建议**：`/bridge/examples` 永远用 `<token>` 占位，只有 `/bridge/token` 在鉴权且 `bridge.http` 为真时返回一次；`/snowluma/password` 改为重新鉴权后一次性显示，或在面板只显示“已自动管理”。
- **置信度**：高
- **标签**：真实可利用（凭据泄漏）

#### P1-7 OneBot `restart()` 的旧 socket `onclose` 会在新连接后再次 `schedule()`，产生双连接/状态回跳

- **位置**：`src/onebot/client.js:133-136`（`onclose` 只要 `!stopped` 就 `setState('disconnected')` + `schedule()`），`:150-166`（`stop()` 立即 `ws?.close()` 并把 `ws=null`；`start()` 立即重连；`restart()` 是同步 `stop(); start()`）；调用点：`src/host.js:557`（保存连接设置）、`:628-631`（`/onebot/reconnect`）。
- **代码证据**：`stop()` 把 `stopped=true` 后立刻 `ws?.close()`，但 socket 的 `onclose` 是异步事件；`restart()` 马上 `start()` 把 `stopped=false`。旧 socket 的 `onclose` 稍后执行时看到 `!stopped` 为真，于是再 `schedule()` 一次；`connect()` 又会覆盖 `ws`，形成两个连接/重复事件。
- **触发条件**：WebSocket 已连接时保存 `httpUrl/wsUrl/httpToken/wsToken/dir/botQQ`，或调用 `/onebot/reconnect`。
- **影响**：重复接收 QQ 事件（可能重复回复/重复入库，平台消息 ID 去重只能兜住部分）、`onebotState` 在 `connected`/`disconnected` 间抖动（host 的 `loginOk` 会被清掉）、额外重连和资源占用。属于**会静默失效/可重复触发**。
- **修复建议**：给每个 socket 增加 generation，`onclose` 只在 `ws === sock && generation === current` 时处理；`stop()` 返回等待 close 的 Promise，`restart()` 先 await 再 start；`schedule()` 同样校验 generation；pending WS 调用在 stop 时统一 reject。
- **置信度**：高
- **标签**：会静默失效（连接状态/重复事件）

#### P1-8 `readBody()` 逐 chunk `s += c` 会破坏跨 chunk 的 UTF-8 多字节字符

- **位置**：`src/host.js:349-356`。
- **代码证据**：
  ```js
  for await (const c of req) {
    bytes += Buffer.byteLength(c)
    if (bytes > maxBytes) throw ...
    s += c
  }
  try { return JSON.parse(s || '{}') } ...
  ```
  `c` 是 Buffer 时，`s += c` 会对每个 chunk 单独 `toString('utf8')`；Node 的 chunk 边界可能落在汉字/emoji 的多字节序列中间，产生 U+FFFD。最小复现：把 `JSON.stringify({name:'大肥鱼测试'})` 在“大”的第一个字节后切成两个 chunk，`readBody` 解析出 `���肥鱼测试`。
- **触发条件**：任何包含中文/emoji 的请求体在 chunk 边界被切开（大配置、长人格文本、`/save` 的大 ext 设置最容易超过一个 chunk）。
- **影响**：字符串被悄悄替换为 U+FFFD，保存后不可恢复；属于**会丢数据**，且不报错。
- **修复建议**：收集 `Buffer` 数组后 `Buffer.concat(chunks).toString('utf8')`；或使用 `StringDecoder`；对 JSON 解析失败给出明确错误；补一个跨多字节边界的测试。
- **置信度**：高
- **标签**：会丢数据

#### P1-9 用户模块 `setup()` 没有超时，永不 resolve 会卡死 boot、登录缓冲和 dispose

- **位置**：`src/core/modules.js:365-372`（`rec.pending.add(setupFinished)` + `await setup`），`:328-330`（`drainPending` 的 `while (rec.pending.size) await Promise.allSettled(...)`），`:500-508`（boot 等待 `await sync()` 后才安装 3 秒轮询）；`src/host.js:412-413`（`booted.then` 才设置 `modulesReady=true`）。
- **代码证据**：`setup` 返回的 Promise 没有 `Promise.race`/`AbortSignal` 超时；`drainPending` 会一直等 `rec.pending`（含 `setupFinished`）清空；`stop()` 只 abort `rec.controller`，不会 reject setup Promise；`dispose()` 返回 `Promise.allSettled([...stopping])`，若 setup 永不结束则永不 settle。
- **触发条件**：用户模块（或未来某个异步内置模块）在 `setup` 中 `await` 一个永不完成的 Promise、网络请求无超时、写文件阻塞；模块作者写错一个 `await` 即可。
- **影响**：`modulesReady` 永远为 false → 登录缓冲最多 200 条后开始丢 QQ 事件；`/modules` 面板显示 running 但功能不可用；插件退出/热重载时 `mods.dispose()` 挂起，`storage.close` 永远不执行。属于**会静默失效**。
- **修复建议**：为每个模块 setup 增加 5–15 秒超时和 `AbortSignal`；超时 `stop(id)` 并写 `errors`；`drainPending` 加最大等待时间（如 30 秒）并在超时后强制清理；boot 不因单个模块 setup 阻塞 `modulesReady`（可用 `Promise.allSettled` 并分别记录）。
- **置信度**：高
- **标签**：会静默失效

#### P1-10 密钥“空串 = 保留、只有 null = 清空”，面板没有统一的清除入口，用户无法真正删除密钥

- **位置**：`src/core/config.js:593-601`（`v === undefined || v === ''` → 恢复 `current`），`:603-612`（生图 profile 空串按 id 保留旧 key）；面板只有 B 站有“清空”按钮（`client/client.js:3057`），`voice.openai.apiKey`、`search.apiKey`、`song.neteaseCookie`、`retrieval.*.apiKey` 等只有“留空保留”占位。
- **代码证据**：
  ```js
  if (v === null) p[k] = ''                 // 明确传 null = 清空
  else if (v === undefined || v === '') p[k] = getAt(current, path) ?? ''
  ```
  面板输入框被清空时天然发送 `''`，所以永远走“保留”分支；普通用户没有发送 `null` 的入口。
- **触发条件**：用户想删除/轮换一个已保存的 API Key/Cookie，把输入框清空后保存；或从其他客户端发 `''`。
- **影响**：旧密钥继续留在 config、继续被使用；用户以为已删除，属于**会静默失效**（安全上更糟：旧凭据无法通过 UI 撤销）。
- **修复建议**：在 `publicConfig` 回传每个密钥的 `xxxSet` 同时提供显式 `clearSecrets: ['voice.openai.apiKey', ...]` 或 `xxxClear:true`；面板为每个密钥提供“清空”按钮并发送 `null`；保存后返回实际清除的字段列表。
- **置信度**：高
- **标签**：会静默失效（无法撤销凭据）

### P2（高风险/性能/数据一致性）

#### P2-1 `/save` 和 `setConfig` 把模块同步错误吞掉，用户看到“保存好了”但功能没生效

- **位置**：`src/host.js:84`（`mods.sync().catch(() => {})`）；`src/host.js:561`（`await mods.sync().catch(() => {})`）。
- **代码证据**：`setConfig` 发现 modules/safeMode 变化时异步 `mods.sync()` 并吞掉拒绝；`/save` 显式再调一次并同样 `.catch(() => {})`，之后返回 `{message:'保存好了'}`。
- **触发条件**：保存模块开关/安全模式/`useBuiltin` 时，`sync()` 抛错（例如 `startUser` 的 `setConfig` 写盘失败、`loadLib` 的根目录读失败、内部异常）。
- **影响**：模块配置没有应用，面板却显示成功；属于**会静默失效**。
- **修复建议**：等待 `sync()` 结果并把 `{ok:false,message}` 返回面板；至少把错误写进 `status().errors` 并在提示中带出；`setConfig` 的异步 sync 应记录失败而非空 catch。
- **置信度**：中
- **标签**：会静默失效

#### P2-2 `OPT_IN_ON_UPDATE` 只覆盖“缺失键 + setupDone 为真”，老用户/旧开发版可能绕过默认关闭

- **位置**：`src/core/config.js:511-520`。
- **代码证据**：
  ```js
  if (raw && raw.setupDone) for (const k of OPT_IN_ON_UPDATE)
    if (raw[k] === undefined) raw[k] = { enabled: false }
  ```
- **触发条件**：老用户配置里 `setupDone` 为 `false`（没走完向导但已有 botQQ/ownerQQ），或旧开发版已经写入 `bili: { enabled: true }`；这两种情况都不会被强制关闭，新增的“会公开发东西”的功能保持开启。
- **影响**：违背 opt-in 安全默认，可能在用户不知情时公开发布内容；属于**会静默失效**（安全开关失效）。
- **修复建议**：不要以 `setupDone` 作为迁移门；用 `schemaVersion`/`configMigration` 记录“该功能是否已 opt-in”，对任何升级前的配置（无论 bili 键是否存在）先设 `enabled:false`，只在面板中由用户显式打开。
- **置信度**：中
- **标签**：会静默失效

#### P2-3 `group.overrides` 只校验 `isObj`，任意类型会在群消息决策时抛 TypeError

- **位置**：`src/core/config.js:618`（`next.group.overrides = incoming.group.overrides` 原样赋值）；`:253`（只 `if (!isObj(g.overrides)) g.overrides = {}`，不校验每个群的值）。
- **代码证据**：`policyFor()` 会 `{...g, ...o}` 展开单个群覆盖；`decideGroupReply` 对 `pol.wakeWords` 调 `.find`、`topicRelevance` 对 `interests` 做 `for...of`。保存 `{"group":{"overrides":{"123":{"wakeWords":5}}}}` 后，`decideGroupReply` 的 `(pol.wakeWords||[]).find` 会在数字上抛 TypeError。
- **触发条件**：面板或 `/save` 发送非法 overrides（类型错误、数组代替对象等）；无需特殊权限（结合 P0-1 更直接）。
- **影响**：该群消息处理抛错，可能让整个群回复链路失败；属于**会静默失效**。
- **修复建议**：为每个 override 复用全局群策略的 `normalize`；拒绝未知键/非法类型；`mergeFromPanel` 对 `group.overrides` 做 schema 校验并返回明确错误。
- **置信度**：高
- **标签**：会静默失效

#### P2-4 `normalize()` 对非法 `chatModels`/`crossChatHistory`/`imageGen.profiles` 静默丢弃，保存却报成功

- **位置**：`src/core/config.js:231`（`normalizeChatModels`）、`:238`（`crossChatHistory` 过滤）、`:355`/`:406-412`（非法 image profile `continue`）；`src/chat/chat-model.js:25-47`（坏条目当作没写）。
- **代码证据**：`normalizeImageProfiles` 对非法 id/重复 id 直接 `continue`；`normalizeChatModels.normalizeMap` 对无效 selection 不报错，直接丢；`crossChatHistory` 对格式不匹配的项 filter 掉。面板 `mergeFromPanel` 对 image profiles 有校验，但 `loadConfig`/其他 `setConfig` 路径和 `chatModels`/`crossChatHistory` 没有同等校验。
- **触发条件**：手工编辑配置、从旧版本导入、模块 `setConfig` 写入非法条目，或面板发送不合规的 chatModels/crossChatHistory。
- **影响**：用户看到“保存好了”，但某些条目/生图服务/共享记录消失；属于**会静默失效**。
- **修复建议**：在 `loadConfig` 和 `mergeFromPanel` 入口统一做 schema 校验；非法条目返回字段级错误而不是丢弃；保留 `raw` 原值到 `.bad` 备份。
- **置信度**：中
- **标签**：会静默失效

#### P2-5 `deepMerge` 让 `modules`/`ext` 等对象映射无法删除键，旧设置会一直“复活”

- **位置**：`src/core/config.js:591` 的 `deepMerge(current, incoming)`；`:618-621` 只对 `chatModels` 两张表做了整张替换，`modules`/`ext` 没有；`src/core/config.js:384-391` 只处理整个 `modules[id]`/`ext[id]` 为 null。
- **代码证据**：`deepMerge` 是递归合并，`incoming.ext[id]` 只带一个键时，`current.ext[id]` 的其他键仍保留；`incoming.modules` 为空对象不会清掉 `current.modules` 中的旧条目。本地复现：`normalize({modules:{x:{enabled:false}}})` + `mergeFromPanel(...,{modules:{}})` 仍返回 `{"x":{"enabled":false,"useBuiltin":false}}`；`ext.foo` 只传 `{a:9}` 时 `b:2` 仍在。
- **影响**：删除模块 fork 标记、重置模块设置、撤销某个 ext 配置项都做不到；旧密钥/旧开关可能持续生效；属于**会静默失效**（用户无法通过面板删除）。
- **修复建议**：采用 JSON Merge Patch 语义（`null` 删除键，对象替换而不是深合并），或对 `modules`/`ext`/`tabs` 显式整表替换；给“删除模块设置”加 API。
- **置信度**：高
- **标签**：会静默失效

#### P2-6 `loadLib()` 全量 import 所有 `src/**/*.js`、失败静默吞掉，且 `libCache.size` 让部分缓存永久化

- **位置**：`src/core/modules.js:34-49`；`:51-56`（`lib()` 只在调用时抛“没有这个内部文件”）。
- **代码证据**：`walk(SRC)` 递归收集所有 `.js`（包括 `src/host.js`、所有 core、所有 builtin module 文件），逐个 `await import`；`catch (error) {}` 不带日志；`if (libCache.size) return libCache` 在并发/部分失败时提前返回半成品。启动时一次加载全部内部源码，内存/启动成本与插件规模线性增长。
- **触发条件**：插件启动、某个内部文件有顶层异常/依赖缺失、两个调用同时进入 `loadLib`。
- **影响**：用户模块 `api.lib()` 在使用时才报“没有这个内部文件”，难以定位；一个文件 import 失败会导致依赖它的用户模块静默启动失败；属于**会静默失效**（且 boot 变慢）。
- **修复建议**：按 key 懒加载并缓存 Promise（`Map<key, Promise>`），失败记录具体文件/错误；启动时只预加载 `libKeys` 白名单或按需；不要静默 catch。
- **置信度**：中
- **标签**：会静默失效

#### P2-7 3 秒 `sync()` 每轮 stat 整个模块目录；模块在自身目录写文件会每 3 秒无限重载

- **位置**：`src/core/modules.js:76-81`（`stampOf` 遍历 `filesOf` 所有文件并 `statSync`）、`:507`（3 秒 interval）、`:539`（`changed = ... seen.stamp !== stampOf(u.dir)`）。
- **代码证据**：`filesOf` 不区分源码和运行数据；模块若把缓存/日志/用户素材写进自己的 `modules/<id>/`，`stampOf` 的 mtime 每次都变，`sync` 判定 `changed`，`startUser` 复制快照并重启模块；每 3 秒循环。
- **触发条件**：用户模块在模块目录内写数据（常见错误；API 文档建议 `api.dataDir` 但未强制）；或模块内有大量文件/大目录。
- **影响**：CPU/磁盘抖动、模块状态反复丢失、定时任务重启；属于**会静默失效**。
- **修复建议**：只监控源码扩展名（`.js/.mjs/.json/.css` 等）并排除 `data/`、`out/`、`logs/`；或在模块目录写标记文件排除；给 stamp 缓存并在同一 mtime/size 下不重启；轮询周期改为可配置或 fs.watch。
- **置信度**：高
- **标签**：会静默失效（性能/状态）

#### P2-8 Hook 超时只是 `Promise.race`，底层 Promise 和参数快照不会被取消/回收

- **位置**：`src/core/hooks.js:67-78`。
- **代码证据**：
  ```js
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(...) }, ...) })
  const result = await Promise.race([Promise.resolve().then(() => item.fn(...)), timeout])
  ...
  } finally { clearTimeout(timer); controller.abort(); record(...) }
  ```
  `item.fn` 返回的 Promise 不会被 await 或 dispose；如果模块不监听 `signal`，定时器触发后该 Promise 仍持有参数快照（`snapshot` 深拷贝）、闭包和可能的网络/文件句柄；超时后模块迟到的副作用仍会执行。
- **触发条件**：任意 Hook 返回永不 resolve 的 Promise，或忽略 `signal` 的长任务。
- **影响**：内存泄漏/事件循环残留；超时后仍可能发消息、写文件、计费；属于**会静默失效**（超时语义不完整）。
- **修复建议**：文档明确“超时只放弃等待，不终止代码”；为 Hook 提供 `AbortSignal` 并强制模块检查；对超时 Hook 记录并禁用该模块的相应 Hook（或降低权重）；不要无限保留快照（限制大小/深度）。
- **置信度**：高
- **标签**：会静默失效（资源泄漏）

#### P2-9 `watchdog()` 没有重入锁，30 秒 interval 与慢速 `snowluma.*` 调用可重叠

- **位置**：`src/host.js:439-461`；`src/snowluma/manager.js:226-298`（`start()` 内 `running/waitPortFree` 等最长可等 20–30 秒）。
- **代码证据**：`safe(fn)`（`host.js:460`）只是 `Promise.resolve().then(fn).catch`，没有 `busy` 标志；`ctx.interval(safe(watchdog), 30_000)` 每 30 秒固定触发。一次 `snowluma.running()`/`snowluma.start()`/`attachBot()` 超过 30 秒时，下一轮会并发进入；`start()` 没有“正在启动”的互斥，两个调用都可能通过 `running()` 检查并各自 `spawn`。
- **触发条件**：SnowLuma 启动慢、端口等待、WebUI 响应慢、OneBot attach 慢。
- **影响**：重复启动 SnowLuma 子进程/重复注入、日志混乱、端口冲突；属于**会静默失效**。
- **修复建议**：`watchdog` 加 `let running=false` 的互斥和超时；`snowluma.start` 用内部 Promise 锁；`hostDisposed` 在每次 await 后检查（见 P2-15）。
- **置信度**：中
- **标签**：会静默失效（进程/连接）

#### P2-10 `/modules/open` 的 `id` 未做路径边界检查，`../` 可逃出模块目录并创建任意目录

- **位置**：`src/host.js:836-838`；`src/core/open-folder.js:4-13`。
- **代码证据**：
  ```js
  route('/modules/open', async (req) => {
    const id = String(query(req).id || '')
    return openFolder(id ? join(mods.dir(), id) : mods.dir())
  })
  ```
  `path.join('/data/modules', '../../../../tmp/aurabot-poc')` 归一化为 `/tmp/aurabot-poc`；`openFolder()` 第一行 `mkdirSync(dir, { recursive: true })` 会创建它，然后 `open`/`explorer` 打开。没有 `resolve` + `startsWith(mods.dir()+sep)` 校验。
- **触发条件**：GET `/aurabot/api/modules/open?id=../../../../tmp/aurabot-poc`（结合 P0-1 无需鉴权）；Windows 上 `..\..\` 类似。
- **影响**：任意可写目录被创建/在桌面打开（钓鱼/写入落点），属于**真实可利用**的路径穿越（权限仅限插件进程用户）。
- **修复建议**：`const base=resolve(mods.dir()); const target=resolve(base,id); if(target!==base && !target.startsWith(base+sep)) return {ok:false}`；先校验再 `mkdirSync`；只允许已存在的模块目录。
- **置信度**：高
- **标签**：真实可利用（路径穿越/任意目录创建）

#### P2-11 默认 `readBody` 43 MB、`/song/import` 用 `readRaw` 读 1 GB，且都没有请求超时/内容类型限制

- **位置**：`src/host.js:349`（默认 `43 * 1024 * 1024`）、`:359-368`（`readRaw` 无分块上限，最终 `Buffer.concat`）；`src/modules/song/index.js:103-110`（`http.raw(req, 1024*1024*1024)`）。
- **代码证据**：`readBody`/`readRaw` 都是 `for await` 累积全部内容后一次性 `JSON.parse`/`Buffer.concat`；没有 `Content-Length` 预检（`readRaw` 有按块计数）、没有读超时、没有 `content-type` 校验。
- **触发条件**：并发向 `/save`、`/persona/save`、`/avatar/upload`、`/song/import` 等发送大请求；恶意网页/本机进程也可。
- **影响**：堆内存膨胀/GC 停顿/进程 OOM；备份/插件主进程可能与 DSH 同进程，影响整个宿主；属于**真实可利用**的 DoS 面（面板无鉴权时更直接）。
- **修复建议**：为每个路由设置合理上限（配置保存 1–2 MB、头像 8 MB、歌曲 100 MB 且流式落盘）；先检查 `Content-Length`；加读取超时；拒绝非 `application/json`（上传路由除外）；`readRaw` 直接写临时文件而非整块内存。
- **置信度**：高
- **标签**：真实可利用（DoS）/资源

#### P2-12 `writeJson` 未收紧文件权限，config.json 里的明文密钥默认可能为 0644

- **位置**：`src/core/store.js:17-20`（`ensureDir` 默认 mkdir 模式）、`:32-36`（`writeFileSync` 默认 0o666 & umask）。
- **代码证据**：`writeFileSync(tmp, ...)` 没有 `{mode:0o600}`；在常见 `umask 022` 下临时/最终文件为 0644。`config.json` 保存 `snowluma.webuiPassword`、`bridge.token`、B 站 Cookie、搜索/语音 API key 等。
- **触发条件**：多用户 macOS/Linux 机器，或用户家目录/上级目录允许其他用户遍历。
- **影响**：同机其他用户可读取插件凭据；属于**会泄漏**（实际可利用性取决于目录权限/umask，置信度中）。
- **修复建议**：`ensureDir` 对数据目录用 `0o700`；`writeFileSync(tmp, ..., {mode:0o600})` 后 `chmod`；启动时检查并修正已有 `config.json` 权限；Windows 使用 ACL。
- **置信度**：中
- **标签**：会泄漏（取决于 umask/目录）

#### P2-13 `bridge.refresh()` 不等待旧工具的异步 disposer 就注册新工具，存在同名工具刷新竞态

- **位置**：`src/core/bridge.js:189-217`。
- **代码证据**：`for (const off of toolOffs) { const value = off(); if (thenable) retiringTools.add(...) }` 之后立刻 `toolOffs=[]` 并 `tools.register(t)`；`retiringTools` 只在 `dispose()` 里 `Promise.allSettled` 等待，`refresh()` 本身不等旧 disposer settle。如果 DSH 的 `tools.register` disposer 异步按名称/闭包删除，旧 disposer 可能在新工具注册后才完成并删掉新工具。
- **触发条件**：配置连续切换 `bridge.dshTools`、模块快速热重载并调用 `api.dshTool`，或两次 `bridge.refresh()` 相邻发生。
- **影响**：联动工具偶尔消失/被旧实例删除，`deniedTools()` 不正确；属于**会静默失效**（待验证 DSH disposer 的确切语义）。
- **修复建议**：`refresh` 串行化（`refreshing` Promise 链），先 `await Promise.allSettled([...retiringTools])` 再注册；给每次 refresh 加 generation，旧 disposer 完成时只处理自己代际。
- **置信度**：中（“旧 disposer 是否按名称删除”**待验证**）
- **标签**：会静默失效（工具注册）

#### P2-14 登录核验期间 `loginBuffer` 硬上限 200 条，超出直接丢事件且每个都打 warn

- **位置**：`src/host.js:228-235`。
- **代码证据**：
  ```js
  if (loginBuffer.length >= 200) {
    log.warn('登录核验期间事件缓冲已满，请检查网关；超出事件未接收')
    return
  }
  loginBuffer.push(ev)
  ```
  没有按聊天/事件类型分级、没有溢出计数/指标，也没有暂停网关或向用户提示“会漏消息”。
- **触发条件**：模块 boot 慢（P1-9）、`checkLogin`/`confirmLogin` 慢，或机器人在高活跃群中启动。
- **影响**：登录窗口内的消息静默丢失，用户只看到机器人没回；属于**会静默失效**。
- **修复建议**：按 chat 限制/落库缓冲；返回溢出统计到 `/state`；把 `modulesReady` 等待时间纳入健康检查；对高活跃场景使用持久化 inbox 而不是内存数组。
- **置信度**：高
- **标签**：会静默失效（丢消息）

#### P2-15 `dispose` 与在途 `watchdog`/延迟任务竞态：销毁后仍可能启动 OneBot/SnowLuma

- **位置**：`src/host.js:439-461`（watchdog 无 `hostDisposed` 检查）、`:464-477`（cleanup 先设 `hostDisposed`，再 `mods/hub` 停、`onebot.stop()`）；`:558`（`setTimeout(safe(watchdog),100)` 未被跟踪）。
- **代码证据**：`watchdog` 在 `await snowluma.running()`/`snowluma.start()`/`attachBot()` 后没有 `if (hostDisposed) return`；cleanup 设置 `hostDisposed=true` 并 `onebot.stop()`/`snowluma.dispose()`，但已进入 await 的 watchdog 恢复后会执行 `onebot.start()` 或 `snowluma.start()`，重新建立连接/子进程。
- **触发条件**：插件卸载/热重载恰好发生在 watchdog 的 SnowLuma 检测/启动/attach 期间，或 `/save` 打开开关后的 100ms 延迟 watchdog 期间。
- **影响**：插件退出后残留 WebSocket/子进程/定时任务；下一次加载可能与旧连接冲突；属于**会静默失效**（生命周期泄漏）。
- **修复建议**：watchdog 每次 await 后检查 `hostDisposed`；cleanup 先 abort watchdog 的 AbortController 并等待在途 Promise；延迟 watchdog 保存 timer 并在 cleanup 清除；SnowLuma `start/attach` 也接受 `hostDisposed` gate。
- **置信度**：中
- **标签**：会静默失效（生命周期泄漏）

#### P2-16 `/state` 是 5 秒轮询的全量聚合接口，重复做网络探测 + 全配置 structuredClone，容易拖慢消息链路

- **位置**：`src/host.js:503-539`（`overview()`）、`:541`（`/state`）；`src/host.js:505`（`snowluma.running()`）、`:520`（`consented()` → `snowluma.agreements()`）、`:507-510`（`onebot.call('get_login_info', 5000ms)`）、`:518`（`publicConfig(cfg)` 全量克隆）；`client/client.js:3866`（面板每 5 秒 `get('/state')`）。
- **代码证据**：每次 `/state` 都重新 `snowluma.detect()`、`await snowluma.running()`、可能 `await snowluma.agreements()`、可能 `await onebot.call(...)`，然后 `publicConfig(structuredClone(cfg))` + `hub.stats()` + `hub.sessions()` + `personas.compat.list()` + `mods.status()`（后者还会 `scanUser()`，安全模式下 `scanUser()` 调两次，`modules.js:635`）。没有缓存、ETag、条件请求或字段选择。
- **触发条件**：面板保持打开（5 秒一次）；SnowLuma/OneBot 慢或掉线时，`running/agreements/get_login_info` 把每个 `/state` 拖长；`ext` 含大量模块设置时 `structuredClone`/JSON.stringify 放大 CPU。
- **影响**：与 OneBot 心跳、消息处理同进程，长 `/state` 会占用事件循环/并发请求堆积；面板轮询可能叠加未完成请求（浏览器 5 秒发一次，慢响应会重叠），属于**会静默失效**（延迟/超时）。
- **修复建议**：拆分 `/state` 为“轻量状态 + 按需详情”；对 SnowLuma 探测和 `get_login_info` 做 10–30 秒 TTL 缓存/后台采样；`publicConfig` 按页面需要的 section 返回；面板改为条件轮询（无变化 304/长轮询/SSE）；`mods.status()` 缓存 scan 结果。
- **置信度**：高（代码事实）；影响取决于部署/配置大小
- **标签**：会静默失效（性能/事件循环）

### P3（中低风险/可维护性/待验证）

#### P3-1 `startSync()` 不登记内置模块的 password 设置，内置密码字段会从 publicConfig 泄漏

- **位置**：`src/core/modules.js:355`（仅异步 `start()` 注册 `registerSecretField`） vs `:397-407`（`startSync()` 没有这段）。
- **代码证据**：当前内置模块没有 `settings: [{type:'password'}]`，所以暂未触发；但一旦新增内置密码设置，`publicConfig()` 的 `extraSecrets` 不含该路径，`/state` 会回传原文。用户模块在启动前被禁用时同理（见 P1-5）。
- **触发条件**：内置模块新增密码设置，或用户模块被禁用/安全模式跳过。
- **影响**：面板配置响应泄漏密码；属于**会泄漏**（潜在）。
- **修复建议**：把 `registerSecretField` 提到 `checkDef`/`status`/`boot` 的公共扫描路径，不只依赖 `start`。
- **置信度**：中（当前无内置密码字段）
- **标签**：会泄漏（潜在）

#### P3-2 `panelSource()` 用 `file.startsWith(u.dir)` 做路径边界，前缀相同的兄弟目录可绕过

- **位置**：`src/core/modules.js:688-695`。
- **代码证据**：`const file = typeof rec.def.panel === 'string' ? resolve(u.dir, rec.def.panel) : join(u.dir,'panel.js'); if (!file.startsWith(u.dir)) return null`。若 `u.dir=/.../modules/foo`，`resolve(u.dir, '../foo-bar/panel.js')` = `/.../modules/foo-bar/panel.js`，`startsWith('/.../modules/foo')` 为 true，读取兄弟目录文件并作为 JS 返回面板。
- **触发条件**：用户模块的 `panel` 字段使用 `../`（模块作者可控；模块本身就是受信任代码，但边界错误会放大供应链/误配置影响）。
- **影响**：模块面板可读取任意同前缀目录里的文件内容并以 `text/javascript` 返回；属于**待验证/低危**（模块已能执行代码）。
- **修复建议**：`const base=resolve(u.dir); const file=resolve(base, ...); if (file!==base && !file.startsWith(base+sep)) return null`；对符号链接 `realpath` 再校验。
- **置信度**：高（逻辑）；影响有限
- **标签**：待验证/路径边界

#### P3-3 `rewriteImports()` 不处理 `export ... from`/双引号/多文件同名，`fork()` 可能复制出坏模块

- **位置**：`src/core/modules.js:110-148`（regex 只匹配 `import` 形式，`rewriteImports` 不处理 `export {x} from`）；`:716-728`（`own.set(f, f.split('/').pop())` 让不同目录同名文件互相覆盖；替换只 split 单引号 spec）。
- **代码证据**：`fork()` 把所有 `b.files` 平铺到模块根，按 basename 建 Map；两个 `bili/api.js`/`other/api.js` 会冲突。`rewriteImports` 的 `import` 正则不覆盖 `export { ... } from './x.js'`，复制后相对路径仍指向原插件目录。
- **触发条件**：`/modules/fork` 某个内置模块，未来内置模块使用这些语法/同名文件。
- **影响**：复制出来的模块加载失败或引用旧源码，用户以为“复制成功”；属于**会静默失效**。
- **修复建议**：使用真正 parser/`es-module-lexer` 重写 import/export；保留子目录结构或对 basename 冲突报错；fork 后执行一次 `checkDef`/import smoke test。
- **置信度**：中（当前内置模块不一定触发）
- **标签**：会静默失效（潜在）

#### P3-4 未知 Hook 事件名被默默当作 observe 接受，拼写错误不会报错

- **位置**：`src/core/modules.js:249-254`（`api.on` 用 `hookSpec(event)`，没有校验 event 是否在 `HOOK_SPECS`）；`src/core/hooks.js:34-35`（`hookSpec(event) = HOOK_SPECS[event] || observation`）。
- **代码证据**：`api.on('replyy', fn)` 的 `hookSpec` 返回 observe 规格，注册成功；`emit/claim/filter` 永远不会用这个事件，模块作者只会在诊断里看到 0 调用。
- **触发条件**：模块事件名拼错、插件升级改名。
- **影响**：模块功能静默不生效，用户/开发者没有错误提示；属于**会静默失效**。
- **修复建议**：`if (!(event in HOOK_SPECS)) throw new Error('未知 Hook 事件 ...')`；对核心 `@core` 保留显式白名单。
- **置信度**：高
- **标签**：会静默失效

#### P3-5 `secrets()` 把所有 header 值（含 `application/json`）登记为全局敏感词，日志会被过度脱敏

- **位置**：`src/host.js:70-72`；`src/core/redact.js:19-27`。
- **代码证据**：`visit` 在 `headers=true` 时对每个 header 字符串执行 `registerSecret(v)`；`voice.httpApi.headers: {'content-type':'application/json'}` 会把 `application/json` 加入 `known`，之后 `redact('content-type: application/json')` 返回 `content-type: ***`。任何日志里出现这个常见字符串都会被替换。
- **触发条件**：配置了任意 `headers`（默认 `voice.httpApi.headers` 为空；用户填自定义 header 时常见），或 `secrets()` 扫过 `imageGen.profiles.extra.headers`。
- **影响**：日志排障信息被破坏、敏感词误报；属于**会静默失效**（可观测性）。
- **修复建议**：headers 只登记名称匹配 `authorization|cookie|token|key|secret` 的值，跳过 content-type/accept/user-agent；`registerSecret` 增加最小长度/熵判断；不要把通配 header 值当地址级 secret。
- **置信度**：高
- **标签**：会静默失效（日志）

#### P3-6 `canSeeImages()` 只看全局模型，忽略 `roles.vision`/`roles.stickerDecision` 的独立视觉模型

- **位置**：`src/core/llm.js:86-93`（`canSeeImages` 用 `defaultModel(dsh,cfg)`）；调用示例 `src/stickers/analysis.js:34`（用 `getConfig()` 判断）。
- **代码证据**：`canSeeImages` 在 `cfg.model.vision==='auto'` 时只解析 `defaultModel`；但 `askModel` 的 `roleModel` 允许 `roles.vision`/`stickerDecision` 单独指定模型。用户在面板把表情决策模型设为视觉模型、全局模型设为纯文本时，`stickers/analysis` 会先 `fail('NO_VISION')`，根本不会让角色模型接手。
- **触发条件**：配置了独立视觉角色模型，而全局模型不支持图片。
- **影响**：表情/参考图分析静默失败并保留待审；属于**会静默失效**。
- **修复建议**：`canSeeImages(dsh,cfg,role)` 按实际使用的 role 解析模型；或在调用点传 `role:'stickerDecision'`；统一 `modelVision` 目标。
- **置信度**：中
- **标签**：会静默失效

#### P3-7 `api.ask` 不合并模块的 `rec.controller.signal`，模块停用后模型调用仍在跑

- **位置**：`src/core/modules.js:296`（`ask: guard('模型调用', (opts) => core.ask(...))`）；`:238-241` 的 `prepareContext` 则专门合并 `rec.controller.signal`。
- **代码证据**：`api.ask` 只把 opts 传给 `core.ask`，没有 `signal: rec.controller.signal`；`stop()` 只 abort controller，无法取消进行中的 LLM 流。`askModel` 的 `control.dispose` 只在调用结束时执行。
- **触发条件**：模块在 `api.ask` 期间被禁用/重载，或插件 dispose。
- **影响**：旧模块的模型调用继续消耗 token、可能回调旧闭包/发送消息；属于**会静默失效**（成本/生命周期）。
- **修复建议**：`core.ask` 接受 `signal`，`api.ask` 用 `AbortSignal.any([opts.signal, rec.controller.signal])`；`stop` 时应触发 abort 并等待进行中的调用结束（或明确不等待但记录）。
- **置信度**：高
- **标签**：会静默失效（成本/生命周期）

#### P3-8 host 返回对象契约不统一，getter 只在直接属性访问时生效；另有死导入/上帝对象

- **位置**：`src/host.js:114`（storage 失败 `ready: Promise.resolve({ok:false,message})`）vs `src/host.js:977-982`（正常 `ready: booted`，成功 resolve `undefined`）；getter `get stickers()/mood()/memory()`（`:979-981`）；未使用的 `spawn` 导入（`:15`）；`apply` 主体约 900 行、60+ 路由集中在 `:480-973`。
- **代码证据**：`ready` 在两种路径类型不同；getter 在 `{...host}`/序列化时会被求值并固化，热重载后外部持有者不会自动更新；`deepMerge` 在 `config.js:190-198` 和 `modules.js:787-793` 有两套不同语义实现。
- **触发条件**：其他 DSH 插件使用 `await ctx.get('aurabot').ready`、展开 host 对象或长期持有 getter 结果。
- **影响**：调用方误判成功/失败、热重载后拿到旧模块导出；维护成本高；属于**低危/待验证**（取决于宿主如何消费 host 返回值）。
- **修复建议**：定义 `AurabotHost` 类型并统一 `ready` 为 `Promise<{ok:boolean,message?}>`；返回只读快照或明确 `get` API 而不是 accessor；把面板路由/OneBot 生命周期/配置服务拆出；删除死导入。
- **置信度**：高（代码事实）/ 中（影响）
- **标签**：待验证（契约/可维护性）

#### P3-9 `updateCommand()` 硬编码 Windows/PowerShell 路径，在 macOS/Linux 上更新按钮给出的命令不可用

- **位置**：`src/core/update.js:37-39`。
- **代码证据**：返回值固定 `& "$env:LOCALAPPDATA\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin ...`；仓库/当前审计环境是 macOS，`package.json` 也未限制 Windows。
- **触发条件**：macOS/Linux 用户点击“更新”并复制命令。
- **影响**：更新失败/用户困惑；属于**会静默失效**（平台）。
- **修复建议**：按 `process.platform` 生成 Windows/POSIX 命令，或改为显示插件安装文档链接；至少标注“仅 Windows”。
- **置信度**：高
- **标签**：会静默失效（平台）

#### P3-10 `net.js` SSRF 结论：未发现可利用绕过；残余是“可信网关本地路径”和 any-port 设计

- **位置**：`src/core/net.js:7-8`（`assertPublicUrl`/`publicHttp` 均 `allowAnyPort:true`）、`:40-69`（`segmentBytes` 对 `onebot.get_image` 返回的 `info.file` 使用 `allowLocal: o.allowLocal !== false`）、`:91-95`（`fetchImage` 本地读取）；`src/search/net.js:22-37`（IPv4/IPv6 私有/保留地址）、`:160-175`（系统 DNS → fake-IP 时 DoH，pinned lookup）。
- **代码证据/验证**：本地验证了 `http://[::ffff:127.0.0.1]/`、`http://[::ffff:7f00:1]/`、十进制/八进制 IPv4（WHATWG URL 归一化为 127.0.0.1）、`localhost.`、`127.0.0.1.nip.io` 等路径都会被 `isPublicAddress` 或 host 规则拒绝；重定向在 `read()` 里逐跳 `resolvePublicUrl`，HTTPS 降级被禁止；响应有 `maxBytes`/超时/压缩拒绝。**未发现可直接绕过的 SSRF**。
- **残余风险**：`allowAnyPort:true` 允许访问公网任意端口（可做公网端口探测/打内部服务 iff 公网可达）；`segmentBytes` 信任 OneBot `get_image` 返回的本地路径；如果网关被替换/恶意，可让插件读取本机任意文件（后续多作为视觉输入，不等于回传给攻击者）。属于**低危/设计边界**。
- **修复建议**：对 OneBot 媒体单独限制在 `dataDir`/已知缓存目录；`allowAnyPort` 改为白名单端口，除非明确需要；为本地路径读取增加 `realpath` + 根目录校验；保留现有 DoH/pinned lookup 测试。
- **置信度**：高（代码路径）；中（网关信任模型）
- **标签**：待验证/设计边界

#### P3-11 定时器/监听器清单中仍有未跟踪项：`listModels` 3 秒 setTimeout、bridge 的 `mods.listen`、SnowLuma 子进程 stdout/stderr 监听

- **位置**：`src/host.js:265`（`setTimeout(() => { listModels().catch(() => {}) }, 3000).unref?.()` 没有保存/清理）；`src/core/bridge.js:250-254`（`mods.listen('activity',...)`/`mods.listen('open/event',...)` 的返回 off 被丢弃，`dispose` 只 `stopped=true`，不解除监听）；`src/snowluma/manager.js:275-277`（`child.stdout?.on('data', relay)` / `stderr`，`dispose()` 只 `child?.kill()`，不 `removeListener`）。
- **代码证据**：`initialWatchdog` 有保存并清理（`host.js:462/472`）；`ctx.interval` 由 effect 清理；`mods` 的 `watching` 有 `clearInterval`；但 `listModels` 的 setTimeout 不在任何 record/effect 中，bridge 两个 `mods.listen` 也没有 off。`SnowLuma` 的 `relay` 闭包持有 `log`/`lowIntegrity` 直到子进程退出。
- **触发条件**：插件在启动后 3 秒内 dispose/重载；bridge 单独 `dispose()`（热重载/测试）；SnowLuma 子进程存活但插件反复重载。
- **影响**：dispose 后仍有一次迟到的 `listModels`（可能访问已卸载的 `ctx.llm`）、旧 bridge 继续记录 activity 到旧 ring、重复加载时旧 stdout/stderr 监听叠加；属于**会静默失效**（生命周期/内存）。
- **修复建议**：所有 `setTimeout`/`setInterval` 通过 `ctx.effect` 或 `AbortController` 登记；`bridge.dispose` 保存并调用 `mods.listen` 返回的 off；SnowLuma `dispose` 移除 `data`/`exit`/`error` 监听后再 kill，并等待退出。
- **置信度**：高（代码事实）
- **标签**：会静默失效（生命周期）

#### P3-12 `dispose` 收尾 effect 注册早于全部路由 effect，`storage.close()` 的时序依赖宿主 effect 处置顺序

- **位置**：`src/host.js:464-478`（收尾 effect）；路由在 `:481-973` 才注册（`route()` 每个路由一个 effect）；`storage?.close()` 在收尾 effect 的 `finally`（`:477`）。
- **代码证据**：主清理 effect 先注册，路由 effect 后注册；如果宿主按 FIFO 处置 effect，收尾会先执行并关闭 storage，随后路由 disposer 才移除 handler，此时在途 `/state`/`/save` 可能访问已关闭的 SQLite；如果宿主按 LIFO（fake-dsh 的 `dispose` 是 `disposers.reverse()`，`test/helpers/fake-dsh.js:227` 可佐证），则路由先移除、问题较小。`mods.dispose()`/`hub.dispose()`/`bridge.dispose()` 内部还有异步清理，收尾 effect 只等待它们，不等待各 route effect。
- **触发条件**：插件卸载/热重载时仍有面板请求在途；宿主 effect 处置顺序与预期相反。
- **影响**：收尾阶段抛 “database is closed” 或请求得到 400/500；属于**待验证**的低概率生命周期问题。
- **修复建议**：把收尾统一挂在一个 `dispose` 生命周期（或在收尾 effect 里先 `hostDisposed = true` 并让所有 route handler 在入口检查 `hostDisposed` 返回 503），不要假设 effect 顺序；`storage.close` 放到 `Promise.allSettled([...mods/hub/bridge])` 之后且所有路由 handler 均会 gate。
- **置信度**：中（顺序依赖**待验证**）
- **标签**：待验证（dispose 顺序）

## 3. 专项结论（只写结论，细节见上面对应条目）

### 3.1 配置系统

- **DEFAULTS/normalize** 的字段覆盖面广，但 `deepMerge` 不是 schema：`null` section 崩溃（P1-4）、非法条目静默丢弃（P2-4）、对象映射无法删除（P2-5）、`OPT_IN` 门不严（P2-2）。
- **loadConfig/saveConfig** 没有版本/备份/锁；坏文件静默回默认（P1-2），高 schemaVersion 直接让插件加载失败（P1-3），并发保存 last-write-wins（P1-1）。
- **publicConfig/mergeFromPanel** 对硬编码 SECRETS、retrieval、imageGen 主密钥处理正确；但 ext 未登记密码、`httpApi.body`、`extra` 会漏（P1-5）；空串无法清钥（P1-10）；`headers` 占位恢复逻辑依赖 `[已保存，原样保留]` 且按数组 id/index 匹配，数组重排可能错配（低危，未单列）。
- **schemaVersion/迁移**：只有 `>2` 拒绝和零散 `delete`，没有迁移链/备份；建议单独 `migrations/` 模块和 `configRevision`。

### 3.2 模块内核

- **loadLib** 全量 import + 静默失败（P2-6）；**importUser 快照**思路正确，但旧快照删除与动态 import 的迟加载文件存在边界；**3 秒 sync** 没有源码/数据目录区分（P2-7）。
- **start/stop** 的 generation、late route 保护、异步 disposer 清理做得比一般插件好；但 **setup 无超时**（P1-9）是最大缺口；`drainPending` 没有上限会让 dispose 卡死。
- **builtin/user 替换、工具名去重、路由冲突**：路由冲突有明确报错；工具重名只 `log.debug` 丢弃，`dshTools` 没有去重提示（低危）；`panelSource` 前缀边界错误（P3-2）；`fork` 的 rewrite/同名文件是潜在坑（P3-3）。
- **内存/生命周期**：`errors` 每个模块最多 8 条，`events` Hook 200 条；`bridge` 的 activity/open 监听在 dispose 时没有 off（P3-8 邻近问题，建议补 `mods.listen` 的 disposer）。
- **`api.settings()`/`api.config()`**：`getConfig` 返回可变对象，模块可直接改内存配置绕过 normalize/持久化（建议在 API 层冻结/深拷贝，P3-8）。

### 3.3 Hook 运行时

- **排序**：`phase → priority → 模块 id → order`，与 `API.md:76` 的契约一致；`order` 用 `rec.offs.length`，包含非 Hook 清理注册，但同一模块内单调，跨模块由 id 决定，稳定。
- **claim/filter**：claim 首个 true 返回；filter 遇 null 中止；`failure:'abort'` 生效；`STALE_HOOK` 会成为 null（P2-8/P3-?)。
- **超时**：Promise.race 只保证“等待结束”，不取消底层 Promise（P2-8）；`snapshot()` 深拷贝无大小/深度上限，且 Date/Map/Set/RegExp 会变成 `{}`，大消息会放大 CPU/内存（建议加深度/字节上限，并保留这些类型）。
- **epoch**：guard 按 `chatId/chat.chatId/msg.chatId` 查找；无 chat 的 Hook 不受 epoch 约束（设计如此，但长任务 Hook 应在 fn 内用 `isCurrent`）；`filterSync` 过期时返回 null 会让 host `rewrite()` 把 persona/rules 变空（可改为抛 `STALE_HOOK` 让调用方回退原文）。

### 3.4 bridge

- **鉴权**：HTTP `/open/*` 的 token 生成、长度检查、`timingSafeEqual` 正确；token 在 query string 可被访问日志/Referrer 记录（建议只允许 Authorization header）。
- **通道隔离**：同进程 service 无 token（设计）；DSH 全局工具受 `dshTools` 开关控制；QQ 自己的会话通过 `deniedTools` 屏蔽；但 `ops.call` 对模块导出无方法白名单，token 持有者可调用任意导出（含管理/删除类方法，P2-13 附近建议 allowlist）。
- **事件环**：RING=300 的 `events` 仅内存；`record` 对 data 不设大小上限；`mods.listen('activity')` 没有保存返回的 off，dispose 后监听仍留在旧模块 map（生命周期泄漏，低危）。
- **工具刷新**：见 P2-13。

### 3.5 llm

- **模型解析**：`roleModel`（角色）→ `defaultModel`（cfg.model → DSH agentDefaultModel）；`normalize` 会把半配置角色清空，优先级基本正确。`canSeeImages` 的 role 盲区见 P3-6。
- **缓存**：vision/reasoning 10 分钟 TTL，key=`provider::model`；正常；但 `modelReasoning` 在临时 resolve 错误时缓存 null 10 分钟，会少传 reasoningEffort（偏保守，可接受）。
- **askModel**：deadline、AbortSignal、流式聚合、attempt 重试、usage 汇总逻辑较完整；残余：`callControl.wait` 的 race 不取消底层 `iterator.next()`/`fn`（P3-7 附近），`notifyUsage` 异步 observer 不等待（依赖宿主 drain），`maxOutputChars` 只统计 text-delta 不统计 reasoning/tool delta（可作成本边界）。
- **错误语义**：`MODEL_TIMEOUT`/`MODEL_ABORTED`/`MODEL_INCOMPLETE`/`NO_VISION` 区分清楚；`streamFailure` 对非 Error 对象有兜底；`usageComplete` 不把未知当 0，正确。

### 3.6 net（SSRF）

- 结论：**未发现可直接利用的 SSRF 绕过**；IPv6 mapped/loopback、十进制/八进制 IPv4、localhost 变体、DNS rebinding（pinned lookup）、重定向跨主机、HTTPS 降级、压缩炸弹、大小/超时都有防护。
- 残余：`allowAnyPort: true`；`segmentBytes` 信任 OneBot `get_image` 的本地路径；`fetchImage` 的 `allowLocal` 是调用方责任。见 P3-10。

### 3.7 host 面板 API（专项补充）

#### 3.7.1 鉴权矩阵（实测的代码事实）

| 路由组 | 鉴权 | 说明 |
|---|---|---|
| `/aurabot/api/open/*`（info/send/think/call/events） | Bearer token（`timingSafeEqual`） | 只有这 5 个走 `bridge.authorized`（`host.js:906-914`） |
| 核心面板 `/state`、`/save`、`/persona/*`、`/bridge/*`、`/snowluma/*`、`/local/*`、`/avatar/*`、`/diagnostics/*` | **无** | `route()` 直接 `webServer.register`，没有 auth/Origin/method 校验（`host.js:383`） |
| 模块路由（内置 + 用户） | **无** | `host.js:384-392` 前缀 handler → `modules.handle` 只查路由/模块在不在（`modules.js:627-631`） |
| 模块副作用示例 | **无** | `/modules/tool`、`/modules/simulate`、`/song/import`（1GB）、`/bili/run`、`/imagegen/cancel`、`/voice/test`、`/speakup/fire` 等都由模块自行注册 |
| DSH 全局工具 / 同进程 service | 无 HTTP 鉴权 | `bridge.service`/`ctx.provide` 设计如此；QQ 会话通过 `deniedTools` 屏蔽 |

- 除 P0-1/P0-2 外：
  - `/diagnostics/export`（`host.js:485`）返回 `publicConfig`、请求/决策摘要和 `cross-chat-history`，无鉴权；聊天内容/提示词可能进入导出（P0-1 同根因，建议单独审计诊断数据脱敏）。
  - `/logs`（`:566-569`）返回日志环形缓冲，日志里包含聊天摘要；`Number(limit)||300` 对负数会改变切片（低危）。
  - `/avatar`/`/avatar/upload` 的 5MB 限制在解析后，43MB JSON 仍可分配；见 P2-11。
  - `/save` 对 `body` 的类型没有校验（数组/字符串会走 `deepMerge` 返回 current），可能把无效请求回成“保存好了”（低危）。
  - `/snowluma/consent` 只校验 `agree===true`，`version` 未校验（`host.js:594-599`）；建议校验协议版本，防止提前同意未来版本（P3 低危）。

### 3.8 代码质量

- `host.js` 是典型的上帝对象：983 行、60+ 路由、God closure 同时持有 config/storage/persona/onebot/hub/routes/modules/bridge；任何跨子系统测试都需要完整 fake（P3-8）。
- `config.js` 的 `deepMerge` 与 `modules.js` 的 `deepMerge` 两套不同语义（`config` 深克隆 base、`modules` 浅 spread），同名函数容易误用；建议收敛为一个 `mergePatch` 模块。
- `readBody/readRaw/query/send` 的 HTTP 样板都堆在 `apply` 内，没有 router/middleware/schema 层；这是 P0-1、P2-11、P2-10 的共同结构性原因。
- 死代码/未用导入：`src/host.js:15` 的 `spawn` 未使用；`modules.js` 的 `libCache` 全局缓存跨 createModules 实例保留（热更新时可能拿旧内部源码）；`config.js` 的 `hhmm` 未被使用（可删）。
- 命名：`ready` 语义（启动完成 vs 失败信息）不统一；`saveConfig` 既像纯函数又会写盘；`state`/`overview` 两套名字混用。建议在重构时统一为 `loadConfigFromDisk`/`writeConfig`/`getPublicConfig`。

## 4. 核心层重构优先级建议

### 第一批（P0/P1，先拆“边界安全”和“配置服务”）

1. **先做面板鉴权层，不动业务**：在 `route()`/模块 prefix 外统一加 `panelAuth` 中间件（DSH connection admit + panel token + Origin/Host/content-type），把 `/open/*` 的 token 逻辑抽成 `auth/bearer.js`；所有有副作用的路由只接受 POST，禁止 GET 副作用。回归点：P0-1、P0-2、P1-6。
2. **拆出 `core/config-service.js`**：`defaults.js`（纯 DEFAULTS）、`normalize.js`（schema + section null 安全）、`secrets.js`（显式 secret schema + 通用掩码）、`store.js`（read/write/backup/revision）、`merge.js`（JSON Merge Patch，支持 null 删除）；`saveConfig` 改为 `updateConfig(patch, {revision})`，进程内串行队列 + 文件锁（多实例用 `flock` 或 lock 文件）。回归点：P1-1/2/3/4/5/10、P2-1/2/3/4/5/12。
3. **`modules.js` 拆成 loader/registry/lifecycle 三个文件**：`loader` 懒加载 `lib`，`registry` 管 tools/routes/listeners/commands，`lifecycle` 管 start/stop/setup 超时/AbortSignal/dispose 上限。先修 P1-9（setup timeout）和 P2-7（sync 缩范围）；再补模块 schema 密码登记（P3-1）。回归点：`modules.test.js`、`issue16-module-lifecycle.test.js`、`hooks.test.js`。

### 第二批（结构/可观测性）

4. **拆 `host.js`**：`host/routes/*.js` + `host/onebot-gateway.js` + `host/snowluma-supervisor.js` + `host/panel-server.js`；`apply()` 只做装配。这样 P0-1/P2-10/P2-15 的修复不会散落在 900 行闭包里。
5. **Hook 运行时**：`hooks.js` 保持纯函数/运行时分离；给 `snapshot` 加深度/字节上限；`invoke` 超时用可取消的 `AbortController` + 明确的“不可取消”文档；`filterSync` 的 stale 改为明确错误码，让 `rewrite()` 回退原文；补 unknown event 校验（P3-4）。
6. **bridge**：refresh 串行化/代际化，`ops.call` 模块方法 allowlist，`dispose` 取消 `mods.listen` 注册的监听（P2-13、P3-8）；token 不写 query。

### 第三批（质量/边缘）

7. `net.js` 保持现有 DoH/pinned 逻辑，补 gateway 本地路径 root 约束和 `allowAnyPort` 配置化（P3-10）；`update.js` 平台化（P3-9）；`logger` 改异步/批量写，`redact` 的 known 集按名称/长度过滤（P3-5）。
8. 所有 `normalize`/`mergeFromPanel` 加 property-based/fuzz 测试（null、数组、原型键、超大字符串、Unicode 跨 chunk），作为配置服务重构的回归基线。

## 5. 回归测试点（按修复项）

- **P0-1/P0-2**：无 token 请求 `/save`/`/modules/tool` → 401/403；Origin 跨站 → 403；POST 非 JSON content-type → 415；GET `/snowluma/reset-password` → 405；跨站 CSRF 不产生状态变化；模块工具在 `as:'other'` 下不能调用 owner 工具。
- **P1-1**：两个并发 `/save` 基于同一 revision，第二个 409 且不覆盖第一个；快速开关 10 次后配置值等于最后一次实际意图；重新读取 revision 一致。
- **P1-2/P1-3/P1-4**：把 `config.json` 写成坏 JSON/EACCES/`model:null`/`schemaVersion:3`，插件进入只读降级而非崩溃；原文件有 `.bad-*` 备份；修复后可保存；现有配置不丢失。
- **P1-5/P1-6**：`publicConfig` 不包含任何 `apiKey/secret/password/token/cookie` 原文（含禁用模块 ext、httpApi.body、imageGen extra headers）；`/bridge/examples` 不含真实 token；`/snowluma/password` 在无重新鉴权时不返回明文。
- **P1-7**：mock WebSocket 在 `restart()` 时旧 socket close 后不产生第二个 connect；事件只处理一次；状态最终 connected 且只有一个活动 socket。
- **P1-8**：用 Readable 把含中文 JSON 切成 1 字节 chunk，`readBody` 结果与原文完全一致；`/save` 人格文本跨 chunk 不乱码。
- **P1-9**：用户模块 `setup` 返回 never-resolve Promise，`boot()` 在超时内完成/或模块被标错，其他模块可用；`modulesReady` 不因单个坏模块永久 false；`dispose()` 在超时内完成。
- **P1-10/P2-5**：面板清空 API key 发送 `null` 后值真的为空；删除 `modules.x`/`ext.foo.b` 后配置不再含旧键；`/state` 显示 `Set:false`。
- **P2-2/P2-3**：老配置 `setupDone:false` 的 bili 被强制 off；非法 `group.overrides` 保存返回错误而不是运行时 TypeError。
- **P2-6/P2-7**：`loadLib` 的单文件 import 失败有日志；用户模块写自身目录不触发无限 reload；3 秒轮询不导致 CPU 抖动。
- **P2-8/P2-9/P2-15**：Hook 永不 resolve 时内存不增长（或至少超时后清理）；慢 SnowLuma 启动期间不出现双进程；dispose 与 watchdog 并发后没有新 socket/子进程。
- **P2-10/P2-11**：`/modules/open?id=../../x` 被拒绝且不 mkdir；43MB/1GB 请求被拒/限流，内存不暴涨。
- **P2-12**：`stat(config.json).mode & 0o777 === 0o600`；数据目录 0o700。
- **P3-1/P3-2/P3-3/P3-4**：内置/禁用模块密码不泄漏；panelSource 只能读自身目录；fork 后新模块可 import；拼错 Hook 名报错。
- **P3-5/P3-6/P3-7**：日志中的 `application/json` 不被 `***`；role 视觉模型可用；模块 stop 后 ask 的 Promise 被 abort。
- **P3-8/P3-9/P3-10**：`ready` 成功/失败 shape 一致；macOS 更新命令可用；`assertPublicUrl` 的 IPv6/十进制/DNS/重定向回归测试保持通过。

## 6. 明确未发现/不能下结论的点

- **Net SSRF**：没有找到可利用绕过；`isPublicAddress`、DoH fake-IP、pinned lookup、重定向逐跳复核看起来是有意加固过的。残余仅 P3-10。
- **Hook 排序稳定性**：`phase/priority/模块 ID/注册顺序` 与 API 文档一致；未发现排序抖动。
- **bridge `timingSafeEqual`**：长度检查 + `timingSafeEqual` 正确；token 生成使用 `randomBytes(24)` 足够。
- **LLM 流式聚合/usage**：主体逻辑完整；未发现把未知 token 当 0 的记账错误；`usageComplete` 语义正确。
- **待验证**：`bridge.refresh` 的旧 disposer 是否真的按名称删除同名工具（依赖 DSH `tools.register` 实现）；`host` dispose 与 route effect 的清理顺序（依赖宿主 effect 处置顺序）；`panelSource` 的 `startsWith` 影响取决于用户模块是否使用 `../` 面板路径。以上均在对应条目标了“待验证”。
