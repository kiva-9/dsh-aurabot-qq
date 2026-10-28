# 编码器契约与接入探针

导出 `createEmbeddingAdapter`、`OpenAITextEmbedding`、`FixedHttpEmbedding`、`defineEmbeddingSpace`、`spaceFingerprint`、`mappingFingerprint`、`embeddingCacheKey`、`validateVector`。完整 VectorIndex 接入见 [向量接口](../vector/README.md)。

`encode({inputs, modality='text', purpose='document', signal?})` 返回 `{spaceId, fingerprint, model, revision, vectors: Float32Array[], modality, purpose}`。使用向量前必须成功 `await probe(...)`。一次 encode 最多 128 输入（可配置 2..256），超时默认 15 秒，JSON 响应默认上限 16 MiB，不跟随重定向。适配器不自动重试计费请求、不读取用户文件、不下载图片、不猜测图片协议。

## 文本接口

`new OpenAITextEmbedding({space, baseUrl, apiKey?, sendDimensions?, probeBaseline?, onDrift?})`。baseUrl 指向 API 根（例如带 `/v1`），适配器追加 `/embeddings`。发送字符串数组、model、`encoding_format:'float'`；只有显式 sendDimensions 时发送 dimensions。按返回的 index 排序，并拒绝重复/缺失 index、错误数量和非法向量。该适配器只允许 text space。

text preprocess 支持显式 `version/unicode/trim/lowercase`；未知变换拒绝。查询/文档分别使用 space.prefixes.query/document，前缀空格保留。

## 固定 image / joint JSON 映射

管理员选定供应商后定义字段映射；不执行脚本，不对任意 `/embeddings` 推断图片支持。例如一个明确约定 `/encode` JSON 协议的服务：

```js
import { FixedHttpEmbedding, mappingFingerprint } from './index.js'

const mapping = {
  version: 'my-image-protocol-v1', path: '/encode',
  modelField: 'model', modalityField: 'modality', purposeField: 'purpose',
  inputs: {
    text: { field: 'texts' },
    image: { field: 'images', itemField: 'url', representation: 'url' },
  },
  response: {
    vectorsPath: 'output.items', vectorPath: 'values', indexPath: 'position',
    modelPath: 'model', revisionPath: 'revision',
  },
}
const space = {
  spaceId: 'joint:my-model:r1', provider: 'configured-provider',
  endpointIdentity: 'configured-joint-endpoint', model: 'my-joint-model', revision: 'r1',
  dims: 512, metric: 'cosine', normalization: 'l2', modalities: ['text', 'image'],
  prefixes: { query: '', document: '' },
  preprocess: {
    text: { version: '1', unicode: 'NFC' },
    image: { version: '1', mode: 'passthrough' },
    protocolMappingFingerprint: mappingFingerprint(mapping),
  },
  protocolMappingVersion: mapping.version,
}
const encoder = new FixedHttpEmbedding({ space, mapping, baseUrl, apiKey, probeBaseline, onDrift })
const samples = {
  text: ['红色裙子', '蓝色杯子'],
  image: ['https://test-assets/red-dress.png', 'https://test-assets/blue-cup.png'],
}
const check = await encoder.probe({
  samples,
  alignmentPairs: [{ text: 0, positiveImage: 0, negativeImage: 1, margin: 0.05 }],
})
```

示例 URL/模型只是契约占位，不能用于声称中文语义质量已经验收。配置好实际服务与自有授权样例后再运行探针。

input.field 是承载数组的 JSON 属性路径；itemField 可把每个值包装为对象。image representation 只支持 `url` 或 `data-url`，后者要求显式 png/jpeg/webp/gif base64 data URL；不接受本地文件路径。图片转换/裁剪由上游按声明版本生成，或显式 `preprocess.image.mode='server'` 并提供 mapping.preprocessField 把预处理参数送到服务端。passthrough 不执行 resize/crop。staticBody 可声明固定 JSON 参数，但不能与动态字段重叠。

response.vectorsPath 指向数组；vectorPath 可省略以表示每项就是向量；indexPath 可省略以表示服务保证输入顺序。modelPath/revisionPath 声明后必须在响应中提供对应字符串。可选 shapePath 要求响应严格为 `[本批条数,space.dims]`；可选 successPath 要求值严格为 true。固定路径支持 `/@cf/...` 这类命名空间，仍拒绝绝对 URL、`//`、路径回退与 query。映射是冻结 JSON，拒绝原型路径与任意表达式。修改内容必须更新 protocolMappingVersion/指纹并建立新空间。

## 探针、漂移与能力边界

`probe({samples?, tolerance=1e-5, alignmentPairs?, signal?})` 每个声明模态使用 2..8 个稳定输入，同时测试 query/document 两种目的：批量、每个输入单条、同输入重复。每个输出都检查 Float32 可表示性、finite、nonzero 和维数。文字模态有两个通用默认样例；图片必须传可复现的测试素材。

首次通过产生 `baseline`，包含 contract fingerprint、样例指纹和向量。**由 service 持久化 baseline 与样例并在重启传回**；否则新实例不能知道历史同名模型是否升级。重新 probe 与 baseline 比较，已知返回 model/revision 变化也会触发漂移。容差用于数值浮动，不保证检测所有模型升级；OpenAI 兼容响应通常没有模型修订字段，仍需固定部署版本和周期探针。这里不自行启动定时器。

漂移把 health 标为 `needsRebuild`，调用可选 `onDrift({spaceId, reason})`，并锁定后续 encode。连接 `onDrift` 到 `index.markNeedsRebuild` 后该空间的索引写入也持久锁定。不能靠重跑 probe 清掉漂移；需要新的 spaceId/修订并重建。HTTP 暂时失败只令 probe 未就绪，错误中不含密钥、URL、输入文本或供应商响应正文。

image/joint 的基础数值探针成功只表示协议与向量契约可用。没有 labeled alignmentPairs 时 health.alignment 为 `not_evaluated`；有正/负样例且全部满足 margin 才是 `passed_supplied_samples`，仅表示提供的样例，不能外推到中文、人物、裁剪和近重复质量。图片可以按图搜图；是否开放联合文本搜图由 service 的能力策略依据此状态决定。

`embeddingCacheKey` 包含整个空间指纹、contentHash、modality、purpose 和 scope；文本缓存必带 account/chat，避免聊天文字跨范围复用。它只生成键，不实现全局无界缓存。编码队列、配额、持久任务、事实主库 outbox 以及最终可见性复核由 memory service 接入。

验证：`node --test test/embedding-http.test.js`。用真实 loopback HTTP server 覆盖两类协议、响应乱序、重复 index、非法向量、同名漂移、修订变化、超时与映射拒绝。没有访问真实模型服务，语义效果与真实费用/限流未验收。

文本协议依据：[OpenAI 官方 embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。固定 image/joint 映射是本项目的显式管理员契约，不声称是供应商通用标准。
