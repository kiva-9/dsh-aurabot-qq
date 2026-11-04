# Aurabot 前端面板审计报告

> 状态：最终版。本文件为只读审计产出；未修改源码。

- 审计对象：`client/client.js`（3993 行，React 18 + 手写 `h()`，无构建）、`src/host.js` 面板 API、`src/core/config.js` 配置模型
- 审计方式：静态通读 + 按组件/配置键交叉比对 + 对关键异步路径做时序推演；未修改任何源码
- 统计口径：`h(Card)` 计数组件；`h(Row)` 加 `f.sw/text/num/percent/range/list/select/choices` 计设置项。嵌套子组件合并到所属标签页，数字为 grep 粗计，只用于比较页面体量。
- 代码规模基线：`client/client.js:45-374` 为内联 CSS；全文 106 处 `h(Card)`、193 处内联 `style: {`、266 处 `useState`、61 处 `useEffect`。

## 0. 结论摘要

用户的三条抱怨都能在代码里找到结构性原因，而不是“用户不会用”：

1. **入口确实太多、层级失焦**：`TABS` 有 25 个一级标签（`client/client.js:504-529`），另有 4 个 `PANEL_GROUPS` 分组（`:3834`）；分组按钮和页面标签使用同一个 `.ab-tab` 视觉类，分组行像第二排标签。`new-features`（“聊天与功能设置”）5 张卡片 43 个设置项，横跨聊天、附件、跨聊天策略、表情、RVC、主动搭话、B 站，是典型的“收藏夹式”大杂烩。
2. **配置没有单一事实来源**：同一语义至少存在 4 套保存模型（全局底部保存 / Persona 草稿+发布 / 模块即时保存 / 扩展面板即时保存）和大量“全局开关 × 模块开关 × 人设覆盖”的多层门控（`mood`、`learning`、`voice`、`local.*` 都是），用户无法判断哪个开关最终生效。
3. **确实存在会丢配置/显示错页的 bug**：5 秒 `/state` 轮询与 `/save` 无请求序号，保存期间继续输入会被回写覆盖；模块页/扩展面板直接 `/save` 不经过全局 `draft`，之后点全局“保存设置”会把模块开关改回去；分组按钮只改 `navGroup` 不改 `tab`，会出现“选中常用组但内容还是语音页、没有任何标签高亮”。

严重度定义：**P0** = 面板不可用或可直接丢配置；**P1** = 主流程/核心功能错误；**P2** = 局部功能错误或明显误导；**P3** = 可维护性、可访问性、细节 polish。

---

## A. 标签页 / 导航全景

### A1. 4 个一级分组（`PANEL_GROUPS`, `client/client.js:3834`）

| 分组 | 标签数 | 成员（声明顺序） | 备注 |
|---|---:|---|---|
| 常用 | 6 | overview, connect, persona, access, group, new-features | `new-features` 声明在最后，但 `TABS` 声明顺序把它排在第 2；实际渲染顺序由 `TABS` 决定（`:3927`），与分组数组顺序不一致 |
| 能力 | 8 | model, voice, stickers, imagegen, search, speakup, song, bili | 8 个能力各占一级页；其中 7 个是模块页，模块一关整页消失 |
| 记忆 | 5 | mood, memory, retrieval, media-memory, learning | 心情/记忆/检索/图片理解/表达与黑话；语义上“检索”和“记忆”高度相邻 |
| 管理 | 6 | tasks, local, modules, token-meter, diagnostics, logs | 任务、本地接口、扩展、Token、诊断、日志 |
| 扩展（动态） | N | `ext:<模块 id>` | 仅当用户模块 `running === 'user'` 且有 settings/panel 且未声明内置 tab 时出现（`:3923-3926`） |

> 注意：`PANEL_GROUPS` 没有 `'扩展'` 键；`panelGroupOf` 对未知 id 一律返回 `'扩展'`（`:3835`）。所以任何漏登记的标签都会静默落到“扩展”组，而不是报错。

### A2. 25 个内置标签总表

| 组 | 标签（id） | 实际用途/内容 | 主要 config 键 | flag / 显示条件 | 规模（Card / Row / f.*） | 重叠/备注 |
|---|---|---|---|---|---:|---|
| 常用 | 概览 `overview` | 机器人状态、在线/试运行、今日统计、当前心情、快捷操作、最近日志、更新提示 | 只读；`enabled`/`dryRun` 顶部即时开关 | 无；始终显示 | 3 Card（含 RecentLogs）+ 4 统计卡 / 0 / 0 | 唯一有全局健康总览的页面；没有“配置地图” |
| 常用 | 聊天与功能设置 `new-features` | 聊天与附件、跨聊天只读策略、表情与语音、主动搭话、B 站 | `incomingFiles.enabled`, `group.ignoreAtOthers`, `ignoredSenderQQs`, `conversation.seedHistory`, `approvalNotify`, `crossChatHistory`, `stickers.collectMode`, `voice.rvc.*`, `speakUp.targets/mode`, `bili.danmakuEnabled/maxDanmakuPerDay/visionEnabled/visionFrames` | 无；始终显示 | 5 / 21 / 17（合计约 43） | **最大杂烩**；`speakUp` 与 SpeakUp 页同键双入口；`voice.rvc`、`stickers.collectMode`、`bili.danmaku*` 在各自功能页没有入口 |
| 常用 | 连接 `connect` | SnowLuma 下载/解压/启动/协议/接入、连接状态、高级地址令牌、头像上方向导入口 | `snowluma.*`, `botQQ` | 无；始终显示 | 3 / 10 / 10 | 与 Wizard 重复实现整套 SnowLuma 流程 |
| 常用 | 人格 `persona` | 人设卡列表、分层编辑（身份/行为/说话/外观/声音/情绪）、参考图库、绑定、头像、实际提示词预览 | `persona.current` 只读；实际写入走 `/persona/*` 服务 API，不进入全局 `draft` | 无；始终显示 | Persona 3 + 绑定/头像/EffectivePrompt 等约 6 区块 / 14 / 0 | **独立保存模型**：草稿/发布，不属于底部保存；`TAB_KEYS` 里没有 persona |
| 常用 | 权限 `access` | 主人 QQ/称呼/权限级别、长任务、资料修改权限、白名单、群管身份、QQ 命令 | `ownerQQ`, `ownerName`, `ownerLevel`, `longTasks`, `profilePerms`, `allow` | 无；始终显示 | 5 / 6 / 4 + 7 组 profilePerms | 与 `new-features`/`group` 分走聊天权限与群策略 |
| 常用 | 聊天 `group` | 危险命令确认、发文件、连发合并、必回唤醒词、会话历史窗口、自动参与刹车、群插话、动态退避、按群覆盖 | `security.dangerConfirm`, `files.*`, `merge.*`, `group.*`, `conversation.*`, `participation.*` | `flag: 'group'` 仅表示 `allow.groups.length > 0`，只控制灰点；无模块门控 | 9 / 26 / 30（约 65） | **第二大杂烩**；`security`/`files` 不在 `TAB_KEYS`；与 `new-features` 共享 `group`/`conversation` |
| 能力 | 模型 `model` | 全局聊天模型/思考强度/视觉能力、每轮工具次数、按聊天模型、后台角色模型、可用模型测速 | `model.*`, `toolCallsPerTurn`, `chatModels.*`, `roles.*` | 无；始终显示 | 5 / 4 / 0 + Select/Range | `roles` 与生图/语音/检索的服务模型是不同层级 |
| 能力 | 语音 `voice` | TTS（OpenAI/HTTP/不用）、ASR 状态与测试 | `voice.*`（但仅部分子键） | `flag: 'voice.enabled'` + `TAB_MODS.voice`（模块关则整页隐藏） | 2 / 18 / 19 | **缺 `voice.defaultVoice`、`voice.speed`、HTTP `apiKey`/`headers` 控件**；RVC 全局设置却在 NewFeatures |
| 能力 | 表情包 `stickers` | 图库工作区、审核/批量操作、自动处理设置、最近决策 | `stickers.*` | `flag: 'stickers.enabled'` + 模块门控 | 5 / 14 / 15 | 主开关 `stickers.enabled` 藏在默认折叠的 `<details>` 中 |
| 能力 | 生图 `imagegen` | 多协议服务、默认/优先路由、配额、任务工作台、作品图库、蒙版 | `imageGen.*`；读取 `local.image` | `flag: 'imageGen.enabled'` + 模块门控 | 6 / 12 / 13 + 每服务 ProfileEditor 23 行 | 服务“检查配置”测试的是已保存配置；`local.image` 可绕过本页开关 |
| 能力 | 搜索 `search` | Tavily 配置、网页搜索/提取、参考图目标与审核、历史 | `search.*` | `flag: 'search.enabled'` + 模块门控 | 4 / 9 / 6 | 与“检索与索引”是不同后端，但命名都像“搜索” |
| 能力 | 主动搭话 `speakup` | 目标聊天、模式、追问、频率、清醒时间、目的预览 | `speakUp.*` | `flag: 'speakUp.enabled'` + 模块门控 | 2 / 7 / 10 | `targets/mode` 在 NewFeatures 重复 |
| 记忆 | 心情 `mood` | 全局基线/半衰期/模型判断、当前范围心情调整、变化记录 | `mood.*` | `flag: 'mood.enabled'` + 模块门控 | 2 / 5 / 4 | 与 Persona 的 `policy.mood` 双层门控 |
| 记忆 | 记忆 `memory` | 全局记忆设置、跨聊天共享组、事实/画像/待复核/召回工作台 | `memory.*` | `flag: 'memory.enabled'` + 模块门控 | 4+ / 3 / 4 | “查看范围”每次进入重置；与检索页职责相邻 |
| 记忆 | 检索与索引 `retrieval` | 索引后端、Qdrant、候选/超时、向量角色、重排、健康、检索工作台、重建任务 | `retrieval.*` | `flag: 'retrieval.enabled'` + 模块门控 | 5 / 19 / 19 + 每角色 23 | 与“记忆”页都可查事实/图片，入口语义重叠 |
| 记忆 | 图片理解 `media-memory` | 自动分析、动画取帧、autoChats、限流、工作台、任务 | `mediaMemory.*` | `flag: 'mediaMemory.enabled'` + 模块门控 | 3 / 12 / 13 | 与生图的 `observeGenerated` 是不同概念，但都涉及图片 |
| 记忆 | 表达与黑话 `learning` | 全局学习/使用开关、证据阈值、审核工作台、提炼进度 | `learning.*` | `flag: 'learning.enabled'` + 模块门控 | 3 / 9 / 12 | 与 Persona 的 `policy.learnExpressions/useExpressions` 多层门控 |
| 管理 | 任务 `tasks` | 生图/翻唱/Planner 等待列表、取消 | 无（只读/操作） | `TAB_MODS.tasks` 模块门控 | 1 / 0 / 0 | `TAB_KEYS.tasks` 无实际用途 |
| 能力 | 翻唱 `song` | 安装/RVC 环境、音色导入、声音参数、网易云、试唱、历史 | `song.*`；读取 `local.song` | `flag: 'song.enabled'` + 模块门控 | 4 / 10 / 8 | 安装流程很长，和普通设置混在一页 |
| 能力 | B站 `bili` | Cookie、定时刷、评论/回复/分享、历史 | `bili.*`（缺 `ffmpegPath` 控件） | `flag: 'bili.enabled'` + 模块门控 | 4 / 13 / 16 | 弹幕/视频理解被放到 NewFeatures，B站页没有 |
| 管理 | 本地接口 `local` | tts/image/song/asr 四个脚本槽、生成模板、测试 | `local.*` | 无；始终显示 | 2 / 0 / 4 个开关 | 可绕过功能页的业务开关，见 B7 |
| 管理 | 扩展 `modules` | 模块总开关、复制/打开/重载、安全模式、新建、模拟测试 | `modules`, `safeMode`, `ext.*` | 无；始终显示 | 4 / 1 / 0 | 所有模块页面的“总开关”都在这里；关掉后对应标签消失 |
| 管理 | Token 统计 `token-meter` | 时间/聊天筛选、总量、按模型、按工作、趋势 | 无（只读） | `TAB_MODS['token-meter']` 模块门控 | 5 / 3 / 0 | 5 张只读卡，没有二级导航 |
| 管理 | 诊断 `diagnostics` | 运行摘要、请求时间线、耗时、决策、回放、Hook、用量 | 无（只读） | 无；始终显示 | 6 / 1 / 0 | 6 张卡堆在一页，与日志/Token 信息重叠 |
| 管理 | 日志 `logs` | 级别/模块过滤、自动刷新 | 无（只读） | 无；始终显示 | 1 / 0 / 0 | 与概览的 RecentLogs、诊断的请求时间线重叠 |
| 扩展 | `ext:<module>` | 用户模块自动表单 + 自定义 `panel.js` | `ext.<id>.*` | `hasUi`（running==='user' && !builtin && settings/panel）且未 `tab` 嵌入 | 1 Card + panel | `TAB_KEYS` 对 ext 单独比较 `draft.ext[id]` |

### A3. 动态扩展标签

- `extTabs = mods.filter(m => hasUi(m) && !intoTab(m)).map(...)`（`:3923-3926`）。用户模块可以用 `def.tab` 嵌入已有内置标签；否则单独成页。
- 用途：只有“用户自己写的模块”才会出现在此；内置模块不生成 ext 标签。
- 控制键：`ext.<moduleId>.<settingKey>`；自定义面板通过 `post('/save', { ext: { [id]: patch } })` 直接保存（`:3249`）。
- flag：无 `flag`；能否出现只看模块是否 `running === 'user'` 且有 UI。
- 重叠：如果用户模块声明 `tab: 'voice'`，会嵌入 Voice 页；但 Voice 模块关掉时整个 Voice 标签被 `TAB_MODS` 过滤，嵌入模块也一起消失。`TAB_KEYS` 对 ext 标签单独处理，dirty 点与普通标签不同。

### A4. “收藏夹式”大杂烩判定

| 页面 | 体量 | 为什么是收藏夹 | 建议归属 |
|---|---:|---|---|
| `new-features` | 5 Card / 21 Row / 17 字段 | 6 个互不相关的主题；多个设置是从功能页“临时搬过来”的孤儿设置 | 拆回 Chat/Permissions/Voice/Stickers/Bili/SpeakUp |
| `group` | 9 Card / 26 Row / 30 字段 | 安全、文件、合并、唤醒、历史、群插话、退避、按群覆盖全堆在一页 | Chat 页二级分区：消息/群聊/安全/会话 |
| `persona` | Persona 192 行 + PersonaReferences 225 行 | 编辑器、参考图库、绑定、头像、提示词预览全在一页；单块 PersonaReferences 225 行 | 人格页二级：卡片/编辑/外观参考/绑定 |
| `stickers` | 5 区块 / 14 Row / 15 字段 | 图库工作台 + 审核 + 全局设置 + 决策日志 | 表情页二级：图库/审核/设置 |
| `imagegen` | 6 Card + 每服务 23 行 | 服务配置、路由、配额、任务、图库、蒙版都在同一页 | 生图页二级：服务/任务/图库 |
| `retrieval` | 5 Card + 每角色 23 行 | 索引、向量角色、重排、健康、检索、维护全在一页 | 记忆页内“检索”二级页 |

---

## B. 重复 / 冲突配置清单

### B1. 同键双入口（draft 共享；最后保存覆盖，但值一致，不产生实际冲突）

| 键 | 位置 A | 位置 B | 证据 | 判定 |
|---|---|---|---|---|
| `speakUp.targets`、`speakUp.mode` | `client/client.js:2103-2104`（SpeakUp 页） | `client/client.js:3821-3822`（NewFeatures） | 两处都是 `f.list('speakUp.targets')` / `f.select('speakUp.mode')`，绑定同一个 `draft` | **同键双入口**：同一 React 树上同一 `draft`，保存时同值，不冲突；属于冗余入口、误导用户“哪个为准” |
| `botQQ` | `client/client.js:737`（Connect 高级） | `client/client.js:3718`（Wizard 第 0 步） | `f.text('botQQ')` | 同键双入口；Wizard 的保存也会写整份 draft，值一致 |
| `ownerQQ`、`ownerName` | `client/client.js:1499-1500`（Access） | `client/client.js:3719-3720`（Wizard） | `f.text('ownerQQ')` 等 | 同键双入口；不冲突，但 Wizard 有独立保存时点 |
| `snowluma.dir` | `client/client.js:700`（Connect 步骤 2） | `client/client.js:3729`（Wizard 步骤 1） | `f.text('snowluma.dir')` | 同键双入口；Wizard 的“检查”会先 `save(draft)`（`:3729`） |

> 同键并不等于安全：Wizard 的 `save` 是整份 draft 保存（见 C23），如果其它页面有未保存编辑，会一起带上；源头上仍是两个入口共享一个大 draft 的耦合。

### B2. 不同键但语义重叠（真正会互相影响/优先级不清）

| # | 语义 | 位置与键 | 实际生效关系 | 判定 |
|---|---|---|---|---|
| B2-1 | 人设 RVC 覆盖 vs 全局 RVC | Persona 页 `client/client.js:1062-1078`：`PersonaRvc` 写 `persona.layers.voice.rvc`；NewFeatures `:3815-3819` 写配置 `voice.rvc.*` | `src/modules/voice/index.js:116` 用 `{ ...(api.config().voice.rvc || {}), ...(profile.rvc || {}) }`；**人设覆盖全局**。Voice 页没有全局 RVC 控件，只有 NewFeatures 有 | 不同键、有明确优先级；但入口错位，用户会以为 Voice 页能配全局 RVC |
| B2-2 | 默认音色 | 配置 `voice.defaultVoice`（`src/core/config.js:86`）；OpenAI 音色 `voice.openai.voice`（`client/client.js:1770`）；人设音色 `persona.layers.voice.voice`（`:1363`） | `src/voice/tts.js:249`：`const voice = profile.voice || cfg.defaultVoice || ''`；OpenAI 分支再 `voice || cfg.openai?.voice`。**人设 > defaultVoice；openai.voice 只是 OpenAI 的兜底**。`defaultVoice` 在 client 全文没有控件；HTTP provider 没有默认音色入口 | 不同键、优先级明确但前端不可配；Persona 提示“留空用语音页默认音色”是**误导** |
| B2-3 | 语速 | 配置 `voice.speed`（`src/core/config.js:87`）；人设 `persona.layers.voice.speed`（`client/client.js:1363`） | `src/voice/tts.js:250`：`profile.speed || cfg.speed || 1`；**人设覆盖全局**；Voice 页无全局语速控件 | 不同键、语义重叠；全局语速没有任何 UI |
| B2-4 | 心情 | `mood.enabled`（Mood 页 `:2455`） vs `persona.policy.mood`（Persona 页 `:1367`） | `src/features/mood.js:44-47`：`config().enabled` 与 `identity.layers?.policy?.mood !== false` **同时为真**才生效 | 不同键、AND 门控；两个开关都叫“有心情起伏/心情”，任一处关闭都静默失效，用户无法判断原因 |
| B2-5 | 表达/黑话学习 | `learning.enabled/learnEnabled/useEnabled/learnExpressions/useExpressions/learnJargon/useJargon`（Learning 页 `:2471-2474`） vs `persona.policy.learnExpressions/useExpressions`（Persona `:1368-1369`） | `src/learning/contracts.js:49-51` `allows()` 要求 `enabled && xxxEnabled && xxxExpressions`；`src/learning/index.js:24-25` 再要求 persona policy 对应字段不为 false；`learnJargon/useJargon` 没有 Persona 对应开关 | 不同键、**四层 AND**；Persona 只有表达两键，没有黑话两键；任何一层关闭都不生效 |
| B2-6 | 本地生图 vs 生图开关 | `local.image`（LocalApi `:3075` 动态开关） vs `imageGen.enabled`（ImageGen `:3360`） | `src/modules/imagegen/index.js:41`：`enabled = profiles().length > 0 && (imageGen.enabled || local.active('image'))`；`local.active` 还要求 `local.image === true` 且脚本文件存在（`src/local/local.js:45-47`） | 不同键、**OR**；LocalApi 打开后即使生图页开关是“关”，能力也可能生效；生图页的“还没开启”提示与事实不一致 |
| B2-7 | 本地 TTS vs 语音开关 | `local.tts`（LocalApi `:3075`） vs `voice.enabled`/`voice.provider`（Voice `:1760`、config `:82`） | `src/modules/voice/index.js:99` 先试 `local.active('tts')`，失败再走 `textToSpeech`；`src/chat/hub.js:842/901` 仍要求 `cfg.voice.enabled` | 不同键、**本地优先 + 全局 enabled 仍为总闸**；LocalApi 描述“出错时语音自动退回内置方式”，但没说还必须开 `voice.enabled` |
| B2-8 | 本地 ASR vs 语音识别开关 | `local.asr`（LocalApi `:3075`） vs `voice.asr`（Voice `:1794`） | `src/chat/hub.js:1338` 用 `wantTranscript: cfg.voice.asr` 决定是否登记转写；`transcribeOne` `:1155` 先 `local.active('asr')`，再 QQ 自带、DSH 识别 | 不同键、**`voice.asr` 是总闸，`local.asr` 是首选实现**；两个开关分处两页 |
| B2-9 | 模型选择 | `model.*`/`roles.*`（Model 页 `:1667-1754`） vs `voice.openai.model`（Voice `:1769`） vs `imageGen.profiles[].model`（ProfileEditor `:3420`） vs `retrieval.roles.*.space.model`（RetrievalRole `:2710`） | 各自服务/角色独立消费；`roles.vision` 只用于表情识图等后台角色，不会影响生图 profile 的 model；没有跨页校验 | **不同概念**，不是同键冲突；但“模型”在 4 个页面出现，缺少层级说明，容易误以为一处设置全局生效 |
| B2-10 | 搜索 vs 检索 | `search.enabled`（Search 页 `:2399`） vs `retrieval.enabled`（Retrieval 页 `:2663`） | 不同后端：Tavily 网页搜索 vs 本地记忆/向量索引；无共同键 | **不同子系统**，不是冲突；但标签名“搜索”“检索与索引”对普通用户几乎同义，建议改名“联网搜索”“记忆检索” |
| B2-11 | 群白名单 vs 按群覆盖 | `allow.groups`（Access `:1518`） vs `group.overrides`（Group `:1628-1632`） | `allow` 决定是否处理该群；`overrides` 只改插话概率；`overrides` 没有校验群必须在 `allow.groups` 中 | 不同键、不同职责；但“按群设置”允许给未授权群建覆盖，用户可能以为这样就把群启用了 |
| B2-12 | 长任务 vs 工具次数 | `longTasks`（Access `:1510`） vs `toolCallsPerTurn`（Model `:1710`） | `longTasks` 给主人私聊额外挂 jobs/schedule 工具；`toolCallsPerTurn` 限制每轮插件工具调用次数；互不影响 | 不同键、相关但非冲突；都改变“能做什么”，分散在权限页和模型页，建议归入“能力/工具” |
| B2-13 | 跨聊天共享 vs 白名单 | `memory.shareGroups`（Memory `:2721`） vs `allow`（Access `:1518`） | `shareGroups` 是资料读取规则，不新增聊天授权；`allow` 才是启用名单；`SharingPolicy` 文案已说明，但两个页面术语相近 | 不同键、职责不同；帮助文案足够，保留但建议在 Access 页放“查看共享规则”链接 |

### B2b. 关键控件的原始代码复核（短引用）

- **SpeakUp 双入口**：`client/client.js:2103` `h(Row,{label:'目标聊天'},f.list('speakUp.targets'))` / `:2104` `f.select('speakUp.mode',...)`；`:3821-3822` 在 NewFeatures 里再次出现同两条。
- **心情双层**：`client/client.js:2455` `h(Card,{title:'心情设置（全局）',right:f.sw('mood.enabled')...})`；`:1367` `h(Switch,{on: L('policy.mood') !== false,onChange:v=>setL('policy.mood',v)})`；`src/features/mood.js:44-47` 两个条件都检查。
- **学习四层**：`client/client.js:2472-2474` `f.sw('learning.learnEnabled')` / `f.sw('learning.learnExpressions')` / `f.sw('learning.learnJargon')`；`:1368-1369` `h(Switch,{on:L('policy.learnExpressions') !== false,...})`；`src/learning/contracts.js:49-51` 与 `src/learning/index.js:24-25` 叠加。
- **音色三键**：`client/client.js:1770` `f.text('voice.openai.voice',...)`；`:1363` `value: L('voice.voice') || ''`；`src/core/config.js:86` `defaultVoice: ''`；`src/voice/tts.js:249` `profile.voice || cfg.defaultVoice || ''`。
- **本地双闸**：`client/client.js:3075` `right: f.sw('local.' + x.slot)`；`src/modules/imagegen/index.js:41` `enabled = profiles().length > 0 && (api.config().imageGen.enabled || local.active('image'))`；`src/modules/voice/index.js:99` `if (local.active('tts'))`；`src/chat/hub.js:1155` `if (localApi?.active('asr'))`。
- **孤儿设置**：`client/client.js:3814` `f.select('stickers.collectMode',...)`；`:3815-3819` `f.sw('voice.rvc.enabled')` 等；`:3825-3828` `f.sw('bili.danmakuEnabled')`/`f.sw('bili.visionEnabled')`；Group/Stickers/Bili 页全文无对应键（见 B3 表）。

### B3. 单入口但“放错家”的孤儿设置（不是重复，但正是用户找不到配置的原因）

| 设置 | 实际唯一入口 | 用户预期入口 | 证据 |
|---|---|---|---|
| `voice.rvc.enabled/voice/pitch/fallback/timeoutMs` | NewFeatures “表情与语音”卡 | Voice 页 | `client/client.js:3815-3819`；Voice 页 `:1755-1798` 无这些控件 |
| `stickers.collectMode` | NewFeatures “表情与语音”卡 | Stickers 页 | `:3814`；Stickers 页 `:1824-1847` 无该控件 |
| `bili.danmakuEnabled/maxDanmakuPerDay/visionEnabled/visionFrames` | NewFeatures “B 站”卡 | Bili 页 | `:3825-3828`；Bili 页 `:3278-3320` 无这些控件 |
| `group.ignoreAtOthers` | NewFeatures “聊天与附件”卡 | Group 页“群里什么时候必回” | `:3803`；Group 页 `:1588-1591` 无该控件 |
| `conversation.seedHistory` | NewFeatures “聊天与附件”卡 | Group 页“会话历史窗口” | `:3805`；Group 页 `:1592-1595` 无该控件 |
| `bili.ffmpegPath` | **无控件** | Bili 页 | `src/core/config.js:137`；client 全文无 `ffmpegPath` |
| `voice.defaultVoice`、`voice.speed`、`voice.httpApi.apiKey`、`voice.httpApi.headers` | **无控件**（`voice.openai.voice` 只覆盖 OpenAI 分支） | Voice 页 | `src/core/config.js:85-87`；client 全文无这些 key |
| `merge.mentionWaitSec`、`merge.mediaExtraSec` | **无控件** | Group 页“连发合并” | `src/core/config.js:60`；client 无这两个 key |
| `mood.judgeIntervalMs`、`memory.extraction.maxBatchMessages/maxChars` | **无控件** | 心情/记忆高级设置 | `src/core/config.js:153、155` |
| `song.keepWork` | **无控件**（调试项，可保留） | 翻唱高级设置 | `src/core/config.js:170` |
| `bridge.dshTools/http/token/allowTargets` | **完全无 UI** | 扩展/联动 | `src/core/config.js:180`；client 全文无 `bridge`；`src/host.js:907` 仍提示“面板「扩展」→ 联动” |
| `tabs` | **无 UI**（实际用 localStorage `aurabot.tab`） | — | `src/core/config.js:173`；`client/client.js:3841` |

---

## C. 前端逻辑 bug（按严重度排序）

### C1 · P0

#### C01 · P0 · 确认 Bug · 5 秒 `/state` 轮询与 `/save` 竞态会回滚刚保存的设置
- **位置**：`client/client.js:3859-3866`、`:3881-3890`；`src/host.js:503-538`
- **证据**：
  - `const reload = useCallback(async () => { const r = await get('/state'); ... setSt(r); if (!dirtyRef.current) setDraft(clone(r.config)) }, [])`
  - `useEffect(() => { reload(); const t = setInterval(reload, 5000); ... }, [reload])`
  - `save`：`const r = await post('/save', body); ... dirtyRef.current = false; setSt(r); setDraft(clone(r.config))`
  - `overview()` 每次要 `await snowluma.running()`（HTTP 3 秒超时）、可能 `get_login_info`（5 秒超时）、`hub.sessions()` 读 `sessions.json`。
- **影响**：一次保存在 `POST /save` 返回后、一个早先发出的 `GET /state` 才返回时，旧快照会把 `st` 和 `draft` 同时覆盖回保存前状态；若用户在这几秒内继续编辑并再次保存，旧值会被写回服务端（真正丢配置）。这不是理论问题：`/state` 可达数秒，两个请求没有序列号/AbortController。
- **修复**：给 `/state` 和 `/save` 加递增 `requestSeq`，只有最新响应可落地；或 `/state` 返回 `revision`/ETag，客户端丢弃旧 revision；保存期间暂停轮询并合并；用 `useRef` 记录 `lastSavedRevision`。至少：`reload` 不得在 `save` 期间调用 `setDraft`。
- **性质**：确认 Bug（数据一致性）。

#### C02 · P0 · 确认流程 Bug · 首次向导不可跳过，SnowLuma 失败时所有设置不可达
- **位置**：`client/client.js:3919`、`:3957-3958`、`:3760`；Wizard `:3707`
- **证据**：
  - `const showWizard = !cfg.setupDone || wizardOpen`（`:3919`）
  - `showWizard ? h(Wizard...) : null`，且 `showWizard ? null : h('div', ...标签/页面...)`（`:3957-3958`）
  - 关闭按钮仅 `st.config.setupDone && onClose` 才渲染（`:3760`）
  - 第 1 步 `canNext` 依赖 `sl.installed`（`:3707`），没有“跳过 / 稍后设置”按钮
- **影响**：新用户如果 SnowLuma 下载失败、解压目录检测失败、或暂时不想接入 QQ，就无法进入任何设置页（连接、人格、权限、模型、扩展全部被隐藏）。面板等于被“未完成向导”锁死。
- **修复**：向导改为可关闭的抽屉/卡片；`setupDone=false` 时仍渲染标签页，只显示一条“未完成设置”提示和“继续向导”按钮；提供“跳过，先配置其它项”；`Wizard` 增加显式关闭按钮。
- **性质**：确认流程 Bug / 首次体验阻断。

### C2 · P1

#### C03 · P1 · 确认 Bug · 保存请求进行中继续输入，成功后会被回写覆盖
- **位置**：`client/client.js:3881-3890`；输入入口 `:490-499`
- **证据**：
  - `save` 取 `const body = override || draft`，等待 `post('/save', body)`，成功后无条件 `setDraft(clone(r.config))`
  - 页面其它输入没有被禁用；`useField.text` 每次 `onChange` 都 `setDraft(setPath(draft, path, e.target.value))`
- **影响**：用户点“保存设置”后继续在任意字段输入；请求返回时 `setDraft` 用保存前的草稿覆盖输入框，刚敲的内容直接消失。`quickToggle`（`:3895-3896`）同样在保存后 reset。同类问题也存在于 `ImageJobs.submit`：`post('/imagegen/submit', form)` 等待期间用户继续改 prompt，成功后的 `setForm({ ...form, prompt: '' ... })`（`:3522-3530`）会用旧闭包把输入清掉。
- **修复**：保存前记录 `editRevision`；响应回来若 `editRevision` 已变化，保留当前 `draft`（只更新 `st`），并提示“保存的是提交时的版本，后续修改仍在草稿”；或保存期间禁用表单；最稳是服务端返回新 config 与 revision，客户端按 revision 合并。
- **性质**：确认 Bug（输入丢失）。

#### C04 · P1 · 确认 Bug · 模块开关 / 安全模式 / 扩展面板直接 `/save`，绕过全局 draft，之后底部保存会改回去
- **位置**：`client/client.js:3103-3108`（`ModuleRow.setMod`）、`:3213`（安全模式）、`:3249`（`ExtPanel.save`）、`:3881-3890`（全局 save）
- **证据**：
  - `setMod`：`await post('/save', { modules: { [m.id]: { ...((draft.modules || {})[m.id] || {}), ...patch } } })`，仅 `setModules(r.modules); reload()`
  - 安全模式：`await post('/save', { safeMode: v })`
  - ExtPanel：`await post('/save', { ext: { [m.id]: patch } })`
  - 全局 `save` 会把当前 `draft`（可能仍是旧的 `modules`/`safeMode`/`ext`）整份 POST。
- **影响**：用户先在 Voice 页改了未保存设置，再去“扩展”关掉一个模块（直接保存成功）；此时全局 `draft` 里该模块仍是“开”。之后点底部“保存设置”会把模块重新打开；安全模式和 ext 设置同理。模块页的 `reload()` 在 `dirtyRef.current` 为 true 时不会刷新 `draft`（`:3864`），所以这个旧值会一直保留。
- **修复**：所有写配置的操作统一走一个 `commit(patch)`：把 patch 合并进 `draft` 并标 dirty，由唯一底部保存提交；或者直接保存时同时 `setDraft(setPath(draft,...))` 更新草稿并保留 dirty 语义。禁止两套写路径。
- **性质**：确认 Bug（丢更新）。

#### C04b · P1 · 确认 Bug · 有未保存草稿时外部修改不可见，整份 draft 保存会覆盖别人改动
- **位置**：`client/client.js:3859-3864`、`:3881-3890`；`src/core/config.js:591-621`
- **证据**：`reload` 只在 `if (!dirtyRef.current) setDraft(clone(r.config))` 时刷新编辑框；`save` 永远 `post('/save', body)` 发送整份 draft；宿主 `mergeFromPanel` 用 `deepMerge(current, incoming)`（`src/core/config.js:591`），draft 中存在的所有键都会覆盖当前配置。
- **影响**：两个浏览器标签、或用户通过 `/aurabot/api/save` / 其它管理端改了配置，而当前面板有未保存草稿时，5 秒轮询只更新 `st.config`、不更新 `draft`，用户看不到外部变化；之后点保存，整份旧 draft 会把外部改动覆盖回去。没有冲突提示、没有 revision 校验。
- **修复**：保存只提交与基线 `st.config` 的 diff，服务端按 `policyRevision`/`configRevision` 做 CAS，冲突返回 409 + 差异；或 dirty 时轮询到外部变化先展示“外部已修改，查看差异/放弃我的草稿”。
- **性质**：确认 Bug（丢更新/多端竞态）。

#### C05 · P1 · 确认 Bug · Persona 的未保存编辑不进入全局 dirty / 标签点，关闭面板会静默丢失
- **位置**：`client/client.js:1208`、`:1256-1261`、`:1277-1293`、`:3937-3941`、`:3967`
- **证据**：
  - Persona 自己维护 `const [dirty, setDirty] = useState(false)`（`:1208`），`setL`/`setAppearance` 只 `setDirty(true)`，不调用全局 `setDraft`
  - `TAB_KEYS` 没有 `persona` 键（`:3937`），`tabDirty('persona')` 永远 `false`
  - 全局底部保存条只依赖 `dirty = JSON.stringify(draft) !== JSON.stringify(st.config)`（`:3878`）
  - Persona 首次访问后被隐藏挂载：`display:curTab.id==='persona'?'':'none'`（`:3967`）
- **影响**：编辑人设后切到别的标签，页面没有脏点、没有提示；关闭浏览器/面板后编辑内容丢失。用户以为“存草稿/发布”会覆盖，但两套状态互不知道；与底部“保存设置”/“撤销”并列时尤其危险。
- **修复**：Persona 的 `dirty` 提升到 AurabotPage 或通过回调上报；`TAB_KEYS.persona` 用 `personaDirty` 特殊值；离开/关闭前弹出确认；底部保存条在 Persona 页显示“存草稿/发布”模式，避免两套操作语义混淆。
- **性质**：确认 Bug（未保存丢失）。

#### C06 · P1 · 确认 Bug · 点击一级分组只改 `navGroup`，内容还是旧页、没有任何标签高亮
- **位置**：`client/client.js:3930-3931`、`:3960`、`:3962-3966`
- **证据**：
  - 分组按钮：`onClick: () => { setNavGroup(g); setNavSearch('') }`（`:3960`）——没有 `setTab` / `go`
  - `visibleTabs = tabs.filter(... groupOf(t.id) === navGroup)`（`:3930`）
  - `curTab = tabs.find(t => t.id === tab) || tabs[0]`（`:3931`），仍指向旧 `tab`
  - 标签高亮：`curTab.id === t.id`，旧 tab 不在 `visibleTabs` 中，所以没有 `.on`
- **影响**：例如当前在“语音”（能力组），点“常用”分组：标签行变成 常用 6 页，但正文仍是语音页，且没有高亮，用户以为 UI 卡住/点错了。结合 C07 的持久化错页，这是用户“标签太多太乱”的直接原因之一。
- **修复**：分组点击时若当前 `tab` 不属于该组，自动 `go(该组第一个可见 tab)`；或允许内容区显示“请选择页面”的空状态；高亮以 `tab` 为准但必须保证 `tab` 在 `visibleTabs`。
- **性质**：确认 Bug（导航状态不一致）。

#### C07 · P1 · 确认 Bug · 持久化标签指向已隐藏页面时，无回退、无修复
- **位置**：`client/client.js:3841-3845`、`:3927-3931`、`:533`（`modOn` 未使用）
- **证据**：
  - `useState(() => localStorage.getItem('aurabot.tab') || 'overview')`（`:3841`）
  - `const [navGroup, setNavGroup] = useState(() => panelGroupOf(tab))`（`:3845`）
  - `const tabs = TABS.filter(t => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running))`（`:3927`）
  - `const curTab = tabs.find(t => t.id === tab) || tabs[0]`（`:3931`）
- **影响**：用户上次停在“语音”，后来在扩展页关掉 voice 模块；下次打开面板 `tab='voice'` 已被过滤，`curTab` 变成 `overview`，但 `navGroup` 仍是 `'能力'`（从旧 tab 计算），出现“能力组 + 概览内容 + 无标签高亮”。扩展到 `ext:old-module` 也一样。
- **修复**：初始化时校验 `tab` 是否在 `tabs`；不在则回退到 `overview` 并重算 `navGroup`；增加 `useEffect` 监听 `tabs` 变化；对 localStorage 值做白名单校验。
- **性质**：确认 Bug（持久化状态未校验）。

#### C08 · P1 · 确认功能缺口 · `bridge` 配置完全没有 UI，但宿主错误提示指向不存在的“扩展 → 联动”
- **位置**：`src/core/config.js:180`；`src/host.js:907`；`client/client.js` 全文无 `bridge`（grep 结果为 0）
- **证据**：
  - `DEFAULTS.bridge = { dshTools:false, http:false, token:'', allowTargets:'whitelist' }`（config `:180`）
  - 宿主 open 路由未授权时返回：`"开放接口没打开（面板「扩展」→ 联动）"`（host `:907`）
  - 客户端 `Modules` 页（`:3184-3224`）只有模块、安全模式、模拟测试，没有“联动”卡
- **影响**：用户按提示去扩展页找不到任何 HTTP/DSH 工具开关；`bridge.dshTools` 与 `bridge.http` 永远无法从面板启用，属于“功能存在但入口不存在”。同时 `overview()` 返回 `bridge` 状态（host `:537`），客户端没用。
- **修复**：在“扩展”页增加“联动”Card：DSH 工具开关、HTTP 开放接口开关、Token 显示/重置、允许目标选择；或从产品上移除 bridge 并在宿主错误里改文案。
- **性质**：确认功能缺口 / 文档-UI 不一致。

#### C09 · P1 · 确认功能缺口 · Voice 页缺少 `defaultVoice`、`speed`、HTTP `apiKey`/`headers` 控件
- **位置**：`src/core/config.js:85-87`；`client/client.js:1755-1798`、`:1363`；`src/voice/tts.js:249`
- **证据**：
  - 配置存在：`httpApi: { ... apiKey: '' }`、`defaultVoice: ''`、`speed: 1`（config `:85-87`）
  - Voice 页只有 `voice.openai.apiKey/model/voice/format`（`:1767-1771`）、HTTP `url/method/body/response/...`（`:1777-1784`），没有 `voice.httpApi.apiKey`、`headers`、`defaultVoice`、全局 `speed`
  - Persona 页有一个 `语速`（`:1363`），但那是 `persona.layers.voice.speed`，不是全局 `voice.speed`
  - TTS 实际优先级：`profile.voice || cfg.defaultVoice || ''`（`src/voice/tts.js:249`）
- **影响**：HTTP TTS 服务需要鉴权时无法从面板配置；`defaultVoice` 无法设置，HTTP provider 的 `{voice}` 模板可能为空；全局语速只能通过改配置文件。Persona 的“留空用语音页默认音色”提示指向不存在的控件。
- **修复**：Voice 页增加“默认音色（全局）”“全局语速”“HTTP API Key”“HTTP Headers”字段；Persona 的提示改为“留空则使用全局默认音色（在语音页设置）”；`voice.openai.voice` 明确标注“仅 OpenAI 兼容”。
- **性质**：确认功能缺口 / 文案误导。

#### C10 · P1 · 确认 Bug · `local.*` 与功能页开关形成双闸，且 LocalApi 状态显示不随 draft 更新
- **位置**：`client/client.js:3062-3085`（LocalApi）、`:1824-1847`（Stickers）、`:1755-1798`（Voice）、`:3341-3406`（ImageGen）；`src/modules/imagegen/index.js:41`；`src/modules/voice/index.js:99`；`src/chat/hub.js:1155`
- **证据**：
  - `LocalApi` 卡片开关：`right: f.sw('local.' + x.slot)`（`:3075`），仅改 draft；状态文字仍使用服务端旧 `x.enabled`（`:3077-3078`）
  - 生图模块：`enabled = profiles().length > 0 && (imageGen.enabled || local.active('image'))`（`src/modules/imagegen/index.js:41`）
  - 语音模块：`if (local.active('tts'))` 优先（`src/modules/voice/index.js:99`）
  - ASR：`transcribeOne` 先 `local.active('asr')`（`src/chat/hub.js:1155`），但 `wantTranscript` 由 `cfg.voice.asr` 决定（`hub.js:1338`）
- **影响**：用户开了 `local.image`，生图能力工作，但生图页仍显示“还没开启”；用户关了 `voice.enabled`，本地 TTS 也不会被调用（总闸仍在 hub）。LocalApi 的“出错时自动退回内置方式”没有说明这些前置条件，导致排障时看错开关。
- **修复**：把本地槽位建模为对应功能页的“实现方式”单选（内置/本地脚本），不再单独做开关；或至少在 LocalApi 卡片显示“受 `voice.enabled` / `imageGen.enabled` 影响”的联动状态，并在保存后重新拉 `/local/status`。
- **性质**：确认 Bug（双闸/状态不一致）。

### C3 · P2

#### C11 · P2 · 确认 Bug · `TAB_KEYS` 脏标记既漏键又过度包含
- **位置**：`client/client.js:3937-3941`；Group 页 `:1578-1581`；NewFeatures `:3802-3828`
- **证据**：
  - `group` 的映射只有 `['group','merge','participation','conversation']`，但 Group 页还编辑 `security.dangerConfirm`（`:1578`）和 `files.*`（`:1579-1581`）
  - `new-features` 映射包含整对象 `'group','voice','stickers','speakUp','bili','conversation'`；NewFeatures 只编辑 `group.ignoreAtOthers`、`voice.rvc.*`、`stickers.collectMode`、`speakUp.targets/mode`、`bili.danmaku*/vision*`。在 Voice/Stickers/Bili 页改任何字段，NewFeatures 标签都会亮脏点
  - `persona` 不在映射中（见 C05）
- **影响**：用户在当前页看不到自己改动的脏点（Group 的 files/security），却在从未打开的页面看到脏点（NewFeatures）；脏点失去“可信的未保存提示”功能，进一步加剧“哪个为准”的困惑。
- **修复**：映射精确到叶子路径（`group.ignoreAtOthers`、`voice.rvc.enabled`、`stickers.collectMode`……），或由字段定义自动生成；Persona 单独用 `personaDirty`；增加单元测试覆盖“每个页面修改每个字段后哪些 tab 亮”。
- **性质**：确认 Bug。

#### C12 · P2 · 设计问题 · `new-features` 是跨 6 个领域的大杂烩，且承载多个孤儿设置
- **位置**：`client/client.js:3790-3831`
- **证据**：5 张 Card：`聊天与附件`、`跨聊天只读策略`、`表情与语音`、`主动搭话`、`B 站`；其中 `stickers.collectMode`、`voice.rvc.*`、`bili.danmaku*/vision*`、`group.ignoreAtOthers`、`conversation.seedHistory` 在各自功能页都没有入口。
- **影响**：用户去“表情包”页找不到表情收集方式，去“语音”页找不到 RVC，去“B站”页找不到弹幕/视频理解；唯一的入口被藏在一个名字像“聊天设置”的页面里，这是“不知道配置去哪配”的最大来源。
- **修复**：按 B3 表把控制逐项搬回所属功能页；NewFeatures 只保留真正的跨聊天策略或删除；删除重复的 SpeakUp 卡。
- **性质**：设计/IA 问题（非崩溃，但直接导致抱怨 2、3）。

#### C13 · P2 · 确认 Bug · 心情有两层开关，任一层关闭都静默失效
- **位置**：`client/client.js:2455`（Mood）、`:1367`（Persona）；`src/features/mood.js:44-47`
- **证据**：`h(Card,{title:'心情设置（全局）',right:f.sw('mood.enabled')...})` vs `h(Row,{label:'有心情起伏'},h(Switch,{on: L('policy.mood') !== false,...}))`；`policyAllows` 同时检查 `config().enabled` 与 `identity.layers?.policy?.mood !== false`。
- **影响**：用户在“心情”页打开总开关，但人设卡里 `policy.mood=false`（默认 true，但编辑过可能关）时完全没反应；反之亦然。页面没有“当前人设覆盖了全局”的提示。
- **修复**：全局页显示“当前人设：已覆盖/跟随全局”，并提供跳到该人设的链接；或把 Persona 的 mood 改成三态（跟随/开/关）并在顶层计算有效值展示。
- **性质**：确认 Bug（多层门控无提示）。

#### C14 · P2 · 确认 Bug · 学习/表达有“全局总开关 + 学习开关 + 使用开关 + 人设策略”四层，且人设没有黑话开关
- **位置**：`client/client.js:2471-2474`、`:1368-1369`；`src/learning/contracts.js:49-51`；`src/learning/index.js:24-25`
- **证据**：Learning 页有 `enabled/learnEnabled/useEnabled/learnExpressions/useExpressions/learnJargon/useJargon`；Persona 只有 `policy.learnExpressions`/`policy.useExpressions`；`allows()` 做 `enabled && xxxEnabled && xxxExpressions`，`policy()` 再要求人设 policy 对应字段不为 false。
- **影响**：任意一层关闭都让功能静默失效；人设页没有 `learnJargon/useJargon`，即使用户在 Persona 里把表达关掉，黑话仍可能学习/使用（取决于全局），行为不一致。
- **修复**：合并为单一“学习/使用”策略；人设层只做 `inherit/on/off` 三态；在 Learning 页展示有效值拆解（全局/人设分别是什么）。
- **性质**：确认 Bug（门控设计）。

#### C15 · P2 · 确认 Bug · 默认音色/语速存在三套不同键，且人设提示错误
- **位置**：`src/core/config.js:86-87`；`client/client.js:1770`、`:1363`；`src/voice/tts.js:249-250`
- **证据**：`voice.defaultVoice`（无 UI） / `voice.openai.voice`（Voice 页“默认音色”） / `persona.layers.voice.voice`（Persona 页“音色”）；`profile.voice || cfg.defaultVoice`；`profile.speed || cfg.speed`。
- **影响**：用户以为 Voice 页“默认音色”是所有人设默认，实际只对 OpenAI provider 生效；HTTP provider + 空 persona 音色时 `{voice}` 为空。语速只有 Persona 页可调，全局 `voice.speed` 无法改。
- **修复**：见 C09；统一成一个 `voice.defaultVoice`/`voice.defaultSpeed`，OpenAI 的 `voice` 改名为 `openaiVoice`（或明确“OpenAI 专用”），Persona 只保留“覆盖”三态。
- **性质**：确认 Bug（语义/文案）。

#### C16 · P2 · 设计问题 · “模型”概念分散在 4 个页面，角色模型与服务模型没有关系说明
- **位置**：`client/client.js:1667-1754`（Model/ROLES）、`:1769`（Voice）、`:3420`（ImageGen profile）、`:2710`（RetrievalRole）
- **证据**：Model 页 `ROLES` 有 replyer/vision/stickerDecision/memory/learning/judge；Voice 的 `voice.openai.model`；ImageGen 的 `p.model`；Retrieval 的 `space.model`；各自独立保存、独立生效。
- **影响**：用户不知道“模型”页的 `roles.vision` 是否影响生图，也不知道 `imagegen` profile 的 model 与 `roles.vision` 哪个优先；改错地方没有效果。
- **修复**：在 Model 页增加“这些模型分别影响什么”的表格；把服务级模型放回各服务卡片并注明“只影响该服务”；`roles.vision` 标注“仅表情识别/媒体理解，不影响生图”。
- **性质**：设计/可发现性。

#### C17 · P2 · 确认行为不一致 · 测试/检查按钮使用“已保存配置”，但页面不阻止未保存编辑
- **位置**：`client/client.js:3407-3409`（ImageGen `ProfileCheck`）、`:1789-1790`（Voice 试听）、`:3289-3290`（Bili 检查登录）、`:3025`（Song 唱给我听）；对照 `:2407`/`:3559` 的正确做法
- **证据**：`ProfileCheck` 直接 `post('/imagegen/test', { id })`；Voice `post('/voice/test', { text: txt })`；Bili `get('/bili/account')`；Song `post('/song/request',...)`。Search 页用 `dirty ? "搜索设置尚未保存..."` 且按钮 `disabled: busy||dirty`；ImageJobs submit 也用 `unsaved` 禁提交。
- **影响**：用户改完 API Key/地址/模型后直接点“检查配置/试听/检查登录/唱给我听”，实际用的是旧配置，得到失败或旧结果，误以为新配置无效。`ProfileCheck` 对新加但未保存的 profile 还会传一个服务端不存在的 id。
- **修复**：统一模式：所有测试按钮在 `dirty` 时禁用并显示“请先保存”；或保存后自动继续测试（先 POST /save 再测试）；新 profile 的“检查配置”必须基于已保存 profile。
- **性质**：确认 UX Bug（行为不一致）。

#### C18 · P2 · 设计问题 · 表情包主开关藏在默认折叠的 `<details>` 内
- **位置**：`client/client.js:1830-1831`
- **证据**：`h('details',{className:'ab-sticker-section'},h('summary',null,'自动处理与发送设置'), h(Card,{...,right:f.sw('stickers.enabled')...}))`；`details` 没有 `open`，默认关闭。
- **影响**：进入表情包页先看到图库工作区；如果 `stickers.enabled` 为 false，用户看不到开关，也不会知道要展开“自动处理与发送设置”。这与“模块关掉标签消失”叠加，用户找不到“开启表情”的地方。
- **修复**：把主开关和状态摘要放在页面顶部 Card，不要折叠；高级设置再放 `<details>`。
- **性质**：设计/UX。

#### C19 · P2 · 确认 Bug · `/bili/state`、`/local/status` 失败时把错误对象当成功状态，页面崩溃
- **位置**：`client/client.js:3282-3283`（Bili）、`:3067-3068`、`:3075`（LocalApi）
- **证据**：`const load = () => get('/bili/state').then(setS)`；`const load = () => get('/local/status').then(setSt)`。`get` 在连不上时返回 `{ok:false,message:'连不上插件...'}`，仍是 truthy；随后 `s.history.length`（`:3315-3316`）或 `st.list.map`（`:3075`）会 `undefined` 抛异常。
- **影响**：网关重启/插件 API 暂时不可用时，B站页或本地接口页直接进入 TabBoundary 错误页，必须手动“再试一次”；错误信息不是“连不上插件”，而是渲染异常。
- **修复**：`load` 检查 `r.ok === false` 时 `setError` 并 return；给 `s`/`st` 初始值加结构默认 `{history:[]}`、`{list:[]}`；TabBoundary 错误提示保留原始错误。
- **性质**：确认 Bug（错误处理）。

#### C20 · P2 · 确认 Bug · ExtPage 的自动表单显示空值而不是模块默认值
- **位置**：`client/client.js:3257-3265`
- **证据**：`const settings = { ...(m.defaults || {}), ...((st.config.ext || {})[m.id] || {}) }`，但 `field()` 全部从 `getPath(draft, p)` 读取 `draft.ext`，没有把 `settings` 合并进 `draft`。`m.defaults` 只在传给 `ExtPanel` 时使用，自动表单不用。
- **影响**：新安装的扩展模块如果有默认值（例如 default true 的 switch、默认端口 number），表单显示 false/空；用户保存后会把默认值覆盖成空值（或模块行为与界面显示不符）。
- **修复**：`const value = getPath(draft,p) ?? settings[s.key]` 作为 field 的初始值；在 `draft.ext[id]` 初始化时合并 defaults；或渲染前 `ensureDefaults`。
- **性质**：确认 Bug。

#### C21 · P2 · 确认 Bug · Persona 加载失败永久显示“加载中”，没有错误/重试
- **位置**：`client/client.js:1224-1234`、`:1242-1243`、`:1325`
- **证据**：`loadList` 失败只 `toast(r.message)`，`list` 仍 `null`；`loadCard` 失败 `setCard(null); setForm(null); return`，没有 `error` state；render 对 `card` 为空固定 `Empty('加载中…')`。
- **影响**：`/persona/list` 或 `/persona/full` 暂时失败时，人设页永远转圈；用户只能刷新整个面板，且没有错误原因。
- **修复**：增加 `listError/cardError` 状态，渲染错误 Card + “重试”；`loadList` 设置空数组 + 错误；`loadCard` toast + 可重试。
- **性质**：确认 Bug（错误处理）。

#### C22 · P2 · 确认 Bug · 宿主 `/save` 的“部分成功”用 `ok:false` 返回，客户端将其当整体失败，dirty 状态错乱
- **位置**：`src/host.js:549-562`；`client/client.js:3886-3891`
- **证据**：宿主先 `setConfig(mergeFromPanel(...))`（保存了其它设置），如果 SnowLuma 改密码失败，返回 `{ ...overview(), ok:false, message:'其他设置保存了，但控制台密码没改...' }`；客户端 `if (r.ok === false) { toast(...); return }`，不执行 `setSt/setDraft`，`dirtyRef` 仍为 true。
- **影响**：用户看到“保存失败”，底部仍显示“有改动还没保存”，但大部分设置其实已经写入；下一次轮询 `st.config` 更新后，draft 与 st 的差异可能消失/变形，用户不知道到底保存了什么，可能重复保存或放弃。
- **修复**：宿主返回 `{ok:true, partial:true, warnings:[...]}` 或 `{saved:true, passwordOk:false}`；客户端按 `saved` 更新 `st/draft`，把 `warnings` 用 warning toast 展示。
- **性质**：确认 Bug（API 契约/错误处理）。

#### C23 · P2 · 确认 Bug · Wizard 的 `await save(...)` 实际无法判断失败，失败也继续下一步
- **位置**：`client/client.js:3708-3712`、`:3729`、`:3769-3770`、`:3881-3892`
- **证据**：`save` 没有返回值（成功/失败都是 `undefined`），`next` 里 `if (step===0||step===1) await save({...draft, enabled:true})` 后无条件 `go(step+1)`；`/setup/done` 也只看自己的 `r.ok`。
- **影响**：QQ 号格式错误、SnowLuma 目录保存失败、网络失败时，向导仍然前进到下一步，最终可能显示“完成”但配置没保存；用户重复操作。
- **修复**：`save` 返回 `{ok, config, message}`；Wizard 的 `next` 在失败时停留并显示错误；`/setup/done` 前确认保存成功。
- **性质**：确认 Bug（流程控制）。

#### C24 · P2 · 确认 Bug · 跨聊天策略/主动搭话目标等非法值保存后被静默过滤，用户输入“消失”
- **位置**：`client/client.js:3808-3812`（NewFeatures 策略编辑）、`:3821`（SpeakUp targets）；`src/core/config.js:238-239`
- **证据**：`crossChatHistory` 归一化：`.filter(p => /^(private|group):\d+$/.test(p.fromChatId) && ... )`；`speakUp.targets`：`.filter(id => /^(private|group):\d+$/.test(id))`。`mergeFromPanel` 不提前校验，客户端也不提示格式。
- **影响**：用户在策略行里填了 `private:abc`、群号带空格或人格 ID 为空，点保存后行静默消失（或 targets 被过滤），不知道哪里错；`slice(0,100)/slice(0,50)` 也会静默截断。
- **修复**：客户端逐行校验并显示行级错误；宿主返回 `warnings` 而不是静默 drop；对上限显示计数和提示。
- **性质**：确认 Bug（静默数据丢失/误导）。

#### C25 · P2 · 性能问题 · 5 秒全量 `/state` + 每次渲染全量 `JSON.stringify`，面板越大越卡
- **位置**：`client/client.js:3866`、`:3878`、`:3937-3941`；`src/host.js:503-538`；`src/chat/hub.js:2284`
- **证据**：
  - `setInterval(reload, 5000)` 无条件 `setSt(r)`；`dirty`/`tabDirty` 每次渲染 `JSON.stringify(draft)`、`JSON.stringify(st.config)`，25 个标签的映射再逐项 `JSON.stringify(draft[k])`。
  - `overview()` 每次 `await snowluma.running()`（HTTP 3s 超时）、`hub.sessions()` 读 `sessions.json`（`src/chat/hub.js:2284` `sessions: () => map().chats`），`storage.info()`、`stickers.library()`、`modules.status()`。
- **影响**：输入每个字符都触发整页 render + 多次大对象序列化；5 秒一次的全量对象替换导致所有子组件重渲染。`imageGen.profiles[].extra` 可包含 ComfyUI 大 workflow，`retrieval.roles` 可能很大，JSON stringify 成本显著。
- **修复**：`/state` 改为 SSE/长轮询或至少 15–30s 且只传变化；服务端返回 config revision；客户端用 `useSyncExternalStore`/浅比较；dirty 改用受控字段版本号；标签脏点按字段路径订阅，不再全量 stringify。
- **性质**：设计/性能问题。

#### C26 · P2 · 性能问题 · `setPath` 每次按键深拷贝整份配置
- **位置**：`client/client.js:24-28`、`:490-499`
- **证据**：`const setPath = (obj, path, value) => { const next = clone(obj); ... }`，`clone = JSON.parse(JSON.stringify(o))`；`useField.text` 的每个 `onChange` 都走 `setDraft(setPath(draft,path,e.target.value))`。
- **影响**：在生图服务/检索角色等大型配置页输入一个字符，会克隆整份 config（含 profiles、workflow、retrieval roles）；长文本编辑明显卡顿。
- **修复**：使用不可变路径更新（只 clone 路径上的对象），或引入 `immer`/`useReducer`；大文本字段用局部 state + debounce 提交。
- **性质**：设计/性能问题。

#### C27 · P2 · 确认结构 Bug · `TabBoundary` 只包住主 body，不包嵌入的扩展模块；模块渲染错误会炸整页
- **位置**：`client/client.js:3967-3969`、`:3252-3273`
- **证据**：`h(TabBoundary,{key:curTab.id,...},h(body,...))` 包住主页面；下一行 `mods.filter(m=>hasUi(m)&&m.tab===curTab.id).map(...h(ExtPage...))` 在 `TabBoundary` 外。`ExtPage` 可渲染任意模块 `panel.js` 或 settings 字段。
- **影响**：嵌入模块的 `panel.js` 或 settings 渲染抛错时，异常冒泡到 `AurabotPage`，整个面板白屏，而不是只坏该模块卡。
- **修复**：每个 `ExtPage` 外层套 `PanelBoundary`（已有组件，`client/client.js:3228-3232`），或把嵌入模块放进 `TabBoundary` 内。
- **性质**：确认 Bug（错误边界覆盖不全）。

#### C28 · P2 · 确认 Bug · `toast` 按中文字符串猜错误类型，`copy` 不 await `navigator.clipboard`
- **位置**：`client/client.js:3852-3858`、`:552`
- **证据**：
  - `const k = kind || (/失败|出错|没成功|不能|读不到|连不上/.test(text) ? 'err' : '')`；调用方大量 `toast(r.message)` 不传 `r.ok`，如 `:716`、`:1790`、`:2113`、`:3735`。
  - `copy`：`try { navigator.clipboard.writeText(text); if (msg) toast(msg,'ok') } catch(e) {...}`；`writeText` 返回 Promise，拒绝时不会进入同步 catch。
- **影响**：成功消息含“不能/不能…”被染红；失败消息不含关键词显示普通色；复制被浏览器拒绝（权限/非安全上下文）仍提示“复制好了”。
- **修复**：`toast(message, kind)` 调用方显式传 `r.ok ? 'ok' : 'err'`；`copy` 改为 `await navigator.clipboard.writeText` 并 `.catch`，提供 `document.execCommand` fallback。
- **性质**：确认 Bug（反馈误导）。

#### C29 · P2 · 设计问题 · UI 输入范围与 `normalize` 限制不一致，保存后数值被静默夹断
- **位置**：`client/client.js:1710`（toolCallsPerTurn max 20）、`:1583-1586`（merge 范围）、`:1788`（voice.autoMaxChars 10–200）；`src/core/config.js:230`（1–30）、`:328-333`（merge 的 normalize 上下限）
- **证据**：UI 的 `Range` max 20，配置 normalize 允许 30；`merge.waitSec` UI 0.5–10，配置 0–30；`merge.maxSec` UI 2–30，配置 0–60；`voice.autoMaxChars` UI 10–200，配置 1–500。保存后 `normalize` 会 `num(...)` 夹到边界，页面重载后值可能跳变。
- **影响**：用户无法设置合法的高值，或设置后显示/实际不一致；误以为保存失败。
- **修复**：从同一配置 schema 生成 min/max/step，前后端共用；或 UI 显示 normalize 后的值并提示“已调整到允许范围”。
- **性质**：设计/一致性问题。

#### C40 · P2 · 确认 Bug · `get`/`post` 封装不检查 HTTP 状态、没有超时/Abort，错误一律伪装成“连不上插件”
- **位置**：`client/client.js:18-22`
- **证据**：
  - `const get = (p) => fetch(...).then((r) => r.json()).catch((e) => ({ ok:false, message:'连不上插件：'+e.message }))`
  - `post` 同样只 `r.json()`，没有 `r.ok` 判断、没有 `AbortController`/`timeout`；`/state` 里 `snowluma.running()` 单次可等 3 秒、`get_login_info` 可等 5 秒。
  - 调用方大量把 `r.ok === false` 当业务失败，把 `catch` 当网络失败；但 HTTP 500 返回 HTML 时 `r.json()` 会 reject，同样显示“连不上插件”，掩盖真实 500。
- **影响**：网关/宿主返回 500、超时、半截 JSON 都被误报为“连不上插件”；请求永不超时会把 `setInterval(reload, 5000)` 堆成并发请求（叠加 C01）。用户无法判断是网络、插件崩溃还是配置错误。
- **修复**：封装 `request(path, {signal, timeoutMs})`：检查 `response.ok`、`content-type`，用 `AbortSignal.timeout(15000)`；区分 `HTTP_ERROR`/`NETWORK`/`TIMEOUT`/`INVALID_JSON`；统一 `{ok, code, message}`。
- **性质**：确认 Bug（错误处理）。

#### C41 · P2 · 确认 Bug · 加载成功后 `/state` 轮询失败不显示错误，面板继续显示旧状态
- **位置**：`client/client.js:3859-3864`、`:3911-3912`
- **证据**：`reload` 失败时 `setErr(r.message)`，但成功加载后的渲染路径完全没有读取 `err`；唯一显示 `err` 的分支是 `if (!st || !draft)` 的初始 loading 卡片（`:3911-3912`）。
- **影响**：插件宿主崩溃/路由 503/网络断开后，面板仍显示最后一次成功状态（在线、连接正常、旧数字），用户继续操作才发现保存/测试失败；没有“状态已过期”提示。
- **修复**：在已加载页面顶部渲染 `err` 的 warning/error banner，保留旧数据但标注“数据可能已过期 + 重试”；`reload` 连续失败时降级为只读并暂停快捷键保存。
- **性质**：确认 Bug（错误可见性）。

### C4 · P3

#### C30 · P3 · 可访问性问题 · `Select` 没有真正的 listbox 键盘焦点/`aria-activedescendant`
- **位置**：`client/client.js:430-456`
- **证据**：选项是 `h('div',{role:'option',...})`（`:448`），不可聚焦；焦点始终在按钮上；没有 `aria-activedescendant`、没有 `aria-controls`；`onKey` 的 Arrow 只改 `act` 状态。`Select` 打开后没有滚动到 `act` 项。
- **影响**：键盘/读屏用户无法知道当前高亮项，长列表不可用；`Tab` 离开不会关闭 popup。
- **修复**：按钮加 `aria-controls`/`aria-activedescendant`；选项加 id；`act` 变化时 `scrollIntoView({block:'nearest'})`；`onBlur`/`Tab` 关闭；或直接用原生 `<select>` + 自定义样式。
- **性质**：可访问性/设计问题。

#### C31 · P3 · 可访问性问题 · `Switch` 多数没有可访问名称，`Row` 不是 `<label>`，`Range` 无名称
- **位置**：`client/client.js:396-397`、`:399-400`、`:466-469`
- **证据**：`Switch` 只有 `title`（可选）和 `aria-checked`，没有 `aria-label`/`aria-labelledby`；`Row` 用 `h('b')` 渲染 label；`Range` 的 `<input type=range>` 没有 `aria-label`。
- **影响**：读屏会读成“开关”而不知道是“总开关/试运行/语音”；点击文字标签也不会聚焦控件。页面上近百个开关，影响显著。
- **修复**：`Row` 给子控件生成 id 并通过 `htmlFor`/`aria-labelledby` 关联；`Switch` 增加 `label` prop；`Range` 增加 `aria-label`。
- **性质**：可访问性。

#### C32 · P3 · 确认小 Bug · `ListArea` 的 effect 依赖是表达式且会在外部更新时覆盖正在输入的内容
- **位置**：`client/client.js:479-486`
- **证据**：`useEffect(() => { if (parse(text).join('\n') !== value.join('\n')) setText(value.join('\n')) }, [value.join('\n')])`；依赖是运行时字符串，不是 `value` 本身；`parse` 未列入依赖。外部保存/5 秒刷新/撤销时会把 `text` 重置为规范化后的值。
- **影响**：用户正在输入的空行、逗号、空格格式在外部 value 变化时被重置；与 C03/C01 叠加更易丢输入。ESLint 也会报 missing dependency。
- **修复**：用 `useEffect(...,[value])` 并比较规范化值；或维护 `lastValueRef`，只在非聚焦/非 composition 时同步；把 `parse` 提为模块级纯函数。
- **性质**：确认小 Bug / 可维护性。

#### C33 · P3 · 确认 Bug · 多个异步预览/校验没有请求序号，旧响应会覆盖新状态
- **位置**：`client/client.js:1397-1401`（EffectivePrompt）、`:1421-1422`（PersonaPreview）、`:2913-2916`（RootPicker）、`:2389-2396`（Search 有部分保护）
- **证据**：`get('/prompt/preview?...').then(value => { if(active) setP(value) })` 用 `active` 只防卸载，不防同一组件内旧请求；`post('/persona/preview',...).then(r=>setA(...))` 没有序列号；`get('/song/root/check...').then(setChk)` 直接 set。
- **影响**：快速切换聊天/快速输入路径/快速切换人设时，后发请求先返回，旧结果覆盖新结果，显示错误提示词/错误磁盘检查。
- **修复**：统一 `const seq=useRef(0); const id=++seq.current; ... if(id===seq.current) setState(...)`；用 AbortController 取消旧请求。
- **性质**：确认 Bug（竞态）。

#### C34 · P3 · 设计问题 · 标签栏滚轮 effect 每次 render 重绑；移动端标签换行而非横向滚动
- **位置**：`client/client.js:3869-3876`；CSS `:68-69`
- **证据**：`useEffect(() => { ... el.addEventListener('wheel', onWheel, {passive:false}); return ... })` 没有依赖数组，每次 render 都重绑；`.ab-tabs{display:flex;flex-wrap:wrap;...}`，`scrollWidth > clientWidth` 在 wrap 布局下通常不成立，滚轮横向滚动不会触发；没有移动端折叠/滚动容器。
- **影响**：每次输入/每 5 秒轮询都重建 wheel 监听；窄屏 25 个标签会换成多行，粘性头部占据大量视口。
- **修复**：加 `[]` 依赖；移动端改为横向 `overflow-x:auto; flex-wrap:nowrap` + 可折叠分组，或二级导航抽屉。
- **性质**：性能/响应式设计。

#### C35 · P3 · 可维护性 · 25 个标签由 4 份平行映射维护，且存在死代码
- **位置**：`client/client.js:504-532`（TABS/TAB_MODS）、`:3834`（PANEL_GROUPS）、`:3937`（TAB_KEYS）；`:533` `modOn`、`:534-536` `ModOff` 从未使用
- **证据**：新增/改名一个标签需要同步改 4 处；`modOn` 无调用，`ModOff` 无调用；`keepPanel` 由 `src/core/modules.js:671` 返回但 client 不读。
- **影响**：标签数量/分组/脏点/显示条件容易再次漂移；`ModOff` 本来可用于“模块关闭但仍展示设置”，现在功能缺失。
- **修复**：建立单一 `PAGE_DEFS` 数组：`{id,label,group,component,moduleId,flag,configKeys,keepPanel}`，由它生成 TABS/PANEL_GROUPS/TAB_MODS/TAB_KEYS；删除未使用函数。
- **性质**：可维护性。

#### C36 · P3 · 性能/结构 · 页面没有 memo，Persona 首次访问后永久隐藏挂载
- **位置**：`client/client.js:3967`；全文无 `React.memo`/`useMemo` 包裹页面组件
- **证据**：`(personaVisited || curTab.id==='persona') ? h(TabBoundary,...,h(Persona,props)) : null` 放在 `display:none` 外层；`Persona` 有 192 行 + 225 行的子组件，之后每次 5 秒 `setSt` 都重新渲染隐藏的整棵 Persona 树。
- **影响**：Persona 页的编辑状态保留是优点，但代价是每次轮询/任意输入都渲染整套人设表单；其他页面切换回来则重新挂载，状态丢失（`Tasks` 过滤、搜索等）。
- **修复**：用 `React.memo`/`useMemo` 按 props 缓存；或把 Persona 状态提升到一个轻量 store，隐藏时只保留状态不渲染表单；或只在 visited 且 tab 可见时挂载，用 `useRef` 保存表单状态。
- **性质**：性能/结构。

#### C37 · P3 · 设计问题 · 多个页面的“查看范围”各自维护，切换标签后回到默认主人私聊
- **位置**：`client/client.js:2387`（Search）、`:2450`（Mood）、`:2466`（Learning）、`:2597`（Memory）、`:2610`（Media）、`:2652`（Retrieval）、`:2518`（Tasks）
- **证据**：每处 `useState({account:..., chat:'private:'+ownerQQ, persona:...})` 或 `useViewingScope(...)`，没有共享 context；每个页面独立选择。
- **影响**：用户在“记忆”页选了某个群查看，切到“表达与黑话/心情/检索”又回到主人私聊；重复选择成本高，也容易误操作到错误范围。
- **修复**：在 AurabotPage 维护一个全局 `viewingScope`（或 Context），各页共用；按页面可选 `persona` 开关；把“当前查看范围”显示在页头。
- **性质**：设计/UX。

#### C38 · P3 · 设计问题 · 表情决策日志只看 `chatScope`（默认主人私聊），与账号共用图库范围不一致
- **位置**：`client/client.js:1847`
- **证据**：`h(StickerDecisionLog,{st,scope:{...chatScope,account:st.config.botQQ}})`；`chatScope` 初始 `chat:'private:'+ownerQQ`（`:1825`），当 `perChat=false` 时 `StickerWorkspace` 是账号级，但决策日志仍默认主人私聊。
- **影响**：用户以为在看“当前账号所有表情决策”，实际只看到主人私聊；需要手动在决策日志里再选聊天，且默认不是账号全部。
- **修复**：`libraryScope === 'account'` 时默认 `range='all'`（决策日志支持 `all`），或在页面显式标明“当前决策日志范围”。
- **性质**：设计/UX。

#### C39 · P3 · 设计问题 · 本地接口状态文案使用服务端的 `x.enabled/x.active`，不会跟随 draft 开关
- **位置**：`client/client.js:3067-3078`
- **证据**：`load` 只在 mount 调用一次（`:3068`）；`x.active`/`x.enabled` 来自 `/local/status`，`f.sw('local.'+x.slot)` 只改 draft；保存后没有重新 `load()`，状态仍是旧值。
- **影响**：用户打开开关后，卡片仍显示“脚本已经有了，开关没开（用内置方式）”；保存后也不更新，误以为开关无效。
- **修复**：保存后 `/local/status` 重新拉取；或状态文案基于 `draft.local[slot]` 而不是服务端 snapshot；把 active/error 分开显示。
- **性质**：确认小 Bug（状态陈旧）。

---

### C5 · Hooks / 状态同步专项核查（结论）

| 检查项 | 结论 | 证据 |
|---|---|---|
| `AurabotPage` 条件 return 是否会破坏 hooks 顺序 | **不会**。所有 `useState/useEffect/useMemo/useCallback` 都在 `if (!st || !draft) return` 之前调用；`Persona` 是元素级条件渲染，不是条件调用 hook | `client/client.js:3836-3912`（hooks 到 `return` 的顺序） |
| Persona 特殊缓存分支是否有 Rules of Hooks 违规 | **没有确认违规**。`Persona` 自己的 hooks 全部在函数顶部（`:1200-1243`）；但它在首次访问后永久挂载在 `display:none` 外层，形成“隐藏但活着”的独立生命周期：`EffectivePrompt` 仍在挂载树中，`JSON.stringify(st.config)` 变化会触发 `/prompt/preview`；`PersonaReferences` 的 effect 也会保持监听 | `client/client.js:3967`、`:1200-1243`、`:1392-1401` |
| `TabBoundary` 是否包住所有页面 | **没有**。主 body 和 Persona 被包住；嵌入的 `ExtPage`（`:3969`）在 boundary 外；`TabBoundary` 是 class error boundary，只捕获渲染/生命周期错误，**不捕获 async/event handler**，所以 `onClick` 里的 throw、fetch rejection 不会显示为“这一页出错了” | `client/client.js:538-551`、`:3967-3969` |
| render 期间写 ref | 存在多处“render 时同步 ref”的写法：`dirtyRef.current = dirty`（`:3879`）、`selectedRef.current = sel`（`:1219`）、`accountContextRef.current` 修改（`:1217`）、`StickerDecisionLog` 的 `active.current` 修改（`:1862-1863`）。当前依赖同步 render 可工作，但在 concurrent/strict 模式下属于不纯渲染，可能读到被丢弃 render 的 ref | `client/client.js:3879`、`:1217-1219`、`:1862-1863` |
| `useEffect` 依赖遗漏 / 表达式依赖 | 已确认：`ListArea` 依赖 `value.join('\n')` 表达式（C32）；`tabsRef` wheel effect 无依赖数组（C34）；`RootPicker`/`EffectivePrompt`/`PersonaPreview` 缺取消（C33）。其余多数 effect 有依赖，但 `load` 函数常被整体放入依赖，导致每次 render 重建 | `client/client.js:483`、`:3870-3876`、`:1397-1401`、`:1421-1422`、`:2913-2916` |
| 受控/非受控 input | 未发现文本 input 在受控/非受控之间切换的确认 bug；`useField` 全部用 `value`，文件 input 用 ref + `e.target.value=''`（如 `:2900`）是合理非受控。风险在 `ListArea`/`JsonArea` 用局部 `text` 与外部 `value` 双状态，已在 C32 记录 | `client/client.js:479-486`、`:3453-3465` |
| 每页是否 memo | **没有**。全文未 import `React.memo`/`useMemo` 包裹页面组件（仅用 `useMemo` 算 dirty）；`Persona` 隐藏挂载时每次 `setSt` 仍重渲染整棵人设树。`TabBoundary` 的 `key={curTab.id}` 又导致其它页面每次切换重新挂载 | `client/client.js:3878`、`:3967-3968` |

> 结论：**没有发现 React “hooks 顺序”层面的硬错误**；真正的风险是 Persona 的条件挂载/隐藏存活、TabBoundary 覆盖不完整、render 期间 ref 写入，以及多处未取消的异步请求。它们和 C05/C27/C33/C34/C36 是同一组问题的不同表现。

---

## D. UI/UX 结构问题

### D1. 两级导航看起来像两排同级标签
- `client/client.js:3960` 的分组按钮和 `:3962-3966` 的页面按钮都使用 `className: 'ab-tab'`；CSS `:68` 只有一套 `.ab-tab` 样式。用户看到的是两排几乎相同的 tab，而不是“分组标题 + 子标签”。
- `PANEL_GROUPS['常用']` 声明顺序为 `overview, connect, persona, access, group, new-features`，但实际 `TABS` 顺序是 `overview, new-features, connect, persona, access, group`（`:504-510`）；分组声明顺序与实际显示顺序不一致，进一步破坏空间记忆。
- 建议：一级用 sidebar/segmented control，二级用 tabs；分组按钮加大字号/不同底色；或在窄屏折叠为下拉。

### D2. 标签命名歧义
| 标签 | 用户以为 | 实际 |
|---|---|---|
| `聊天`（group） | 所有聊天行为，包括私聊/群聊 | 主要是群聊策略、群插话、群覆盖；私聊/群聊共用项在 NewFeatures |
| `聊天与功能设置`（new-features） | 聊天相关设置 | 跨聊天策略 + 附件 + 表情 + RVC + 主动搭话 + B站，跨 6 个领域 |
| `权限`（access） | 所有权限 | 主人/白名单/资料修改/长任务；群管只看白名单，不能改群策略 |
| `记忆`（memory） vs `检索与索引`（retrieval） | 都是“找记忆/搜索” | 记忆是事实/画像/共享组；检索是索引/向量/重排/检索测试；两页都能查事实 |
| `搜索`（search） vs `检索与索引` | 都是搜索 | Tavily 网页搜索 vs 本地记忆索引，后端完全不同 |
| `模型`（model） | 所有模型 | 聊天模型 + 后台角色模型；TTS/生图/向量模型分别在各自页面 |
- 建议重命名：`聊天与群`（Group）、`权限与名单`（Access）、`联网搜索`（Search）、`记忆检索`（Retrieval）、`模型与费用`（Model/Token）。

### D3. 保存模型至少 5 种，用户无法建立心智模型
| 保存方式 | 代表页面 | 代码证据 | 用户体验 |
|---|---|---|---|
| 全局 draft + 底部保存条 / Ctrl+S | 大部分设置页 | `client/client.js:3878-3892`、`:3970-3973` | 改了不一定马上生效；离开页面前要记得按保存 |
| Persona 独立草稿/发布 | 人格 | `:1277-1293`、`:1383-1384` | 与底部保存条并列，不知道“存草稿”和“保存设置”区别 |
| 模块开关即时 `/save` | 扩展/模块行 | `:3103-3108`、`:3213` | 没有底部保存提示，点一下立即生效；与其它页的 draft 冲突 |
| 扩展面板即时 `/save` | 自定义模块 panel | `:3249` | 同上，且无法撤销 |
| 测试/检查基于已保存配置 | 语音/生图/B站/翻唱 | `:3407-3409`、`:1789-1790`、`:3290`、`:3025` | “先保存再测试”只在部分页面提示，用户反复试错 |
- 建议：明确“只有一种保存：底部保存”或“所有卡片即时保存，无底部条”；Persona 的草稿/发布作为唯一例外必须显著标为“人设版本管理”，并在离开时确认。

### D4. 开关 flag / 模块门控导致“页面消失”
- 业务开关：`TABS` 的 `flag` 只控制标签上的灰点（`:512-524`、`:3963-3965`），不会隐藏页面。
- 模块开关：`TAB_MODS` + `TABS.filter` 会让 15 个页面在模块未运行时直接消失（`:532`、`:3927`），包括 voice/stickers/imagegen/search/speakup/mood/memory/retrieval/media-memory/learning/tasks/song/bili/token-meter。
- `ModOff`（`:534-536`）本来是给“模块关着但保留页面”的提示组件，但从未使用；`keepPanel` 由 `src/core/modules.js:671` 返回，客户端未实现。
- 后果：用户关掉“表情包”模块后，表情包标签消失，想再打开只能去“扩展”找模块行；业务开关 `stickers.enabled` 也一起不可达。
- 建议：模块关闭时保留标签，显示 `ModOff` 卡（“模块关着，去扩展打开”+ 按钮）；业务开关放在功能页顶部；`keepPanel` 用于自带设置页的模块。

### D5. 空状态 / 引导 / 配置地图
- 概览没有“从哪里开始”的配置地图；只有状态卡和快捷操作。新用户看到 25 个标签不知道该点哪个。
- `NewFeatures` 没有引导说明它是“收留所”；用户很难知道 RVC/弹幕/收集方式在这里。
- `Overview` 的“最近动态”只到日志；没有“未完成配置”清单（SnowLuma 未安装、模型未选、语音未配、记忆未开）。
- 建议：概览增加“配置完成度”清单（接入/人格/模型/语音/记忆）和每项“去设置 →”；给每个功能页加“该功能是否可用”状态条。

### D6. 移动端/窄屏
- `.ab-tabs{display:flex;flex-wrap:wrap;...}`（`:68`）会换行；25 个标签在窄屏变成多行，`position:sticky;top:0`（`:68`）占用大量高度。
- `tabsRef` 的滚轮横向滚动在 `flex-wrap:wrap` 下基本不触发（C34）。
- `.ab-row` 在 `max-width:640px` 变成纵向（`:53`），但 `ab-g4` 的 `minmax(150px,1fr)` 和 `ab-g2` 的 300px 仍可能挤压；`ab-sticker-gallery` 有专门媒体查询，说明其它页面未系统适配。
- 建议：移动端使用“分组 + 当前组横向滚动”或抽屉；`ab-tabs` 在各断点改为 `flex-wrap:nowrap; overflow-x:auto`；为 `ab-card` 的 `right` 控件加窄屏换行。

### D7. 首次使用向导
- 见 C02：`showWizard` 阻断全部标签；向导第 1 步没有“跳过/稍后安装 SnowLuma”。
- `Wizard` 用 `localStorage.aurabot.wiz` 记录步骤（`:3698-3699`），但 `showWizard` 只看 `setupDone`；关闭向导后下次继续可能从旧步骤开始，和“重新走一遍”按钮语义不一致。
- 建议：向导改为非阻断式 checklist（概览里的 5 步），用户随时可离开；`重新走一遍` 显式重置到 step 0。

### D8. 页面状态/滚动/筛选在切换后重置
- `TabBoundary` 以 `key={curTab.id}` 强制重新挂载（`:3968`），除 Persona 外所有页面切换后筛选、搜索、分页、滚动位置都丢失；Persona 是唯一保留的（`:3967`），体验不一致。
- 建议：页面组件不强制 key，或用 URL/localStorage 保存各页轻量状态；Persona 的保留策略统一到所有页或都不保留。

---

## E. 代码质量

### E1. 规模与组织
- `client/client.js` 单文件 3993 行，包含 CSS（45-374）、70+ 组件、API 封装、状态、业务表单、诊断/日志/表格；没有任何按功能拆分。任何小改动都在一个 4000 行文件里 review。
- 106 处 `h(Card)`、599 处 `h('div')`、193 处内联 `style: {`、266 处 `useState`、61 处 `useEffect`；CSS 中还有两段“美化”重复覆盖（`:24-374`），维护时很难判断最终生效规则。
- 没有 build/TypeScript；`h()` 手写，字段名、props、事件拼写全靠运行时。

### E2. 四份平行映射
- `TABS`（`:504-529`）、`TAB_MODS`（`:532`）、`PANEL_GROUPS`（`:3834`）、`TAB_KEYS`（`:3937`）必须手工同步；新增一个标签要改 4 处，且没有测试保证一致。
- `modOn`（`:533`）、`ModOff`（`:534-536`）未被调用；`tabs` 配置（`src/core/config.js:173`）也没有被使用（实际是 localStorage）。这些“半成品”说明设计曾计划过更灵活的导航但没有完成。

### E3. 重复 UI 流程
- `Connect`（`:683-751`）和 `Wizard`（`:3697-3774`）各实现一套 SnowLuma 下载/解压/启动/协议/接入步骤；文案和按钮状态略有漂移（Wizard 没有 Connect 的 `高级` 字段，Connect 没有向导的分步校验）。
- `Settings` 各处重复 `setBusy` + `load` + `toast` 模式；`ScopePicker` 在 7 个页面重复初始化（C37）。
- 重复的常量块：`STICKER_STATES`（`:1818`）、`ROLES`（`:1723`）、`TOKEN_METRICS`（`:2142`）、`IMG_PROTOCOLS`（`:3324`）等；本身可接受，但应集中到 `constants`/模块。

### E4. 硬编码与平台假设
- 大量中文文案硬编码在 JSX；无法统一改词/翻译。
- 默认路径 `C:\Aurabot\snowluma`、`C:\Aurabot\qq-chats` 等 Windows 路径散落在 UI/配置；插件当前 Windows-only，但客户端的“本地接口/翻唱”页面仍把路径当字符串显示，跨平台时会误导。
- 大量 `max/min/step` 硬编码与 `config.js` 的 `num()` 范围不一致（C29）。

### E5. 异步/错误处理模式
- 大量 `load` 函数没有 `r.ok` 检查（C19），大量 `useEffect` 没有 Abort/序列号（C33），大量 `setInterval` 没有“仅可见时”限制。
- `Btn` 的 `onClick` 只 `try/finally` 不 `catch`（`:408-413`），异步异常会变成 unhandled rejection，用户只看到按钮复原。
- `toast` 靠字符串猜类型（C28）；没有统一的 `ApiError` 类型。

### E6. 测试
- 仓库有 `test/issue16-panel.test.js`、`test/stickers-ui.test.js`、`test/token-dashboard-panel.test.js` 等静态/VM 测试，但**没有覆盖** `TAB_KEYS` 与页面字段的一致性、`save`/轮询竞态、分组切换、模块死代码、`Persona` 与全局 dirty 的交互。
- 改前端 IA 前应先补一组“页面-键-标签”契约测试，否则重构会破坏现有静态断言（例如 `test/issue16-panel.test.js` 明确要求 `NewFeatures` 包含 `stickers.collectMode`、`voice.rvc.enabled` 等 path，见该文件 `test/issue16-panel.test.js:19`）。

---

## F. 前端重构建议

### F1. 目标信息架构（建议 7 个一级页 + 二级页）

| 一级页 | 二级页/区块 | 归属设置 |
|---|---|---|
| **概览** | 状态、配置完成度、快捷操作、最近动态、更新提示 | 只读 + `enabled`/`dryRun` 顶部总开关 |
| **接入** | SnowLuma、协议、启动/接入、连接诊断、高级地址令牌 | `snowluma.*`, `botQQ`；Wizard 改成概览 checklist 或抽屉 |
| **人格** | 卡片列表、编辑（身份/行为/说话/外观/声音）、参考图、绑定、版本历史 | `persona.*`、`persona.layers.*`；全局语音默认放“能力/语音” |
| **聊天与群** | 权限与名单、群策略、消息合并、会话窗口、附件、跨聊天策略、安全/文件 | `owner*`, `allow`, `profilePerms`, `longTasks`, `group.*`, `merge.*`, `conversation.*`, `incomingFiles`, `ignoredSenderQQs`, `crossChatHistory`, `security`, `files` |
| **能力** | 语音、表情包、生图、联网搜索、主动搭话、翻唱、B站（每个功能一页） | `voice.*`, `stickers.*`, `imageGen.*`, `search.*`, `speakUp.*`, `song.*`, `bili.*`；模块开关只做“启用/停用”，业务开关在功能页顶部 |
| **记忆与学习** | 记忆、检索与索引、图片理解、心情、表达与黑话 | `memory.*`, `retrieval.*`, `mediaMemory.*`, `mood.*`, `learning.*` |
| **系统** | 模型与用量、扩展、本地接口、联动、日志、诊断、Token | `model.*`, `chatModels.*`, `roles.*`, `toolCallsPerTurn`, `modules`, `safeMode`, `ext.*`, `local.*`, `bridge.*`, `token-meter`, `diagnostics`, `logs` |

> “模型”建议作为“系统”下的二级页，或独立一级“模型与用量”；生图/语音的服务模型留在各自服务卡片，不再和 `roles.*` 混在一起。

### F2. 去重原则（单一事实来源）

1. **每个配置键只有一个 owner 页面**：用 schema 声明 `key -> {page, section, label, type, min, max, visibleWhen}`；同一 key 不允许手工出现在第二个页面。`speakUp.targets/mode` 只保留 SpeakUp 页。
2. **功能页拥有自己的全部设置**：`stickers.collectMode` 回 Stickers，`voice.rvc.*` 回 Voice，`bili.danmaku*/vision*` 回 Bili，`group.ignoreAtOthers`/`conversation.seedHistory` 回 Group/Chat。
3. **模块开关与业务开关分层但可见**：`modules.<id>.enabled` 是“模块是否加载”，`<feature>.enabled` 是“功能是否使用”；模块关闭时保留标签并显示 `ModOff`，业务页顶部显示“模块未运行 → 去扩展启用”。
4. **多层策略改成三态继承**：`persona.policy.*` 改成 `inherit/on/off`；页头显示“当前有效值（来自全局/人设）”。`mood`/`learning` 尤其需要。
5. **保存统一**：全局 draft + 单一保存条；Persona 的“草稿/发布”仅作为版本管理，不参与全局 dirty；模块/扩展不再直接 `/save`，统一 `commit(patch)`。
6. **测试按钮跟随保存**：所有“检查/试听/测试”按钮在 dirty 时禁用或先保存再测试；由 hooks 统一实现。

### F3. 渐进式改造步骤（避免大爆炸）

| 步骤 | 内容 | 风险 | 验收 |
|---|---|---|---|
| 0 | 建立 `PAGE_DEFS`/配置 schema（仅新增元数据，不改 UI）：id、label、group、component、moduleId、flag、configKeys、keepPanel | 低 | 生成结果与当前 TABS/PANEL_GROUPS/TAB_MODS/TAB_KEYS 逐项一致；加契约测试 |
| 1 | 修导航状态：校验 localStorage tab；分组切换自动选第一个可见页；模块关闭显示 `ModOff`/`keepPanel`；删除 `modOn`/`ModOff` 死代码或启用 | 低 | 任何隐藏页/异常 tab 都回 overview；模块关闭仍可见设置入口 |
| 2 | 修保存/轮询：请求 seq/Abort；保存期间暂停轮询；save 返回结果；Persona dirty 上报；模块/扩展保存并入 draft（或明确即时保存） | 中 | 保存期间输入不丢；模块开关不会被底部保存回滚；Persona 有脏点 |
| 3 | 去重 NewFeatures：把 B3 的孤儿设置搬回功能页；移除重复 SpeakUp；保留跨聊天策略到 Chat/Permissions；更新旧测试 | 中 | 每个 key 只有一个入口；搜索/帮助链接能指向正确页 |
| 4 | 页面拆分：Group → 群聊/会话/安全；Stickers → 图库/审核/设置；ImageGen → 服务/任务/图库；Persona → 编辑/参考/绑定 | 中高 | 每个二级页 < 20 个设置项；旧 URL/标签 ID 重定向 |
| 5 | 一级 IA 合并为 7 页（F1）；旧 TABS id 映射到新路由；移动端导航抽屉 | 高 | 用户从概览 2 次点击内到达任意设置；移动端标签不换行 |
| 6 | 性能：`/state` SSE/revision；memo 页面；dirty 按字段订阅；`setPath` 不可变路径或 Immer | 中 | 输入无卡顿；5 秒轮询不重渲染整棵树；`/state` payload 减小 |

> 建议顺序：0→1→2 先解决“丢配置/找不到”的硬伤，再做 3/4 信息架构，最后 5/6 大改。每一步都保留旧标签 ID 的兼容重定向，避免用户 localStorage 失效。

---

## 附录 1：最烂的 5 个函数/区块

| 排名 | 函数/区块 | 行范围 | 规模/复杂度（grep 估算） | 为什么最烂 |
|---|---|---:|---|---|
| 1 | `PersonaReferences` | `client/client.js:837-1061` | 225 行；约 218 个分支 token；大量 useState/useRef | 上传、图库加载、删除、默认选择、旧版转换、预览、状态机全在一个函数；任何新需求都往这里堆，排错必须理解十几个 ref/seq。 |
| 2 | `StickerWorkspace` | `client/client.js:1908-2039` | 132 行；约 164 个分支 token；25 个 state/ref | 列表筛选、分页、选择、批量操作、确认弹窗、上传、QQ 导入、任务队列、错误恢复全部耦合；一改就影响审核安全。 |
| 3 | `Persona` | `client/client.js:1200-1391` | 192 行；约 117 个分支 token；多个竞态 ref | 人设列表、加载卡、编辑、草稿/发布、历史/回滚、预览、绑定、导入导出；同时承担状态机与 UI，`dirty` 与全局保存脱节（C05）。 |
| 4 | `AurabotPage` | `client/client.js:3836-3978` | 143 行；约 95 个分支 token | 导航、持久化、5 秒轮询、draft/dirty、保存、快捷开关、向导、标签映射、扩展标签全部集中；C01/C03/C06/C07 都在这里。 |
| 5 | `RetrievalPanel` | `client/client.js:2651-2704` | 54 行；约 81 个分支 token | 54 行里塞下配置、角色编辑、健康检查、检索工作台、重建/同步/任务；大量单行 JSX/三元表达式，可读性极差。 |
| 备选 | `Song` | `client/client.js:2952-3040` | 89 行；约 80 个分支 token | 安装进度、根目录检测、音色导入、网易云、试唱、历史、取消/重发混在一页。 |
| 备选 | `StickerCell` | `client/client.js:2052-2087` | 36 行；约 71 个分支 token | 36 行内包含审核、编辑、同步、动画帧、删除、来源 JSON，密度极高。 |

> 复杂度为 grep `if/for/while/case/catch/&&/||/?` 的 token 粗估，仅用于排序，不等同于严格圈复杂度。

## 附录 2：前端配置重复矩阵

图例：`●` = 有直接控件；`◐` = 间接/只读/由其他开关控制；`○` = 无控件；`同键` = 同一 config 路径；`异键` = 不同路径。

| 配置/语义 | 页面/位置 | 页面/位置 | 类型 | 实际结果 |
|---|---|---|---|---|
| `speakUp.targets` / `speakUp.mode` | SpeakUp `client:2103-2104` ● | NewFeatures `client:3821-3822` ● | 同键 | 共享 draft，最后保存同值；冗余入口，非冲突 |
| `botQQ` | Connect `client:737` ● | Wizard `client:3718` ● | 同键 | 同值；Wizard 保存整份 draft |
| `ownerQQ` / `ownerName` | Access `client:1499-1500` ● | Wizard `client:3719-3720` ● | 同键 | 同值；双入口 |
| `snowluma.dir` | Connect `client:700` ● | Wizard `client:3729` ● | 同键 | 同值；Wizard 有独立“检查”保存 |
| `voice.rvc.*` | NewFeatures `client:3815-3819` ● | PersonaRvc `client:1062-1078` ◐（persona 层） | 异键 | 全局 `voice.rvc` + 人设覆盖；`src/modules/voice/index.js:116` 人设优先；Voice 页无全局入口 |
| `voice.defaultVoice` | config `config.js:86` ○ | Voice `client:1770` 仅 `openai.voice` ◐ / Persona `client:1363` ◐ | 异键 | `profile.voice || cfg.defaultVoice`；defaultVoice 无 UI，HTTP 默认音色缺失 |
| `voice.speed` | config `config.js:87` ○ | Persona `client:1363` ● | 异键 | 人设覆盖全局；全局无法设置 |
| `voice.httpApi.apiKey` / `headers` | config `config.js:85` ○ | Voice 页无 ○ | 异键 | HTTP TTS 鉴权无法从 UI 配 |
| `mood.enabled` | Mood `client:2455` ● | Persona `policy.mood` `client:1367` ● | 异键（语义同） | 两层 AND；任一关即失效（`features/mood.js:44-47`） |
| `learning.enabled` / `learnEnabled` / `useEnabled` / `learnExpressions` / `useExpressions` | Learning `client:2471-2474` ● | Persona `policy.learnExpressions/useExpressions` `client:1368-1369` ● | 异键（语义同） | 四层 AND（`learning/contracts.js:49-51`、`learning/index.js:24-25`）；黑话无人设开关 |
| `local.image` | LocalApi `client:3075` ● | ImageGen `client:3360` ● | 异键 | `imageGen.enabled || local.active('image')`（`modules/imagegen/index.js:41`）；本地可绕过 UI 开关 |
| `local.tts` | LocalApi `client:3075` ● | Voice `client:1760` ●（`voice.enabled`） | 异键 | 本地 TTS 优先（`modules/voice/index.js:99`），但 `voice.enabled` 仍是总闸（`hub.js:842/901`） |
| `local.asr` | LocalApi `client:3075` ● | Voice `client:1794` ●（`voice.asr`） | 异键 | `voice.asr` 决定登记转写（`hub.js:1338`），`local.asr` 只在 transcribe 内首选（`hub.js:1155`） |
| `stickers.collectMode` | NewFeatures `client:3814` ● | Stickers `client:1824-1847` ○ | 异键（单入口放错页） | 表情页找不到“收集方式” |
| `bili.danmakuEnabled` / `maxDanmakuPerDay` / `visionEnabled` / `visionFrames` | NewFeatures `client:3825-3828` ● | Bili `client:3278-3320` ○ | 异键（单入口放错页） | B站页找不到弹幕/视频理解 |
| `group.ignoreAtOthers` | NewFeatures `client:3803` ● | Group `client:1573-1633` ○ | 异键（单入口放错页） | 群聊页找不到“@别人时忽略唤醒词” |
| `conversation.seedHistory` | NewFeatures `client:3805` ● | Group `client:1592-1595` ○ | 异键（单入口放错页） | 会话历史窗口旁缺“新会话带入历史” |
| `model.*` / `roles.*` | Model `client:1667-1754` ● | Voice `client:1769` / ImageGen `client:3420` / Retrieval `client:2710` ● | 异键（不同服务） | 各自独立；无跨页说明，用户误以为全局模型影响所有服务 |
| `search.enabled` | Search `client:2399` ● | Retrieval `client:2663` ●（`retrieval.enabled`） | 异键（不同子系统） | 网页搜索 vs 记忆索引；命名相近但无冲突 |
| `allow.groups` | Access `client:1518` ● | Group `client:1628-1632` ●（`group.overrides`） | 异键 | 授权范围 vs 插话概率；覆盖可建在未授权群上 |
| `longTasks` | Access `client:1510` ● | Model `client:1710` ●（`toolCallsPerTurn`） | 异键 | 增加工具 vs 限制调用次数；相关但分处两页 |
| `memory.shareGroups` | Memory `client:2721` ● | Access `client:1518` ●（`allow`） | 异键 | 共享读取规则 vs 启用名单；文案已区分但易混 |
| `merge.mentionWaitSec` / `mediaExtraSec` | config `config.js:60` ○ | Group 页无 ○ | 异键（无 UI） | 连发合并高级参数不可配 |
| `bili.ffmpegPath` | config `config.js:137` ○ | Bili 页无 ○ | 异键（无 UI） | 视频画面理解/ffmpeg 路径不可配 |
| `mood.judgeIntervalMs` / `memory.extraction.maxBatchMessages` / `maxChars` | config `config.js:153/155` ○ | 对应页无 ○ | 异键（无 UI） | 高级参数不可配 |
| `bridge.*` | config `config.js:180` ○ | 无页面 ○ | 异键（无 UI） | 功能存在但入口完全缺失（host `:907` 文案错误） |
| `tabs` | config `config.js:173` ○ | localStorage `client:3841` ● | 异键（语义重复） | 配置里的 tabs 没被使用；实际偏好存 localStorage |

---

## 附：建议优先修复顺序（TL;DR）

1. **C01/C03**：先消灭保存/轮询竞态与输入丢失——这是数据正确性。
2. **C04/C05/C07**：统一写入路径与未保存提示，避免模块/人格配置被底部保存回滚或静默丢失。
3. **C02/C06**：修向导阻断与分组导航，让用户先能“进得去、点得对”。
4. **C11/C12 + B3**：把 `new-features` 的孤儿设置搬回功能页，建立单一事实来源。
5. **C08/C09**：补齐 bridge 与 Voice 缺失入口，否则这些配置永远无法从 UI 使用。
6. **C25/C26/C36**：再做性能与组件拆分；否则 IA 改完仍会卡。

（以上均基于当前工作区文件的静态审计；未启动浏览器做交互回归，行号以审计时文件为准。）
