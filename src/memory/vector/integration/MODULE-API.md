# Retrieval 内置模块接线契约

入口：`src/modules/retrieval/index.js`，`setup(api)` **同步返回** exports。依赖 `api.lazy('memory')`、`api.core.storage/hub/http`、`api.prepareContext/context/tool/route/every/onDispose`。主线程注册 builtin、配置持久化、secret 和 UI；模块负责索引初始化、探测、持久队列、预热、检索、重排、图片门卫与停机。源码导入没有 worker/HTTP/文件写入副作用。

## 配置

从 `module-config.js` 或模块入口导出：`RETRIEVAL_DEFAULTS`、`normalizeRetrievalConfig(value)`、`RETRIEVAL_CONFIG_SCHEMA`、`RETRIEVAL_SECRET_FIELDS`。语义校验另有 `runtimeRetrievalConfig(normalized, forcedPath)`（从 module-config 或 integration/index 导出）。defaults 的完整结构：

```js
retrieval: {
  enabled: false, version: 1,
  index: { backend: 'local', cacheBytes: 8388608, pageSize: 256,
    maxPending: 32, timeoutMs: 15000, collectionPrefix: 'aurabot' },
  roles: {},
  queue: { batchSize: 32, maxPending: 256, maxAttempts: 3 },
  retrieval: { maxCandidates: 5000, lexicalLimit: 80, vectorLimit: 80, rrfK: 60, limit: 10 },
  sync: { intervalMs: 60000, pageSize: 128, maxJobsPerTick: 8, scopesPerTick: 8 },
  images: { maxBytes: 6291456 },
  reranker: { enabled: false, endpoint: '', model: '', apiKey: '', timeoutMs: 3000,
    maxCandidates: 40, budget: { maxCallsPerMinute: 10, maxInputChars: 32000, maxConcurrent: 1 } }
}
```

`enabled:false` 时不创建模块索引目录、worker、主库 outbox，也不调用模型。index.path 被规范化器丢弃，运行时固定到 `api.dataDir()/vector-indexes/<backend-namespace-hash>.sqlite`。目录逃逸/指向主库会拒绝。该文件只存派生索引、同步日志、基线与任务。

`index.backend` 为 local 或 qdrant；qdrant 另需 `baseUrl`，可填 `apiKey`。其他可选参数：`maxResponseBytes`。index 参数约束见导出的 JSON Schema。

`roles.text/image/joint` 每项的必填字段：`type,baseUrl,space`；可选 `apiKey,sendDimensions,timeoutMs,maxResponseBytes,maxBatch,probeTolerance,mapping,samples,alignmentPairs`。每个 role 使用独立 spaceId。`probeTolerance` 为有限数值 `0..0.01`，默认 `1e-5`；service 显式传给 adapter.probe，批量/单条/重复及持久基线比较都使用该值，baseline 记录本次 tolerance。CF 可由主线程针对该 role 配置 `0.0005`，不影响其他 role 或模型名/维数校验；已有 needsRebuild 锁定不会因此自动清除。space 的必填字段为：

```js
{ spaceId, provider, endpointIdentity, model, revision, dims, metric,
  modalities, prefixes: {query,document}, normalization, preprocess, protocolMappingVersion }
```

文本用 `type:'openai-text'` / `protocolMappingVersion:'openai-text-v1'`。图片/联合使用 `type:'fixed-http'`，固定映射内容哈希必须等于 `space.preprocess.protocolMappingFingerprint`。**内置模块要求 `mapping.inputs.image.representation:'data-url'`**；从 occurrence 异步读取受管资产，检查 MIME/hash/大小后编码，不公布本地路径或创建公开 URL。图片编码每次一张；描述文本仍按 queue.batchSize 分批。底层独立 adapter 的 URL 映射能力不等于本模块接受任意 URL。

图片/联合接入必须提供 2..8 个固定 `samples.image` data URL；joint 还需文本样例。直接联合文本搜图要求 `alignmentPairs` 正负样例通过。基础探针不证明中文语义质量。

secret 路径（字符串数组，主配置注册器可按 `.` 拆分）：

- `retrieval.index.apiKey`
- `retrieval.roles.text.apiKey`
- `retrieval.roles.image.apiKey`
- `retrieval.roles.joint.apiKey`
- `retrieval.reranker.apiKey`

默认无自动探针。开启/重载只初始化，恢复任务保持 queued；显式 POST probe/rebuild/retry/sync 才启动队列。sync 不主动探针，未通过探针的角色保留源 outbox pending。手动探针后，启用的增量队列可进行实际编码；这些操作可能产生模型费用，应由 UI 明确呈现。

禁用/停止后，已经安装的源 outbox 触发器仍保留，继续在来源事务内记录变更以便下次恢复；不保留活跃 worker 或模型调用。首次默认禁用则完全不安装它们。

## 模块 exports

```js
const retrieval = api.lazy('retrieval')
await retrieval.ready                   // 初始化结果；启动不必 await，setup 不能 async
await retrieval.ensureReady()           // 应用最新配置；disabled 返回 null，异常带 code
retrieval.status()                      // 同步 {enabled,ready,initializing,lastError,pending}
await retrieval.health()                // 能力、空间、代际、角色探针、任务、outbox、reranker
await retrieval.prepareContext(ctx)     // 模块已注册 api.prepareContext，主线程无需重复注册
retrieval.contextFor(chat, sessionId)    // 同步 string；每次复查 repo.get/证据/范围/epoch
await retrieval.recall({query,limit?,category?,subject?,from?,to?}, context)
await retrieval.queryImages({query?,occurrenceId?,limit?}, context)
await retrieval.dispose()               // 幂等，取消网络/任务，等待 tracked 工作，关闭 worker
```

context 的字段为 `{account,chatId,actorId,personaId,requestId,signal?,assertActive?}`。普通调用必须关联真实 request，验证请求来源账号/聊天/作者、未撤回、未取消和当前 epoch。工具范围来自 hub turn，忽略模型伪造的 scope/account/chat。可信管理路径可用 `authority:'owner-panel'` 且 actorId 等于当前 ownerQQ。

`prepareContext` 接受宿主 `{chat,chatId,sessionId,text,account,persona,signal,isCurrent,...}`，预热完成后，contextFor 保持同步；缓存不因 Hook 在 finally abort 执行 signal 而被误清空，使用 isCurrent/epoch 和最终来源指纹门卫。主事实模块自身的 context 注入由主线程安排，避免重复注入。

## 图片与 history_references

模型工具 `recall_images({query?,occurrenceId?,limit?})` 返回：

```js
{ ok:true, scope, channels, degraded, candidateCount, truncated,
  hits:[{ id, occurrenceId, assetId, sourceActor, sourceMessageId,
    generatedJobId, generationId, generation, contentHash, scope, description,
    score, channels, sourceRevision, rerank? }] }
// 普通消息图 generation=null；生成图 generation={jobId,parentJobId,sourceKind:'generated'}
```

score 为 RRF 分数；rerank.score 是独立模型评分。结果只包含已存在的 occurrence，不把检索相似度视为用户选择。工具不返回原始 image 对象、data URL、字节或本地路径。

生图接线：

```js
// 用户/模型显式选择 history_references:[{occurrenceId,role}]
const reference = await retrieval.materializeReference({occurrenceId,role}, context)
// {assetId,occurrenceId,sourceMessageId,sourceActor,generatedJobId,generationId,
//  generation,contentHash,scope,description,role,selectionReason}

// 排队准备/发送前再次同步调用；不能仅相信早先检索结果或原始 assetId。
const current = retrieval.assertReferences([reference], context)
const one = retrieval.getImageReference(occurrenceId, context) // 同步 gate，role='reference'
```

materializeReference 不创建新资产或新的出现记录：校验受管文件后返回已有标识。普通请求只能引用 `sourceActor === context.actorId` 的图；生成图的 sourceActor 来自 `jobs.actor_id`，不能拿 bot 的发送者身份替代原任务发起者。owner-panel 才可显式跨作者。跨聊天仍必须经 `memory.shareGroups` 的 image 类别授权；同资产字节不扩大 occurrence 权限。来源消息撤回、资产失效/改变、谱系丢失、范围/作者变化立即拒绝。原始 URL/assetId 不能作为图搜输入或绕过历史引用门卫。

`createImageSourceRepository({storage,getPolicy,getMediaAnalysis})` 的 `getMediaAnalysis()` 返回当前 media-memory 模块接口。内置模块已通过 `api.use('media-memory')` 接线。读取 `analysis.mediaMemory.result` 时先要求 `settings().enabled===true`，再同步调用 `visible({chatId:来源聊天,occurrenceId})`，复查 blocked 作者、maxAge、源消息内容/范围变更和 withdrawn/recall。结果必须匹配当前 occurrence/account/chat/message/asset 与落库投影；接口缺失、抛错或返回 Promise 都隐藏描述/OCR。原图引用继续受独立 occurrence/撤回/作者门卫约束。禁用单条分析撤销其文本；restore 只接受 producer 恢复的有效 human 说明，模型结果保持空。`analysisRevision` 进入索引指纹，同毫秒恢复人工说明也使用新向量身份。

若在内核发送阶段 request 已关闭，主线程应使用自己保留的可信任务范围重新执行相同来源门卫，不能伪造一个普通有效请求。本模块的普通 context API 会拒绝 closed/expired 请求。

## Panel routes

宿主实际路径统一加 `/aurabot/api`。全部使用已认证的 owner panel；本模块额外要求 botQQ/ownerQQ 已配置。范围输入使用 `chatId,personaId`；账号取当前配置，传错 account 会拒绝。无写配置路由，仍由 core/config 保存。

| 方法 | `/retrieval/...` | 输入 | 成功返回 |
| --- | --- | --- | --- |
| GET | schema | 无 | `{ok,schema,defaults,secretFields}` |
| GET | status | 无 | `{ok,enabled,ready,initializing,lastError,automaticProbe:false}` |
| GET | health | 无 | `{ok,enabled,index,roles,capabilities,jobs,outbox,reranker,...}`；禁用时精简状态 |
| POST | query | `{chatId,personaId?,query,limit?,category?,subject?,from?,to?}` | `{ok,hits,scope,channels,degraded,candidateCount,truncated}` |
| POST | images | `{chatId,personaId?,query?,occurrenceId?,limit?}` | 同上，图片来源格式 |
| POST | reference/materialize | `{chatId,personaId?,occurrenceId,role?}` | `{ok,reference}` |
| POST | probe | `{roles?:['text','image','joint']}` | `{ok,jobId,state}` |
| POST | rebuild | `{role?,chatId,personaId?,generation?,activate?}`，也接受 `scopes:[{chatId,personaId?}]` | `{ok,jobId,state,account,coverage:'account',scopeCount}` |
| GET | jobs | `{limit?:1..100}` | `{ok,items}`，当前账号任务及探针 |
| GET | job | `{id}` 或 `{jobId}` | `{ok,job}` |
| POST | cancel / retry | `{jobId}` | `{ok,job}`，显式 retry 可重试 failed/cancelled，受 maxAttempts 限制 |
| POST | sync | `{chatId?,personaId?}` | `{ok,scanned,accepted,jobs}`，扫描一轮、投递有限批次 |

错误为 `{ok:false,code,message}`。配置/映射/范围等校验返回安全说明；网络响应、密钥、文件系统异常路径不返回。job.error 保留错误 code。queued/running/succeeded/failed/cancelled 是持久任务状态。

面板 rebuild 输入聊天只用于校验发起范围；实际操作是 owner 专用的当前机器人完整 space 重建。通过 `scopePage(account,{cursor,limit})` 枚举该账号的事实/图片范围，并纳入同 space 已有索引引用的范围（含待清理来源），以 exact-owned 分页读取，避免跨聊天共享导致重复或范围扩张。最多 256 个范围，超限报 SOURCE_LIMIT。若该 space 的已有引用包含其他账号，返回 REBUILD_ACCOUNT_CONFLICT；不探针、不删除外账号记录、不切换原代际。队列执行时重新发现范围并核对当前账号，账号变化中止。底层 `service.rebuild({scopes,...})` 仍要求调用方明确给全覆盖；内置面板改用 `service.rebuildAccount({account,authority:'owner-panel',scopes?,role?,generation?,activate?})`。此操作未注册为普通聊天工具。

## 编码用量回调

`createMemoryVectorService({repo,imageRepo,config,getAccount?,onEvent?,onUsage?})` 接受构造回调，不向持久配置/schema 放函数。内置模块调用 `api.core.usage?.record(entry)`；没有账本也可运行。每次实际 encoder HTTP 尝试一条记录，单条/批量/重复探针分别计数，跳过的幂等索引不计数；status 代表 HTTP 成功/失败（succeeded/failed），不代表整个探针已通过。

entry 仅含 `id,service:'embedding',model,role,account,chatId,requestId,status,billing:'unknown',startedAt,durationMs,inputTokens,outputTokens,cachedTokens,inputCount,inputChars,credits,amount,currency`。后台编码关联来源 scope，跨聊天批次 chatId 为 null；查询和 prepareContext 透传可信 requestId。OpenAI 兼容响应只提取明确的 `usage.prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens` 非负整数；固定 HTTP 未声明 usage 映射时保留 null。inputChars 是实际发送文本（含 prefix）的 JS 字符长度，图片不按 base64 推算。未知 tokens/credits/amount/currency 为 null，不保存 prompt、图片数据、URL、密钥或响应正文，账本异常不改变检索结果。

## 独立 reranker

只在启用且有文本查询/可见候选时调用；初始化、健康检查、embedding probe 和 rebuild 不调用它。没有 embedding space/dims，不比较向量。

固定协议 `fixed-rerank-v1`：完整 endpoint，POST JSON `{model,query,documents:string[]}`，apiKey 用 Bearer。响应 `{results:[{index,score}],model?}` 必须覆盖全部输入，索引为不重复的 0..N-1 整数，score 为有限数字，可选 model 必须匹配。按 score 降序，同分保留原融合次序；只重排融合结果前 maxCandidates，尾部保留融合顺序。

候选在出站前经过当前 repo.get 门卫，返回后再次检查当前 source/evidence 指纹。输入超字符预算、并发/每分钟调用预算耗尽、超时、非法响应等回退原融合排序，并返回 `degraded:[{channel:'reranker',reason:code}]`。只接收评分，不接受远端返回的替代正文/ID。

budget 是每个运行实例的滚动 60 秒请求次数、总字符数和并发上限，失败尝试也计数，0 次/分钟完全阻止调用；重启会清零计数。它不是计费金额上限，也未接全局 Planner 预算。无独立自动测试请求。

## 持久增量与分页边界

启用后在主库创建本模块的 `retrieval_source_outbox/scans/clock/discovery` 表和命名触发器，不改主库 user_version 或事实源码。事实、证据、tombstone、消息、occurrence、asset、生成任务与谱系变更在原来源事务内登记 outbox。事务回滚会同时回滚登记。仅在派生 worker SQLite 确认 enqueue 持久化之后，按 outbox version CAS 标为 accepted；accepted 代表持久接收，不代表已编码成功。无跨数据库原子事务，崩溃窗口使用幂等键重放。

首次范围发现、旧数据补漏、扫描游标持久化；每次 tick 每范围只读一页，并在页面之间让出事件循环。完整范围周期扫描也能发现时间到期/文件失效，内容指纹避免重复编码。无探针的存活记录留 pending；删除先由事实/图片源门卫屏蔽，再异步清理索引。

来源 page 在 SQL 内限制 account/chat/persona/shareGroups/category，再由 memory.getFactsByIds/get 或 imageRepo.get 执行最终门卫。增量/重建可以流式超过 maxCandidates，引用清理也分页；单次召回仍最多 maxCandidates 个候选（默认5000，最大10000），扫描预算最多约4倍该值；达到预算返回 truncated=true/SOURCE_LIMIT，不能声称全范围召回。主库每页的同步 SQL/少量资产 stat 仍在主线程，完整历史扫描/单次查询无阻塞能力没有夸大。

重建维持旧 generation 服务，最多追赶三轮稳定检查点后原子切换；必须覆盖该 space 已有所有来源，否则覆盖校验拒绝发布。activate:false 只生成 ready 代；高级内核调用 `state = await ensureReady(); state.service.index.switchGeneration({spaceId,generation})` 可显式发布。

## 验证范围

`node --test --test-timeout=30000 test/vector*.test.js test/embedding*.test.js` 使用真实临时 SQLite、真实 modules/Hook runtime、FakeDSH 和真实 loopback HTTP mock。没有调用外部付费模型，没有本任务的真实 Qdrant/真实 DSH/QQ 验收声明。10k/100k 底层离线基准见 `../benchmark-results.json`，不是完整事实物化/网络模型的性能承诺。

Cloudflare 原生 REST 映射说明见 [CLOUDFLARE-MAPPING.md](../../embedding/CLOUDFLARE-MAPPING.md)。账号/token 与真实模型测试由主线程负责，本任务仅做官方文档核对及本地 HTTP mock。
