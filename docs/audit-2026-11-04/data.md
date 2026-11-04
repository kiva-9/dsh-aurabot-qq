# 数据层审计 — DSH QBot（Aurabot）

> **状态：最终版（D-001..D-027 已定稿）**。只读审计：本文件是审计笔记，未改动任何源码。
> 审计范围：`src/storage/*`、`src/memory/*`（含 `vector/*`、`embedding/*`）、`src/learning/*`、`src/search/*`、`src/migrate/*`、`src/diagnostics/*`、`src/domain/scope.js`。
> 时间：2026-11-04（Asia/Shanghai）。当前库核心迁移版本：`PRAGMA user_version = 7`。

## 0. 结论摘要

数据层整体工程化程度不低：主库有 WAL/busy_timeout、同步事务封装、消息幂等、资产按 sha256 去重；记忆域有 tombstone、证据交集、审计、提取 checkpoint 与批次租约；检索有 SSRF 防护和前端（主库）二次核验。但存在四个结构性问题：

1. **恢复/回滚路径在真实库上直接不可用**：`restore.js` 的 `KNOWN_TABLES` 缺少 search、bili、media 派生表，而 search/bili 模块默认启动时会无条件建表。真实安装的 `aurabot.db` 几乎必然被 `UNSUPPORTED_SCHEMA` 拒绝，灾难恢复与“迁移回滚”没有可执行路径。（P0）
2. **多套 schema 不进 `user_version` 迁移**：memory/learning/search 用 `CREATE TABLE IF NOT EXISTS` 运行时建表，不参与核心迁移版本；升级无法加列/改约束，降级也无法识别“库比程序新”。（P1）
3. **权限语义有两套**：`domain/scope.canSee` 与 `memory/scope.visible` 对 persona、shareGroups.account、`system:` 聊天的处理不同；同一记录在不同模块可能得到不同可见性结论，缺少唯一权威实现。（P1/P2）
4. **主库同步 SQLite 在多个每消息/每回合热路径上做全表扫描或大枚举**：memory lexical 5000 候选、learning 每入站消息扫描最多 2000 条、profiles 逐 subject 重算、diagnostics N+1；长历史下会阻塞事件循环，且若干缺失索引让审计/画像写入放大。（P2）

## 1. 数据模型 / 表关系简述

### 1.1 主库 `aurabot.db`（核心 v7）

```text
chats(id=private:QQ/group:群号/system:名, account_id, kind, platform_id, title)
  └─< messages(id, account_id, chat_id→chats.id, event_kind, platform_msg_id, dedupe_key UNIQUE,
               author_id, platform_time, received_at, recv_seq UNIQUE, text, segments_json,
               reply_to, forwards_json, mentioned, trace_id, recalled_at)
        └─< asset_occurrences(id, message_id→messages.id, chat_id, author_id, seg_index, kind,
                              asset_id→assets.id, remote_json, state, scope_json, analysis_json,
                              UNIQUE(message_id, seg_index))
assets(id, sha256 UNIQUE, mime, bytes, width, height, path, source_kind, state)
chat_epochs(chat_id PK, epoch, reason, updated_at)
requests(id, chat_id→chats.id, actor_id, source_message_ids_json, reply_target,
         policy_revision, epoch, state, trace_id, created_at, updated_at)
outbox(id, batch_id, seq, chat_id, request_id, epoch, kind, payload_json,
       idempotency_key UNIQUE, state, attempts, platform_msg_id, last_error, ...)
personas / persona_revisions / persona_bindings / persona_tombstones
jobs / job_attempts / generation_lineage / quota_reservations / image_job_configs
diagnostic_events(id, account_id, chat_id, trace_id, request_id, kind, at, payload_json)
legacy_migrations(step PK, state, started_at, finished_at, report_json, error)
meta(key,value)   sequences(name,value)
```

`requests.source_message_ids_json` 是 JSON 数组而非关联表；`messages.recv_seq` 是全局递增接收序（`sequences('recv')`），是记忆提取 checkpoint 的唯一推进依据。

### 1.2 记忆域（同库，`memory/schema.js` 自建，不进 `user_version`）

```text
memory_facts(id, account, chat, persona, category, body JSON, revision, status,
             fingerprint, created_at, updated_at)
  ├─< memory_fact_evidence(fact_id, evidence_id)  N:N
  └─< memory_evidence(id, account, chat, persona, message_id, body JSON, revision, deleted_at,
                      UNIQUE(account,chat,persona,message_id))
memory_audit(seq AUTOINCREMENT, fact_id, account, chat, persona, at, body)
memory_tombstones(kind,key,account,chat,persona PK, deleted_at, body)
memory_scope_revisions(scope_key PK, revision)   ← messages update/delete trigger
memory_checkpoints(scope_key PK, scope JSON, recv_seq, watermark, state, lease_token, lease_until, ...)
memory_episodes(id, scope_key, scope, from_seq, to_seq, body JSON, created_at)
memory_profiles(scope_key, subject PK, fingerprint, body, updated_at)
memory_overrides(scope_key, subject PK, body JSON, revision)
memory_quarantine(id, account, chat, persona, source_key, body, state, approved_fact_id,
                  UNIQUE(account,chat,persona,source_key))
```

事实的正确性语义：`body` 是权威 JSON，`account/chat/persona/revision/status/fingerprint` 是冗余索引列；`fingerprint = hash(structuralKey)`（不含 `text`），tombstone 按 `(kind,key,account,chat,persona|*)` 阻止重放。证据可见性取所有来源的**交集**（`evidenceFor` 要求每条 evidence 都可见）。事实删除会同时写 fact/fingerprint tombstone 并删除同 scope 的证据与消息 tombstone。

### 1.3 学习域（同库，`learning/schema.js` 自建）

```text
wp6_learning_records(id, scope_key, account_id, chat_id, persona_id, kind,
                     item_key, data_json, status, manual_lock, revision, expires_at,
                     last_used_at, uses, invalid_reason, UNIQUE(scope_key,kind,item_key))
  ├─< wp6_learning_evidence(record_id,message_id PK, fingerprint, author_id, spam_key, at)
  ├─< wp6_learning_audit(id INTEGER PK, record_id, scope_key, action, actor_id, revision, at, note)
  ├─< wp6_learning_versions(record_id,revision PK, snapshot_json)
  └─< wp6_learning_uses(record_id,request_id PK, at)
wp6_learning_checkpoints(scope_key,kind PK, scan_seq, processed_seq, overflow_from/to, lease_owner/until,...)
wp6_learning_queue(scope_key,kind,message_id PK, recv_seq, spam_key UNIQUE)
wp6_learning_seen(scope_key,kind,spam_key PK, at)
wp6_learning_shared_usage(record_id,viewer_scope PK, last_used_at, uses)
wp6_model_budget(day PK, calls) / wp6_model_calls(id PK, scope_key, kind, expires_at)
```

学习条目 = 群内表达/黑话，默认 `pending`，人工 `approved` 后才可被 `select` 注入；`learnEnabled/useEnabled` 与 persona policy 双重开关。

### 1.4 搜索域（同库，`search/store.js` 自建）

```text
search_results(id, account_id, chat_id, actor_id, request_id, turn_id, kind, cache_key,
               created_at, expires_at, result_json)
search_budgets(account_id,chat_id,turn_id PK, searches,tools,downloads)
search_limits(key,window PK, used)
search_reference_bytes(result_id→search_results.id, candidate_id PK, mime, bytes BLOB)
```

搜索结果按 `(account,chat,actor,cache_key)` 命中缓存；参考图字节单独 BLOB 表（上限 128 MiB，但只清过期字节，不清结果行）。

### 1.5 诊断/用量（同库，核心迁移或 `usage.js` 自建）

```text
diagnostic_events(id, account_id, chat_id, trace_id, request_id, kind, at, payload_json)
service_calls(id PK, account_id, chat_id, request_id, service, model, role, status, billing,
              started_at, duration_ms, input_tokens, output_tokens, cached_tokens,
              input_count, input_chars, credits, amount, currency,
              provider, finished_at, attempts, usage_complete, operation_id, stage,
              source_ids_json, error_code, finish_reason)
service_call_requests(call_id,request_id PK)
service_call_outcomes(call_id PK, account_id, chat_id, status, error)
```

### 1.6 向量索引库（独立 SQLite，worker 打开）

```text
vector_spaces(spaceId PK, contract, fingerprint, active, needsRebuild, reason)
vector_generations(spaceId,generation PK, state)
vector_heads(spaceId,id PK, sourceRevision, scopeRevision, deleted, hash, scope)
vector_rows(spaceId,generation,id PK, sourceRevision, scopeRevision, account, chat,
            category, persona, metadata, vector BLOB)
vector_outbox(seq PK AUTOINCREMENT, spaceId, generation, id, kind, UNIQUE(...))
vector_service_jobs / vector_service_refs / vector_service_state / vector_meta
```

`vector_heads` 是墓碑/版本屏障；`vector_rows` 是分代可重建数据；`vector_outbox` 是 Qdrant 的持久同步日志。主库记忆/图片是唯一事实源，向量库只是派生索引（`MemoryVectorService.finalGuard` 应再次回主库核验）。

## 2. 问题清单（P0–P3）

> 说明：`置信度 5` = 源码直接可证；4 = 有明确代码路径、少量运行假设；3 = 设计/组合风险需复现。标记：`[数据丢失]` `[越权可见]` `[重复计费]` `[索引不一致]` `[迁移不可回滚]`。

### P0

#### D-001 `[迁移不可回滚]` 恢复流程对真实数据库必然 `UNSUPPORTED_SCHEMA`，因为没有把 search/bili/media 派生的表列入 `KNOWN_TABLES`

- **file:line**：`src/migrate/restore.js:22-30`（`KNOWN_TABLES` 白名单）；`src/search/store.js:20-45`（`search_results/search_budgets/search_limits/search_reference_bytes`）；`src/modules/search/index.js:13`（search 模块 setup 无条件 `createSearchService`）；`src/bili/duty.js:66`（`bili_screenshots` 在 `createBili` 构造时无条件创建）；`src/runtime/media.js:128-131`（`image_derivative_manifest` 在首次图片处理时创建）。
- **证据**：`checkSchema(currentDb,'current')` 对 `sqlite_schema` 的每一个非 `sqlite_%` 表执行 `if (!KNOWN_TABLES.has(table)) failure('UNSUPPORTED_SCHEMA', ...)`。`KNOWN_TABLES` 中没有 `search_*`、`bili_screenshots`、`image_derivative_manifest`。`createSearchService` 在模块 setup 时即调用 `createSearchStore → ensureSchema`；`createBili` 构造时直接 `storage.db.exec(CREATE TABLE IF NOT EXISTS bili_screenshots ...)`。因此正常启动后库中必然有这些表。
- **触发条件**：任意正常安装（search/bili 模块默认启用）执行 `prepareRestore`/`scripts/restore-aurabot.mjs`。我用 `createStorage + createSearchService` 复现：`prepareRestore` 返回 `UNSUPPORTED_SCHEMA current: unhandled table search_results`（在仅有一个空 search service 的最小库里即触发）。
- **影响**：`restore.js` 是文档化的离线恢复流程，也是“迁移失败后回滚”的唯一工具。它在检查阶段就拒绝真实库，意味着升级失败、库损坏、误删后无法按设计恢复；同时使 `RESTORE_CORE_SCHEMA_VERSION=7` 的兼容性声明失真。属于恢复不可用/迁移不可回滚，不是普通功能缺陷。
- **修复建议**：把 search/bili/media 表纳入 `KNOWN_TABLES` 并明确策略：search 结果缓存/预算/参考字节可作为“可丢弃缓存”显式忽略或归档；`bili_screenshots`、`image_derivative_manifest` 保留为不可见派生记录（状态 `unavailable`/`disabled`），不要因未知表拒绝整库。为这些表补 restore switch 测试：`search enabled`、`bili used`、`image processed` 三种库都必须能产出 isolated candidate。
- **置信度**：5。

### P1

#### D-002 `[迁移不可回滚][索引不一致]` memory/learning/search 的 schema 不进 `PRAGMA user_version`，`CREATE TABLE IF NOT EXISTS` 无法升级既有库

- **file:line**：`src/memory/schema.js:1-6`（注释明确 “deliberately does not change the host's PRAGMA user_version”）；`src/learning/schema.js:3-6`；`src/search/store.js:19-21`（注释 “does not change user_version or run the global migration”）；`src/storage/migrations.js:267-299`（只有核心迁移推进 `user_version`）；`src/migrate/restore.js:17`（restore 只认核心 v7）。
- **证据**：三套 `ensureSchema` 全部使用 `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`，没有 `ALTER TABLE`、没有 domain schema 版本表，也没有把 `PRAGMA user_version` 纳入。`memory/schema.js` 返回 `{domain:'memory',version:1}` 但无任何持久化/检查；`learning` 和 `search` 连返回值都没有。
- **触发条件**：后续给 `memory_facts`/`wp6_learning_records`/`search_results` 增加列、约束、索引或改语义，升级旧库时 `CREATE TABLE IF NOT EXISTS` 静默不生效；新代码读写新列会 `no such column`/写入失败，且旧代码打开新库也不会像核心迁移那样因 `DB_TOO_NEW` 拒绝。
- **影响**：升级路径不可预测；数据库可能处于“核心 v7 + 域 schema 半新半旧”的混合状态。`restore.js` 的 `RESTORE_CORE_SCHEMA_VERSION=7` 也不能代表真实结构，恢复器可能接受/拒绝错误的库。属于迁移不可回滚和索引/结构不一致的高风险源。
- **修复建议**：把各域 `ensureSchema` 改为版本化迁移：统一在一个 `schema_migrations(domain,version)` 表（或扩展核心 `MIGRATIONS`）里记录版本，每个版本一个事务性 `up`，只追加不改；启动时 `assert domain version <= code version`，旧代码遇到新域版本拒绝打开。`restore.js` 应读取该表并校验域版本，而不是只看核心 7。
- **置信度**：5。

#### D-003 `[数据丢失]` 恢复流程删除全部 `memory_overrides`（人工画像别名/条目），只留 archive，没有恢复/复核路径

- **file:line**：`src/migrate/restore.js:575-577`（`for (const table of ['memory_profiles','memory_overrides','memory_episodes']) { archiveTable(table); DELETE }`）。
- **证据**：`memory_overrides` 是用户/AI 面板写入的人工画像覆盖（`aliases`、`entries`、`actorId`、`reason`、`history`，见 `src/memory/profiles.js:125-150`），不是派生缓存。`archiveTable` 只把行写入 `restore_records` 审计台账；候选库删除后不会重新生成 override；`memory_profiles` 重建也不会恢复人工别名/确认条目（`buildProfile` 只从 `visibleOverride(input)` 读取现有 override）。
- **触发条件**：用户使用过 `/profiles/save` 保存人工画像别名/确认条目，之后执行离线恢复。
- **影响**：恢复后人工画像数据从可用库消失，只剩难以使用的审计 JSON；用户需要手工重新录入。属于恢复过程的数据丢失，且不体现在 `report.limitations` 的具体表清单中。
- **修复建议**：将 `memory_overrides` 视为需要保留的人工数据：复制到候选库但降为 `disabled/review` 状态（或保留 body、将 `sourceSignatures` 标记为 stale），不要直接 DELETE；在报告中列出 `droppedManualOverrides` 数量。`memory_profiles`/`memory_episodes` 可以重建，但应单独归档并说明。
- **置信度**：5。

#### D-004 `[越权可见]` `chats` 以 chatId 单列为主键，多账号共用 chatId 时账号、最近消息与撤回互相污染

- **file:line**：`src/storage/migrations.js:21-29`（`chats.id TEXT PRIMARY KEY, account_id TEXT NOT NULL`，没有 `UNIQUE(account_id,id)`）；`src/storage/index.js:44-53`（`ON CONFLICT(id)` 只更新 `title/updated_at`，不更新 `account_id/kind/platform_id`）；`src/storage/index.js:84-86`（`byPlatformId`/`recent`/`markRecalled` 均无 account 参数；`recent` 直接按 chat_id 取，`markRecalled` 按 chat_id+platform_msg_id 更新）。
- **证据**：我用两个账号写同一个 `group:1`：`chats.get('group:1')` 返回第一个账号 `botA`，而 `messages.recent('group:1')` 返回 `[botA 的 A, botB 的 B]`；`byPlatformId('group:1','2')` 返回 `botB`。`markRecalled` 会同时更新两个账号的同一平台消息 ID。调用点例如 `src/modules/song/index.js:85` 的 `byPlatformId(chatId,messageId)` 不带 account，可能取到另一账号的消息。
- **触发条件**：配置过多个机器人账号（或切换 `botQQ` 后旧库仍保留旧账号消息），且同一 `private:QQ`/`group:群号` 在两个账号下都存在。这是多账号部署的常见形态。
- **影响**：`chats.get` 返回错误账号/标题；`messages.recent` 的 `LIMIT` 在过滤账号前截断，旧账号消息可能挤掉当前账号最近上下文；`markRecalled` 会把另一账号的消息标记为撤回；`byPlatformId` 可能把旧账号消息当作当前消息用于回复/引用。属于跨账号可见性和错误撤回。
- **修复建议**：`chats` 主键改 `(account_id, id)`（或 `id` 保持但所有查询强制 account），`messages.recent/byPlatformId/markRecalled` 全部增加 account 参数；`recent` 的 SQL 直接带 `account_id=?`，不要靠调用方后置过滤；给 `markRecalled` 增加 `account_id` 与 `event_kind` 条件。迁移时重建 chats 并保留旧数据。
- **置信度**：5。

#### D-005 `[越权可见]` `domain/scope.canSee` 与 `memory/scope.visible` 是两套不同权限语义；persona、shareGroups.account、system 聊天处理不一致

- **file:line**：`src/domain/scope.js:7-20,41-52`（`PERSONA_SCOPED` 只有 expression/mood/experience；`canSee` 只看 `g.categories/g.chats`，不校验 `g.account`；`makeScope` 允许 `system:`）；`src/memory/scope.js:26-33`（`visible` 对任何非空 `scope.persona` 都要求 viewer.persona 相同；shareGroups 校验 `g.account===viewer.account`；`scopeOf` 的 chat 正则只允许 `group|private`）；`src/learning/contracts.js:8-14`（`scopeOf` 要求 persona 非空、拒绝控制字符）；`src/search/store.js:6-11`（只到 account/chat，不要求 persona）。
- **证据**：`memory/scope.visible` 的第二个条件是 `(scope.persona && scope.persona !== viewer.persona)`，因此一个 `category:'fact'`、`persona:'p'` 的记忆对同一聊天里的 `persona:'q'` 不可见；`domain.canSee` 只在 `PERSONA_SCOPED.has(scope.category)` 时检查 persona，对 fact/profile/image 不检查。反过来，`domain.canSee` 的 shareGroups 循环没有 `g.account` 过滤，而 `memory.visible` 会过滤掉属于其他账号的组；更严重的是 `src/domain/scope.js:23-34` 的 `normalizeShareGroups` 返回 `{id,chats,categories}`，直接丢掉 `account`（`core/config.js:287` 用它归一化 `memory.shareGroups`），所以任何“只允许某账号共享”的配置会静默扩大为所有账号的同一 shareGroup。`memory.scopeOf` 拒绝 `system:foo`，`domain.makeScope` 接受 `system:foo`，`search.searchScope` 又拒绝；同一个“scope”在不同模块含义不同。
- **触发条件**：同一个聊天存在多 persona；或配置了带 `account` 的 shareGroups；或存在 system 聊天/系统事件。`learning/visibility.js` 复用 `domain.canSee`，`memory` 复用 `memory.visible`；未来任何模块把 memory fact 传给 `canSee` 就会得到不同结论。
- **影响**：权限审计无法给出唯一答案；最危险的方向是 `domain.canSee` 对 fact/profile 不做 persona 限制，若某个读取路径误用 `canSee` 处理带 persona 的记忆事实，就会出现“同聊天换人设仍可见”的越权；反之 `memory.visible` 又可能让 domain 认为可见的记录在记忆面板消失。shareGroups 的 `account` 过滤缺失是明确的跨账号配置风险。
- **修复建议**：抽出唯一的 `scope/visibility` 核心（一个模块、一个 `canSee(scope,viewer,policy,category)`），所有 memory/learning/search 调用同一实现；明确 persona 规则（fact/profile 是否 persona-scoped）并写进 schema/测试；shareGroups 统一校验 `account`；`system:` 在所有 scope API 中统一拒绝或统一允许（建议只允许 message/diagnostic 使用，不允许 memory/learning）。
- **置信度**：4（源码差异确定；是否形成实际越权取决于调用路径）。

#### D-006 `[索引不一致]` memory 的词法召回/统计/枚举硬上限 5000，超出部分静默不可见

- **file:line**：`src/memory/query.js:92-111`（`enumerate` 的 `limit=clamp(options.limit,300,5000)`，`lexical` 的 `candidateLimit:clamp(options.candidateLimit,5000,5000)` 强制 5000）；`src/memory/query.js:120-133`（只对候选打分）；`src/memory/index.js:109-113`（`stats` 用 `Number.MAX_SAFE_INTEGER` 但被 `list` 的 5000 上限截断）；`src/memory/README.md:220`（承认是 bounded candidate retrieval，不是完整历史检索）。
- **证据**：`clamp` 的第三个参数是最大值；`enumerate` 最多取 5000 条；`lexical` 把 `candidateLimit` 参数夹到 5000，所以 `recall`/`list({q})` 只能看到按 `created_at`（默认）排序的最多 5000 条事实。`stats()` 也走 `repo.list`，超过 5000 后的 active/conflicted/outdated 计数严重偏小；`/memories` 路由同时调用 `memory.list` 和 `memory.stats`，会做两次 5000 条枚举。
- **触发条件**：单个 account+chat（或共享组）事实数超过 5000。长期运行、自动提炼频繁的群很容易达到。
- **影响**：老事实永久不可召回；统计数字错误；面板 `limit` 再大也无法枚举完整历史。不是数据丢失，但对用户表现为“记忆丢了”，且会误导运营判断。
- **修复建议**：把召回改为真正的分页/倒排索引（FTS5 或向量 ANN），不要用一次性最多 5000 的字符串 BM25；至少在返回中暴露 `truncated/scanned` 并在 UI 明示；`stats` 用 `SELECT COUNT(*) ... GROUP BY status` 直接统计，不要走 list。若保留 5000 上限，README/接口必须返回明确截断标志。
- **置信度**：5。

#### D-007 `[索引不一致]` 重建向量索引时按页读全量，但查询时候选集仅前 5000 条，索引里有、召回永远看不到

- **file:line**：`src/memory/vector/integration/service.js:142-172`（`_documents` 使用 `max=cfg.retrieval.maxCandidates`，默认配置 `maxCandidates` 上限 10000）；`src/memory/vector/integration/config.js:45`（`maxCandidates` 允许 1..10000）；`src/memory/vector/integration/service.js:174-190`（`_documentPages` 重建时逐页读，无 5000 上限）；`src/memory/vector/integration/service.js:513-518`（检索先 `_documents`，再把 `docs.map(d=>d.vectorId)` 作为 `authorizedIds`）。
- **证据**：重建使用 `_documentPages` 可索引一个 scope 内全部事实（内存 repo 的 `page` 支持 cursor）；而 `recall` 的 `_documents` 用 `source.page` 循环到 `rows.length <= max`，达到 `maxCandidates`（默认 5000）即停止；`_vectorChannel` 的 `authorizedIds` 只含这 5000 个 id。结果是索引里有第 5001+ 条向量，但查询永远拿不到（worker 的 `authorized_ids` 过滤）。
- **触发条件**：单 scope 事实数 > `retrieval.maxCandidates`（默认 5000），且用户依赖向量通道而非词法通道。
- **影响**：索引内容与可检索集合不一致，重建成功但检索结果缺失；同时 `degraded` 只在 `truncated` 为 true 时出现，默认 5000 下不会提示用户。属于“索引不一致/漏检索”。
- **修复建议**：查询与重建使用同一候选边界；若设计是只检索最近 N 条，重建也应只索引 N 条，或在 `recall` 返回 `degraded:{channel:'sources',reason:'CANDIDATE_LIMIT'}`；更合理的是用 scope-filtered ANN 查询而不是先枚举全部文档再授权。
- **置信度**：4（依赖 `memory.page` 能枚举全量；代码路径成立）。

### P2

#### D-008 `[索引不一致]` 记忆/学习高频表缺索引，审计、画像、回合热路径全表扫描

- **file:line**：`src/memory/schema.js:29-32`（`memory_audit` 只有 `seq` 主键，无 `fact_id` 索引）；`src/memory/schema.js:57-64`（`memory_episodes`/`memory_profiles` 无 `scope_key`/`subject` 辅助索引；`memory_profiles` PK 是 `(scope_key,subject)`，按 `subject` 单独查询走全表）；`src/learning/schema.js:20-22`（`wp6_learning_audit` 无 `record_id` 索引）；`src/learning/store.js:24-29`（每次 audit 都执行 `DELETE ... WHERE record_id=? AND id NOT IN (SELECT ... ORDER BY id DESC LIMIT 50)`，两次全表扫描）。
- **证据（EXPLAIN QUERY PLAN，实测）**：`SELECT seq,body FROM memory_audit WHERE fact_id=? ORDER BY seq` → `SCAN memory_audit`；`SELECT * FROM memory_profiles WHERE subject=?` → `SCAN memory_profiles`；`SELECT * FROM memory_episodes WHERE scope_key=? ORDER BY to_seq DESC` → `SCAN memory_episodes` + `USE TEMP B-TREE FOR ORDER BY`；`SELECT ... FROM wp6_learning_audit WHERE scope_key=? AND record_id=?` → `SCAN wp6_learning_audit`；audit 的 DELETE → `SCAN wp6_learning_audit` + 子查询再扫。
- **触发条件**：任意长期运行库（审计/画像/学习条目累积）。`memory/store.js:23-35` 的 `touch()` 在每次事实保存时按 `subject` 查 `memory_profiles`；`learning/store.audit` 在每次 observe/edit/approve 都扫描审计表。
- **影响**：事实写入 O(画像总数)，学习写入 O(审计总数)，面板 `auditOf`/`history` 全表扫；主线程同步 SQLite 下直接表现为卡顿、消息处理延迟。
- **修复建议**：补 `memory_audit(fact_id,seq)`、`memory_episodes(scope_key,to_seq DESC)`、`memory_profiles(subject)`、`wp6_learning_audit(record_id,id DESC)`、`wp6_learning_uses(at)`、`wp6_learning_shared_usage(last_used_at)`；学习 audit 的裁剪改成按 `record_id` 索引子查询或单独维护计数。补 EXPLAIN 断言测试。
- **置信度**：5。

#### D-009 `[同步阻塞]` learning 每收到一条入站消息都会在事务里扫描最多 2000 条历史消息，并逐条 `readEvidence`

- **file:line**：`src/learning/index.js:42-79`（`enqueue` 被 `api.on('activity')` 和 `prompt/prepared` 调用；`rows = SELECT id,recv_seq ... LIMIT 2000`，`for (const m of rows) visit(m)`，`visit` 内 `source(scope,m.id)` → `readEvidence` → `storage.messages.get`）；`src/learning/index.js:14`（每次 activity 对 KINDS 两种 kind 都 enqueue）；`src/learning/store.js:100-119`（`refresh` 每次遍历全部学习记录和证据）。
- **证据**：`enqueue` 的 `scan` 从 `cp.scanSeq` 开始；如果安装时已有 >2000 条历史且队列已满/未推进，`scan` 会停在早期，之后每条新消息都重新读同一批 2000 条并逐条 `readEvidence`（每条做账号、时间、正文、指纹检查）。即使队列未满，`store.refresh` 先遍历全部 `wp6_learning_records`（最多 1000）及其证据。
- **触发条件**：已有较大群历史（>2000 条）后启用学习；或队列满、scan 水位长期停滞。
- **影响**：每条消息 O(2000×读消息+过滤)×2 kind，外加 refresh 的 O(1000×证据)；主线程同步 SQLite 下会显著拖慢消息/回复，极端情况下消息积压。属于隐藏的每消息热点。
- **修复建议**：用 SQL 一次筛选候选（`author_id != bot`、时间窗口、seen 子查询），按 `recv_seq` 建覆盖索引；把证据校验移到入队后异步/worker；为 `wp6_learning_seen(scope_key,kind,spam_key)` 与 `wp6_learning_queue(scope_key,kind,spam_key)` 已有 PK 足够；限制每次 activity 扫描量并持久化 `scan` 游标，不要把 gap 长期回填。
- **置信度**：4。

#### D-010 `[同步阻塞]` profile 读取本身会在每次 prompt 重算全量 inputs，多 subject × 多次 list，缓存只省了生成不省 IO

- **file:line**：`src/memory/profiles.js:7-28`（`inputs()` 每次 `repo.list(...limit:200)` + `getMany` + 全部 evidence 校验 + hash）；`src/memory/profiles.js:62-73`（`profileOf` 先 `inputs` 再比 fingerprint）；`src/memory/profiles.js:95-99`（`buildProfile` 又调 `inputs`，再 `profileOf` 再 `inputs`）；`src/memory/index.js:60-74`（`contextFor` 对最多 4 个 subject 循环 `profileOf`）。
- **证据**：`profileOf` 即使缓存命中，也必须先构造 `input`（`repo.list` 返回 up to 200 facts + evidence + override + policy hash）才能比较 `input.fingerprint`。`contextFor` 每个 subject 一次，4 个 subject = 4 次 list + 4 次 evidence 批量读；`profiles()` 面板再对每个 profile row 循环。
- **触发条件**：每个 prompt 的 `contextFor`（`prompt/prepared` 钩子）都会触发；群里有多个说话者时最多 4 个 subject。
- **影响**：每轮回复前主线程执行大量同步 SQLite 读；长历史/多画像时直接增加首 token 延迟。缓存只避免 LLM 生成，不避免 DB 重算。
- **修复建议**：把 profile 的 `inputs` 结果或 fingerprint 缓存到 `memory_scope_revisions` 版本键下；用一条 join SQL 读取 subject facts + evidence；按 `scope+subject` 建立增量失效（已有 `touch`），未变化时直接返回 `memory_profiles` 行而不重算 inputs；`contextFor` 限制 subject 数或缓存跨轮。
- **置信度**：5。

#### D-011 `[同步阻塞]` 主库所有大查询/事务都在主线程同步 `DatabaseSync` 上执行，缺少 worker/只读连接的实际使用

- **file:line**：`src/storage/db.js:7-17`（`node:sqlite` `DatabaseSync`；顶部注释说“大查询以后放进 worker”，但实际 storage 只暴露同步连接）；`src/memory/query.js:92-133`（最多 5000 条枚举 + `buildIndex` 同步）；`src/learning/index.js:185-220`（`select` 每回合 scan `store.readable` 最多 1000 条，每项再 `db.get` uses）；`src/diagnostics/index.js:323-350`（`latencies` 最多 40 个 request，每个 `ownedRequest/eventRows/jobs/deliveries/plannerRows` 多次查询）；`src/diagnostics/index.js:118-128`（`summary` 多个 `counts`/JSON 扫描）。
- **证据**：所有 repo 方法直接 `db.all/get/run`；`memory` 的 lexical cache 只缓存索引，不缓存构建 CPU；`learning.select` 的 `usable` 是同步数组；`diagnostics.latencies` 循环发查询。`storage/db.js` 没有 worker 连接或只读连接实现。
- **触发条件**：daemon 正常处理消息/面板请求/定时任务；历史数据量增长后。
- **影响**：事件循环被阻塞，QQ 消息处理延迟、Web 面板卡顿；同步 SQLite 与 `busy_timeout=5000` 叠加时，单个慢查询可让所有 hook 等待。属于架构级性能风险。
- **修复建议**：把重查询（lexical 构建、profile inputs、diagnostics/latencies、usage dashboard、搜索历史）移到 worker 或独立的只读连接；主线程只做短事务；对面板接口做分页/缓存；监控 `eventLoopDelay` 并在超过阈值时降级。
- **置信度**：5。

#### D-012 `[重复计费][索引不一致]` 搜索缓存失败路径：失败结果也写入 `search_results` 且永不清理；预算/额度表同样无界

- **file:line**：`src/search/service.js:66-75`（`catch` 中 `record.status='failed'; record.expiresAt=now(); record.sources=[]...; store.save(record)`）；`src/search/store.js:50-63`（`save` 只清理 `search_reference_bytes` 中过期 result 的字节，不删除 `search_results` 行）；`src/search/store.js:78-82`（`cached` 只返回 `status==='complete'`，失败记录不会被命中，下一次同 query 再生成一条新失败记录）；`src/search/store.js:87-92`（`search_budgets` 每 turn 插入，从不删除）；`src/search/store.js:99-108`（`search_limits` 只删当前 key 的旧 window，key 轮换后残留）。
- **证据**：失败路径明确保存审计记录，`expiresAt=now` 但行保留；`history` 会把这些失败记录当历史返回；没有 TTL 清理 `search_results` 的作业。搜索缓存/失败重试时每次都 `randomUUID()` 新 `record.id`，所以同一 query 的连续失败会线性增长。`search_reference_bytes` 仅在 `save(..., blobs)` 且 result 过期时删除，若结果无图片或从不再次 save，则永久残留。
- **触发条件**：Tavily/HTTP 失败、DNS 失败、用户反复重试、长期使用搜索。
- **影响**：`search_results`/`search_budgets`/`search_limits` 无限增长，面板 history 变慢；失败记录污染审计；虽然不直接重复计费，但每次重试会再次消耗 Tavily 配额/预算，`search_budgets` 不清理导致表膨胀。属于缓存失败路径 + 计量/成本风险。
- **修复建议**：失败记录进入独立短 TTL 审计表（如 `search_failures`）或 `search_results` 设置 1 天硬 TTL 清理任务；`cached` 前先按 `expires_at` 清理；为 `search_results(expires_at)`、`search_budgets(created_at/turn)` 建定期 DELETE；失败重试前用幂等键（query+profile+actor）限制频率；`search_reference_bytes` 随 result 删除 `ON DELETE CASCADE`（已声明 FK，但从未删 result）。
- **置信度**：5。

#### D-013 `[越权可见]` 搜索缓存写入按 actor，读取 `store.get`/`result`/`candidateFor` 只按 account+chat，同聊天其他 actor 可复用他人的搜索结果/参考图

- **file:line**：`src/search/store.js:57-60`（`search_results` 保存 `actor_id`）；`src/search/store.js:65-70`（`get(context,id)` 的 WHERE 只有 `id + account_id + chat_id`，没有 `actor_id`）；`src/search/service.js:158-168`（`result`/`candidateFor` 基于 `store.get`）；`src/search/service.js:190-204`（`referenceBytes`/`previewReference` 同样）；`src/search/service.js:111-113`（cache key 只对 `cached` 限 actor）。
- **证据**：`search_results_cache` 索引含 actor，`cached()` 也按 actor 查；但 `result()`/`candidateFor()`/`referenceBytes()` 通过 `store.get()` 只校验 account/chat。群聊中用户 B 只要知道 A 的 `resultId`（tool result 返回）或 `candidateId`，即可读取 A 的搜索正文/参考图字节，甚至 `materializeReference` 把 A 的候选转成自己 authorId 的 occurrence（`service.js:207-223`）。
- **触发条件**：同 account+chat 的多个用户/actor，且搜索结果 ID 被共享或被模型上下文泄漏；群聊场景常见。
- **影响**：actor 级缓存隔离失效；搜索查询可能包含用户私密意图；参考图/页面正文跨用户可见。虽然搜索发生在群聊，但 store 的设计明确区分 actor，实际读取没有兑现。属于越权可见（同聊天横向）。
- **修复建议**：`store.get`/`bytes`/`candidateFor` 增加 `actorId` 条件（除 owner-panel 显式授权外）；`materializeReference` 要求 `record.actorId===ctx.actorId` 或 owner；tool result 的 resultId 绑定 actor；补同 chat 两 actor 的访问测试。
- **置信度**：4（取决于产品是否允许群内共享搜索结果；从 cache key 设计看意图是隔离）。

#### D-014 `[索引不一致]` `diagnostic_events` 的 ring 裁剪每 100 次写入做全表扫描 + 临时排序；`decisions` 查询也没有 kind 索引

- **file:line**：`src/diagnostics/index.js:90-91`（`if(++written%100===0) DELETE FROM diagnostic_events WHERE id IN (SELECT id FROM diagnostic_events ORDER BY at DESC LIMIT -1 OFFSET 10000)`）；`src/diagnostics/index.js:130-132`（`decisions` 按 `account_id` + `kind='群聊决策'` + `ORDER BY at DESC`，无 kind 索引）；`src/storage/migrations.js:259-264`（只有 `(account_id,trace_id,at)` 与 `(account_id,chat_id,at)`）。
- **证据（EXPLAIN）**：裁剪语句对 `diagnostic_events` `SCAN` + `USE TEMP B-TREE FOR ORDER BY`；`decisions` 用 `diagnostic_chat(account_id)` 前缀后仍需临时排序，且 kind 不是索引列。
- **触发条件**：群聊决策频繁（每条被评估的群消息都可能写事件）；面板打开决策列表。
- **影响**：每 100 条事件一次全表扫 + 排序；事件量到 10k 后每次约扫 10k 行，主线程同步 SQLite 下形成周期性卡顿；`decisions` 返回也慢。
- **修复建议**：加 `diagnostic_events(at)` 与 `(account_id,kind,at)` 索引；裁剪维护单独 ring 元数据/按 rowid 删除，或按 `at` 索引 `DELETE WHERE at < (SELECT ... OFFSET 10000)`；补 EXPLAIN 测试。
- **置信度**：5。

#### D-015 `[不完整回放]` diagnostics replay 缺少 `mentionedOthers` 输入，且 replay 版本只 hash 两个函数的源码，无法保证“exact replay”

- **file:line**：`src/diagnostics/index.js:34-44`（`replayInput` 只复制 `mentioned/repliedToBot/continuedRequest`，没有 `mentionedOthers`）；`src/chat/group-policy.js:69`（`const hit = !p.mentionedOthers && ...`）；`src/diagnostics/index.js:10-11`（`GROUP_POLICY_REPLAY_VERSION` 只 hash `String(decideGroupReply)+String(inQuietHours)`，不覆盖 `DEFAULT_GROUP_POLICY` 或其他被调用辅助函数）。
- **证据**：若记录时 `mentionedOthers=true`，replay 时 `input.mentionedOthers` 为 undefined，`!undefined` true，wakeWords 可能命中并返回 reply，而原决策因“@别人”不触发；`matchesRecordedBase` 会显示 false，但 `status` 仍是 `recomputed`，UI 可能展示错误回放。`DEFAULT_GROUP_POLICY` 的默认值变化不会改变版本 hash。
- **触发条件**：群消息包含 `mentionedOthers` 的决策记录；或 `DEFAULT_GROUP_POLICY`/被调用辅助函数升级。
- **影响**：诊断回放给出错误的“重算结果”，与“exact replay”承诺不符；排障会误判。
- **修复建议**：把 `mentionedOthers` 加入 `replayInput`/`missing` 校验；replay version 用显式 `ENGINE_VERSION` 常量 + 全部依赖实现的源码/hash（或不用源码 hash，改用发布号）；对 `DEFAULT_GROUP_POLICY` 也纳入 fingerprint。
- **置信度**：5。

#### D-016 `[统计口径]` token 按天分组使用浮点 `started_at/1000`，与 dashboard 的整秒 CAST 不一致，午夜边界可能分错天

- **file:line**：`src/diagnostics/usage.js:15`（`GROUP_KEYS.day = strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', '+8 hours')`）；`src/diagnostics/usage.js:166-169`（dashboard 注释明确“先截取整秒：SQLite 的浮点日期转换可能把末秒的亚毫秒四舍五入到次日”，并使用 `CAST(started_at / 1000 AS INTEGER)`）。
- **证据**：同一 `started_at`（如 `2026-10-29T23:59:59.999+08:00`）在 `aggregate({groupBy:'day'})` 与 `dashboard()` 可能落入不同日期；`token-meter` 的 `summary` 使用 `aggregate`，面板使用 `dashboard`，两个入口数字可能不一致。
- **触发条件**：`started_at` 带亚毫秒（`Date.now()` 通常整数毫秒，但 `record` 的 `startedAt` 可由调用方传浮点/`performance` 结果；`usage.record` 接受任意 number）。
- **影响**：日统计与面板趋势不一致；在 23:59:59.5–59.999 的调用会被归到次日，用户看到“今天多了一次/昨天少了一次”。
- **修复建议**：`GROUP_KEYS.day` 同样使用 `CAST(started_at / 1000 AS INTEGER)`；`record` 对 `startedAt` 统一 `Math.floor`；补亚毫秒边界测试。
- **置信度**：4。

#### D-017 `[重复计费/漏计]` token 映射忽略 `cacheWriteTokens`，且 planner 事件用 `turn:step` 作为 id 会把同一步的多次 assistant 事件合并

- **file:line**：`src/diagnostics/usage.js:95-97`（只映射 `cachedTokens`/`cacheReadTokens`/`cache_read_input_tokens`，没有 `cacheWriteTokens`/`cache_write_tokens`）；`src/core/llm.js:166`（DSH tokenKeys 包含 `cacheWriteTokens`）；`src/chat/hub.js:1045`（`id: dsh:${key}:${d.turn}:${d.step??0}`，`INSERT OR IGNORE` 以 id 去重）；`src/diagnostics/usage.js:89-92`（`INSERT OR IGNORE` 不更新已有 usage 行）。
- **证据**：`notifyUsage` 可以上报 `cacheWriteTokens`，但 `usage.record` 不会存入 `cached_tokens` 或任何列；`cacheWriteTokens` 是输入计费的一部分时，`totalTokens` 会漏计。planner 的 `assistant/attempt` 与 `assistant/message` 在同一 turn/step 会得到同一个 id；第一次 `INSERT OR IGNORE` 获胜，第二次的 `status/tokens` 不会更新，且同一步多个 assistant 消息会被合并为一行。
- **触发条件**：provider 上报 cache write tokens；DSH planner 在同一步产生 attempt+message/多次 message 事件。
- **影响**：token 面板低估用量；planner 调用状态可能显示 `unknown` 而实际成功；不一定是“重复计费”，但属于计量口径错误。
- **修复建议**：增加 `cache_write_tokens` 列并纳入总 token（确认 DSH 语义：unhit input + cache read + cache write）；planner id 增加 `event.type` 或 attempt 序号，或对同 id 的后续事件使用 UPSERT 更新而非 INSERT OR IGNORE；补 provider token 全字段映射测试。
- **置信度**：4（cacheWrite 是否计费取决于 provider；代码确实丢弃）。

#### D-018 `[迁移不可回滚]` 旧数据备份的 manifest `complete` 在跳过大目录时仍为 true，且首次启动后不会再备份新出现的旧文件

- **file:line**：`src/migrate/legacy.js:75-94`（`skipped.push(it.name)` 但 `complete: !failed.length`，没有把 `skipped` 计入完整性）；`src/host.js:97-105`（`if (!storage.meta.get('legacy.backup'))` 只做一次，之后不会再扫）。
- **证据**：`LEGACY_FILES` 把 `local/songs/logs/voice-cache/douyin` 标为 `large`，`backupLegacy` 明确 `skipped`，但 manifest `complete` 仍 true；`host.js` 设置 `legacy.backup` 后永久跳过 preflight/backup。若用户在首次启动后才放入旧 `memories.json`，不会再有备份。
- **触发条件**：旧数据目录包含大目录；或旧数据在首次启动后才出现/被替换。
- **影响**：用户看到 `complete:true` 误以为备份完整；实际大目录没有复制，恢复时缺少内容。属于备份完整性/迁移数据风险。
- **修复建议**：manifest 增加 `complete: !failed.length && !skipped.length` 或 `completeWithoutLarge` 字段；报告 UI 明示 skipped；每次启动检查 `legacy.preflight` 的文件 mtime/size 或将备份状态与内容 hash 绑定，新文件出现时重新备份。
- **置信度**：5。

#### D-019 `[数据丢失]` 恢复合并 memory checkpoint 时 watermark 取 current/backup 最大值，但候选库不复制 current 的新消息，可能留下无法跨越的 `SOURCE_GAP`

- **file:line**：`src/migrate/restore.js:244-253`（`watermark: Math.max(old?.watermark, row.watermark, row.recv_seq)`）；`src/migrate/restore.js:296-311`（`recvFloor` 取 current 的 `sequences('recv')`/messages 最大值并写回候选）；`src/memory/extraction.js:103-110`（`while (row.recv_seq < target)` 从 messages 取 `recv_seq>checkpoint AND <=target`，无结果就 `SOURCE_GAP`）。
- **证据**：恢复以 backup 为候选基础，只复制 current 的删除/审计/用量等，不复制 current 在 backup 之后新增的消息。如果 current 的 checkpoint 有 `watermark`（enqueue 已推进）但 `recv_seq` 仍是旧值，合并后候选的 `watermark` 大于候选 messages 的最大 `recv_seq`，但中间的 current 消息不存在；`work` 查询为空 → `SOURCE_GAP`，checkpoint 卡住。若 current 的 `recv_seq` 已推进到新消息，watermark 也同步，则不会出现；取决于 enqueue/consume 时序。
- **触发条件**：备份后有人发消息（watermark 被 enqueue 提升），但提取尚未处理（recv_seq 未推进），随后恢复。
- **影响**：恢复后该 scope 的提取永久失败/需要手工重置 checkpoint；新消息无法提炼，表现为记忆停止更新。
- **修复建议**：恢复时把候选 `watermark` 限制到候选 messages 的 `MAX(recv_seq)`（或者保留 current 水位但将缺失区间标记为 skipped，不让 `SOURCE_GAP` 卡死）；在报告中记录 `clampedWatermarks`；补“备份后有新消息且未提炼”的测试。
- **置信度**：4（时序依赖，代码路径成立）。

#### D-020 `[数据丢失]` `memory.changeScope` 不检查目标 scope 的 fingerprint tombstone，也不检查删除后的跨范围重放

- **file:line**：`src/memory/store.js:393-403`（`changeScope` 只检查 `evidenceFor(f,scope)`，没有 `tombstone('fingerprint',factFingerprint(f),scope)`）；`src/memory/store.js:122-129`（`canRead` 会检查目标/来源 fingerprint tombstone，导致移动成功后记录在目标不可见）；`src/memory/store.js:304-312`（删除只写当前 `scope` 的 fact/fingerprint tombstone，同 claim 在其他共享聊天可重建）。
- **证据**：如果用户曾在目标 scope“遗忘”同一结构性事实（fingerprint 相同），`changeScope` 返回成功但 `canRead` 在目标返回 false；面板显示移动成功但记录消失。删除事实时只对 `scope` 写 tombstone；如果该事实通过 shareGroups 在另一个聊天可见，另一个聊天重新提取同一 claim 会得到新的 fact（目标 scope 无 tombstone），原聊天又通过共享看到它。
- **触发条件**：跨聊天共享事实 + 目标 scope 有同 fingerprint tombstone；或先删除再在其他共享聊天重建。
- **影响**：删除/移动的用户预期失效；可能被理解为“越权可见/删除不彻底”；数据不会物理丢失但语义丢失。
- **修复建议**：`changeScope` 在写入前检查目标 fact/fingerprint tombstone，命中则拒绝并提示先恢复；删除时把 fingerprint tombstone 写入所有可见的共享 viewer scope，或在 `canRead` 对共享来源应用来源 scope 的 tombstone；补共享组删除/移动测试。
- **置信度**：4。

#### D-021 `[数据丢失/容量]` learning 的 `maxItemsPerScope` 把 `deleted` 墓碑也算入上限，删除后无法再学习新词

- **file:line**：`src/learning/store.js:92`（`SELECT COUNT(*) ... WHERE scope_key=? AND kind=?` 没有过滤 `status!='deleted'`；错误信息也明确“含删除墓碑”）。
- **证据**：`transition('deleted')` 保留记录行（`status='deleted'`，`learning/store.js:194-198` 只删 uses 不删 record），因此每个删除条目永久占用容量。达到 `maxItemsPerScope`（默认 200）后所有 `upsert` 都 `CAPACITY`，用户只能改大配置或手动清库。
- **触发条件**：长期使用黑话/表达学习，删除/重建超过上限。
- **影响**：学习功能静默停止；用户无法通过正常删除释放容量。属于容量/数据生命周期缺陷。
- **修复建议**：计数排除 `status='deleted'`，或把删除墓碑移到独立表/字段；给用户提供容量面板与清理已删除条目的操作。
- **置信度**：5。

#### D-022 `[迁移/数据丢失]` `memory/legacy` 以“路径 hash”为 step，文件内容变化后仍因 `state='done'` 永久跳过；读取/解析在主线程同步

- **file:line**：`src/memory/legacy.js:12-16`（`step='memory.legacy-quarantine.v1:'+hash(resolve(file))`，`if (previous?.state==='done') continue`）；`:18-20`（`statSync<=32MiB` 后 `readFileSync`/`JSON.parse` 同步）；`src/memory/index.js:32`（`createMemoryStore` 构造时同步执行 `importLegacyQuarantine`）。
- **证据**：`step` 只包含绝对路径，不包含文件内容 hash；`previous.state==='done'` 时不再读取/导入。若用户在首次导入后向 `memories.json` 追加内容，永远不会导入。32 MiB 文件在主线程读取/JSON.parse，启动时阻塞。
- **触发条件**：旧 memories.json 在首次启动后被修改/追加；或文件接近 32 MiB。
- **影响**：新增旧记忆静默丢失；启动卡顿/OOM 风险。属于 legacy 导入隔离与数据丢失风险。
- **修复建议**：`step` 包含文件内容 hash（或记录 `contentHash` 并在变化时重扫）；导入完成后只标记该版本；大文件分批/异步 worker；`payload.items` 非数组时拒绝并报告。
- **置信度**：5。

#### D-023 `[事务]` learning/search 的 schema 初始化没有事务，失败会留下半套表/索引；`ensureRuntime` 同样无事务

- **file:line**：`src/learning/schema.js:3-6`（`ensureSchema(db)` 直接 `db.exec`，没有 `db.tx`）；`src/learning/runtime.js:5-8`（`ensureRuntime` 两条 `CREATE TABLE` 直接 `db.exec`）；`src/search/store.js:19-21,48-49`（`ensureSchema` 直接 `db.exec`，`createSearchStore` 调用）。
- **证据**：`db.exec` 一次执行多条 DDL，SQLite 对每条语句单独提交；如果第 3 张表/索引失败，前两张已持久化，后续 `CREATE TABLE IF NOT EXISTS` 不会补建缺失部分。`memory/schema.js` 反而正确地用了 `db.tx`（`:6`）。
- **触发条件**：磁盘满、SQLite 锁、DDL 语法/权限异常、进程崩溃。
- **影响**：应用启动时留下“表存在但索引/触发器缺失”的库；后续查询可能全表扫描或写失败；排查困难。属于事务边界/索引不一致。
- **修复建议**：所有 `ensureSchema`/`ensureRuntime` 包在 `db.tx` 中（DDL 在 SQLite 事务内可行）；对 schema 版本化后每步仍保持单事务。
- **置信度**：5。

### P3

#### D-024 `[数据丢失]` `requests.create` 不拒绝已撤回的消息；请求可建立在 recall 后的消息上

- **file:line**：`src/storage/index.js:165-174`（`sources` 只检查 `m.chatId`/`authorId`/account，不检查 `m.recalledAt`；`appendSource` 在 `:181-183` 检查了 `message.recalledAt != null`，二者不一致）。
- **证据**：`create` 可从 `messages.get(id)` 拿到 `recalledAt` 非空的行并写入 request；随后 `hub` 可能把它当作当前请求来源，模型/工具看到已撤回内容。`appendSource` 却明确拒绝 recalled 消息，行为不一致。
- **触发条件**：QQ recall 事件与请求创建竞态；面板/外部调用 create 时传入已撤回消息。
- **影响**：撤回内容参与回复/记忆证据；违反用户撤回预期。
- **修复建议**：`create` 增加 `sources.some(m=>m.recalledAt!=null)` 拒绝；统一 `appendSource` 的检查。
- **置信度**：5。

#### D-025 `[数据丢失/存储泄漏]` `putAsset` 在 DB 事务之前写文件；DB 失败会留下孤儿文件，已有 `state:'stored'` 但文件缺失时也不修复

- **file:line**：`src/storage/index.js:91-114`（`:98-103` 先写 tmp/rename，`:104` 才开始 `db.tx`；`:94-95` 只按 sha 查 state，不检查文件存在）。
- **证据**：`writeFileSync(tmp)`/`renameSync` 在事务外；如果后续 `INSERT` 失败（磁盘/约束/进程崩溃），文件已落盘但无 assets 行，永远没有 GC 路径。反之若 DB 中 `state='stored'` 但文件被外部删除，`putAsset` 直接返回旧行，不会重建文件。
- **触发条件**：磁盘满/崩溃/手工删除资产文件。
- **影响**：媒体目录无限残留或资产不可读；不影响主数据但影响存储审计。
- **修复建议**：先写临时文件，事务成功后再 rename；或在失败时删除 tmp；`putAsset` 校验 `existsSync(abs)` + hash，缺失/不匹配时重建；增加资产 GC/一致性检查。
- **置信度**：5。

#### D-026 `[数据损坏]` JSON 承载的 `body`/`data_json`/`result_json`/`payload_json` 在读取时大多无容错，单行损坏会打崩整个列表/面板

- **file:line**：`src/memory/store.js:8`（`const decode = row => row ? JSON.parse(row.body) : null`）；`src/memory/query.js:8`（`parse` 同样直接 `JSON.parse`）；`src/learning/store.js:19`（`...JSON.parse(r.data_json)`）；`src/search/store.js:69,81`（`JSON.parse(row.result_json)`）；`src/diagnostics/index.js:76`（`decode` 直接 `JSON.parse`）。
- **证据**：这些数据由本进程写入，通常有效；但 DB 升级/手工编辑/中断写入可能产生坏行。`storage` 的 `fromJson` 有 fallback，而 memory/learning/search 的读取路径没有。`memory_profiles.profileOf` 的 `cached.sections` 旧版本缺 section 也会在 `.map(e=>e.text)` 时抛错（`profiles.js:69-72`）。
- **触发条件**：坏 `body`/旧版 profile schema/迁移残留/手工 SQL。
- **影响**：`/memories`、`/profiles`、`/learning/items`、`/search/history` 500，整条列表无法读取；单个坏行可能阻塞所有事实加载。
- **修复建议**：统一容错解析（记录 `malformed_json` 并隔离坏行）；profile body 做版本/字段校验；启动时/迁移时做完整性检查并备份坏行。
- **置信度**：4。

#### D-027 `[代码质量]` 多套概念实现/死代码：scope、lexical 辅助、legacy 迁移框架、embedding cache key 各自为政

- **file:line**：`src/domain/scope.js` 与 `src/memory/scope.js` 与 `src/learning/contracts.js` 与 `src/search/store.js` 四套 scope；`src/migrate/legacy.js:102-120` 的 `runLegacySteps` 没有任何生产调用点（grep 仅测试）；`src/memory/lexical.js:80-158` 的 `agoText`/`whenText`/`parseReflection`/`shouldForget` 中多个仅测试使用；`src/memory/embedding/adapters.js:223-228` 的 `embeddingCacheKey` 无生产调用；`src/memory/vector/integration/source-outbox.js` 与 `src/memory/legacy.js` 各自实现迁移/触发。
- **证据**：`grep -rn "runLegacySteps" src` 只命中定义；`agoText` 无引用；`embeddingCacheKey` 无引用；`memory`/`learning`/`search` 的 scopeKey 分别是 canonical object / JSON array / account+chat，键格式不统一。两套 `preflight/backupLegacy` 与 `memory/legacy` 的导入逻辑并存。
- **触发条件**：维护/升级时；同一概念改动只改一处会留下不一致。
- **影响**：审计/修复成本高；权限/缓存/迁移行为难统一；死代码可能被误调用。
- **修复建议**：建立 `src/domain/scope.js` 为唯一 scope 权威，删除其余重复；统一 scopeKey 格式；删除或接入 `runLegacySteps`；把 legacy 导入集中到 `migrate` 域；清理未使用导出并加 lint (`no-unused`)。
- **置信度**：5。

## 3. 重点主题交叉索引

- **数据丢失**：D-003（memory_overrides）、D-018（旧备份 skipped 但仍 complete）、D-019（checkpoint 卡死）、D-020（移动/删除语义失效）、D-022（legacy 增量丢失）、D-025（资产孤儿/缺失）、D-026（JSON 损坏）。
- **越权可见**：D-004（多账号 chat 污染）、D-005（两套 visible/canSee）、D-013（搜索 actor 隔离失效）、D-020（共享删除重建）；D-001 的恢复失败间接导致无法通过恢复撤销错误授权。
- **重复计费/成本**：D-012（搜索失败重试 + 预算表无界）、D-017（token cacheWrite 漏计/planner 合并）、D-009/D-010/D-011 的同步热点造成额外模型/查询成本。
- **索引不一致**：D-002（域 schema 无版本）、D-007（向量重建/查询候选不一致）、D-008（缺索引）、D-014（diagnostics）、D-005（scope 语义不一致）。
- **迁移不可回滚**：D-001（恢复直接拒绝真实库）、D-002（域 schema 无版本）、D-018/D-019（备份/checkpoint 恢复语义）、D-022（legacy 只导一次）。

## 4. 数据层治理建议（按收敛顺序）

1. **先修恢复链**：把 search/bili/media 派生表纳入 restore 的 known/ignore 策略；用真实启动后的库（含 search/bili/图片处理）跑 `prepareRestore` 作为 CI 必测；恢复器必须在 upgrade 前可执行。
2. **统一 schema 版本与迁移**：建立 `schema_migrations(domain,version)`（或扩展核心 MIGRATIONS），memory/learning/search 全部走版本化 `up`；所有 `ensureSchema` 包事务；启动时校验 domain version，旧代码拒绝新域版本。
3. **统一 scope/visibility 权威**：只保留 `domain/scope.js` 一个 `canSee`，memory/learning/search 全部改用它；明确 persona-scoped 类别；shareGroups 统一 account/category/chat 校验；为 `system:` 设统一规则。
4. **主库读写分离/异步化**：重查询（lexical 5000 构建、profiles inputs、learning enqueue/select、diagnostics/latencies、usage dashboard）移 worker 或只读连接；主线程只保留短事务；面板接口强制分页。
5. **补索引与容量治理**：先补 D-008/D-014 索引，给 search_results/search_budgets 加 TTL 清理；给 memory_audit/profile/episodes/learning_audit 加索引；给 memory/learning 的容量上限排除 deleted 墓碑。
6. **数据保留/审计**：`memory_profiles`/`memory_overrides`/恢复候选的保留策略写成 manifest；`memory_audit`/`service_calls`/`diagnostic_events` 设 retention + compaction；恢复报告显式列出 dropped/archived 表与条数。
7. **统一 token 口径**：定义 `inputTokens`（unhit）与 `cachedTokens`（read/write）列语义，dashboard/aggregate/token-meter 共用同一 SQL 表达式；planner 事件 id 加 event/attempt 维度。

## 5. 必须补的测试

- `restore`：真实启动后（search/bili/图片处理过）的 `aurabot.db` 能通过 `prepareRestore`；`search` 表缺失/存在两种都覆盖；`memory_overrides` 人工数据保留或显式报告 dropped。
- `schema`：memory/learning/search 域 schema 从 vN 升级到 vN+1 的迁移测试；旧代码打开新域版本必须拒绝；`ensureSchema` 中途失败回滚。
- `scope`：同一 fact 在不同 persona、shareGroups 带 `account`、`system:` chat 下 memory/learning/search 三模块的可见性矩阵一致。
- `memory`：>5000 facts 的 recall/list/stats 行为与截断标志；`changeScope` 目标 fingerprint tombstone；共享组删除重建；`prepareBatch` 候选 top40 外的重复。
- `search`：失败/超时/DNS 拒绝后 `search_results` 行数有界；同 chat 两 actor 的 `resultId` 隔离；缓存命中不重复写行；预算表清理。
- `vector`：>maxCandidates 事实的 rebuild vs recall 一致性；`finalGuard` 异步 repo 不会被静默丢弃；Qdrant 404/重试/崩溃恢复后的 outbox 幂等。
- `learning`：>2000 历史 + 队列满时每消息扫描量；`maxItemsPerScope` 删除墓碑不占容量；`select` 的 N+1 有界。
- `usage`：亚毫秒 23:59:59.999 日分组；cacheWriteTokens；planner attempt/message 同 id 合并。
- `diagnostics`：`mentionedOthers` 回放、`DEFAULT_GROUP_POLICY` 变更导致 replay version 变化、`diagnostic_events` 10k 裁剪耗时。

---

*（最终版：D-001..D-027 与治理建议、测试清单已定稿；不含后续扩展条目。）*
