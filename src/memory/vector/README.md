# VectorIndex / Embedding 接口（本次独立工作包）

范围：本目录、`../embedding/`、`test/vector*.test.js`、`test/embedding*.test.js` 和 `scripts/benchmark-vectors.mjs`。不修改 memory service、宿主、配置或主库迁移。Node 自带 `node:sqlite` + `worker_threads`，无新增 npm 依赖。工作区当前 Node 24.18.0 已运行；实际 DSH 的加载/打包仍由主代理联调。

## 最小接入

```js
import { createVectorIndex } from './vector/index.js'
import { OpenAITextEmbedding } from './embedding/index.js'

const space = {
  spaceId: 'text:my-model:r1',
  provider: 'my-provider', endpointIdentity: 'embedding-profile-1',
  model: 'configured-model', revision: 'r1', dims: 384,
  metric: 'cosine', modalities: ['text'], normalization: 'l2',
  prefixes: { query: 'query: ', document: 'passage: ' },
  preprocess: { text: { version: '1', unicode: 'NFC', trim: true } },
  protocolMappingVersion: 'openai-text-v1',
}
const index = await createVectorIndex({
  backend: 'local', path: '/dedicated/index-vectors.sqlite', spaces: [space],
  cacheBytes: 8 * 1024 * 1024, pageSize: 256, maxPending: 32,
})
const encoder = new OpenAITextEmbedding({
  space, baseUrl: 'http://configured-provider/v1', apiKey: 'from-secret-store',
  // Only enable if the chosen provider/model supports the dimensions parameter.
  sendDimensions: false,
  // Load the prior baseline from the service's persisted embedding-space metadata.
  probeBaseline: savedBaseline,
  onDrift: change => index.markNeedsRebuild(change),
})
const admission = await encoder.probe()
// Persist admission.baseline outside this adapter, together with its fixed probe inputs.
const encoded = await encoder.encode({ inputs: ['要索引的内容'], purpose: 'document' })
await index.upsert({
  spaceId: space.spaceId,
  records: [{
    id: 'fact:business-id',
    vector: { spaceId: encoded.spaceId, fingerprint: encoded.fingerprint, vector: encoded.vectors[0] },
    sourceRevision: 1, scopeRevision: 1,
    account: 'qq:bot', chat: 'group:123', category: 'fact', persona: '',
    metadata: { sourceId: 'source:123', occurrenceId: 'occurrence:456' },
  }],
})
const q = await encoder.encode({ inputs: ['检索词'], purpose: 'query' })
const result = await index.query({
  spaceId: q.spaceId,
  vector: { spaceId: q.spaceId, fingerprint: q.fingerprint, vector: q.vectors[0] },
  filter: { account: 'qq:bot', chat: 'group:123', category: 'fact', personas: ['', 'selected-persona'] },
  authorizedIds: ['fact:business-id'], // Optional additional intersection; [] means zero hits.
  limit: 20,
})
// Revalidate sourceRevision/scopeRevision, tombstone and visibility in the fact store
// immediately before using hits. The vector index is a derived index, not the authority.
await index.close()
```

`createVectorIndex`、全部索引方法均为异步。factory 会注册 `spaces`；也可随后 `await index.registerSpace(space)`。所有目录必须由调用者显式配置，adapter 不读取 Aurabot 真实 data。向量数据库必须是独立文件，不能指向事实主库。SQLite 独占连接使同一文件只有一个 worker；异常退出时 OS 释放锁，重新 factory 即可恢复。主线程导入所有源文件无数据库/worker 启动副作用；worker 入口用 `if (parentPort)` 保护。

## 统一操作与权限

| 方法 | 输入 / 结果 |
| --- | --- |
| `upsert` | `{spaceId, generation?, records}` → `{accepted, skipped, spaceId, generation}`；每批最多 256 条/16 MiB 向量 |
| `query` | `{spaceId, vector, filter, authorizedIds?, limit?}` → `{hits, spaceId, generation, stats}`；limit 1..1000，默认 10 |
| `delete` | `{spaceId, ids, sourceRevision}` → `{deleted, skipped}`；每批最多 10000 个 ID，跨本空间所有代际 |
| `health` | 后端、空间与当前代、needsRebuild、待同步项、缓存使用量、worker 内存 |
| `rebuild` | `{spaceId, generation, records, batchSize?}`；records 是逐记录 sync/async iterable；完成时仅 ready，不自动发布 |
| `switchGeneration` | `{spaceId, generation, expectedGeneration?}`；只切换覆盖当前有效源版本/权限版本的 ready 代 |
| `markNeedsRebuild` | `{spaceId, reason}`；持久锁定该空间写入，旧索引仍可读取；新编码配置必须建立新 spaceId |
| `close` | 关闭 worker/连接；幂等 |

hit 字段为 `id, score, spaceId, generation, sourceRevision, scopeRevision, account, chat, category, persona, metadata`。score 在同一空间内越大越相近：余弦、点积、负欧式距离。业务只能使用同空间排序/排名融合，不能混加不同模型分数，也不能把视觉相似当作身份鉴定。

record 的业务 ID 在一个 space 内全局唯一，应包含需要的业务命名空间。scope 字段可放顶层，也可在 `scope` 内；顶层优先。`sourceRevision` 为非负安全整数；`scopeRevision` 默认 0，但服务应显式维护它。source/scope 两个版本分别不允许倒退。版本对相同但内容不同会拒绝整批；可见范围变化必须提升 scopeRevision。metadata 最多 16 KiB，向量必须有限、非零且维数相等，落盘为 little-endian Float32。

`filter.account` 必填，必须再带 `chat`、`chats` 或 `scopes`。支持 `category/categories`、`persona/personas`；persona 未提供时只查询空 persona（角色无关记录），绝不默认包含所有人设。空列表授予空集合。省略 category 表示这些已授权聊天内的所有类别，使用共享策略时应显式限制类别。

不同类别的跨群共享使用相关联的 grants，避免把“群 2 共享图片”放大成“群 2 共享事实”：

```js
filter: {
  account: 'qq:bot',
  scopes: [
    { chat: 'group:1', category: 'fact', persona: '' },
    { chat: 'group:2', category: 'image', persona: '' },
  ],
}
```

scopes 与平铺 scope 字段互斥；最多 256 grants。平铺各字段是明确授权的笛卡尔积，列表最多 1000 项。`authorizedIds` 是进一步求交，最多 100000 项。该 filter 必须由 memory service 根据可信请求上下文生成，不能直接接受模型生成的权限。

本地在 SQL 中先按范围、版本和授权 ID 集合筛选，再分块精确 top-K；不是 ANN。分页同时受 pageSize 和约 4 MiB 页面预算约束，Float32 LRU 默认 8 MiB，SQLite page cache 8 MiB，不把整个空间加载到内存。RPC 队列有背压，超限返回 `VECTOR_BACKPRESSURE`，由持久任务队列退避重试。

## 重建、删除与持久化边界

每个空间初始代为 `g0`。rebuild 的每个批次独立提交，批次之间旧代继续服务。新版本写入同时进入 active/building/ready 代；同版本快照只补目标代。完成时检验所有当前未删除 head 的向量覆盖，遗漏会报 `INCOMPLETE_GENERATION`。切换在 SQLite 事务内原子更新 active 指针；失败/中断可用同一 candidate generation 和完整快照重跑。已 retired 的代不能重新使用该名字。旧代保留用于诊断，不自动回收磁盘。

delete 先持久化 tombstone 并删除所有代的该 ID。比当前源版本旧的删除请求跳过；一旦 tombstone 成功，该业务 ID 在该空间内永久不再接受 upsert，即使迟到任务声称更高版本。需要恢复为新业务 ID。一个事实进入多个 embedding spaces 时，service 必须向每个 space 传播删除，同时在事实库先屏蔽读取。向量层没有事实主库事务权限，不能代替主库 outbox/删除屏障。

spaceId 的全部契约不可变，包含提供方、端点身份、模型/修订、维数、度量、归一化、模态、前缀、预处理和协议映射。**相同维度不表示兼容。** 切换模型时注册新 spaceId、重新编码/重建；service 在主库事务中一起选择新的“查询编码器 + spaceId”，不能只换编码器。这里的 switchGeneration 管理一个 space 内的索引代际，不隐式把两个编码空间视为同一空间。

## Qdrant HTTP adapter

```js
const index = await createVectorIndex({
  backend: 'qdrant', path: '/dedicated/qdrant-sync-journal.sqlite', spaces: [space],
  baseUrl: 'http://localhost:6333', apiKey: 'from-secret-store',
  collectionPrefix: 'aurabot_instance_1', timeoutMs: 15000,
})
```

使用官方 REST `points/query`、keyword payload indexes、UUIDv5 points、`wait=true&ordering=strong` 写入以及同请求 delete/create alias 切换。collection 名包含 space fingerprint 与 generation 的哈希；业务 ID 确定性映射为 UUID，原 ID 保留 payload。远端必须支持 Query API（Qdrant 1.10+）；本轮按当前官方 API 文档核对，未用真实 Qdrant 验收。

每个远端命名空间只能由一个本适配器实例写入；collectionPrefix 应为实例专用。journal 使用 worker SQLite，保留全量派生 Float32 向量和版本/tombstone 以及有界批次读取的同步 outbox，因此磁盘同时保存本地派生副本与远端索引。它不是事实主库，也不提供跨进程/跨主库/Qdrant 的分布式事务。

HTTP 超时/失败时日志不确认，后续 upsert/query/delete 重试同步；同 ID 的重放幂等。删除与权限更新先进入日志，HTTP 失败时 query 拒绝返回未追赶的索引。HTTP 查询本身包含账号、聊天、类别、人设、space、generation 和可选 has_id 预过滤；返回后另核对本地最新版本，这不是全库取回后过滤。调用 service 仍需对事实源进行最终校验。

发布前持久化切换意图，然后原子改变远端 alias，最后更新本地代。响应丢失或进程重启重放该意图，不能把未确认的半切换当作成功。适配器查询使用冻结的具体 collection，避免 alias 与本地指针短暂分离时把查询向量发往错误代。HTTP 失败明确报错，无服务时不会假装使用本地结果完成 Qdrant 验收。

## 验证与基准

```powershell
node --test test/vector-local.test.js test/vector-qdrant.test.js test/embedding-http.test.js
node scripts/benchmark-vectors.mjs --output src/memory/vector/benchmark-results.json
```

测试只使用随机 OS 临时目录和 127.0.0.1 HTTP 服务。HTTP mock 验证请求/响应、鉴权头、预过滤、重启重放、版本与切换失败路径，不是实际 Qdrant 或真实模型验收。

benchmark 默认每空间 10000/100000 条、384D 文本和 512D 图片空间；查询各 30 次，分别测 1% 授权集合和全授权集合。报告含 p50/p95/p99、worker 重开/首查、索引吞吐、后台增量写入时查询、进程峰值 RSS、worker 内存、控制线程事件循环与磁盘体积。数据构造和 SQLite 分别在 worker，控制进程降低优先级，顺序批次间暂停 2ms。临时数据库结束即删，结果 JSON 留在本目录。

“冷启动”仅指 worker/SQLite 重开，**未清 OS 文件缓存**；随机合成数据没有语义 recall/MRR 意义。性能数字只针对当前机器/当次负载，实际 DSH 并发、真实图片向量和 Qdrant 容量尚未验收。见 `benchmark-results.json` 的原始测量参数与记录。

协议来源（仅官方）：[Qdrant points/UUID](https://qdrant.tech/documentation/concepts/points/)、[Query API](https://api.qdrant.tech/api-reference/search/query-points/)、[payload filtering](https://qdrant.tech/documentation/search/filtering/)、[collection aliases](https://qdrant.tech/documentation/manage-data/collections/)、[OpenAI embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。
