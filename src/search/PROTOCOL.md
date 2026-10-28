# WP5 搜索接入协议

实现范围：`src/search/*.js`、`src/modules/search/index.js`、`test/search*.test.js`。不注册全局配置、module registry 或 UI；由主线程集成。没有新增依赖。SQLite 使用传入的 `storage.db`；导入文件不会打开真实数据库或发起网络请求。

## 注册与配置

注册 `src/modules/search/index.js` 的 default module。`files` 是精确的八个 JS 文件路径，供 loadLib/模块复制使用。

读取 `getConfig().search`，默认值在 `SEARCH_DEFAULTS`；模块不写配置。建议主线程注册以下字段，并将 `search.apiKey` 注册为 secret：

```js
search: {
  enabled: false,
  baseUrl: 'https://api.tavily.com',
  apiKey: '',
  maxResults: 5,
  timeoutMs: 30000,
  searchDepth: 'basic',
  extractDepth: 'basic',
  maxSearchRounds: 2,        // 硬上限 2
  maxToolsPerTurn: 6,       // 硬上限 6
  maxExtractUrls: 5,        // 硬上限 20
  maxCandidates: 6,         // 每一来源搜索最多下载 6 张
  maxSourcePages: 3,
  maxReferences: 3,         // 最多保留 3 张 verified；最多 3 次视觉审核
  visionReview: false,      // true 时调用 core.ask 的 vision 角色，可能产生模型费用
  maxConcurrent: 2,
  maxRequestsPerMinute: 20,
  maxRequestsPerDay: 100,
  maxResponseBytes: 2097152,
  maxPageBytes: 1048576,
  maxImageBytes: 10485760,
  maxImagePixels: 40000000,
  maxCacheBytes: 134217728,
  maxContentChars: 20000,
  maxRedirects: 4,
  readRetries: 1,
  cacheTtlMs: 900000,
  referenceTtlMs: 86400000,
}
```

未启用返回 `SEARCH_DISABLED`；缺 key/无效服务地址返回 `SEARCH_UNCONFIGURED`，不会用环境变量、模拟数据或其它服务兜底。baseUrl 是管理员信任的 API 端点，允许显式配置本机代理；工具参数不能传入或替换它。

## QQ 工具

| 工具 | 参数 |
| --- | --- |
| `qq_web_search` | `query`（1–400 字符）；可选 `maxResults/includeImages/timeRange/includeDomains/excludeDomains` |
| `qq_web_extract` | `urls: string[]`；可选 `query`，有 query 时正文类型是 targeted-chunks |
| `qq_reference_candidates` | `query` 或 `resultId`；可选 `entity:{name,work,version,kind}`，kind 是 fictional/object/public-person |

工具根据执行时的 `hub.turnActor(sessionId)`、`hub.turnRequests(sessionId)` 和当前 chat 构造身份。模型参数不能改 actor/account/chat/request/turn/baseUrl/key。缺少可绑定的 request ID 时明确拒绝；混合请求依赖 hub 的 `for_message` 选择具体 actor。回合第一条 request ID 是共享预算键，steer 追加请求和切换 actor 不会重置两轮搜索预算。

返回有界 JSON：`{ok,resultId,type,cached,budget,dataOnly,trust,factStatus,sources,candidates,failures,omitted,...}`。sources 包含完整 URL、citationId、最多 600 字符文本及 `pageRead/contentKind`。正文只在按范围读取的 result API 中返回。候选使用 `resultId + candidates[].id` 定位；**只有 `candidates[].status === 'verified'` 可以 materialize**。

不提供让模型自行设置 confirmed/verified 的工具。主线程给 `qq_draw_image` 增加 `reference_candidates:[{resultId,candidateId,role?}]` 后，逐个调用下面的 materialize 接口；不得根据模型声称“用户确认了”直接改候选状态。

## 模块服务与生图对接

`api.use('search')` 直接导出以下函数，同时也有 `.service`：

```js
const context = {
  account: String(getConfig().botQQ),
  chatId: chat.chatId,
  actorId: String(who.actorId),
  requestId: who.requestId,
  turnId: hub.turnRequests(sessionId)[0]?.id || who.requestId,
  signal,                    // 可选 AbortSignal
  assertActive() { /* 主调方检查请求仍有效、epoch 未变 */ },
}

await search.searchWeb({ query, includeImages: true }, context)
await search.extractPage({ urls, query }, context)
await search.searchImageCandidates({ resultId, entity }, context)
search.result(context, resultId)
search.history(context, { limit: 20, before, beforeId })

const ref = search.materializeReference({ resultId, candidateId }, context)
// 同步返回：
// { assetId, occurrenceId, role: 'identity', reason, resultId, candidateId }
// 可按明确的生图用途覆盖 role 为 identity/style/composition，保留 occurrenceId。
// occurrence 含 account+chat 的 image scope、来源页、图片 URL、抓取时间和审核信息。
// 主调方继续以相同 request/actor/chat scope 登记 image job。
```

服务方法抛出 `SearchError`；工具与面板包装为 `{ok:false,code,message,resultId?}`。网络成功返回 `{ok:true,result,cached,budget,requestId,turnId,dataOnly:true,factStatus:'unconfirmed'}`。`referenceBytes({resultId,candidateId},context)` 仅返回已审核且未过期的 `{buf,mime,candidate}`；`previewReference(...)` 允许预览已通过来源/文件检查但尚未审核的图片，不能因此视为可生成。

materialize 不会重新下载或生成图片，不读取任意文件路径，不调用记忆模块。重复调用复用已存在的 asset/occurrence；过期、跨账号/聊天、未审核、图片丢失均明确失败。scope 的可信来源是调用方，不应把模型或网页对象直接作为 context 传入。

## 面板 HTTP 协议

内置模块注册的实际前缀为 `/aurabot/api`。读接口使用 query，写接口使用 JSON body。除 status 外必须给 `chatId`；不能省略范围后列出全库。账号固定取配置 botQQ，操作者固定取配置 ownerQQ。面板权限沿用宿主现有的主人面板边界，不能把这些写接口暴露成未经认证的公共接口。

| 方法和路径（省略前缀） | 输入 | 成功返回 |
| --- | --- | --- |
| `GET /search/status` | 无 | `{ok:true,available,provider?}`，不可用含 code/message |
| `POST /search/query` | `{chatId,query,maxResults?,includeImages?,timeRange?,includeDomains?,excludeDomains?}` | 网络结果 envelope |
| `POST /search/extract` | `{chatId,urls,query?,resultId?}` | 网络结果 envelope；resultId 可继承同一主人的工作流预算 |
| `POST /search/references` | `{chatId,resultId?,query?,entity?}` | reference-candidates envelope |
| `GET /search/history` | `chatId,limit?,before?,beforeId?` | `{ok:true,list:[{id,type,query,scope,actorId,createdAt,fetchedAt,expiresAt,status,sourceCount,candidateCount,error?}]}` |
| `GET /search/result` | `chatId,id` | `{ok:true,result}`，包含 `expired` |
| `GET /search/reference/preview` | `chatId,resultId,candidateId` | 图片二进制、真实 MIME、nosniff、private/no-store；失败为 JSON |
| `POST /search/reference/confirm` | 见下方 | `{ok:true,result}` |
| `POST /search/reference/materialize` | `{chatId,resultId,candidateId}` | `{ok:true,reference:{assetId,occurrenceId,role,reason,resultId,candidateId}}` |

history 按 `(createdAt DESC,id DESC)` 排序。下一页携带末条的 `before=createdAt&beforeId=id`，同毫秒记录不会被跳过；limit 默认 20，最多 50。

人工确认的 body：

```json
{
  "chatId": "group:123",
  "resultId": "srch_...",
  "candidateId": "c1",
  "review": {
    "matchesTarget": true,
    "clear": true,
    "unobstructed": true,
    "singleSubject": true,
    "noWatermark": true,
    "reason": "人工核对了作品、版本和图片内容"
  }
}
```

前五项都必须是布尔值，reason 必填。全部 true 才为 verified；任一 false 记为 rejected。必须已有明确 entity.name、可靠来源关联、成功下载、至少 128×128 且未过期；人工确认不能绕过这些硬限制。确认只表示参考适用，`factStatus` 始终是 unconfirmed。

面板闭环：query（includeImages=true）→ references（resultId+entity）→ preview → 展示五项审核并提交 confirm → materialize → 用返回 ref 创建 image job。已由视觉审核通过的候选可以直接 materialize。面板不应把 needs_review/rejected 状态显示成“已确认”。

## 数据与约束

结果 discriminant 为 `web-search/page-extract/reference-candidates`。每条记录都有 `schemaVersion/id/provider/scope/actorId/requestId/turnId/query/createdAt/fetchedAt/expiresAt/cache/trust/factStatus`。sources 分为 web-hit/page-content；citations 持有 resultId/sourceId/URL；搜索 snippet 的 pageRead 必为 false，提取或实际静态页面检查才为 true。没有自动写入用户事实、记忆或画像的路径。

候选字段包含 `id/type/entity/sourcePageUrl/imageUrl/description/discoveredAt/fetchedAt/relevance/sourceCheck/download/visualReview/status/failure`。来源页未知时 sourcePageUrl 为 null，并有失败说明；不把图片主机或同名搜索命中冒充来源。通过静态 HTML 的 img/srcset/og:image 等实际图片链接核对关系，补用 Tavily Extract 的图片列表；仅有 provider score 或描述不能证明作品/版本。

视觉默认关闭；开启时通过 core.ask 的 vision 角色进行有界、无工具的结构化审核。仅 fictional/object 可自动审核；现实人物和未声明种类保留人工确认路径，不以人脸相似度认定现实人物身份。来源、低分辨率、格式、下载失败或结构化审核失败不会被默认为通过。

所有外部 URL 必须是 HTTP(S)、80/443 端口，无认证信息和本地路径；拒绝私网、回环、链路本地、保留地址、IPv4 映射/过渡 IPv6 和混合公私 DNS。解析结果固定到实际连接，每个重定向重新检查，禁止 HTTPS 降级。限制头部、声明大小、流式字节数、图片 MIME/签名/容器/尺寸/像素，拒绝 SVG/HTML 和压缩响应。只静态读取 HTML，不执行脚本、不 eval、不用页面/OCR 内容修改权限。

Tavily Extract 发送前用受限 HEAD（必要时 GET）预检跳转链，只接受请求过的返回 URL。第三方 Tavily 内部的网络解析/跳转不能由本机连接固定约束；本模块不把这种第三方抓取宣称为本地网络安全证明。实际来源页/图片下载始终走本机受限 transport。

两轮搜索、六次工具调用、每个来源搜索六次下载预算均在 SQLite 原子预留；失败也消耗已预留预算，不可通过并发、切换 actor、服务重建或重复使用结果 ID 重置。Tavily search/extract 都是计费 POST，不自动重试，不跟随带 key 的跳转；只有 GET/HEAD 的瞬时网络错误及指定临时 HTTP 状态有限重试。每分钟/UTC 日的全局 API 请求额度按服务/key 指纹保存，不保存 key 原文。

超时覆盖 DNS、连接、正文、回退、重试和候选流水线。AbortSignal、面板断线、模块卸载会取消本机 HTTP；epoch/request/config 变化拦截迟到结果。宿主 vision 若不能物理中断，结果也不会迟到提交。候选二进制缓存总额默认 128 MiB；新写入时清理过期图片字节，保留历史来源说明。到期缓存不能继续 materialize。

新表由 `ensureSchema(db)` 幂等创建：`search_results/search_budgets/search_limits/search_reference_bytes`。不修改 `user_version`，便于后续合并 migration。来源详情嵌入 result_json，待审核/已审核图片 bytes 用 result 外键关联保存；只有 materialize 才进入现有资产/occurrence 表。

常见错误码：`SEARCH_DISABLED/SEARCH_UNCONFIGURED/SEARCH_UNAVAILABLE/CONTEXT_REQUIRED/SCOPE_REQUIRED/SCOPE_MISMATCH/STALE_CONTEXT/NOT_FOUND/RESULT_EXPIRED/REFERENCE_UNVERIFIED/INVALID_REVIEW/BUDGET_EXHAUSTED/QUOTA_EXHAUSTED/CACHE_FULL/BUSY/CANCELED/TIMEOUT/UNSAFE_URL/REDIRECT_BLOCKED/TOO_LARGE/INVALID_IMAGE/IMAGE_TYPE_MISMATCH/HTTP_AUTH/RATE_LIMITED/INVALID_RESPONSE`。

## 验证与官方协议

运行 `node --test test/search*.test.js`。全部 HTTP/故障测试走本机 mock；公开域名场景通过仅测试使用的 DNS/request 注入映射到本机 socket。数据库为 `:memory:`，密钥为 mock，无真实付费请求，不读取真实 data。

2026-10-28 已阅读指定 Tavily integration skill，并核对 [Tavily Search 官方协议](https://docs.tavily.com/documentation/api-reference/endpoint/search) 和 [Tavily Extract 官方协议](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。按 Bearer 认证、POST /search 和 /extract、include_images/include_image_descriptions、results/failed_results 实现；query 提取的 raw_content 标为 targeted-chunks，不声称已读完整原文。
