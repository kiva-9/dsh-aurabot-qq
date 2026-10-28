# 外部审计报告复核与方案补充

日期：2026-10-28。输入：用户上传的 `MaiBot-to-aurabot-审计报告.md`，SHA-256 为 `36264afecee6c5bcfa676c7c7a4b302a0f7f91da881c8cf834ad90ca49c366ce`。结果已合并进 [完整方案 v2](REFACTOR-PLAN.md)，不是另起一套路线。

原报告未提供 Git commit，提到的五份 `audit-repos/report-*.md` 明细未随附件提供。本次逐项阅读上传报告，对关键新增机制回到既有固定版本源码核验：Aurabot `6acbf9dfdf3e8008f671ce7914eac48208e7dc6a`，MaiBot `6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3`。不据此认定报告作者确实通读了其声称的全部源码，也不把其工期和收益比例当作测量结果。

本轮未改业务实现。新增 3 项本地模拟核验，结果见 [external-review-checks.json](audit/external-review-checks.json)；其中既有支持报告的发现，也有纠正报告的证据，不能计成 3 个新增漏洞。既有 22 个场景结果保留不变。

## 1. 逐项取舍

| 报告条目 | 核验与判断 | 合并到方案的内容 |
| --- | --- | --- |
| 3.1 错别字生成 | MaiBot 有该机制，但“文本正确是一大破绽”“拟人收益最大”没有评估依据；自动改字可能损坏名字、参数和结论 | 不列为核心交付；自然表达先由人设、时机与拆句改善，错字只保留为可选展示提议 |
| 3.2 记忆两段式去重 | 候选漏斗、三态判断、目标 ID 校验在源码中存在 [M-dedup]；Aurabot 的否定偏好误合已额外复现 | §11 明确 `keep/reuse/possible_duplicate`、批内候选、证据保留和事务提交；去重与事实冲突分开 |
| 3.3 退避与防抖 | 原方案已有；“到期但模型忙的批次不再被延长”和“纯表情不续长”值得补细 [M-debounce] | §4 加入两条时序不变量；退避按实际决策回合更新，不能按每条 none 结果累加 |
| 3.4 表情审核与 GIF | 缺 VLM/调用异常时拒绝注册已确认；但非结构化判词不保证所有未知响应被拒绝 [M-emoji] | §16 增加待审状态、结构化判定、审核与描述均覆盖动画关键帧、统一媒体文本投影；不硬禁所有截图和多字表情 |
| 3.5 画像指纹与六桶 | 内容指纹和六类条目确实存在 [M-profile] [M-profile-text]；Aurabot 重复生成调用已复现 | §11 增加完整证据版本缓存、主动失效、人工覆盖、六类结构化资料；不采用仅 ID/数量的哈希 |
| 3.6 表达学习闭环 | 原方案已有方向；来源校验、队列、水位、并发控制值得明确。重复学习覆盖人工 checked 状态的路径确实存在 [M-expression] | §16 补齐可恢复队列、情境→表达、来源回溯、人工批准/停用保护、去刷屏与冷却 |
| 3.7 黑话三段推断 | 源码确有上下文解释、孤立解释、比较，以及推断阈值 [M-jargon] | 新增群内黑话词典；不同群分义、未知状态、证据水位、人工纠错、可修订；推断差异只是证据而非真值 |
| 3.8 拆句保真 | MaiBot 校验后会映射回原文切片，并保存逗号分隔符，不只是比较字符串 [M-split] | §17 补内容覆盖/顺序/切点校验，超限合并，失败原样发送；保护代码、URL、Unicode |
| 3.9 自适应配额 | 原方案已有分层门控；报告对一个系数的解释与代码相反 [M-likelihood] | §4 明确“接话倾向”和“发言预算”分开控制，批次计数、只收紧的反馈及本地标定 |
| 3.10 注意力风格 | 实际是提示词风格配置，不是调度算法 [M-drift] | 纳入人设的联想/回主线/反应风格，不能降低任务正确性或打散执行流程 |
| 3.11 增量记忆触发 | 按消息阈值写回和成功后更新检查点已确认 [M-memory-flow]；原方案未写清触发组合 | §11 补“新消息阈值或时间阈值”、显式记忆请求优先、合并水位与短期缓冲 |
| 3.12 事实状态与冲突 | 原方案已有时间、证据、取代关系和冲突保留；无需当成全新架构 | §11 明确状态枚举、稳定性、变更流水和单值/多值差别；不把任意不同陈述都标冲突 |
| 3.13 Hook 规格 | MaiBot 确有声明与固定排序 [M-hook-spec] [M-hook-dispatch]；Aurabot 主要是事件原语 | §18 补 schema、受控修改、阶段、超时、失败策略、观察快照；声明不等于隔离恶意模块 |

原报告 P2 中还吸收了上下文查询的节流、模板严格校验、统一配置 schema、异步完成追加事件及工具结果有界摘要。这些并入既有模块，完整声明式 UI DSL、多平台 Broker、独立子代理运行时不作为本轮必要设施。报价/工期不从其“约 20 人日取得 80% 收益”推导。

## 2. 三项额外验证

| 场景 | 本地结果 | 意义 |
| --- | --- | --- |
| 连续写入完全相同的事实 | 第二次返回第一条的 updated ID，库中只有 1 条 | “连同批去重都没有”过度概括；串行提炼后的 add 已能看到之前写入的事实 |
| “测试甲长期喜欢喝无糖的冰美式咖啡”与“不喜欢…” | 相似度约 0.824，合成同一条，未保留独立冲突事实 | 否定/更正确实不能靠 Jaccard 阈值识别；支持重做语义去重和冲突关系 |
| 原始事实不变，连续生成同一人物画像 | 模拟模型被调用 2 次 | 内容指纹短路具有明确可验证的省调用价值 |

核验直接调用现有 `createMemoryStore`，使用临时目录、合成文字与模拟模型，未接真实服务。源码入口为 `src/features/memory.js:186` 和 `:377`。[A-memory]

## 3. 不能照搬的判断与实现细节

### 3.1 主动参与倾向的系数被解释反了

报告将 `+2.6525 × recent_self_ratio` 解释成“自己最近说太多强负”。实际代码的系数为正，且输入明确是最近五分钟机器人发言占比。[M-likelihood] 这更接近已有对话参与的相关信号，不是防刷屏惩罚。控制频率需由预算/门控承担，不能照着错误解释实现负权重并声称复刻 MaiBot。

### 3.2 沉默、等待、停止和取消不是同一状态

`[沉默]` 表示不发可见内容；等待需要唤醒条件，停止当前决策与取消后台任务也不同。报告的“无法向 DSH 会话注入 wait 工具”没有充分依据：Aurabot 已通过 `agent.ctx.tools.register(tool)` 挂载会话工具。[A-hub]

这不证明宿主天然具备完整挂起/恢复接口，但足以说明不能直接排除插件工具＋调度器的方案。继续保留原方案的 DSH 契约检查和 Planner/Replyer 分工，不复制 MaiBot 的整个执行循环。

### 3.3 图像审核的 fail-closed 需要更严格的返回契约

已读 `review_emoji_for_registration()` 在没有 VLM 或调用抛错时拒绝，但成功返回后仅检查是否包含“否”，其他文本可能被放行；同一文件中 GIF 拼帧明确出现在描述构建路径，审核入口直接使用原图字节。[M-emoji]

因此不能概括成“已有完整审核兜底，GIF 各处都正确处理”。本方案要求 unknown 留在待审池，解析失败不能通过；审核和描述复用同一组有界关键帧。词数、截图和表情用途由可配置素材策略决定，不复制其所有默认筛选标准。

### 3.4 画像缓存键不能省掉内容与范围

报告介绍 MaiBot 的内容指纹是正确的，但给 Aurabot 的简化建议是“记忆 ID 集合＋数量哈希”，这会漏掉正文修改、撤回、有效期及权限变化。MaiBot 的指纹本身包含证据内容与生成签名。[M-profile]

我们的缓存还需范围/角色/人工覆盖和状态版本，并在删除、权限收窄及时间边界变化时主动失效，不能只等待 TTL。

### 3.5 相似度、三次推断与提示词约束不是效果保证

“黑话推断比任何规则都准”“拟人靠后处理即可保证”“纯增益且风险极低”均缺少本任务评估。三次调用可能放大初次误解，短词子串可误命中，截图/多字表情也可能是群里真正需要的素材。

采用这些机制时增加来源、未知状态、人工纠错、失败回退和测试集。拆句尽量从原文取切点；审核/选择解析失败时不自动选第一张；不为了拟人改变关键事实。

### 3.6 现有能力值得保留，但“没有”和“更强”需要具体比较

Aurabot 已有表达习惯学习、聚合与试运行，报告一处说其学习“独有”，另一处又说“完全没有学说话”，两者定义不一致。更准确的区分是：已有相处经验与文风摘要，欠缺有证据、可审核的“情境→表达”条目闭环。

同样，已有表情额度/权限档/视觉模型配置不代表实现没有缺陷：此前已复现额度并发、请求身份和视觉输入选择问题。不能据“功能存在”取消对应修复。

### 3.7 生命周期与模块隔离不能交给一句“宿主负责”

Aurabot 有长期持有的 Map、缓冲和计时器，[A-hub] 因而仍需自己的回收、重载和任务恢复。Node 模块在同一进程内不天然构成安全隔离；Python 的 `asyncio.to_thread` 也不能直接成为 JavaScript 实现建议。

继续采用有界缓存、worker、异步 IO、版本化 Hook 和停用流程，不复制无关宿主框架。涉及 QQ 回执或收费服务时，也不能把某个内部 inbox 的幂等流程推广成所有外部操作都 exactly-once。

## 4. 对原方案自身的修正

- **无可靠消息 ID 时的去重**：删除“短窗口内容指纹可以直接去重”的模糊表述，防止真实同文连发被误删；来源不可辨识时明确能力限制。
- **防抖计时**：明确平台时间用于内容，本机接收时间/单调时钟用于等待，不受适配器时间偏差控制。
- **学习与画像**：从抽象的“异步提炼/学习”补成触发、水位、版本、失效及人工状态契约。
- **输出**：拆句和压缩分开；展示层不能丢字，语义压缩是另一项明确动作。
- **完整范围保持**：文本/图片 embedding、多协议生图、视觉表情选择和持久化任务继续属于完整交付。报告以原版小数据量为由建议省略索引工程，不适合用户已经确定的重构目标。

无需为了采用这份报告而改换总体架构。它主要补足群内知识积累、成本控制和输出验证的细节；核心任务仍是统一请求来源、人设、媒体资产、记忆范围、任务状态与发送回执。

## 源码索引

[A-memory]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/features/memory.js#L186
[A-hub]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/chat/hub.js#L261
[M-dedup]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/core/utils/fact_deduplication.py#L205
[M-debounce]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/debounce/controller.py#L47
[M-emoji]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/emoji_system/emoji_manager.py#L963
[M-profile]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/core/utils/person_profile_service.py#L127
[M-profile-text]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/core/utils/profile_text.py
[M-expression]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/learners/expression_learner.py#L858
[M-jargon]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/learners/jargon_miner.py#L399
[M-split]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/utils/llm_sentence_splitter.py
[M-likelihood]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/turn_trigger/reply_likelihood.py#L24
[M-drift]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/attention_drift.py
[M-memory-flow]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/services/memory_flow_service.py#L565
[M-hook-spec]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/plugin_runtime/host/hook_spec_registry.py
[M-hook-dispatch]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/plugin_runtime/host/hook_dispatcher.py#L303
