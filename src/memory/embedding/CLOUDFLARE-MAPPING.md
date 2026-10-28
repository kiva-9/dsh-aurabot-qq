# Cloudflare Workers AI 文本映射

本文件只记录协议配置与本地 mock 结果，不含真实账号/token，没有访问真实模型。主线程负责选择中文模型、核实免费档额度、保管 token 和执行 live 验证。

官方依据：

- [REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)：账号路径 `/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}`、Bearer token、REST `result/success/errors` 外层结构。
- [文本模型输入/输出示例](https://developers.cloudflare.com/workers-ai/models/bge-base-en-v1.5/)：`text` 字符串数组，输出 `data` 与 `shape`。该链接用于说明格式，不是中文模型推荐。
- [BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/)：官方多语言模型页；当前读取的 Usage 用 `text`，参数表却显示 contexts/request_id，存在不一致。因此此处不据它锁定最终维数/响应，须由主线程确认所选模型的同步 dense 输出。
- [OpenAI 兼容接口](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)：另可用已有 openai-text adapter 对接 `/ai/v1` baseUrl；不能把此路径的 `data[].embedding` 与原生 REST `result.data` 混为一种响应。

原生同步 dense HTTP 映射：

```js
import { mappingFingerprint } from './src/memory/embedding/index.js'

// accountId、selectedModel、verifiedDims、admissionRevision、prefixes 由主线程确定。
// selectedModel 形如 @cf/<namespace>/<model>；verifiedDims 必须为实际正整数。
const mapping = {
  version: 'cf-run-text-v1',
  path: `/${selectedModel}`,
  inputs: { text: { field: 'text' } },
  response: {
    vectorsPath: 'result.data',
    shapePath: 'result.shape',
    successPath: 'success',
  },
}
const role = {
  type: 'fixed-http',
  baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`,
  // apiKey 只由主线程通过 secret 存储注入，禁止日志/文档写出 token。
  timeoutMs: 15000,
  maxBatch: 8, // 本地批次上限；还需按所选模型的实际限制确定
  space: {
    spaceId: 'cf:text:chosen-model:admission-1',
    provider: 'cloudflare-workers-ai',
    endpointIdentity: 'cf-account-profile-1',
    model: selectedModel,
    revision: admissionRevision, // 本地验收版本，不冒充供应商返回的模型修订号
    dims: verifiedDims, metric: 'cosine', modalities: ['text'],
    prefixes, // {query,document}，按所选模型官方契约确定
    normalization: 'l2',
    preprocess: {
      text: { version: '1', unicode: 'NFC', trim: true },
      protocolMappingFingerprint: mappingFingerprint(mapping),
    },
    protocolMappingVersion: mapping.version,
  },
  mapping,
  samples: { text: ['小明喜欢咖啡。', '红色裙子挂在衣柜里。'] },
}
// retrieval.roles.text = role
// 只有主线程授权并注入 secret 后，才显式 POST /retrieval/probe {roles:['text']}。
```

请求体只有 `{text:[...]}`；不填 modelField/modalityField/purposeField，模型由 URL 选择。模型若需要其他固定参数，用 mapping.staticBody 明确声明，且重算指纹。诸如 pooling 改变会影响向量兼容性，不能沿用旧空间。

响应 `result.data` 必须是按输入顺序的二维数字数组；每个向量仍检查 Float32 finite/nonzero/维数。声明 shapePath 后必须是严格数字 `[本批输入数,space.dims]`；声明 successPath 后必须严格为 true。若受控 Worker 自己返回顶层 `{data,shape}`，可改用 `vectorsPath:'data' / shapePath:'shape'` 并去掉 successPath。其他字段名如 outputshape 只能显式映射，不能靠自动猜测。

没有自动 reshape/稀疏转 dense/异步 request_id 轮询；缺失、ragged、flattened、错误 shape 都拒绝。Cloudflare 原生响应若不带 model/revision，就不声明对应 response 路径；后端同名模型漂移靠持久探针基线检测，不能声称识别所有升级。

两个文本样例执行完整探针时共 **8 次 HTTP 请求**：query/document 两个目的分别执行一次批量、一次重复输入批量、两次单条。即使前缀相同也保留这两个目的的契约测试。启动/健康不会自动发起探针。正式 live 前主线程应核实本次免费额度，本文不声明账号尚余免费额度。

本地验证：`test/embedding-cloudflare.test.js` 使用 127.0.0.1 和测试专用假 key，覆盖 @ 路径、数组请求、result.data、shape/success、非法维数/原型路径；真实 Cloudflare/中文语义/配额尚未由本任务验收。
