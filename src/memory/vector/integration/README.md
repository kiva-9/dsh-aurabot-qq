# MemoryVectorService 接线契约

本文记录底层服务 API，入口 `src/memory/vector/integration/service.js`（也可用本目录 `index.js`）。完整内置模块已实现于 `src/modules/retrieval/index.js`；其同步 setup、默认关闭的配置、自动 Hook/tool/panel 接线、历史图片引用与主库 outbox 契约见 [MODULE-API.md](./MODULE-API.md)。主线程负责 builtin 注册、配置持久化和 UI；本写集未修改 memory 主文件、host、config、client。

## 配置 schema

导出 `MEMORY_VECTOR_CONFIG_SCHEMA`（JSON Schema 2020-12，apiKey 标记 writeOnly/x-secret）和 `validateMemoryVectorConfig(config)`。未知配置字段拒绝；模型、模态、space 与固定映射的语义约束还会在 factory 中检查。一个可替换参数后使用的最小配置：

```js
const config = {
  version: 1,
  index: {
    backend: 'local',
    path: 'D:/replace-me/vector-index.sqlite', // 独立派生索引/任务文件，不能指向事实主库
    cacheBytes: 8 * 1024 * 1024,
    pageSize: 256,
    maxPending: 32,
  },
  roles: {
    text: {
      type: 'openai-text', baseUrl: 'http://configured-endpoint/v1', apiKey: 'secret-store-value',
      sendDimensions: false, timeoutMs: 15000, maxResponseBytes: 16 * 1024 * 1024, maxBatch: 128,
      space: {
        spaceId: 'text:configured-model:deployment-1', provider: 'configured-provider',
        endpointIdentity: 'embedding-profile-1', model: 'configured-model', revision: 'deployment-1',
        dims: 384, metric: 'cosine', modalities: ['text'], normalization: 'l2',
        prefixes: { query: '', document: '' },
        preprocess: { text: { version: '1', unicode: 'NFC', trim: true } },
        protocolMappingVersion: 'openai-text-v1',
      },
    },
  },
  queue: { batchSize: 32, maxPending: 256, maxAttempts: 3 },
  retrieval: { maxCandidates: 5000, lexicalLimit: 80, vectorLimit: 80, rrfK: 60, limit: 10 },
}
```

参数都是示例，须按实际服务配置。`roles.image` 使用仅 image 的空间，`roles.joint` 使用 text+image 的共同空间，两者 `type:'fixed-http'`，需要 `mapping`、`samples.image`；joint 另需 `samples.text`。要启用联合文字搜图还必须提供 `alignmentPairs` 正/负样例并通过探针。映射的精确字段见 [编码契约](../../embedding/README.md)。每个 role 使用不同 spaceId。

`index.backend:'qdrant'` 时必须配置 `baseUrl`，可配置 `apiKey/collectionPrefix/timeoutMs/maxResponseBytes`；`path` 仍必填，用于专用 SQLite worker 同步日志、任务和探针基线。凭据只进入 HTTP 请求，不进入 health/job 输出。factory 可在远端暂不可达时保留持久日志和词法降级，health 报 remoteAvailable=false；不伪造 Qdrant 已验收。

## 初始化与宿主 Hook

```js
import { createMemoryVectorService } from './memory/vector/integration/service.js'

const vectors = await createMemoryVectorService({
  repo,       // src/memory/store.js 的 createFactRepository 返回值
  imageRepo,  // 可选，见下方图片接口
  config,
  onEvent: event => diagnostics.record(event), // 可选；事件不含密钥/原始向量
})
await vectors.initialize({ probe: true, start: true })

// 最新 api.prepareContext 参数可以直接传入：
// {chat,chatId,sessionId,text,account,persona,personaSnapshot,signal,isCurrent,...}
api.prepareContext(ctx => vectors.prepareContext(ctx))

// resolveScope 必须使用宿主当前账号和当前 turn persona；不要信任模型字段。
api.context(({ chat, sessionId }) => {
  const scope = resolveScope({ chat, sessionId })
  return vectors.contextFor(chat, sessionId, { scope }) // 同步 string，永不返回 Promise
})
api.onDispose(() => vectors.close())
```

如果 prepare 传入显式 `epoch` 或 `conversationEpoch`，同步读取必须传同值：`contextFor(chat, sessionId, {scope, epoch})`。当前主线程 Hook 未传 epoch 时，使用 `isCurrent()` 的模块/会话 epoch 门卫、每 session 单调 ticket 及 scope 隔离；新 prepare 立即清掉该 session 的旧命中，旧请求迟到不能回填。

`signal` 用于终止预热的网络请求。当前 Hook runtime 在正常完成的 finally 也会 abort 执行 signal，因此成功缓存优先保存 `isCurrent` 而不是把该执行 signal 当作缓存生命周期。没有 `isCurrent` 的独立调用才使用 signal 的存活状态检查。缓存最多 64 个 session、TTL 60 秒，不设常驻计时器；每次同步读取都重新 `repo.get(id, scope)`，比较当前 source/evidence fingerprint，失效证据、权限变化、删除、角色变化立即丢弃。

repo 需要 **同步** `list(scope, options?)`、`get(id, scope)`、`revision(scope)`；实际 memory repo 的 get 已执行证据受众交集、tombstone、有效期和 persona 检查。可选 `visibilityStamp(scope)` 用于跨共享群的重建检查点。无论缓存或向量层是否滞后，均以该 repo 为最终门卫。异步 get 不会被误当对象使用，最终同步门卫会拒绝它。

`prepareContext` 还接受显式 `{scope,sessionId,query,epoch?,signal?,isCurrent?,limit?}`；返回 `{ready,count,degraded,epoch}` 或 `{ready:false,stale:true|aborted:true}`。它不会生成模型回复，不会把 Promise 注入上下文。

## 查询与图片

```js
const result = await vectors.recall({
  scope, query: '提神饮料', limit: 8,
  category: 'fact', subject: 'user-id', from: 0, to: Date.now(), signal,
})
// result = {hits,scope,degraded,channels,candidateCount,truncated}
// hit = {id,kind,score,channels,snapshotHash,sourceRevision,it}
// channels 中记录各通道 rank 与原始 score；score 为 RRF，不是模型置信度。

const images = await vectors.queryImages({
  scope, query: '红色裙子', image: { url: 'https://authorized-reference/image.png' }, limit: 8,
})
// image 可省略；使用 text 时，走描述/OCR/当前 occurrence 说明和已验收的 joint 文本通道。
// image 命中另外包含 assetId/occurrenceId/sourceMessageId/generationId。

// 工具拿到结果后若还做了异步重排/等待，使用前再次同步核验：
const currentHits = vectors.finalGuard(result.hits, { scope })
const currentImages = vectors.finalGuard(images.hits, { scope, kind: 'image' })
```

实际召回：repo 当前可见候选 → worker BM25 与文本/视觉/联合向量查询 → RRF 去重融合 → 最终 repo get 门卫。向量调用之前同时传递 scope filter 和精确当前版本 ID 集合，不能先全库 top-K 再筛权限。网络/探针失败时保留真实词法结果并返回 degraded；joint 未通过已标注对齐样例时禁用直接跨模态查询。

支持可选 `repo.page(scope,{cursor,limit}) => {items,nextCursor,done,scanned}`，内置来源包装器已经实现 SQL 范围预过滤和页面之间让出主线程。增量/重建、引用清理均可分页超过 maxCandidates。单次查询默认候选上限 5000、可配置 1..10000，并限制扫描预算，超过则标记 truncated/降级原因。未提供 page 的独立 repo 仍使用有界 list，过大重建拒绝部分发布。没有承诺 10 万事实在主线程物化无阻塞；10 万向量性能是底层 worker 的独立测量。

imageRepo 也必须提供同步 `list(scope,{limit}) / get(occurrenceId,scope) / revision(scope)`，读时自行完成当前可见性/证据门卫；可选 page。真实 storage 包装器还提供异步 `loadImage(id,scope,{signal})`，列表只带 `image:{assetId}`，编码前才取得已校验的 data URL。独立 repo 也可直接提供以下不可变 URL 形式，每条数据按 occurrence 分开：

```js
{
  id: 'occurrence-id', occurrenceId: 'occurrence-id',
  scope: { account: 'qq:bot', chat: 'group:123', persona: '' },
  revision: 1, assetId: 'shared-byte-asset-id', contentHash: 'sha256-of-processed-image',
  image: { url: 'https://authorized-immutable-asset/image.png' }, // 或映射声明的 data URL
  preprocessRevision: 'frame-and-resize-v1',
  description: '纯视觉描述', ocr: '识别文字', chatText: '本 occurrence 可见的附加说明',
  sourceMessageId: 'message-id', generationId: 'optional-lineage-id',
}
```

不同 occurrence 即使引用同一 asset 也独立编码/授权；返回时只展开本次可见的 occurrence。使用内置包装器时会验证受管文件 MIME/长度/hash/来源；使用自定义 URL repository 时，不验证或保证该 URL 的字节内容未变化。

## 变更投递、后台探测与重建

```js
// factory 不自动调用模型。initialize 默认 probe + start；也可显式后台初始化：
vectors.start()
const probeJob = await vectors.enqueueProbe({ roles: ['text'], idempotencyKey: 'probe-run-1' })

// 主库事务提交之后，从主库持久 outbox 投递；幂等键应含该次来源/范围版本。
const job = await vectors.enqueueIndex({ scope, ids: [factId], kind: 'fact', idempotencyKey: 'fact-change-42' })
await vectors.enqueueIndex({ scope, kind: 'image' }) // 本范围图片描述/图像/joint 所有已配置 role

// 返回 jobId 即可让 panel 展示，网络编码及批次写入在后台推进。
const rebuild = await vectors.rebuild({
  role: 'text', scopes: [scopeA, scopeB], generation: 'g-new', activate: true,
})
const status = await vectors.job(rebuild.jobId)
const recent = await vectors.jobs({ limit: 50 })
await vectors.cancelJob(job.jobId)
await vectors.retryJob(job.jobId) // 只重试 failed/cancelled，受 maxAttempts 限制
await vectors.waitForIdle() // 测试/关停等待；普通聊天不要等待全队列
```

job 状态是 queued/running/succeeded/failed/cancelled，持久化在 worker SQLite。异常中断的 running 在重启恢复为 queued；关闭时未完成任务也释放回 queued。单执行器、显式失败重试、队列背压，避免无界并发和后台自动重复付费。相同幂等键必须对应相同 payload。initialize 会装入已持久化探针 baseline，探测成功自动保存；漂移持久标记 needsRebuild 并禁止该空间编码/写入。

向量业务 ID 包含来源快照指纹，metadata 保留原 sourceId/sourceRevision。这样事实人工恢复/修订会形成新版本 ID，旧向量 tombstone 仍永久有效。每个编码结果写入前后重新读 source；源在 HTTP 编码期间删除/变更时不提交迟到结果。首次加载/更换角色配置的重建范围必须覆盖该空间已索引的所有来源；底层覆盖校验会阻止漏范围发布。

重建先探测，旧 generation 保持查询；snapshot 后最多追赶三轮增量，检查 repo/imageRepo revision 是否到达稳定检查点，再原子 switch。持续变动、缺数据、漂移或协议错误均保留失败状态和旧代，不发布半成品。`activate:false` 只建 ready 代，主线程可以随后显式 `vectors.index.switchGeneration({spaceId,generation})`。模型契约变化必须换 spaceId；现有 service 配置不可原地替换旧空间契约，需主线程管理角色配置/新实例生命周期。

删除传播顺序必须是**事实/图片主库先屏蔽读取，再清理派生索引**：

```js
repo.remove(factId, { scope, actorId, reason })
await vectors.deleteSources({ scope, ids: [factId], kind: 'fact' })
```

若 source.get 仍返回可读记录，deleteSources 报 SOURCE_STILL_VISIBLE，避免把索引清理误当作事实删除。查询和 context 的最终门卫不依赖清理是否完成。内置模块的 source-outbox.js 通过自身命名触发器实现主库事务内登记，派生持久队列收妥后按版本 CAS accepted；没有跨库单事务。独立使用 service 的调用者仍需提供自己的来源 outbox。

## Panel 与验收边界

底层 Panel 可使用 schema/validate、health、probe/enqueueProbe、rebuild、jobs/job/retryJob/cancelJob。health 返回后端、空间/generation、漂移、探针状态、当前能力、缓存、reranker 和任务；不返回 apiKey。内置模块已经注册 `/retrieval/*` 路由，须使用宿主已认证的 owner panel，详见 MODULE-API.md。

可选 top-level `config.reranker` 独立使用固定 HTTP query/documents → index/score 协议，默认关闭。融合后对当前可见候选重排，失败/预算耗尽保留融合结果和 degraded，最后仍检查来源指纹。配置字段和精确 HTTP 契约见 MODULE-API.md。

测试：`node --test test/vector*.test.js test/embedding*.test.js`。整合测试使用真实临时 SQLite memory repo 和真实 loopback HTTP mock，覆盖混合召回、降级、图片 occurrence 隔离、来源/证据删除、编码/查询竞态、同步缓存门卫、信号/epoch、持久任务、漂移与后台重建。没有声称真实 Qdrant、真实 embedding 模型或 QQ/DSH 联调通过。
