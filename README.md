# Aurabot · 住在 QQ 里的大肥鱼

本版本包含 Issue #16 的选择性移植实现，处于实机验收前阶段；范围、开关和验证清单见 [实现交接](docs/AUDIT16-IMPLEMENTATION.md)。

**2.0.0-rc.2，候选版本。** Aurabot 是 DeepSeek Harness（DSH）插件，经 SnowLuma / OneBot v11 连接独立 QQ 号，提供聊天、人设、范围化记忆，以及可选的语音、表情、搜索、生图和翻唱。

本次本机整合状态（2026-10-29）：**原版全量备份已校验，候选版本已安装到实际 DSH**。指定 Magpie 模型、Cloudflare BGE-M3、GRSAI 生图与参考再生成、StepFun TTS、本地 SenseVoice、Tavily 搜索与正文提取，以及主人私聊的文字/图片/语音投递已有真实验证。范围隔离、故障恢复和面板编辑保存另有自动化与界面测试；完整结果和未覆盖的场景见 [验证记录](docs/VALIDATION-2026-10-29.md)。

这是自用替换候选，保留原包名、插件 ID 和数据目录；不与原版同时运行。已配置的能力仍需看探针、任务和真实回执，不能把单个样例通过理解为所有服务或实群场景已验证。

```text
QQ ⇄ SnowLuma / OneBot ⇄ Aurabot ⇄ DSH 会话
                          ├─ SQLite：消息、请求、事实、任务与发送账本
                          └─ 资产文件、可重建检索索引、配置与扩展
```

DSH 侧栏的 **Aurabot** 面板按功能分开：连接、人格、权限、聊天、模型、语音、表情包、生图、搜索、主动搭话、心情、记忆、检索与索引、表达与黑话、任务、Token 统计、扩展、诊断等。操作说明见 [使用手册](docs/USER-MANUAL.md)，扩展接口见 [API 2](src/modules/API.md) 和 [类型声明](src/modules/aurabot.d.ts)。

## 安装与替换使用

需要 Windows、支持插件的 DSH 桌面版、符合本项目 Node.js 要求的宿主运行时，以及机器人 QQ 小号。当前最低 Node.js 声明为 22.13.0，开发环境见 [开发说明](docs/DEVELOPMENT.md)。自行安装并配置 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)，由本人阅读、同意其协议后再接入机器人账号。

可以直接从本 fork 的 GitHub 仓库安装。先退出 DSH 并备份当前数据，再执行：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "https://github.com/kiva-9/dsh-aurabot-qq#main"
```

验收时建议把 `#main` 换成目标版本的完整提交 SHA，锁定已检查的代码；更新后再核对实际安装版本。该命令更新同名插件的代码，不负责迁移两个分叉之间的数据。从本 fork 更新到本次 Token 面板版本不需要改配置或数据库结构；如果当前运行的是上游版本，应先准备匹配的 fork 数据快照，不能叠加两个版本的数据目录。安装可能触发插件重载，运行中的机器人应留到维护窗口再更新。

测试本地候选版本时，将下列路径替换为实际仓库目录，在 DSH 停止使用旧插件并完成备份后安装：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "C:\dev\dsh-aurabot-qq"
```

重启后先核对面板版本、机器人账号、主人账号、白名单和模型设置。默认 `enabled:false`、`dryRun:true`。试运行会限制高层 QQ 发送，但模型推理、显式服务测试和可信扩展的直接外部调用仍可能发生；不是免费或无副作用沙箱。

分叉继续使用包名 **dsh-aurabot-qq**、挂载 ID **aurabot** 和原模块 ID，以替换方式使用；不要改名并行启动两套接收/发送实例。单个内置模块的 fork 在「扩展」点“复制一份来改”，保持目录与 id 相同。保留自定义文件不代表自动合并新版协议，升级时需检查范围与取消契约。

## 这次重构改变了什么

| 领域 | 当前行为与边界 |
| --- | --- |
| 人设 | 草稿与发布版本分开，支持按聊天绑定；回合使用冻结的人设版本，切换使旧工作失效 |
| 消息与请求 | 原始接收记录有 recv_seq，来源区分 actor/account/chat；多人的合并聊天不能互相借用授权 |
| 事实记忆 | SQLite 存 subject/predicate/value、speaker、肯否、模态、条件、时间、状态、稳定性和证据；更正/撤回有审计。普通人物事实 persona 为空，经历和画像按用途隔离 |
| 提炼与画像 | 达到消息数或时间阈值后增量提炼；事实、证据、摘要、checkpoint 事务提交，失败不推进，原日志不清空。画像缓存随证据内容和范围修订失效，人工覆盖有 revision |
| 删除与旧档案 | tombstone 阻止迟到重放；恢复只进入待复核，证据和事实分别批准。未知来源 memories.json 一次导入隔离区，不自动公开 |
| 范围与检索 | account/chat/persona 先过滤；共享 groups 按类别明确授权、不传递，派生内容需满足全部来源的可见交集。词法支持中文；分页、批量证据读取和范围缓存避免每次扫描全账号 |
| 可选向量 | 本地 SQLite worker 或 Qdrant 适配；文本/图片/联合空间分开，探针验证后启用相应通道。索引可重建，返回前仍核验主库。未知或不可用通道明确降级 |
| 心情与学习 | 心情按账号/聊天/人设隔离，只影响短期表达；不阻断明确请求和承诺。表达习惯、群内黑话有证据、审核和撤销，学习与使用开关独立 |
| 任务与投递 | 生成结果与送达结果分开，持久任务/outbox/等待可恢复；unknown 不盲重试。取消等待不等于取消后台任务，取消不能撤回已发生的收费/发送 |
| 表情包 | 保存、分析、审核、QQ 收藏同步独立记录；按聊天选择已批准素材，不合适可不发，动画需核对原图。达到容量上限停止接收，不自动清空已审核库 |
| 生图与搜索 | 生图支持按配置声明的协议能力选择流程；参考图有来源和用途，提交前复核。搜索候选、下载成功与批准引用是不同步骤 |
| API 2 扩展 | 异步 prepareContext 与同步 context 分开；Hook 有顺序、结构检查、执行 signal、epoch 校验和诊断。超时不具备强制终止 JavaScript 或撤销外部请求的能力 |

面板、领域实现仍可独立替换。保留 QQ 管理、联系人、B 站和翻唱模块；QQ 空间、抖音功能已移除，旧文件不因功能移除而自动删除。

## 默认开关与配置能力

模块加载开关和业务开关是两层；未配置外部服务不会因模块已加载而自动可用。

| 功能 | 默认值 / 使用前条件 |
| --- | --- |
| 总开关 / 试运行 | 关 / 开；核对账号和白名单后再正式上线 |
| 记忆 | enabled=true；默认 20 条新消息或 30 分钟触发条件，须有新消息；每事务实际最多 100 条，原记录保留 |
| 心情 | 开；模型判断 judge=false，默认基线 60、半衰期 3 小时 |
| 表达与黑话 | 模块功能 enabled=true，但 learnEnabled=false、useEnabled=false；私聊学习 allowPrivate=false |
| 检索与索引 | retrieval.enabled=false；roles 初始为空；启动/热重载不自动探测付费 embedding |
| 表情包 | 开且允许收集/描述；进入待审，自动批准不默认开启 |
| 生图 / 搜索 / 翻唱 / B站 | 业务开关默认关，需要各自服务、权限或音色配置 |
| 语音 | enabled=true，provider=none；配置外部 OpenAI 兼容或固定 HTTP 接口后才可合成；不再内置 edge-tts/Windows 语音 |
| 主动搭话 | 功能默认开，仅主人私聊，仍受总开关、试运行、时间和频率约束 |
| 本地脚本 / 联动接口 / 长任务模式 | 默认关，需显式启用并核对权限 |

向量模型、重排、视觉或生图协议的“可配置”不等于所有提供方已实测；以当前 schema、探针和健康状态为准。不同向量空间的原始分数不能直接混加，图像相似也不证明身份一致。

## 升级、备份与数据位置

默认数据目录为 `%USERPROFILE%\.dsh\plugins-data\aurabot\`，可由 `DSH_HOME` 或 `AURABOT_DATA_DIR` 改变。配置、主库 aurabot.db、assets、modules、modules-data、local、日志等不在插件安装代码目录中；外置翻唱环境和模型还可能在别处。插件不会自动读取 .env 文件。

**升级前停止插件并独立备份完整数据目录和外置资源。** 自动 `_backup-v2-*` 只复制预检清单内的旧 JSON/目录，跳过 local、songs、logs、voice-cache 等标记的大目录；manifest 会记录 copied/skipped/failed。数据库版本升级的 backups/ 是 SQLite 快照，也不含全部资产、脚本或凭据。自动小备份不等于全量备份，不能据此保证重装或回退绝不丢数据。

主库、结构迁移或必要备份失败时，启动会保留诊断错误并暂停聊天和后台任务，避免无账本收费/发送。不要删除数据库或改版本号来绕过错误；修复原因后再重启。旧记忆的范围未知数据只进入待复核区；旧心情不会作为全局状态重新注入。旧版插件不能直接读取更高版本数据库，应使用匹配的升级前备份恢复。

## 开发与验证

```powershell
npm.cmd ci
npm.cmd test
```

测试使用 Node.js 测试运行器、临时数据库、fake DSH 和本地模拟 HTTP/OneBot。它们验证受控协议、恢复、权限和失败路径，不能替代真实服务验收；全仓通过情况以当前测试输出为准，不引用旧版本计数作为本版本结论。

记忆域收尾时，61 项独立测试通过。另一次本机合成测试使用 100000 条临时事实，其中目标聊天 5000 条：list 读取 5009 条候选约 165ms；词法冷查询约 179.8ms、7 次热查询中位 4.6ms/最高 7.5ms，热查询未重扫候选。该语料故意重复，测试将相关性阈值设为 0；这是范围读取与缓存测量，不是召回质量、真实用户库或整机延迟保证。主库仍是同步 SQLite，有界查询并不等于完全无阻塞。

复现性能用例（不接触真实数据）：

```powershell
$env:AURABOT_MEMORY_BENCH='1'
node --test test/memory-query-benchmark.test.js
Remove-Item Env:AURABOT_MEMORY_BENCH
```

主要目录：src/storage（主库）、src/memory（事实与派生检索）、src/learning（表达/黑话）、src/stickers（表情审核）、src/jobs 和 src/delivery（任务/发送）、src/runtime（调度/等待）、src/modules（扩展）、client（面板）、test（自动化验证）。

## 致谢

参考了 [Yuuyuko-uu](https://github.com/Yuuyuko-uu) 的相关 DSH 插件在宿主机制上的经验。保留原项目的贡献与许可说明；此分叉的范围化数据和任务重构应以当前候选版本代码与测试为准。
