# Aurabot 扩展接口说明（插件 v{{VERSION}} · 扩展接口 v{{API}}）

本文对应 **2.0.0-rc.2 / API 2**。运行时把本文件和 `aurabot.d.ts` 复制到数据目录 `modules/`；运行时副本会更新，自己的模块请放在 `modules/<id>/`。

API 2 仍接受声明 `api:1` 的模块，但不会恢复旧版全局记忆、心情或未经范围核验的读取方式。新模块声明 `api:2`。下面描述当前代码契约；中间安装包的部分真实样例已测，最终整合包验收由主线程另行汇总。

2026-10-29 主线程确认的中间包样例包括 Magpie ping/system 回合、真实 SnowLuma 连接及主人私聊文本/生图 confirmed delivered、Cloudflare BGE-M3 中文 3/3 与向量范围/删除闭环、GRSAI 生图与参考图再生成、StepFun TTS 可解码且非静音；音频可懂性未验证。具体边界见 [使用手册](../../docs/USER-MANUAL.md)，不据此扩展模块权限或补造费用。

模块运行在宿主 Node.js 进程中，是受信任代码，**不是沙箱**。Hook 超时、参数快照和停用门卫不能限制任意文件、网络、`api.core` 或 `api.dsh` 调用。

## 最小模块与生命周期

`modules/hello/index.mjs`：

```js
/** @type {import('../aurabot').AurabotModule} */
export default {
  id:'hello', name:'打招呼', version:'0.1.0', api:2,
  setup(api) {
    api.on('message', async (msg, execution) => {
      if (msg.text !== '你好') return false
      if (api.signal.aborted || execution.signal.aborted || !execution.isCurrent()) return false
      await api.reply(msg, '你好呀～')
      return true
    })
  },
}
```

- id 与文件夹名相同，2–40 个字符，小写字母开头，仅小写字母、数字、`-`。入口支持 index.mjs/index.js，以 `_` 或 `.` 开头的目录不加载。
- 用户模块支持多文件和 npm 包；在模块目录安装依赖。热重载从 `.aurabot-cache/` 快照加载，依赖目录不复制。读随包文件用 `api.dir`，写运行数据用 `api.dataDir()`。
- setup 返回模块导出，用户模块可异步 setup；内置模块必须同步返回。异步初始化可导出 ready Promise，由调用方显式等待。
- 停用先使实例失效、abort `api.signal`，撤销注册并等待已登记的清理与导出 dispose；宿主关闭数据库前等待模块清理。自行启动的 Promise、网络和 worker 不会全部自动纳入等待，必须由模块取消、跟踪并在 dispose 中收束。
- `api.onDispose(fn)` 允许返回 Promise；清理应幂等。它返回登记的函数本身，不是“取消登记”函数。

定义还支持 description/defaults/settings/panel/tab。settings 自动生成表单，支持 text/number/switch/select/textarea/password，值保存在 `config.ext[id]`。每次用 `api.settings()` 读取最新值。

`files` 是内置模块 fork 时一并复制的**相对 src/ 的精确文件清单**，不支持目录或 glob。当前复制器把实现文件放在目标目录的同一层，需检查重名文件及复制后的 import，不能把目录当作已复制成功。

## 常用 api

| 接口 | 契约 |
| --- | --- |
| id/source/dir/version/apiVersion/signal | 标识、builtin/user、原目录、插件版本、接口版本、模块生命周期信号 |
| config() / setConfig(patch) | 读取完整配置；对象深合并，函数返回完整新配置 |
| settings() / saveSettings(patch) | 当前模块 defaults 与保存值 / 修改模块设置 |
| dataDir(...parts) / log.info/warn/error/debug | 专用运行目录 / 分类日志 |
| use(id) / lazy(id) / has(id) | 当前导出或 null / 动态代理 / 是否运行。不要长期保留热重载前的导出 |
| on(event,fn,options?) / emit(event,...args) | 注册 Hook / 发观察事件；emit 不等待全部监听完成 |
| tool(builder) / defineTool(spec) | 按会话提供工具 / 构造工具定义 |
| context(fn) | 同步返回稳定的上下文文字或空值；Promise 会被拒绝并记错 |
| prepareContext(fn,options?) | 每次送入会话前异步准备，再由 `prompt/prepared` 消费当轮有效结果 |
| rule(fnOrText) | 同步补充规则，函数每轮读取 kind/config |
| command({name,aliases,desc,run}) | 主人命令，返回文字回到发命令的聊天 |
| every(ms,fn,label?) / later(ms,fn) | 进程内定时器，停用撤销；every 最小 1 秒且同回调不重叠。持久等待用 tasks |
| route(path,handler) | 新模块为 `/aurabot/api/ext/<id>/<path>`；内置模块及其同 ID 替换保留原路径 |
| onDispose(fn) | 异步清理，参见生命周期 |

工具、上下文、规则、命令、Hook、定时器与路由注册通常返回撤销函数；emit 不返回撤销函数。

| 操作 | 说明 |
| --- | --- |
| send(chatId,text) | 正常拆条和回复流程，可含 voice/sticker/poke 标记 |
| sendText(chatId,text) / reply(msg,text) | 直接文字；reply 在群内引用原消息 |
| sendImage(chatId,src) / sendSegments(chatId,segments,note?) | 图片 / OneBot 消息段；路径和资产仍须符合宿主校验 |
| sendFile(chatId,file,name?) / sendVoiceFile(chatId,file,note?) | 发文件 / 把音频当语音条发；本机路径限 QQ 工作区和 `files.dirs`，受 `files.enabled` 控制。没确认送达时抛错，`DELIVERY_UNKNOWN` 不要重发 |
| onebot(action,params,options?) | 直接网关调用，不能假定继承高层发送、试运行或请求权限保护 |
| ask(stringOrOptions) | 单次模型调用，可能收费；并无统一物理取消保证 |
| think(prompt,{title,timeoutMs}?) | 带人格的后台会话，返回文字，不自动送达 QQ |
| isOwner(userId) | 比较主人 ID，不能代替整条请求授权 |

chatId 为 `private:<QQ>` / `group:<群号>`；后台会话可为 `system:<名字>`，不属于记忆等聊天数据范围。高层发送受总开关、试运行和当前授权约束。创建任务、拿到文件、生成成功都不等于送达。

## API 2 Hook 执行契约

`on(event,fn,{mode?,phase?,priority?,timeoutMs?})` 的 mode 必须符合事件规定。按 phase、priority、模块 ID、注册顺序升序执行；phase 限 -10..10、priority 限 -100..100、异步超时限 10..30000ms。普通默认 5000ms，context/prepare 默认 10000ms。

异步监听收到最后一个参数 `execution={signal,isCurrent}`。普通对象/数组递归复制并冻结；过滤器应返回新值，不原地修改。undefined 保留前值，filter 返回 null 终止链；错误、超时、结构无效按事件策略处理。

| 事件 | 模式 / 参数（省略最后的 execution） | 结果与失败策略 |
| --- | --- | --- |
| message / poke | claim；消息 / 原戳一戳事件 | true 接管；false/undefined 继续；错误继续后续监听 |
| group/decide | filter；decision,{msg,policy,recentTexts,memScore} | 必须有 boolean reply，可带 mode/reason。错误保留前值；null 终止链但当前 hub 保留原决定，阻止回复请返回 `{reply:false}` |
| prompt | filter；content,{chat,senderId,queryText} | text/image 内容数组；错误或 null 阻止本次提交 |
| prompt/prepared | filter；content,{chat,chatId,sessionId,text,queryText,prevText,speakers,persona,account,requestId,requests,signal} | context/prepare 和会话有效性检查后执行；text 是准备时使用的查询。返回 text/image 内容数组；错误或 null 阻止本次提交 |
| reply | filter；text,{chatId,userText} | 新文字；null 不发；普通错误保留前值 |
| reply/items | filter；items,{chatId,text,userText} | text/voice/sticker/image/poke 数组；错误或 null 中止发送链 |
| send | filter；segments,{chatId,note,force} | OneBot 段数组；错误或 null 中止高层发送；直接 onebot 不经过此链 |
| model | sync；selection,chat | 模型选择对象，不能返回 Promise |
| persona / rules | sync；text / text,kind | 新文字，不能返回 Promise |
| context/prepare | observe，按序 await；准备参数 | 返回值不注入上下文；错误记诊断后继续 |
| activity / onebot / onebot/state | observe；活动 / 原事件 / 状态 | 不接管、不改写；emit 发起后不等待 |
| config / module/start / module/stop / 自定义事件 | observe；各自参数 | 默认观察模式，不是新 filter |

数组结果最多 200 项。image 回复项接受 HTTP(S) 或 asset:，send 段 file 接受 HTTP(S)、asset: 或 base64://，不能注入任意本地路径。同步 Hook 没有异步 execution 参数，也没有可抢占超时；Promise 会被记为 ASYNC_SYNC_HOOK。

**取消限制：** runtime 检查模块实例和可识别聊天的 epoch，丢弃迟到结果；filter 的 STALE_HOOK 中止链。execution.signal 在正常完成、超时或失败的 finally 都会 abort，不能当作成功缓存的长期有效标志。isCurrent 检查实例/epoch，不等价于“未超时”；写入前仍要检查 signal、请求归属、当前账号和配置。

超时是 Promise race，不能终止同步死循环，不能撤回已经发出的 HTTP、QQ 或收费请求。普通 Hook 的执行 signal 不保证在模块停用瞬间触发，模块应合并 api.signal，并在每个 await 后核验状态。脱离回调运行的任务必须自行管理。

### prepareContext 与同步上下文

当前 hub 传入 `{chat,chatId,sessionId,text,account,persona,personaSnapshot,requestIds,requestId,signal}`。prepareContext 包装后补上 isCurrent，并合并本轮、Hook、模块的 signal。准备失败不等于取消聊天，提供者必须清理本次旧缓存。

普通 context 目前只保证 `{chat,sessionId}`，**没有 persona 顶层参数**。用 `api.core.hub.turnPersona(sessionId)?.personaId` 解析冻结人设，账号取宿主当前配置。一般人物事实写入 persona:''，读取可带当前人设；不要为每个人格复制人物事实。

预热缓存需以 session + scope + 查询/单调 ticket 隔离，提交前检查 signal/isCurrent/账号，同步读取再核对源版本和可见性。随请求变化的检索、人物资料和学习结果应通过 `prompt/prepared` 加入本轮内容，而不是放入可能留存多份快照的系统 context。内置 retrieval 已注册这两个入口，无需重复注册；模块导出为 `prepareContext(args)` 与 `contextFor(chat,sessionId,options?)`，后者自行解析当前 scope，可用 `options.query` 匹配准备查询；底层向量 service 接受 `{scope,epoch}`。

## 工具授权与持久任务

工具生成器收到 `{chat,level,sessionId}`，level 为 full/social/chat。生成器不是每次 execute 都执行，权限必须在执行时检查。`execute(args,exec)` 的 exec 来自 DSH，可能带 signal/abortSignal，不是 Hook execution。

```js
api.tool(({chat}) => chat.kind === 'system' ? [] : api.defineTool({
  name:'module_status', description:'查看本模块状态',
  execute:async () => ({ok:true,message:'模块已加载'}),
}))
```

副作用工具从 hub.turnActor、hub.turnRequests、storage.requests.get 和来源消息确定 actor/account/chat；模型参数不能指定 actor、授权 scope 或 force。多请求回合中“出现过主人”不等于所有请求获授权，turnHasOwner 不能单独授权收费/管理动作。await 前后都核验请求、账号、epoch、权限和取消状态。

storage.requests.create/appendSource 核验来源同 actor、同聊天、同账号；调用方还要核对当前机器人账号与请求生命周期。内部 message ID 与 QQ platform message ID 不通用。

- `qq_wait` 等 job/request/media/time，必须有期限，登记后结束当前决策并有界唤醒。job 的 unknown 也可能满足终态等待，不能据此说成功。
- `qq_stop` 只结束当前决策，不取消后台任务或已登记等待。
- `qq_tasks` 查询当前账号/聊天下有权查看的任务；通常只能看自己的，主人可管理当前聊天。
- `qq_cancel_task` 要明确 ID，取消等待不会取消它所等待的任务。

收费先登记账本和预留额度，再提交；发送走持久 outbox。**unknown 表示可能已收费/已发送，禁止盲目重交、重新生成或补发**。只有明确 not_sent/rejected、提供方查询结果或稳定幂等契约才支持相应重试。取消不能承诺退款或撤回已送达消息；语音发送未知时也不能自动再发文字。

## 服务调用用量与只读诊断

`api.core.usage.record(input)` 是同步、本地的服务调用凭据登记，不是收费授权、额度预留或提供方对账。成功返回调用 ID；显式 requestId 无法关联到所给账号的来源消息时不写入并返回 undefined。账号取 input.account、context.account 或宿主当前账号；调用方须提供可信的账号/请求上下文，不能从模型参数照搬。requestId 合法时 chatId 取请求自身聊天。

| 字段 | 契约 |
| --- | --- |
| id | 可选稳定调用 ID；相同 ID 的记录 INSERT OR IGNORE，不累加、不覆盖旧凭据。不同外部尝试使用不同 ID |
| service/model/role/status/billing | 服务标识、型号、角色、调用状态与计费状态；status/billing 未提供为 unknown。不要在这些字符串中放正文或密钥 |
| account/chatId/requestId/context | 来源绑定；context 可提供 account/chatId/chat/requestId/role。后台调用可不属于某个用户请求 |
| requestIds | 共享批次参与请求 ID；只有同账号、同聊天且来源有效的请求才能关联。同一调用在总账只算一次，跨请求视图不能再次相加 |
| startedAt/durationMs | 开始时间戳与耗时（毫秒）；不完整耗时保持未知 |
| inputTokens/outputTokens/cachedTokens | 服务实际返回的 token 用量；也支持 tokens/usage 中对应别名，建议先在适配器归一化 |
| inputCount/inputChars | 实际输入数量/字符计数，不等于 token 数或费用 |
| credits/amount/currency | 实际返回的额度、金额及币种；没有明确响应就保持 null，不按 token、成功状态或 charged 推算金额 |

数值字段仅接受非负有限 number，缺失或无效转为 null。表内不保存提示词、回复正文、完整响应或未列出的自定义字段；完整响应应先提取允许的数值再登记。宿主 `askModel` 观察器和已接入的提供方会登记调用，模块不能为同一调用再次生成新 ID 重复记账；任意扩展直接网络调用并不会自动全部被捕获。

```js
// usage 是适配器从真实响应提取的用量，不是整个提供方响应。
function recordProviderCall(api, context, callId, usage) {
  return api.core.usage.record({
    id:callId, service:'custom-provider', context,
    status:usage.status ?? 'unknown', billing:usage.billing ?? 'unknown',
    inputTokens:usage.inputTokens ?? null, outputTokens:usage.outputTokens ?? null,
    cachedTokens:usage.cachedTokens ?? null, credits:usage.credits ?? null,
    amount:usage.amount ?? null, currency:usage.currency ?? null,
  })
}
```

以下路径均省略统一 `/aurabot/api` 前缀，均为 GET，只查询当前账号；诊断接口不执行模型、工具或 QQ。

| 路径 | 参数与返回 |
| --- | --- |
| /diagnostics/usage | requestId?/chatId?/limit?（默认 50，1–200）；返回 `{ok,totals,amounts,items,note}`。`core.usage.report(options)` 返回同一内容但没有 ok |
| /diagnostics/replay | requestId 或 eventId **恰选其一**，limit 上限 100；返回 readOnly、scope、版本、events、unknown、truncated，请求回放另含 observedLedger 与 latency |
| /diagnostics/latencies | chatId?/from?/to?/limit?；from/to 为请求 createdAt 的含边界毫秒时间戳，limit 默认 40、最多 100；返回 window/metrics/items/requestCount/excluded |

usage.totals 提供服务调用数、已返回用量和 unknownAmountCalls；amounts 只汇总提供了金额和币种的行，按币种分开。items 另可包含生图/翻唱任务尝试；这些回退行可能缺少 token/金额字段，消费方同样必须显示未知。无记录、字段缺失和显式 0 是不同状态，不能因执行成功就展示零成本。诊断导出包含 usage，但账本不保证覆盖全部外部调用或提供方最终账单。

replay 仅在快照输入完整、历史纯基础群聊策略实现版本匹配且需要的随机值已记录时重算该策略。不重放 Hook/参与限制的全部历史，也不拿当前配置或记忆补历史；当前账本标记为 `current_persisted_rows_not_historical_state_transitions`。无法重算时返回 unavailable/unsupported-policy 与缺失原因，不能把它包装成成功复现。

latencies.metrics 的 firstDecision/firstConfirmedReply/finalDelivery 分别给出 sampleCount、missingCount、p50Ms、p95Ms，采用 nearest-rank。最终投递需要请求结束、全部相关段及任务的确认回执；无回执、未知、截断或时间顺序问题保持 null 并列入 issues。统计只覆盖 window 指定的有界最近请求，不是全历史性能承诺。

## 范围化记忆

```js
const memory = api.use('memory')
const scope = {account:'20000002',chat:'group:777',persona:''}
const result = memory.create({
  scope, text:'小明喜欢咖啡', subject:'10000001', predicate:'likes', value:'咖啡',
  speakerId:'10000001', polarity:'positive', modality:'asserted', conditions:[],
  eventTime:null, validFrom:null, validTo:null, stability:'stable',
  manualEvidence:{kind:'manual',text:'管理员核对原话：小明喜欢咖啡',speakerId:'10000001',actorId:'admin'},
})
```

这是受信任管理端示例，聊天工具不能伪造人工复核。真实聊天证据用 evidenceMessageIds（内部消息 ID）；来源要真实、未撤回且可见，speaker 对应来源。value 可为非空字符串、有限数值或 boolean；时间为整数毫秒或 null；conditions:null 表示未知，[] 表示无条件。modality 为 asserted/reported/hypothetical/plan/joke/uncertain，只有 asserted 可标 stable。

所有内容读写需要显式 scope。account 不可共享；chat 只在显式 shareGroups 内按类别共享，非传递且只读；事实还需满足**全部证据受众交集**。普通事实 persona 留空，experience 必须有 persona，profile/override 用精确查看范围。共享事实不能从接收聊天改写。

| 接口 | 说明 |
| --- | --- |
| create(input) / add(input) | create 抛错；兼容 add 返回 ok:false/code/message。成功含 id/item/scope/account/chat |
| get(id,{scope,...}) / getFactsByIds(ids,{scope,...}) | 最终来源核验；批量最多 200 ID，不可见项省略 |
| list({scope,limit,...}) / list(scope,{limit,...}) | SQL 范围预过滤、批量核验证据。默认 300，最多 5000 返回项；单调用最多 20000 候选 |
| page(scope,{cursor,limit,...}) | 默认 100，最多 1000 SQL 候选；返回 items/nextCursor/done/scanned/visibilityStamp/revision 和范围信息 |
| recall(query,{scope,...}) / contextFor(chat,sessionId,{scope,...}) | 中文词法召回，含日期、来源和状态 / 同步上下文 |
| revision(scope) / visibilityStamp(scope) | 本范围修订 / 共享可见来源和策略标记，不能代替最终证据校验 |
| update(id,patch,meta) / correct(id,replacement,meta) | 带 scope/expectedRevision/actorId/reason；结构编辑提供新证据，更正保留 supersedes |
| retract/remove/restore/approve(id,meta) | 撤回/删除留审计；restore 仅 quarantined，approve 需 approved:true |
| evidence/evidenceReview/audit(id,{scope}) | 可用来源 / 恢复审核元数据 / 原范围管理员审计 |
| profileOf(subject,{scope}) / buildProfile(subject,{scope}) | 有效缓存或 null / 异步重建 |
| getOverrides(subject,{scope}) / setOverrides(subject,value,meta) | 返回 override:{aliases,entries,revision} / 带 expectedRevision 写入 |
| enqueue(scope) / tick({scope}) / consolidate({scope}) / status(scope) | recv_seq 水位、条件提炼、手动提炼、检查点 |
| dispose() / stop() | 幂等取消并等待提炼/去重/画像；SQLite 由宿主关闭 |

page 支持 subject/category/statuses/includeInactive/currentOnly/ownScope；order 为 created（默认）或 updated，时间降序、ID 升序。空 items 仍可能有 nextCursor，必须继续；范围/查询不匹配为 INVALID_CURSOR，来源/策略改变为 STALE_CURSOR，需从第一页重来。

词法缓存按可见修订和有效期边界失效，最多 5000 候选建立范围索引，热查询重新核验排名结果。它不是任意大历史的穷尽搜索；统计与面板列表也是有界读取，不可当作全库审计导出。向量候选以主库为准，等待后再次使用应重新 getFactsByIds。

profileOf 含当前 scope 的安全 override/revision；没有画像也可 getOverrides。entries 为 `{section,text,factIds}`，section 是 identity/relationships/stableFacts/preferences/recentInteractions/uncertain。证据内容、有效期、共享策略变化使缓存失效；旧覆盖文本隐藏，revision 保留供编辑。

恢复必须分别审核证据和事实：

```js
memory.restore(factId,{scope,actorId:'admin',reason:'申请恢复核查'})
const sources = memory.evidenceReview(factId,{scope})
// 管理员逐条核对原始材料后再执行，不从旧审计文本自动批准。
memory.approveEvidence(sources[0].id,{
  scope,expectedRevision:sources[0].revision,approved:true,
  actorId:'admin',reason:'已核实来源仍有效',
})
// 所有必要来源通过后，另行批准事实。
memory.approve(factId,{scope,approved:true,actorId:'admin',reason:'已复核事实与范围'})
```

tombstone 继续抑制迟到提炼；恢复不清除阻止重放的记录。证据内容改变需 refresh 和重新审批，不能直接复活旧文本。自动 recall/profile 不把审计历史当事实。

`addEvent({scope:{account,chat,persona},text,sourceId,confirmed:true,...})` 保留模块兼容入口，只用于有成功回执的经历。未知来源和失败尝试不沉淀成人物事实。无 scope 的旧 list/recall/profile 拒绝；兼容 contextFor 返回空、topicScore 为 0、lastConsolidate 为 null。

提炼按收到的 recv_seq 推进，事实、证据、摘要、checkpoint 事务提交；失败区间不推进，原日志不清空。停用或账号改变后模型迟到响应不能写库；当前 askModel 没有物理中断契约，不代表已经发生的调用被撤销。

旧 memories.json（库旁或 legacy/ 下）按来源一次导入隔离区，解析失败保留待处理状态。未知来源不信任 JSON 自报范围，管理员要显式分配并给新核实证据；隔离区不参与自动 recall/profile/context。

### 记忆面板 API

完整路径加 `/aurabot/api`。GET 用 account/chat/persona，memory POST 用 scope 对象。依赖宿主管理端认证，不可直接开放给聊天工具；失败返回 ok:false/code/message。

| 路径 | 用途 / 关键请求 |
| --- | --- |
| GET /memories | q/includeInactive/limit，返回 items/stats/review；默认 100、面板最多 300 |
| POST /memory/add、/memory/update、/memory/correct | 完整 create / id+patch+expectedRevision / id+replacement+expectedRevision，核实证据和审计字段 |
| POST /memory/delete、/memory/retract、/memory/restore、/memory/approve、/memory/scope | id/scope/actorId/reason；approve 需 approved:true，scope 需 targetScope/expectedRevision |
| GET /memory/evidence、/memory/evidence/review、/memory/audit | id 为 fact ID |
| POST /memory/evidence/delete、/memory/evidence/refresh、/memory/evidence/approve | id 为 evidence ID；approve 需 expectedRevision/approved:true |
| GET /memory/extraction、/memory/recalls；POST /memory/extract | 进度、召回记录、手动提炼 |
| GET /profiles、/profiles/override | 后者需 subject，无缓存也能取得 override revision |
| POST /profiles/rebuild、/profiles/save | subject/scope；save 还需 override/expectedRevision/actorId/reason |
| GET /memory/quarantine | includeUnassigned=true 显式查看未知来源与迁移报告 |
| POST /memory/quarantine/import、/memory/quarantine/approve | payload/sourceKey?；或 id/fact/approved:true/actorId/reason |

/memory/import 和 /memory/import/commit 是隔离导入别名，不直接发布。page 是模块导出方法，目前没有独立 HTTP 分页路由。完整领域契约见 [记忆域说明](../memory/README.md)。

## 其他内置模块与默认状态

modules[id].enabled 与功能配置是两层开关；模块加载不等于服务配置完成。

| ID | 当前接口与边界 |
| --- | --- |
| mood | state/current/label/nudge/reset/observe/judge/effects/contextLine/stop；account/chat/persona 必填。关键词判断默认开启、模型判断默认关闭；只影响短期表达，明确请求/承诺不受阻断 |
| learning | list/get/upsert/update/transition/history/evidence/sources/enqueue/learn/checkpoint/select/contextFor/stop；表达/黑话分开。learnEnabled/useEnabled 默认 false，私聊学习默认禁止 |
| retrieval | prepareContext/contextFor/recall/queryImages/materializeReference/assertReferences/health/status/dispose；默认关闭，启动不自动 probe 付费模型，面板显式探测后开放对应通道 |
| token-meter | summary({range,chatId?,groupBy?})；range 为 today/7d/30d/all，自然日固定按 UTC+8。只读 service_calls，不含金额；totalTokens 包含 LLM 缓存读取，embedding 缓存已含在输入中。GET /token-meter/summary；dashboard(options) 及 GET /token-meter/dashboard 见下 |
| tasks | planner 与请求授权、wait/stop/listTasks/cancelTask 等；GET /tasks/list、POST /tasks/cancel，面板传 chatId |
| stickers | list/get/selectForReply/collect/addFromBuffer/approve/reject/disable/remove/queueStatus/reconcileSync/stop 等，必须有聊天范围。本地保存、审核、分析、QQ 收藏同步各有状态 |
| voice | speak(text,profile) → Promise<{file,engine}>；外部 OpenAI 兼容 TTS/固定 HTTP，默认 provider:none，本地脚本另行开启 |
| imagegen | enabled/runner/service；旧 generate 不可用。区分生成、待发送、送达、取消、未知 |
| search | 默认关闭，Tavily 搜索/提取和参考图复核；候选不是自动批准的生图引用 |
| song/bili/speakup | 翻唱/B站/主动搭话分别受配置权限与回执约束；song/bili 默认关闭，speakup 功能默认开启但受总开关和试运行约束 |
| qq-tools/group-admin/profile/contacts | QQ、群管理、资料和联系人工具，授权以执行前检查为准 |

`GET /token-meter/dashboard` 返回当前账号同一窗口的 Token 总计、模型分组和趋势，只统计 `llm` 与 `embedding` 调用；不带 `chatId` 时包括账号的后台调用，带上则只统计该聊天。参数 `range=today|7d|30d|all|custom`，默认 `7d`；`custom` 必须提供真实的 `startDate`、`endDate`（`YYYY-MM-DD`，含结束日）。日期按固定 UTC+8（`Etc/GMT-8`）自然日计算，年份为 1970–9999，最多跨 1200 个自然月；错误参数返回 `{ok:false,message}`。预设范围截至查询时刻，`all` 从首条匹配记录开始，没有记录时趋势为空。

成功返回 `{ok:true,range,from,to,timeZone,generatedAt,note,totals,models,trend}`。`from`、`to` 是毫秒时间戳，窗口为 `[from,to)`；`trend.granularity` 为 `day` 或 `month`（超过 366 天按月），`trend.points` 补齐空期，`key` 分别为 `YYYY-MM-DD` 或 `YYYY-MM`。模型按 `totalTokens` 降序、名称升序排序，缺少名称归入 `(unknown)`。每个总计、模型和趋势点都有 `calls`、`callsWithUsage`、`incompleteCalls`、`inputTokens`、`outputTokens`、`cachedTokens`、`totalTokens`；额外的 `inputCallsWithUsage`、`outputCallsWithUsage`、`cachedCallsWithUsage` 分别统计字段非空的调用（含真实 0），可用于区分未返回与返回零。缺失字段不计入总和，所有数字都不代表费用。

retrieval 的文本/图片/联合空间独立配置，能力取决于协议、模态、维度、前缀、预处理与探针；不能因模型名或维数相同就混用向量。索引是可重建派生数据，词法降级、候选截断和 needsRebuild 要如实展示。历史图按 occurrence 授权，asset 字节相同不授予跨聊天权限；引用还要绑定请求者、使用前复核。

`POST /retrieval/rebuild` 是主人面板的**当前账号完整重建**。输入 role、account、chatId/persona（或初始 scopes）、generation?/activate?；chat/scopes 是发现起点，不是重建边界。底层 `rebuildAccount({account,authority:'owner-panel',...})` 枚举账号自有来源范围和该空间已有引用，包含已删除来源留下的范围；凭据由可信管理端构造，模型不能自授 authority。返回 `{ok,jobId,state,account,coverage:'account',scopeCount}` 表示登记，不代表完成或已切换。超过 256 个范围、空间混入其他账号、账号变化或无法得到一致水位会拒绝/失败，不能发布局部代际；查询结果仍逐次按查看者范围核验。重建可能探测和编码并收费。

心情管理在 /mood/state、/history、/nudge、/reset；学习在 /learning/items、/sources、/evidence、/audit、/status、/create、/update、/approve、/disable、/delete、/restore、/revert、/run 等（均补相应 /mood 或 /learning 前缀）。范围为 account/chat/persona，学习修改带 expectedRevision，恢复回 pending，不直接 approved。

表情分析可提出用途/OCR/动作描述，但保存不等于批准。自动审核仅在显式配置启用且满足门槛时使用；动画须人工查看原文件确认。达到上限停止接收，不自动清掉已审核库；QQ 同步 unknown 先核对，不能直接再收藏。

## 面板、核心能力与 fork

现有 tab 包括 memory/mood/learning/retrieval/tasks/stickers/imagegen/search/voice/song/bili/speakup，以及 overview/connect/persona/access/group/model/local/diagnostics/logs/modules。关闭模块会隐藏所属功能页。

自定义 panel.js 是函数体，得到 React/h/ui/call，最后返回组件。call(path,body?) 无 body 为 GET，有 body 为 POST；组件接收 settings/save/toast。ui 提供 Card/Btn/Switch/Row/Empty/Select。密码字段不回显，模块自行输出的日志/响应仍须避免泄密。

api.core 提供 storage、usage、hub、onebot、personas、local、groupRoles、mutes、http、modules、planner、runner 注册及配置/日志工具。storage 是同步 SQLite 仓库，事务回调不能 await，也不能绕过领域授权。memory 当前由 ensureSchema(storage) 幂等建域表，尚未登记到主迁移版本表。api.core/lib/dsh 是可变内部能力，具体签名以实现为准；类型中的 any 不授予额外权限。

**fork 替换：**「扩展」→“复制一份来改”，保留 modules/<原id>/ 和 export default.id。同一包 ID 才替换内置实现；改 ID 会成为并存模块，可能重复注册。复制后检查精确 files、导出与范围契约再热重载。useBuiltin 可临时恢复内置版；用户版加载失败会尝试回到内置版，但不能撤销已发生的外部副作用。

fork 文件不自动合并新版，面板通过 forkedFrom 提示差异。插件分叉继续保留 `dsh-aurabot-qq` 包标识和模块 ID，以替换方式安装更新；不要为了升级再启动第二个发送实例。

## 迁移与验证边界

主库或必要升级备份失败时 host 返回诊断错误，暂停聊天/后台任务，不退回无账本发送。旧数据步骤失败不得把半迁移状态当成功；已移除功能的数据保留但不重新启用。

首次 `_backup-v2-*` 只是清单内旧 JSON/目录备份，跳过 local、songs、logs、voice-cache 等标记目录；数据库升级的 backups/ 是 SQLite 快照。**两者都不是全量备份**。升级前停止插件，独立备份整个数据目录、外置模型/脚本/凭据和所需宿主资料，检查 manifest 的 skipped/failed。

独立隔离恢复模块为 `src/migrate/restore.js`，导入没有 IO；API 与 CLI 均只准备候选，不提供运行库切换：

```js
import { prepareRestore } from './src/migrate/restore.js'
const report = await prepareRestore({
  currentDb, backupDb, outputDir, offline:true,
  // 可选 assertOffline(phase) 必须返回 true 或 Promise<true>。
})
// report.state === 'isolated'; switchAllowed === false;
// deletionHistoryComplete === false; reportPath/candidateDb/configPath 为绝对路径。
```

`offline:true` 由离线运维调用方确认 DSH/子宿主已停止，不是探测结果。assertOffline 在 before-copy/after-current-copy/after-backup-copy/before-complete 边界调用；只有 true 才继续，文件哈希检查也不能代替停止宿主。currentDb 必须可读且与 backupDb 独立；outputDir 必须新建且不与源目录重叠。先保存当前主库及 WAL/SHM/journal 原始副本，然后生成一致快照、合并已知屏障、隔离事实/证据、禁用自动功能及旧任务重放。usage 记录按稳定 ID 合并，不补金额，矛盾记录以 USAGE_CONFLICT 拒绝。原件不被 SQLite 打开或写入；报告与失败副本保留。

目前固定支持核心 schema 7，未知结构、损坏记录、缺失屏障表、身份冲突或源变化等抛出带 code 的错误；创建输出后失败附 reportPath/outputDir，报告 state:'refused'。缺失/清理/早先回滚掉的删除历史无法核实，所以即使成功也仅为隔离候选，需独立审批与正式切换集成。缓存/派生索引须从审核后的来源重建；外部向量库、媒体、JSON、宿主文件和用户模块不在恢复范围。数据库副本/审计可含原任务配置与凭据，新生成 config 才是不复制凭据且自动功能全关的配置。

CLI：`node scripts/restore-aurabot.mjs --current <库> --backup <备份> --output <新目录> --offline`。0 表示隔离准备成功，1 表示拒绝/错误；没有 force/install/switch 参数。`scripts/` 当前未列入包 files，CLI 从源码仓库运行，src 模块随源码使用。工具的当前库副本不能替代已经独立验证的全量备份。

记忆与恢复器自动化测试使用临时 SQLite/fixture，不读取真实用户数据；restore 21 项通过，未做真实库恢复。真实服务的中间包样例与最终整合包验收分开记录。面板模拟会执行模块代码/命令并捕获高层发送，但直接网关、模型、文件和外部请求仍可能发生，不能当作无副作用沙箱。

排查先看「扩展」运行实例/错误、「诊断」Hook 耗时与失败、任务/outbox 状态，再看脱敏日志。安全模式停止加载用户模块，不能撤销此前外部操作，也不会打开明确禁用的功能。

## 内部源码

api.lib('路径') 相对 src/；下列清单由运行时生成，内部签名不保证稳定：

{{LIB}}
