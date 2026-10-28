# Aurabot 重构前审计：群聊、人设、记忆与多模态链路

审计日期：2026-10-28。状态：已完成本轮源码审计与定向模拟复现，尚未修改业务实现。配套方案见 [REFACTOR-PLAN.md](REFACTOR-PLAN.md)。

## 1. 范围与证据边界

- Aurabot 基线：`6acbf9dfdf3e8008f671ce7914eac48208e7dc6a`，版本 `1.0.5`。本地初始化文件不属于业务重构。
- MaiBot 对照：`6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3`。下文只描述实际阅读的路径，不代表审计了 MaiBot 全部功能或证明它没有其他问题。
- 阅读范围覆盖收消息、聚合与触发、模型与提示词、权限、人设、记忆、心情、图片、表情包、搜索、工具执行、发送与恢复，以及配置和界面入口。
- 在临时数据目录、模拟 DSH / OneBot / 模型中运行了 **22 个定向场景**，全部复现所描述行为。其中有缺陷，也有能力缺口或需要重新设计的既有行为，不能概括为“22 个同等严重的漏洞”。机器可读结果见 [audit/results.json](audit/results.json)。
- 没有连接真实 QQ 群，没有用真实模型比较 embedding 召回率，没有实测外部搜索、生图、TTS 服务，也没有测量生产性能。接口方案同时参考官方 SDK 源码，仍需协议联调。
- 现有测试初始化基线为 272 项中的 269 项通过、3 项平台相关失败，详见 [DEVELOPMENT.md](DEVELOPMENT.md)。本轮定向复现不替代基线测试。

本文用“已复现”表示模拟执行证据；“源码确认”表示明确读到实现；“风险判断”表示存在条件性失效路径，尚未完成真实服务验证。P1 表示应优先修复的数据隔离、授权、数据丢失或本地文件边界问题；P2 表示正确性、稳定性、体验问题。

## 2. 最影响群聊体验的结论

这次值得重构的不是某个提示词，而是消息、请求、图片、任务、记忆和发送结果之间的身份与状态关系。

1. 群消息里“谁说过话”与“谁提出这个操作请求”没有可靠分离，权限不能继续依赖本轮是否出现主人。
2. 图片现在主要是临时上下文材料，没有完整的图片身份、引用关系和生成版本，因此无法可靠支持“改刚才那张”“用回复里的第二张做参考”。
3. 人设只有全局正文切换，但会话、表达习惯、情绪原因和后台提炼没有随之分域；改名字不等于换了一套一致的人格。
4. 记忆检索缺少可靠的可见范围约束。直接接 embedding 会把现有串群问题放大，而不是自动改善记忆质量。
5. 生图成功和 QQ 发送成功被混成一个结果；长任务、重试、重启和多段消息需要统一状态与回执。

## 3. 已复现的问题与能力缺口

| ID / 优先级 | 场景与结果 | 直接影响 | 源码位置 |
| --- | --- | --- | --- |
| A01 / P1 | 私聊记忆可进入群聊上下文 | 私聊内容跨范围传播 | `src/features/memory.js:307,397–422` [A-memory] |
| A02 / P1 | 记忆提炼模型报错后，整理仍报成功并删除旧日志 | 没有成功保存的记忆失去原始材料 | `src/features/memory.js:555–587` [A-memory] |
| A03 / P2 | 两个并发表情收藏越过每小时 1 张额度，QQ 收藏 2 次，本地仅留下 1 条 | 额度失效、索引丢更新 | `src/features/stickers.js:108–142` [A-stickers] |
| A04 / P2 | 生图后的发送返回 `null`，工具仍返回“画好发出去了”并记录成功事件 | 用户收不到图，后续记忆却认为已完成 | `src/modules/imagegen/index.js:20–27` [A-image-tool] |
| A05 / P1 | 同一群聊回合包含非主人请求，却得到“本轮全是主人”的权限结果 | 请求可能借同轮其他人的身份执行 | `src/chat/hub.js:859–895,1033–1043,1081–1090` [A-hub] |
| A06 / P2 | 引用消息取回了，但引用图片没有进入模型输入 | “把这张图改一下”丢失关键参考 | `src/chat/hub.js:560–565,631` [A-hub] |
| A07 / P2 | 按聊天选择了视觉模型，却仍按全局模型裁掉图片 | 配置看起来正确，模型实际看不到图 | `src/chat/hub.js:210–237,779,852` [A-hub] |
| A08 / P2 | 群回复 4 段被截成 3 段，最后的实质答案丢失 | 控制刷屏变成删除答案 | `src/chat/hub.js:456` [A-hub] |
| A09 / P1 | 群回复中的 Markdown 图片路径能读取并发送本地测试 PNG | 群回复解析器越过本地文件边界 | `src/chat/hub.js:414–417`、`src/core/net.js:93–98` [A-hub] [A-net] |
| A10 / P2 | 没有匹配表情时随机选中“幸灾乐祸”，用于安慰回复 | 情绪错配，破坏群聊观感 | `src/features/stickers.js:57–66` [A-stickers] |
| A11 / P2 | 图片下载慢时拆成两轮：先请求无图，后有图无新消息 | 因果关系受网络速度影响 | `src/chat/hub.js:767–791` [A-hub] |
| A12 / P2 | 同一消息 ID 的重复事件在提示词出现两次 | 重连重放可导致重复回应或任务 | `src/chat/hub.js` 收消息到入队路径 [A-hub] |
| A13 / P2 | 声称保留 30 分钟的近期图片，在第 31 分钟仍能读出 | 旧图被当成当前参考 | `src/chat/hub.js:672–676,1156` [A-hub] |
| A14 / P2 | 保存 `role.a` 静默变成 `rolea`，覆盖已有卡 | 人设 ID 不是稳定身份 | `src/persona/personas.js:38,61–68` [A-personas] |
| A15 / P2 | 删除内置人设后，下一次列表读取又自动复制回来 | 用户操作不持久，迁移与删除语义混乱 | `src/persona/personas.js:13–19,40–55` [A-personas] |
| A16 / P2 | 当前人设不存在时静默使用列表第一张卡 | 配置故障变成机器人换身份 | `src/persona/personas.js:77–79` [A-personas] |
| A17 / P1 | 私聊原话成为心情原因，随后注入群聊上下文 | 即使修正主记忆检索，仍有另一条串范围路径 | `src/features/companion.js:101,136`、`src/modules/mood/index.js:14–24` [A-companion] [A-mood] |
| A18 / P2 | 换人设后仍注入旧角色的全局自我表达习惯 | 新旧人格混合，越用越漂移 | `src/features/memory.js:351–360,407–410,621–635` [A-memory] |
| A19 / P2 | 当前卡设为“小蓝”，后台人物档案提炼仍使用“大肥鱼” | 角色身份在不同环节不一致 | `src/features/memory.js:385`；同类硬编码还在 `217,435,508,628` 和心情判断中 [A-memory] [A-companion] |
| A20 / P2 | 精确 ID 删除当前人设被拦截，带非法字符的别名却能删除它 | 删除检查与实际操作对象不一致 | `src/host.js:509–513`、`src/persona/personas.js:71–73` [A-host] [A-personas] |
| A21 / 设计缺口 | A 角色切成 B 角色仍复用同一 DSH 会话 | 旧身份的对话历史继续参与生成；复现证明会话复用，未测真实模型漂移程度 | `src/chat/hub.js:169` 起会话选择路径 [A-hub] |
| A22 / 能力缺口 | “星期六下午三点在码头集合”：字面“码头集合”命中，“之前约好的碰面时间”不命中 | 纯词法检索不能覆盖语义回忆；这一个样例不是 embedding 模型性能对比 | `src/features/memory.js:22–94,307` [A-memory] |

A05 的复现证明权限判断与提示词中请求来源不一致，不等于已在真实 QQ 上执行了未授权群管操作。A09 只读取了专门创建的合成图片，没有读取用户文件。

## 4. 其他源码确认与条件性风险

### 人设、提示词与学习

- `persona.current` 是全局单值；`host.js:69` 的 `aurabot_persona` 不按聊天解析。前端有卡片编辑，但没有发布版本、聊天绑定、修订回滚或完整切换事务。
- 默认卡把身份、虚构生活、回复长度、语音标记、工具行为等混在一段正文。它与通用规则重复约束，部分绝对表述可能让模型在失败时仍声称具备能力。应把人格内容与实际工具能力分开编译，不能靠再加一段提示词解决。
- 前端人设异步加载缺少完整的编辑版本与过期结果控制，切卡可能覆盖未保存编辑。这是静态交互风险，未做浏览器复现。
- `learnSelfStyle()` 汇总不同聊天的表达习惯；人物档案以 QQ 号索引，但不能因此获得跨聊天公开权限。情绪、人物印象、相处经验、缓存同样属于隔离边界。
- 主动聊天会构造虚构日常并走专门生成路径。角色故事可以作为明确的角色设定保留，但不能被记成“实际浏览、发送、搜索、生成成功”的操作事实。

### 图片与长任务

- 当前 `generate(prompt)` 只有一个提示词，主要发 JSON 到 `/images/generations`；本地接口也只传 prompt / size。没有原生编辑、蒙版、多图角色、任务查询、取消或输出版本关系。[A-image]
- 模型参数和响应字段不能靠“OpenAI 兼容”四个字概括。不同模型是否接受 `response_format`、多个输入图、蒙版和输出格式须分别声明。
- 近期图片仅保留片段、用户和时间等信息，缺少稳定消息引用；表情图和普通图片的输入优先级可能挤掉真正参考图。
- 图片请求超时、聊天忙碌上限和本地任务时长各自控制，不能形成统一的重启恢复与结果去重保证。
- 外部下载在初始 URL 之外还需要检查每次重定向目标；已有检查不能自动证明最终地址安全。此项为静态路径判断，未发起真实探测。

### 记忆、授权和发送

- 记忆去重、近期事件、人物档案及部分提炼状态是全局的。向量库必须继承更严格的 scope，不能把全库 top-k 找完再由模型“自己保密”。
- `extractLines()` 只处理最后若干块，整理却可推进整个输入的处理位置；应记录逐块结果，区分失败、无有效事实和已经提交。
- 表情库编辑/删除工具的部分操作没有完整的请求级管理权限；只限制“主人手动添加的图不能被别人删”并不能保护整个库。
- 用同一人的“最近一条”消息绑定迟到的语音转写，存在绑定到后续消息的风险；异步处理必须用 message ID 回填。
- 发送错误常被折成 `null`，调用者又把调用完成当作发送成功。需要段级回执、失败状态和可恢复 outbox。

## 5. 与 MaiBot 的逐环节对照

以下“采用”指借鉴机制并独立实现，除非另行审查授权，不直接搬运代码。

| 环节 | Aurabot 当前状态 | MaiBot 实际可参考之处 | 本项目决定 |
| --- | --- | --- | --- |
| 消息聚合 | 下载/转写影响入队时机，缺少完整重复事件约束 | 分角色、说话人、静默间隔的 debounce controller [M-debounce] | 接收即落库和计时，媒体异步补齐；有限等待与最大聚合窗口 |
| 说话触发 | 群聊规则与模型回合耦合 | 调度器依次处理防抖、等待恢复、静默、强制提及、空闲退避、动态门控 [M-scheduler] | 采用分层门控，数值须用本群回放校准；不照搬其训练权重 |
| Planner | 现有 DSH agent 能调工具，但决策/回复/完成边界混在一起 | Planner 使用行为风格，工具执行后可继续等待、回复、停止 [M-loop] | 引入 Planner 与 Replyer 分工；复用 DSH agent 执行循环，避免再套一个竞争循环 |
| 人设 | 全局 Markdown 正文；后台硬编码身份 | `personality`、`behavior_style`、`reply_style` 三层，Planner/Replyer 各取所需，有相关测试 [M-personality] [M-replyer] [M-personality-tests] | 采用分层；自行补充卡片版本、分群绑定、切换事务。MaiBot 此配置是全局的，不能说它已提供这些能力 |
| 变化风格 | 自我习惯全局汇总 | 可选多种回复风格与概率 [M-personality] | 默认使用稳定风格；可配置情境变化，但不随机更换核心身份 |
| 表达学习 | 范围、身份、用途混合 | learn/use 分开、审核态、共享分组、学习并发锁 [M-learning] [M-learner] | 分群分人设学习，候选→筛选→发布，支持撤销；学习不能改管理员权限和核心设定 |
| 提示词维护 | 多处分散拼接 | 模板加载、缓存版本；实际请求指纹可追溯 [M-prompt] [M-fingerprint] | 单一 PromptCompiler、角色与来源清单、每轮固定版本；摘要用于定位差异，不存完整私密提示词到公开日志 |
| 消息图片绑定 | 近期数组、有限图片截取 | message ID + 图片序号；裁剪后延迟编码，构建任务局部隔离 [M-attachments] [M-deferred] | 稳定 asset/occurrence ID，失败不挤移编号，原图与预览分离 |
| 文本记忆 | 词法召回，范围与提炼提交存在问题 | 当前聊天 + 显式共享组，提炼成功才推进进度 [M-memory-config] [M-memory-flow] | 混合召回、证据和版本、可靠提炼任务；不是把现有 JSON 直接灌进向量库 |
| 图片记忆 | 没有完整图片向量记忆 | exact hash 与视觉相似分开；查询前限制可见 occurrence；向量空间指纹 [M-image-runtime] [M-image-embedder] | 采用核心约束；另做文本描述/OCR 路径和可选联合空间，不能把以图搜图冒充文字搜图 |
| 图片索引恢复 | 没有独立可靠队列 | 持久化 writeback journal、重试、发布前检查任务是否仍有效 [M-image-journal] [M-image-runtime] | 统一持久化索引任务，防删除后迟到任务把图片重新写回 |
| 表情收藏 | 并发额度、索引与 QQ 收藏不同步 | 按图锁、描述异步生成 [M-emoji] | 事务额度 + 哈希去重 + 持久化状态，QQ 收藏同步独立重试 |
| 表情选择 | 模糊匹配，无匹配时随机选 | 候选图 + 视觉选择 [M-send-emoji] | 采用候选检索与视觉复核，但不复制解析失败时选第一张的回退；允许不发表情 |
| 网络搜索 | 没有统一的插件内搜索/图片来源模型 | 搜索和提取适配层、类型化结果、错误区分 [M-search] [M-tavily] | 采用分层接口；其已读 Tavily 路径主要是文本搜索/提取，参考图搜集与验证需另做 |
| 生图与编辑 | 单 prompt、单次请求 | 本轮未证明 MaiBot 有可直接替代本需求的完整多协议生图工作流 | 根据官方协议与本项目目标独立设计，见方案 |
| 工具权限 | 本轮主人参与状态被当成授权依据 | 插件宿主 capability token [M-auth] | 只借鉴能力边界；插件身份授权不能替代 QQ 用户请求授权 |
| 可见回复 | 有硬截断、发送失败被掩盖 | 回复工具记录分段结果、已发送 ID，并区分生成成功/发送失败 [M-reply-tool] | 采用回执语义，再增加持久化 outbox 与重启对账 |
| 数据迁移 | 分散 JSON/文件状态 | 版本化迁移步骤，成功才推进版本 [M-migrations] | 接入自己的启动与备份流程；其 manager 明确不自动接业务启动，不能直接声称已经有完整升级保障 |
| TTS / ASR | 多种语音能力耦合在现有体系 | 本轮不作未验证的 MaiBot 优劣结论 | 外部 TTS 单独适配；ASR 保留独立入站能力，均使用统一资产/任务/回执 |
| QQ空间 / 抖音 | 模块、配置、路由、后台任务和界面存在引用 | 与本次目标无关 | 完整移除，并保留旧数据迁移备份，不只隐藏菜单 |

## 6. embedding 的专项结论

**建议文本和图片都做，完整纳入本次架构。** 但它们承担的是检索与关联，不负责判断授权、事实真假或“这是不是用户明确指定的那张图”。

### 文本：混合检索，而非全部换成向量

词法检索对 QQ 号、昵称、日期、模型名和原句很好；embedding 对换一种说法的回忆更有价值。建议同时检索原始对话片段、情节摘要、结构化事实与人物资料，按适用类型融合、去重和重排，再携带证据进入上下文。时间冲突、否定、转述、玩笑以及“别人说某人怎样”不能被相似度抹掉。

### 图片：至少分清四种能力

1. **同图定位**：内容哈希用于相同字节，感知哈希辅助找转码/缩放后的近重复，不能证明身份。
2. **以图搜图**：图片 embedding 召回视觉相近的历史图片，并关联当时的聊天、请求和生成任务。
3. **文字搜图**：描述、OCR、用户给图的说明和生成提示词进入文本索引；适合“上周那张红裙子的图”。
4. **跨模态检索**：只有明确支持同一联合向量空间的文字编码器/图片编码器，才能直接比较文字向量与图片向量。两个服务输出维数相同远远不够。

MaiBot 的已读图片检索入口接收图片字节或内容哈希，先确定可见图片 occurrence，再做同图/视觉相似查询。其 embedder 记录模型、提供方、维数、协议与预处理指纹，并用重复图和不同纯色图做可用性检查。[M-image-runtime] [M-image-embedder]

这证明它重视空间兼容性与故障检查，但纯色图检查不是中文文字搜图、人物一致性或语义召回质量的验收。我们需要自己的真实场景标注集。

### 先修范围，再增加召回能力

图片字节可以物理去重，但每一次出现的聊天范围、消息作者、时间和用途必须独立保留。私聊里的照片即使和群图哈希相同，也不能把私聊说明、心情原因或关联记忆一起带到群里。索引、缓存、摘要、人物档案、表达习惯、搜索结果和重排全部遵循同一权限范围。

## 7. 对改造规模的判断

保留 DSH 集成、QQ 桥接基础、身份/配置工具和有价值的测试设施；重写聊天编排、媒体资产、权限请求模型、记忆存储、人设编译和任务回执。模块化结构值得保留，但当前大体量 hub、host、memory 和前端单文件不宜继续堆分支。

这不是先做阉割版本的理由。完整能力应在一套契约下设计、在本轮实现；开发时仍按依赖分批提交与验证，最后形成一个完整可发布版本，避免把“一次性实现”误解为一次性修改所有文件后才测试。

MaiBot 根许可证为 GPL-3.0，Aurabot 为 MIT。本方案借鉴已核实的设计机制，独立实现；若之后决定直接采用具体代码，需单独核对对应文件/子模块授权及发行方式。

## 8. 用户提供报告后的补充核验

已复核 `MaiBot-to-aurabot-审计报告.md`，关键源码与逐项取舍见 [EXTERNAL-AUDIT-REVIEW.md](EXTERNAL-AUDIT-REVIEW.md)。原 22 个场景及优先级不变，额外 3 项模拟核验分别确认：顺序重复写入已有去重、否定偏好会被相似度误合、画像证据未变仍重复调用模型。

补充机制已并入方案 v2：分范围语义去重、六类画像与证据指纹、增量提炼触发、群内黑话词典、学习状态保护、内容保真的拆句、待审表情与动画帧处理、Hook 规格、摘要契约。未采用报告的错字最高优先级、效果百分比和工期估算；对模型系数解释、等待语义及模块隔离等不准确之处保留了源码说明。

## 源码索引（固定审计版本）

[A-hub]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/chat/hub.js
[A-memory]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/features/memory.js
[A-stickers]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/features/stickers.js
[A-image-tool]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/modules/imagegen/index.js
[A-image]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/features/imagegen.js
[A-net]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/core/net.js
[A-personas]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/persona/personas.js
[A-host]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/host.js
[A-companion]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/features/companion.js
[A-mood]: https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/blob/6acbf9dfdf3e8008f671ce7914eac48208e7dc6a/src/modules/mood/index.js
[M-debounce]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/debounce/controller.py
[M-scheduler]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/turn_trigger/scheduler.py
[M-loop]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/chat_loop_service.py
[M-personality]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/config/official_configs.py#L148
[M-replyer]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/chat/replyer/maisaka_generator_base.py
[M-personality-tests]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/pytests/maisaka/test_behavior_style_prompt.py
[M-learning]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/config/official_configs.py#L3930
[M-learner]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/learners/expression_learner.py
[M-prompt]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/prompt/prompt_manager.py
[M-fingerprint]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/common/reply_effect_fingerprint.py
[M-attachments]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/context/image_attachment.py
[M-deferred]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/visual/deferred_images.py
[M-memory-config]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/CONFIG_REFERENCE.md#L357
[M-memory-flow]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/services/memory_flow_service.py
[M-image-runtime]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/core/image/runtime.py#L418
[M-image-embedder]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/A_memorix/core/image/embedder.py
[M-image-journal]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/services/image_writeback_journal.py
[M-emoji]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/emoji_system/emoji_manager.py
[M-send-emoji]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/send_emoji.py
[M-search]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/web_search/service.py
[M-tavily]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/web_search/adapters/tavily.py
[M-auth]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/plugin_runtime/host/authorization.py
[M-reply-tool]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/maisaka/builtin_tool/reply.py#L671
[M-migrations]: https://github.com/Mai-with-u/MaiBot/blob/6bcb2e068cd98793a132cb8cc4ebf3cc00cb8fc3/src/common/database/migrations/manager.py
