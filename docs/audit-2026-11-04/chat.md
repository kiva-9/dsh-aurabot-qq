# 聊天 / 任务链路审计（最终版）

- 审计对象：`/Users/kiva/Desktop/DSH QBot`（Aurabot DSH 插件）
- 只读审计：未修改任何源码
- 范围：`src/chat/*`、`src/runtime/*`、`src/delivery/*`、`src/jobs/*`、`src/onebot/client.js`
- 方法：逐行阅读 + 定向最小探针（只读运行，不写源码/数据目录之外的业务数据）
- 状态：**最终版（P0/P1/P2/P3、主链路图、探针、重构建议与回归测试均已收录）**

> 结论先说：当前最危险的不是单个函数写错，而是**“同一 chat 的会话身份、调度忙闲、outbox 投递”三套状态没有单一事实来源**。旧会话的 `turn/end` 可以释放新会话的 busy 状态，`BUSY_MAX_MS` 又会在 4 分钟后主动制造第二个并发回合；而重启后普通回复的 outbox 批次又因为 `requiresGuard` 永远不会被自动恢复。三者叠加时，会出现“旧回复发到新会话 / 新请求被旧回复占用 / 半截回复永久 pending”的组合故障。

---

## 1. 聊天主链路简图（数据流 + 关键函数）

### 1.1 入站（QQ → 会话）

```text
OneBot WS/HTTP
  └─ createOneBotClient.onEvent            src/onebot/client.js
       └─ host.dispatchEvent               src/host.js
            ├─ dangerGuard.handleReply     (private owner only)
            └─ hub.onMessage               src/chat/hub.js:1217
                 ├─ account / historyTimeAllowed 过滤
                 ├─ parseMessageEvent      src/chat/inbound.js:36
                 ├─ storage.messages.ingest / duplicate 去重
                 ├─ groupBuf 记录群消息
                 ├─ checkAllowed          src/chat/access.js:11
                 ├─ owner command         src/chat/commands.js
                 ├─ hooks.message         src/core/hooks.js
                 ├─ quotedOf / followups.accept / expandForwards
                 ├─ media.register        src/runtime/media.js:28
                 └─ scheduler.add         src/runtime/scheduler.js:39
```

关键点：`ingest` 先于 `checkAllowed`、`groupBuf`、`media.register` 和 `scheduler.add`。消息一旦入库，后续任何异常都不会回滚入库记录；而重放又会被 `duplicate` 直接挡掉（`hub.js:1232-1235`），所以**后半段异常 = 消息永久丢失，无法靠网关重放恢复**。

### 1.2 聚合 / 调度（会话 → DSH）

```text
scheduler.add（按 chat 合并、wait/max/media extra）
  └─ scheduler.mature → ready[chatId] 队列
       └─ scheduler.pump → dispatch(chat, batch, {steer})
            src/runtime/scheduler.js:107-121
            └─ hub.dispatch              src/chat/hub.js:1646
                 ├─ group: participation.evaluate + decideGroupReply
                 │         + groupPrompt / groupRefs / autoReply
                 ├─ private: 拼【私聊】文本
                 ├─ media.resultsOf + occurrences/图片编号
                 ├─ personaOf(chat) 检查
                 ├─ storage.requests.create（每个 actor 一条）
                 └─ pushToSession      src/chat/hub.js:1816
                      ├─ hooks.prompt / preparedPrompt
                      ├─ agentFor       src/chat/hub.js:244
                      │    ├─ sessions.json 映射 / 档位 preset
                      │    ├─ 轮换 maxTurns/context/age
                      │    ├─ persona 切换 switchIdentity
                      │    ├─ resolveTarget/applyModel
                      │    └─ mount（工具 + social scope + context）
                      ├─ prepareContext
                      ├─ media.prepareForModel / attachments.admit
                      ├─ sessionNotes + seedHistory
                      └─ agent.followup / agent.steer
```

### 1.3 出站（DSH → QQ）

```text
DSH session/event
  └─ hub.onSessionEvent                 src/chat/hub.js:1017
       ├─ turn/start → running.add(chatId) / turnState
       ├─ assistant/message → st.lastTurn/st.text
       └─ turn/end → release? / deliver
            └─ hub.deliver              src/chat/hub.js:793
                 ├─ hooks.reply → publicReply → replyer/parseReply
                 ├─ hooks.items → 拆条 / 语音 / 表情
                 ├─ stickers.decideForReply / claimDecision
                 ├─ resolveMessage (asset:/sticker-ref)
                 └─ sendItems            src/chat/hub.js:577
                      └─ outbox.enqueue/deliver   src/delivery/outbox.js
                           └─ transmit   src/chat/hub.js:461
                                ├─ hooks.send
                                ├─ enabled/dryRun/canSend 门
                                └─ onebot.call(send_*_msg)
```

### 1.4 Jobs / Planner 旁路

```text
planner.wait / request 补充
  └─ wakeInbox (meta planner:inbox:*)
       └─ pushToSession

jobs runner (image/song/media-analysis)
  ├─ enqueue → prepare → submit → poll → store → deliver → notify
  ├─ 状态机 src/jobs/runner.js（ACTIVE/FINAL、lease/fence）
  └─ image.deliver → hub.sendImageAssets → 同一 outbox
```

---

## 2. 问题清单（P0/P1 先行）

> 格式：位置 / 代码证据 / 触发场景 / 影响 / 修复建议 / 置信度。
> 行号以当前工作区文件为准；`hub.js` 为 `src/chat/hub.js` 简写。

### P0-01 试运行/总开关可被 `force` 绕过，真实发出 QQ 消息

- 位置：`hub.js:1265`、`hub.js:1270`、`hub.js:498-506`、`hub.js:594-597`
- 代码证据：
  ```js
  // onCommand：总开关关着也处理，回复直接发
  await sendSegments(msg.chatId, [{ type: 'text', data: { text: reply } }], ..., { force: true })
  // transmit：
  if (force) {}
  else if (!cfg.enabled) { ... return null }
  else if (cfg.dryRun) { ... return null }
  ```
- 触发：配置 `dryRun: true`（默认值）或 `enabled: false`；主人发送任意 `/help`、`/silent`、`/status` 等命令；或扩展模块调用 `hub.sendSegments(..., { force: true })`。
- 影响：**试运行/总开关关时仍会真实调用 `send_private_msg`/`send_group_msg`**。这是直接的“试运行没有拦住外部副作用”，且与 `config.dryRun` 注释“只记日志不真发”相冲突。
- 修复：`force` 只允许绕过 `enabled`，绝不允许绕过 `dryRun`；把“是否允许外部发送”收敛到一个 `effectPolicy(chatId, {force})`，在 `transmit` 最前面统一判断，`hooks.send` 之前也要先经过该策略。
- 置信度：高（已用 `hubFixture` 最小探针复现：`dryRun:true` 下 `sendSegments(...,{force:true})` 实际产生 `send_private_msg`）。

### P0-02 会话档位/预设切换不清理旧会话：旧回复、旧映射、旧工具可串到新会话

- 位置：`hub.js:244-249`、`hub.js:277-294`、`hub.js:306`、`hub.js:1070-1071`、`hub.js:1777-1779`、`hub.js:2128-2142`
- 代码证据：
  - `agentFor` 只在 `entry.preset === preset && entry.level === level` 时复用会话，否则 `sid = ''` 直接新建：
    ```js
    let sid = entry && entry.preset === preset && entry.level === level ? entry.sessionId : ''
    ...
    if (!sid) { sid = await createSession(...); agent = await resolveAgent(sid) }
    sessionToChat.set(sessionKey(sid), chat.chatId)
    ```
  - 旧路径没有 `sessionToChat.delete(oldSid)`、`turnState.delete(oldSid)`、`unmount(oldSid)`，也没有 `storage.epochs.bump(chatId)`；对比 `switchIdentity`（`:2128-2142`）和 `abandonChat`（`:2112-2125`）都做了 bump/清理。
  - `onSessionEvent` 只要 `sessionToChat.get(key)` 还有值就继续处理：`:1019-1021`；`turn/end` 无条件 `running.delete(chatId)`（`:1070-1071`），再 `release(chatId)`（`:1777-1779`）。
- 触发：主人把 `ownerLevel` 从 `full` 改为 `social`/`chat`（或切换 `longTasks` 导致 preset 变化）时，旧会话仍有 turn 在跑；或 `resolveAgent` 抛错/会话被归档后，旧 agent 仍有迟到事件。
- 影响：
  1. 旧 session 的 `chatOfSession` 仍返回旧 chatId（实测），旧回合的 `turn/end` 会 `running.delete(chatId)`，释放**新会话**的忙状态，scheduler 可在新会话仍生成时再派发一批；
  2. 旧回合的 `deliver` 的 `epoch` 未被 bump（档位切换路径），会把旧档位/旧人设的回复发到当前 QQ；
  3. 旧 `mounted` 记录仍在，旧 agent 上的插件工具/上下文没有卸载，档位降级后旧工具仍有执行机会。
- 修复：把“会话身份”（account + chatId + level + preset + persona + epoch）收敛为一个 `SessionIdentity`；任何 identity 变化都必须走同一个 `switchSession`：bump epoch → cancel 旧 turn → unmount 旧 session → delete `sessionToChat/turnState` → archive；`agentFor` 不允许有“只新建不清理”的分支。
- 置信度：高（实测 `ownerLevel full→social` 后 `hub.chatOfSession(oldSid)` 仍为 `private:10000001`，`hub.turnSendersAllOwner(oldSid)` 仍为 true；代码路径明确）。

### P0-03 Scheduler 4 分钟硬超时会在同一 chat 启动第二个并发回合，`running`/`turnState` 共享导致丢消息/重复/串台

- 位置：`src/runtime/scheduler.js:10`、`:33`、`:107-121`、`:140-143`；`hub.js:1506`、`:1070-1071`、`:1777-1779`、`:1856-1866`
- 代码证据：
  ```js
  const BUSY_MAX_MS = 4 * 60_000 // 卡住保护：超过这么久就当上一轮已经结束
  const isBusy = (chatId) => busySince.has(chatId) && timers.now() - busySince.get(chatId) < BUSY_MAX_MS
  function pump(chatId) {
    ...
    if (isBusy(chatId)) { ... return }
    ready.delete(chatId)
    busySince.set(chatId, timers.now())
    run(merge(list), false)
  }
  ```
  `hub.running` 是 `Set<chatId>`（`:1506`），`pushToSession` 新一轮会 `st.controller?.abort()` 并重置 `st.requests`（`:1856-1866`）；`turn/end` 直接 `running.delete(chatId)`（`:1070-1071`）。
- 触发：模型/工具轮次超过 4 分钟（长任务、慢 provider、工具卡住），期间群里/私聊又来一批消息到期；scheduler 认为“上一轮已结束”并启动第二批；之后第一批的 `turn/end` 才到。
- 影响：第一批 `turn/end` 会释放第二批的 busy 状态，并按**第二批**的 `st.requests` 发送**第一批**的文本（`st.lastTurn` 相等时 `st.text` 被第二批覆盖/混用）；随后第二批结束再次释放/发送。表现为：请求被标记answered但回复是上一轮、重复发送、后续消息被并发处理、Flush 顺序错乱。
- 修复：去掉 `BUSY_MAX_MS` 这种“超过就当作结束”的隐式状态转换；改为显式 `TurnToken`：`pushToSession` 生成 `turnId` 与 `AbortController`，`turn/end` 必须携带同一 `turnId` 才能释放；scheduler 的 `busySince` 只由 `turnEnded(turnId)` 清除。若需要卡住保护，应 `cancel` 当前 turn 并显式产生 `turn/end`/失败事件，而不是直接开新轮。
- 置信度：高（scheduler 探针已复现：第一轮未结束时，推进 4 分 1 秒后再 `add` 会启动第二轮；第二轮在 `busySince` 覆盖后仍为 busy，第一轮迟到 `turnEnded` 会释放它）。

### P0-04 普通回复的 outbox 批次在重启后永远不会恢复：回复截断，状态永久 pending

- 位置：`hub.js:578-590`、`hub.js:927`、`src/host.js:210`、`src/delivery/outbox.js:110-127`、`:273-286`、`:161-163`
- 代码证据：
  ```js
  // hub.sendItemsNow
  const batchId = outbox.enqueue({ ..., requiresGuard: typeof shouldSend === 'function' })
  // deliver 正常路径
  sendItems(chatId, g, { epoch, requestId, shouldSend: stickerGuard })
  // host 启动恢复
  hub.recoverOutbox().then(...)      // 没有 shouldSend
  // outbox.claimBatch
  if (!m.requiresGuard || shouldSend) { ... 扫描 pending / 生成 token ... }
  ```
  `pending()` 也要求 `m.requiresGuard` 时必须有 `shouldSend`，否则直接 false（`:161-163`）。
- 触发：任何正常 QQ 回复（`deliver` → `sendItems`）在发送中途进程崩溃/被杀；重启后 `host.checkLogin` 调 `hub.recoverOutbox()` 不传 `shouldSend`。
- 影响：带 `requiresGuard` 的批次既不会被 `resumed`，也不会被 `stale` 取消；`outbox` 行永久 `pending`，用户只收到前半截或完全没收到回复；`recover` 返回 `{resumed:0, stale:0}`，日志无提示。对“重启后状态错/丢消息”是确定性问题。
- 修复：为“会话回复”的 guard 提供启动恢复实现（只检查 account、epoch、`cfg.enabled && !cfg.dryRun`，不依赖旧 `AbortController`）；或区分 `requiresGuard` 的 `job` 与 `sessionReply` 两类，`recover` 对 sessionReply 用安全 guard 恢复，对 job 留给 job worker。另给带 guard 批次增加“无 worker 的超时取消”路径。
- 置信度：高（已用最小探针复现：`enqueue({requiresGuard:true})` 后 `recover({maxAgeMs:0})` 返回 `{stuck:0,stale:0,resumed:0}`，`summary.pending` 仍为 1）。

---

### P1-01 私聊 steer 竞态：批次从 ready 删除后才 `agent.steer`；旧轮先结束则批次丢失且不 `running.add`

- 位置：`src/runtime/scheduler.js:111-115`、`:123-129`；`hub.js:1519`、`:1937-1946`、`:1823-1826`
- 代码证据：
  ```js
  // scheduler pump
  if (list[0].chat.kind === 'private' && canSteer(chatId)) {
    ready.delete(chatId)
    run(merge(list), true)          // 先删除 ready
  }
  // run catch
  .catch(error => { log?.warn?.(...); if (!steer) turnEnded(batch.chat.chatId) }) // steer 失败不 turnEnded
  ```
  ```js
  // hub.pushToSession
  if (opts.steer && typeof agent.steer === 'function') {
    await agent.steer(message)      // 不 running.add，不检查 turn 是否还活着
  } else { ... }
  ```
- 触发：`pump` 判断 `running.has(chatId)` 为 true 后，原 turn 在 `agentFor`/`prepareContext`/hooks 的 await 期间结束；或宿主没有 `agent.steer`（`probeAgent` 标注为可选，`src/runtime/host-contract.js:37`）。
- 影响：
  1. 批次已从 `ready` 删除，但 `agent.steer` 抛错时 `run` 的 catch 因 `steer=true` 不 `turnEnded`，该批永远丢失；
  2. 若 `agent.steer` 实际把消息当新 followup 启动，`turn/start` 看到 `running.has(chatId)` false，会把 `st.requests=[]` 重置（`hub.js:1029-1033`），请求元数据丢失；
  3. 宿主没有 `steer` 时走 `followup` 却仍走 steer 调度路径，原轮和新轮可并发。
- 修复：`canSteer` 必须同时检查 `agentCaps.caps['agent.steer']` 与当前 turn token；`pushToSession` 在 steer 前先 `assertTurnAlive(turnId)`，失败则把批次重新放回 scheduler 而不是丢弃；`agent.steer` 失败必须 `turnEnded`/requeue。
- 置信度：中高（代码路径确定；具体后果依赖 DSH `steer` 在 idle 时的行为，宿主契约把 `steer` 标为可选）。

### P1-02 `dispatch` 任何异常都会永久丢掉已成熟的批次（无重试/死信）

- 位置：`src/runtime/scheduler.js:95-103`（`mature` 把 open 移入 ready）、`:118-120`（先 `ready.delete`）、`:123-129`（catch 只 log）；`hub.js:1646-1773`（dispatch 多处可抛）
- 代码证据：`mature` 已把条目从 `open` 删除，`pump` 又在 `run` 前删除 `ready`；`dispatch` 中 `groupPrompt`、`media.resultsOf`、`storage.requests.create`、`pushToSession`/`agentFor` 均未包 try/catch；`run` 的 catch 只 `log.warn` + `turnEnded`，没有死信/重试。
- 触发：`agentFor` 临时失败（宿主 sessionController 不可用）、`storage.requests.create` 因消息被撤回/不存在抛错、`buildTools/mount` 的 `SOCIAL_SCOPE_UNAVAILABLE`、`groupPrompt` 等待 `groupName` 超时后抛错、`prepareContext` 抛错等。
- 影响：用户消息已经入库且已从 scheduler 删除，但从未交给模型；无重试、无 UI 提示、无死信记录；下次网关重放会被 `ingest` 的 duplicate 挡掉。与 P1-03 是同一类“入库即消费”的丢消息问题。
- 修复：`dispatch` 整体 try/catch，失败时把 batch 写 `chat:deadletter` 或重新 `scheduler.add`（带 backoff，限次数）；对请求 `storage.requests.setState(q.id,'dispatch_failed')`；日志带 batchId/messageIds。
- 置信度：高（所有抛出点均为 `await` 且无 catch；唯一外层是 scheduler `run` catch）。

### P1-03 `onMessage` 在 ingest 之后、scheduler.add 之前的异常会永久吞掉消息（重放被 duplicate 挡掉）

- 位置：`hub.js:1227-1238`（先 ingest + duplicate return）、`hub.js:1309-1338`（quotedOf/expandForwards/media.register 均可能抛）、`hub.js:1350`（最后才 scheduler.add）；`src/host.js:173` 只 `log.error`
- 代码证据：`media.register` 内部 `storage.occurrences.add`/`makeScope` 可抛；`quotedOf` 外部 `onebot.call` 虽有 catch，但 `storage.assets`/`parseMessageEvent` 边界仍可能抛；`expandForwards` 的 `msg.media.push`/`msg.images` 依赖数组存在。`onMessage` 没有 try/catch，`host.dispatchEvent` 只捕获并日志。
- 触发：SQLite busy/locked、磁盘满、媒体段缺字段、转发节点异常、`msg.chatId` 异常导致 `makeScope` 抛错、`media.register` 中 `occurrences.add` 失败。
- 影响：消息在 `messages` 表里已经是“已接收”，但从未进入 scheduler；网关重放时 `ingest` 返回 `{duplicate:true}` 直接 return，**永久丢失**；聊天记录里却有这条消息，用户会以为她看到了。
- 修复：把“入库 → 媒体登记 → scheduler 入队”放到同一事务/可靠 inbox 表（状态 `received/queued`），失败可重试；或 `onMessage` 整体 try/catch，失败后写 `inbound_deadletter` 并在 allowed 时回应用户“这条没处理成功”。
- 置信度：高（代码顺序与 duplicate 直接 return 明确）。

### P1-04 试运行只拦 QQ 发送，不拦模型/工具/生图/视觉等外部副作用（会真实收费）

- 位置：`hub.js:1274-1277`（只检查 `enabled`，不检查 `dryRun`）、`hub.js:1507-1523`（scheduler 不检查 `dryRun`）、`hub.js:364-393`（`mount` 无条件注册工具）、`hub.js:1816-1946`（`pushToSession` → `agent.followup` 无 dryRun 门）、`src/jobs/image.js:256-266`（`submit` 无 dryRun）、`src/modules/imagegen/index.js:186`（`svc.enqueue` 无 dryRun）、`src/runtime/media-analysis.js:297-315` 与 `:355-365`（视觉 enqueue/ask 无 dryRun）
- 代码证据：`jobs/image.js:305-307` 只在 **deliver** 检查 `cfg.dryRun`，但 `submit` 已经调用了真实 `adapter.submit`；`media-analysis` 的 `autoGate`/`enqueue` 只读 `settings.enabled`（`:302`），没有 `dryRun`；`hub.mount` 对所有工具注册无 dryRun 判断；`host.js:841` 还明确说模块直接 `api.onebot` 不在此列。
- 影响：用户在面板打开“试运行”以为零副作用，实际会：调用 LLM（聊天轮次）→ 调用生图 API（可能按次收费）→ 调用 vision API（媒体分析）→ 搜索模块/扩展 HTTP → 可能由模块直接 `api.onebot` 发消息。`dryRun` 不是安全沙箱，也不是成本保护。
- 修复：建立统一 `EffectPolicy`：`readOnly`/`dryRun` 时禁止 `agent.followup/steer`、禁止 `buildTools` 注册有副作用工具、禁止 `image.submit`/`media-analysis.ask`/`onebot.call` 的写操作；至少将 `dryRun` 传播到 jobs runner 的 `submit` 层并在 `enqueue` 处直接拒绝。若产品只打算“只不真发”，应在 UI/文档明确写“仍会调用模型和外部服务，可能收费”。
- 置信度：高（代码路径与各模块检查点可枚举；`jobs/image.js`、`media-analysis.js` 的无 dryRun 是直接证据）。

### P1-05 换人设/重开不清理群运行时状态：旧 `groupBuf`/`groupEngaged`/`groupSaid` 会污染新身份

- 位置：`hub.js:128-135`（`groupBuf`/`groupInterjects`/`groupSaid`/`groupFedAt`/`groupRefs`/`groupEngaged`）、`hub.js:2128-2142`（`switchIdentity` 只清 `sessionNotes`/`imageNotes`）、`hub.js:2145-2159`（`resetChat` 不清理）、`hub.js:2268-2272`（只有 `accountChanged` 才清）、`hub.js:1473`（`groupPrompt` 的 `older` 直接读 `groupBuf`）、`src/chat/group-policy.js:82-84`（engaged 直接 reply）
- 代码证据：`switchIdentity`/`resetChat` 仅处理会话、epoch、outbox；`groupBuf`、`groupEngaged`、`groupSaid`、`participation` 状态都在 hub 外或独立 map，未随身份变化清理。`resetChat` 的 `abandonChat` 也没有 `groupEngaged.delete`/`groupBuf.clear`。
- 触发：群聊中换人设；重开某个群会话；随后立刻收到新消息。
- 影响：新身份的第一批 prompt 会把旧身份的 5 分钟群消息当“早前背景”；`groupEngaged` 让新身份在 3 分钟内进入 engaged 模式并绕过群策略冷却/小时限制；`groupSaid` 把旧身份的发言计入 burst。表现为“新人设一上来就接着旧话题/抢话”。
- 修复：把群运行时状态做成 `{chatId, epoch}` 命名空间；`switchIdentity`/`resetChat`/`agentFor` 轮换都 `groupBuf.delete(gid)`、`groupEngaged.delete(gid)`、`groupSaid.delete(gid)`、`groupInterjects.delete(gid)`、`participation.reset(scope)`；`resetChat` 与 `switchIdentity` 共用同一清理函数。
- 置信度：高（状态未清理与读取路径明确）。

### P1-06 `outbox.cancelPending` 只取消 `pending`，已 `sending` 的旧人设消息仍可能发出去

- 位置：`src/delivery/outbox.js:289-292`、`hub.js:2117`、`hub.js:2132`、`outbox.js:193-216`、`hub.js:461-522`（`transmit` 对非 sticker 不检查 signal/epoch）
- 代码证据：
  ```js
  function cancelPending(chatId, reason = '已取消') {
    return db.run("UPDATE outbox SET state = 'canceled' ... WHERE chat_id = ? AND state = 'pending'", ...)
  }
  ```
  `sendOne` 先 `setState('sending')`（`:193-194`），再 `await send(...)`（`:197-201`）；`transmit` 只在 sticker permit 分支检查 `guard.signal.aborted`（`:480-492`），普通消息没有 epoch/signal 复检。
- 触发：`switchIdentity`/`resetChat`/`abandonChat` 发生在某条回复已经 `sending`、但 `onebot.call` 尚未返回的窗口；或 `hooks.send` 长时间 await。
- 影响：旧人设/旧会话的消息在换人设后仍发到 QQ；`pending` 行被取消但 `sending` 行继续发送；用户看到“旧角色最后一句”穿到新会话。
- 修复：`cancelPending` 同时处理 `sending`（标记 `cancel_requested` 并让 `transmit` 在每个 await 后检查 `epoch`/signal）；`transmit` 接受 `signal` 与 `epoch` 并至少在 `hooks.send` 前后各检查一次；对非 sticker 也执行 `deliveryGuard.signal.aborted`。
- 置信度：中高（窗口存在；是否实际发送取决于 `onebot.call` 延迟，但代码没有阻断）。

### P1-07 `sendVoiceFile` / `sendSegments` 绕过 `sendFile` 的本机路径白名单（可读任意文件并作为语音/文件发出）

- 位置：`hub.js:688-697`（`sendVoiceFile` 直接 `readFileSync(file)`）、`hub.js:594-597`（`sendSegments`）、`hub.js:511`（`transmit` 对 file 首段走 `uploadFile`）、`hub.js:525-535`（`uploadFile` 直接读传入路径）；`src/modules/API.md:65-66` 声明这些 API 的路径须受 QQ 工作区和 `files.dirs` 限制、受 `files.enabled` 控制
- 代码证据：`sendFile` 有 `checkLocalFile(src,{roots:[WORKSPACE_DIR,...cfg.files.dirs],denied:[dataDir('.')]})`（`:714-717`），但 `sendVoiceFile` 和 `sendSegments` 没有；`uploadFile` 没有再次校验。
- 触发：任何拿到 `hub.sendVoiceFile`/`sendSegments` 的扩展模块（模块 API 公开）传入 `/etc/passwd`、`~/.ssh/id_rsa` 等绝对路径；或未来把这两个 API 暴露成模型工具。
- 影响：本机文件读取/外发（音频条或文件），违反 API 文档承诺的路径限制；`sendVoiceFile` 还会把整个文件 `readFileSync` 进内存，无大小上限。
- 修复：`sendVoiceFile`/`sendSegments` 复用 `sendFile` 的 `checkLocalFile` + `cfg.files.enabled` + `maxBytes`；`transmit/uploadFile` 对 `file` 段统一校验来源（只接受 `asset:` 或已通过 `checkLocalFile` 的路径）。路径校验放在 `uploadFile` 最内层，防止绕过。
- 置信度：高（实现与 API 文档直接矛盾）。

### P1-08 `groupInterjects` 从未写入：群聊 `cooldownSec`/`maxPerHour` 是死逻辑；`engaged` 分支又绕过所有限制

- 位置：`hub.js:129`（声明）、`hub.js:1665`（读取）、`hub.js:2270`（仅清空，无写入）；`src/chat/group-policy.js:85-89`（`lastHour`/`cooldown`）、`:82-84`（engaged 在限制之前直接 reply）
- 代码证据：全仓 grep `groupInterjects` 只有声明、读取、清空，没有 `push`/`set`。`decideGroupReply` 的顺序是：`mentioned/replied/continued/wake` → `burst` → `interjectChance` → `quietHours` → `minRel` → **engaged 直接 return true** → 才检查 `maxPerHour`/`cooldown`。
- 触发：`participation.enabled` 被关闭（或参与控制器状态与 group-policy 不一致），且她最近在群里说过话（`groupEngaged` 3 分钟有效）；群消息持续到来。
- 影响：`cooldownSec`/`maxPerHour` 完全不生效；`engaged` 每批都回，可能连续刷屏；`burstMax` 只统计 `groupSaid`，不能替代小时/冷却限制。
- 修复：在 `deliver` 确认发出 `mode` 为 `interject`/`engaged` 时把时间写入 `groupInterjects`；或删除 group-policy 内部限制，明确只由 participation 控制器限流（二者选一，不能两套半死逻辑）。`engaged` 分支也应先检查 `maxPerHour`/`cooldown`/`recent`。
- 置信度：高（全仓无写入；已在 Lead 消息中同向确认）。

### P1-09 群聊 `ready` 积压 + `groupBuf` 无总上限：长时间忙时合并成巨大 prompt，内存/上下文爆量

- 位置：`src/runtime/scheduler.js:28-30`、`:95-103`、`:133-136`；`hub.js:1242-1247`、`:1469-1491`、`:1707-1735`
- 代码证据：`ready` 是 `Map<chatId, Array<batch>>`，`mature` 只 push，`pump` 只有在非忙时一次 `merge(list)` 全部 `flatMap`；没有 backlog 上限。`groupBuf` 每群最多 40 条，但群数量无上限，且 `onMessage` 在 `checkAllowed` 之前就 push（`:1242-1247`）。`groupPrompt` 把 `fresh` 全部编号拼进 prompt（`:1479-1491`），`dispatch` 对每个 entry 创建 request（`:1758-1765`）。
- 触发：群里连续聊天，而她正在处理一个长任务（> 数十秒），消息不断到期但 `isBusy` 为 true；随后 `turnEnd` 一次合并全部。
- 影响：memory 中保留大量批次；一次 `groupPrompt` 可能有数百条、几万字；模型上下文被撑爆/费用高；`requests` 数量爆炸；`participation` 的 backlog 只是降低概率，不能限制大小。
- 修复：`ready` 每 chat 最多保留 N 批（例如 3）或总 entries 上限；超限时把最旧/最不重要的 `interject/context` 批次压缩成摘要或丢弃并记录；`groupPrompt` 对 `fresh` 做 `slice(-N)`、单条 `clipText`。
- 置信度：高（无上限的数组与全量 merge 明确）。

### P1-10 `resetChat`/`switchIdentity` 不 `unmount` 旧 agent：`mounted` 与宿主工具/上下文注册泄漏

- 位置：`hub.js:108-115`（`mounted`）、`hub.js:2128-2142`（`switchIdentity`）、`hub.js:2145-2159`（`resetChat`）、`hub.js:2162-2191`（`resetSessions`）；`unmount` 只在 `hub.js:257`（轮换）、`:375`（重新 mount）、`:1988`（runSystemTurn）、`:2255`（dispose）调用
- 代码证据：`unmount(sid)` 是唯一会逐个执行 `registration.offs` 并删除 `mounted` 的地方；`switchIdentity`/`resetChat` 只 `turnState.delete`、`sessionToChat.delete`、`map` 删除，没有 `unmount(sessionKey(e.sessionId))`。`resetSessions` 也只是 `delete m.chats[chatId]`。
- 触发：任何 `/reset`、面板重开、换人设、`refreshPersonas`（`hub.js:2240-2244`）或 `accountChanged`。
- 影响：旧 agent 的插件工具、social scope guard、systemPrompt context 仍挂在 `dsh.agents` 的旧 session 上；`mounted` map 只增不减。长期运行/频繁重开使内存增长；若旧 agent 被宿主恢复或收到迟到事件，旧工具仍可执行（权限档位可能已改变）。
- 修复：`switchIdentity`/`resetChat`/`abandonChat` 共用 `teardownSession(chatId, sid)`：unmount → abort → cancel → epoch bump → delete maps → archive；`resetSessions` 对每个 session 调用；`mounted` 用 sessionId 与 chatId 双键并加定期 orphan 清理。
- 置信度：高（`unmount` 调用点与 reset/switch 代码路径明确）。

### P1-11 Planner wait 会在请求已经 `answered` 后再次唤醒：旧请求二次回答/重复回合

- 位置：`src/runtime/planner.js:10`（`REQUEST_CANCELED` 不含 `answered`/`delivery_*`）、`:74`（`authorize` 只拒绝这个集合）、`:159`（`inspectWait` 对 request 只要 `signature(target) !== baseline` 就 ready）、`hub.js:1137`（正常回复结束把 request 置 `answered`）、`src/runtime/wake-inbox.js:31-36`（dispatch 不复查 request 终态）
- 代码证据：
  ```js
  const REQUEST_CANCELED = new Set(['canceled', 'cancel_requested', 'closed', 'expired'])
  ...
  if (REQUEST_CANCELED.has(r.state)) fail('CANCELED', ...)
  ...
  return { ready: signature(target) !== r.baseline || (event?.recvSeq > r.afterSeq), ... }
  ```
  `signature` 包含 `target.updatedAt`；`requests.setState('answered')` 会更新 `updated_at`，所以在“原回合先正常发出回复并标记 answered、但 planner wait 还没到期”的窗口，wait 会认为条件已满足并唤醒。
- 触发：模型/工具登记 `planner.wait({condition:'request'})` 后，本轮又正常产出回复；`onSessionEvent` 的 `deliver` 将 request 置 answered；随后 `waitQueue.tick` 看到 `updatedAt` 变化。
- 影响：同一个 request 被再次交给模型，可能出现第二轮回答、重复发送、request 状态被改写；如果 wait 目标是 `private` owner，可能重复扣费/打扰。
- 修复：`REQUEST_CANCELED` 加入 `answered`、`delivery_partial`、`delivery_unknown`；`inspectWait` 的 request 条件只比较 `sourceMessageIds`/`recvSeq` 的增量，不比较 `updatedAt`；`wakeInbox.dispatch` 在 `pushToSession` 前再次读取 request，若已终态则 `cancel` 并 `release`。
- 置信度：中高（状态集合与 signature 代码明确；触发窗口依赖 wait 与正常回复并存）。

---

## 3. P2（中等风险 / 体验与资源问题）

### P2-01 `groupName` 无失败缓存：网关不支持 `get_group_info` 时，每个群批次都要等 30 秒

- 位置：`hub.js:1143-1150`、`hub.js:1462`、`src/onebot/client.js:46`（默认 `timeoutMs=30000`）
- 代码证据：
  ```js
  async function groupName(gid) {
    if (groupNames.has(gid)) return groupNames.get(gid)
    try { const info = await onebot.call('get_group_info', { group_id: Number(gid) }) ... }
    catch (error) {}
    return groupNames.get(gid) || gid
  }
  ```
  只有成功才 `groupNames.set`，失败不记 negative cache；`groupPrompt` 每次 awaiting `groupName`。
- 触发：网关实现不支持/无权限 `get_group_info`（或临时网络错误）；群里每次 `dispatch` 都会等默认 30 秒才把 prompt 交给模型。
- 影响：群消息响应延迟非常明显；用户会看到“已读不回”；多个群同时出错时拖住调度。
- 修复：失败也写 `{name:gid,failed:true,at}`，按 5–10 分钟 TTL 缓存；调用时显式 `timeoutMs:3000~5000`；首次会话标题用群号即可，不阻塞 prompt。
- 置信度：高。

### P2-02 `planner:wait` / `planner:inbox` / `planner:turn` / `outbox:batch` 元数据只写不删：长期运行 DB 膨胀、tick 变慢

- 位置：`src/runtime/waits.js:35`（`all()` 全量扫描）、`:74-85`（只有 `save`，无 delete）；`src/runtime/wake-inbox.js:7-8`、`:22-45`（done/canceled/unknown 永久保留）；`src/runtime/planner.js:108-118`（每个 turn 一个 `planner:turn:*`）、`:295-310`（`planner:chain:*`）；`src/delivery/outbox.js:14`、`:39-49`、`:62-88`（每个 batch 一个 `outbox:batch:*`，outbox 表行也不删）
- 代码证据：全仓没有对 `planner:wait:`/`planner:inbox:`/`planner:turn:`/`outbox:batch:` 的 DELETE；`wakeInbox.rows` 用 `GLOB 'planner:inbox:*'` + `json_extract(value,'$.state')`，每 500ms 全表扫描。
- 触发：长期运行、频繁任务/等待/回复。
- 影响：`meta` 表持续增长；`json_extract` 扫描使 tick 变慢；`outbox` 表也增长；重启恢复遍历所有 batch（`outbox.recover` `SELECT ... GROUP BY`）耗时线性增加。
- 修复：终态记录加 `expiresAt` 并定期清理（例如 wait/wake 保留 7 天、outbox 保留 30 天）；`planner:turn` 在 `finishedAt` 后归档/删除；`outbox` 批次终态后聚合保留或迁移；`wakeInbox` 用独立表 + state 索引，避免 `json_extract` 扫描。
- 置信度：高。

### P2-03 `proactiveGuards` 在取消/校验失败路径泄漏

- 位置：`hub.js:1555`、`:1583-1592`；`src/runtime/wake-inbox.js:22-27`
- 代码证据：`enqueueProactive` 先 `proactiveGuards.set(eventId,{signal,shouldSend})`，只有 `accept` 同步抛错时 catch 删除；`wakeInbox.tick` 在 `validate(ctx)` 抛错时 `save(r,{state:'canceled'})` 后 `continue`，没有回调通知 hub 删除 guard。若 `reserve` 因 chat 忙返回 false，事件留在 queued，guard 也一直保留。
- 触发：主动搭话事件入队后配置变 `dryRun`/关闭 speakUp/换人设/epoch 变化，`validateProactive` 抛错；或目标 chat 长期 busy。
- 影响：`proactiveGuards` 无界增长，且持有旧 `shouldSend`/`AbortSignal` 闭包；旧 persona/旧配置的引用泄漏。
- 修复：给 `createWakeInbox` 增加 `onDiscard(eventId)`/`onTerminal` 回调；所有 `canceled/unknown/expired` 路径调用；`enqueueProactive` 只保存必要 scope，不持有大闭包。
- 置信度：高。

### P2-04 群消息的 `groupBuf` 在 `checkAllowed` 之前写入，且按群无 LRU：非白名单群也占内存

- 位置：`hub.js:1242-1247`（push）、`hub.js:1249`（checkAllowed 在其后）、`hub.js:128-135`
- 代码证据：`if (msg.kind==='group') { ... groupBuf.set(msg.groupId,buf) }` 在 `checkAllowed` 之前；每个群最多 40 条但群数量无上限。`accountChanged` 才整体清空（`:2270`），普通配置变更不清理。
- 触发：机器人加入了大量群，或群被移出白名单后仍在群里收消息。
- 影响：`groupBuf` 常驻内存；被移出白名单的群仍保留 40 条旧文本；若以后重新加入白名单，这些旧消息会作为 `recentTexts`/`older` 进入 prompt（`:1659`、`:1473`）。
- 修复：把 `groupBuf` push 移到 `allowed.allowed` 之后；使用 `Map<gid,{entries,lastAt}>` + 每群 TTL/LRU（如 20 个群），配置变更时清理不在白名单的群。
- 置信度：高。

### P2-05 回复的媒体/语音没有总上限：`capBubbles` 只数 text，`capItems` 只删 sticker/poke，模型可产生大量图片/语音条

- 位置：`src/chat/reply.js:325-336`（`capBubbles`/`capItems`）、`hub.js:839-867`（group cap 后 `items.filter(kind!=='sticker')` 并加回 sticker）
- 代码证据：`capBubbles(items,max)` 的 `count` 是 `out.filter(i=>i.kind==='text').length`；`capItems` 只删 `sticker`/`poke`，`mergeToLimit` 只能合并 text。`parseReply` 的 `imageAsset`/`voiceRequest` 可任意多（`MAX_BLOCKS 256`）。`deliver` 对 `items` 的 `kind==='image'` 会逐个 `imageItem` 下载发送。
- 触发：模型输出多个 `![x](https://...)`、多个 `<voice>…</voice>`，或扩展 `hooks.items` 返回大量媒体。
- 影响：群聊“3 条上限”被媒体绕过；outbox 生成大量消息、外部 URL 被逐个下载（放大 SSRF/带宽/发送频率）；用户被刷屏。
- 修复：回复层统一 `MAX_BUBBLES` 按“所有 kind”计数；媒体单独限额（如每个回复最多 1 个 voice、1 个 image、1 个 sticker）；超出部分丢弃并日志/告知模型。
- 置信度：高。

### P2-06 `history-boundary` 没有任何生产写入点：清空历史边界是死代码

- 位置：`src/chat/history-boundary.js:3-10`；`hub.js:1222`、`:1336`、`:1360`、`:1474`、`:1926`、`:1933` 等调用；`hub.js:176-178` `deleteChatLog` 只删 JSONL
- 代码证据：全仓 grep `history:boundary` 只有 `history-boundary.js` 和测试；`src/` 内无任何 `storage.meta.set('history:boundary:...')`。`deleteChatLog` 不删除 `messages`/`occurrences`/`outbox`/`sessionNotes`。
- 触发：用户清空聊天记录/重新开始后，`historyTimeAllowed` 的 `cutoff` 始终为 0，所有历史都通过；`quotedOf`、`seedHistory`、`qq_chat_history` 仍可读旧消息。
- 影响：隐私预期“清空后不再进入上下文”不成立；旧聊天内容可能被重新注入/被引用；这是安全边界失效而非普通功能缺失。
- 修复：在清空流程里原子写 `history:boundary:<account> = {at: max(now, platform times)}`；同时删除/标记清理 `messages`（或按边界过滤所有查询）、`occurrences`、`outbox`、`chatlog`；增加 e2e 测试：清空后旧消息不出现在 `dispatch`/`quotedOf`/`seedHistory`。
- 置信度：高（源码无写入点）。

### P2-07 危险命令 guard 只覆盖 `bash`/`pwsh` 两个工具名，其他 shell/代码工具直接绕过

- 位置：`src/security/danger.js:11`（`SHELL_TOOLS = new Set(['bash','pwsh'])`）、`:96-99`；`src/host.js:422`（只挂 `tools/pre-execute`）
- 代码证据：`preExecute` 只对 `SHELL_TOOLS.has(exec?.name)` 做危险正则匹配；`isDangerousCommand` 是正则黑名单（文件开头注释也承认“不是沙箱”，无法挡 base64/脚本/别名）。DSH 若提供 `terminal`、`run_command`、`python`、`node`、`run_code` 等代码执行工具，均不经过该 guard。
- 触发：`security.dangerConfirm: true` 时，模型被提示注入/误操作，选择其他终端类工具执行危险命令。
- 影响：用户以为“危险命令会先问主人”，实际只保护两个工具名；这是“安全确认”的明显盲区。
- 修复：按工具能力而不是名字分类（所有可执行命令的工具都进 guard）；无法枚举时使用 allowlist（只允许已知安全工具）+ 默认 deny；保留正则作为补充，明确文档它不是沙箱。
- 置信度：中高（依赖 DSH 工具目录；但 `SHELL_TOOLS` 白名单本身是代码事实）。

### P2-08 `deniedTools` 只做 `restrict({deny})`，没有执行 guard；被隐藏的工具仍可能被调用

- 位置：`hub.js:369-384`（`denied` 计算与 `agent.ctx.tools.restrict({deny:denied})`）、`src/chat/session-scope.js:62-70`（明确注释 “restrict() intentionally exempts tools registered on this agent itself… hiding a schema is not an authorization check. Keep the execution guard”）
- 代码证据：
  ```js
  if (level === 'full' && denied.length) {
    try { offs.push(agent.ctx.tools.restrict({ deny: denied })) } catch ...
  }
  ```
  没有 `agent.ctx.tools.guard(exec => denied.includes(exec.name) ? ... : undefined)`。
- 触发：DSH `restrict` 只过滤模型可见 schema（session-scope 的注释说明确实存在该语义）；模型通过 prompt 注入知道被 deny 的工具名，或扩展 hook 直接调用。
- 影响：本应只给其他 DSH 会话用的联动工具（`bridge.deniedTools`）可能仍可被 QQ 会话调用，造成跨会话越权/数据泄漏。
- 修复：与 `installSocialScope` 一样，同时 `restrict` + `tools.guard`（按 `exec.name` 拒绝）；测试用 fake agent 直接执行 denied 工具，断言返回拒绝。
- 置信度：中（需核对 DSH 版本 `restrict` 语义；但本仓库自己的注释已指出仅隐藏 schema 不足）。

### P2-09 Jobs 状态与 outbox 状态没有对账：崩溃后 job 可能显示 `delivery_pending/unknown`，QQ 实际已收到

- 位置：`src/jobs/runner.js:399-427`（`deliver` 先 `delivery_pending`/PARKED，再调 handler）、`:174-184`（`recoverRow` 将 delivery_pending 置 unknown）、`src/jobs/image.js:305-311`（handler 通过 outbox 发送）、`:419-424`（只写 job.output.delivery）
- 代码证据：`runner.deliver` 在 handler 返回前崩溃 → `delivery_pending`；`recoverRow` 对 `delivery_pending` 一律标记“发送中断，结果不确定”并 PARKED；但 outbox 可能已有 `delivered` 行。`jobs/image.js` 返回 `batchId`，`runner` 存入 `deliveryBatchId`，但恢复时不去查 outbox 行。
- 触发：图片任务发送中进程崩溃/被杀；或 `h.deliver` 内部 outbox 已成功但 runner 的 `set()` 未提交。
- 影响：面板/任务状态显示“不确定/待发送”，用户可能手动重发；实际 QQ 已收到（重复风险由 outbox 的 batchId 挡住，但 job 状态仍是错的）；运维无法判断。
- 修复：`runner.recoverRow`/`deliver` 以 outbox batch 为权威：查 `outbox.rows(batchId)`，全 delivered → job delivered；全 pending → 继续；有 unknown → job unknown；有 failed/canceled → delivery_pending 并给出可重发依据。把 `deliveryBatchId` 持久化到 job output（已部分存在）并在恢复时使用。
- 置信度：高（状态机代码明确无对账查询）。

### P2-10 Jobs runner 没有统一的阶段超时：`submit/poll/store/deliver` 任一 hang 住，租约 heartbeat 会一直续，perChat 永久被占

- 位置：`src/jobs/runner.js:134-149`（heartbeat 只续租）、`:309-337`（submit）、`:340-355`（poll）、`:399-428`（deliver）；`src/jobs/image.js:256-266`（`adapter.submit` 无总超时；适配器内部的 fetch timeout 不一定覆盖全部）、`:305-311`（handler/send 无总超时）
- 代码证据：`runner` 没有 `Promise.race`/`AbortSignal.timeout` 包住 handler；`keepAlive` 每 `leaseMs/3` 续租，只要 handler Promise 未 settle 就无限续租。`jobs/image.js` 的 `perChat: 1` 会让同类新任务一直 `busy`。
- 触发：生图 provider 卡住、TTS/网络 hang、outbox 内 `onebot.call` 队列卡住；或 handler 忘记处理 signal。
- 影响：任务永远 `running`，用户看不到超时；同 chat 新图片任务被 `perChat` 挡住；重启后 `recoverRow` 可能报 unknown。资源/额度被占。
- 修复：runner 给每个阶段设 `phaseTimeoutMs`，超时 abort handler 并标记 `unknown`（对可能已提交的外部请求保守），同时释放 perChat；适配器层也要传 signal。
- 置信度：高。

### P2-11 `turnSendersAllOwner` / `turnActor` 的 owner 回退不是按聊天类型硬限制，群聊存在条件放宽入口

- 位置：`hub.js:2012`（`turnActor` 的 `st?.directOwner || ownerPrivateChat` 返回 owner）、`hub.js:2065-2073`（`turnSendersAllOwner` 的 `st?.directOwner` 分支）、`hub.js:1025`（任何 `user/message` 且 `source.kind==='user'` 置 `directOwner=true`）
- 代码证据：
  ```js
  if (!s.length && (st?.directOwner || ownerPrivateChat(sessionId))) return { actorId: String(getConfig().ownerQQ), requestId: null }
  ...
  if (st?.directOwner) return true
  ```
  这两个分支没有检查 `chatOfSession(sessionId)` 是否为 `private:owner`；群聊 session 中只要 `st.directOwner` 被置位且 `requests/senders` 为空，就会以主人身份执行工具。
- 触发：群里主人在 DSH 面板直接打字（正常场景 owner 本人），或旧 session 映射未清理/其他 DSH 客户端写入 `user/message`；随后在 `st.requests` 清空后的窗口调用工具。
- 影响：正常路径下 `st.requests` 非空时由严格请求分支保护；但 `directOwner` 窗口 + 群聊 session 会把 owner 权限放大到群聊工具（例如 imagegen ownerOnly、qq 发送类工具）。若 DSH 面板事件可被非主人触发，就是越权。
- 修复：`directOwner` 分支强制 `chatOfSession(sessionId) === private:${ownerQQ}`；群聊只允许 `st.requests` 全 owner 的严格分支；`turnActor` 同理。
- 置信度：中（正常单主人桌面场景是设计内；边界依赖 DSH 面板事件可信度和旧 session 映射，风险真实存在）。

### P2-12 `agentFor` 的 maxTurns/maxContext/maxAge 轮换对 `level==='full'`（主人私聊）完全不生效

- 位置：`hub.js:252-254` `if (sid && level !== 'full' && !running.has(...) && (...))`；`src/core/config.js:33` 默认 `conversation.maxTurns/maxContextTokens/maxAgeMinutes`
- 代码证据：轮换条件显式加了 `level !== 'full'`；主人私聊默认 `ownerLevel:'full'`，所以 `entry.turns` 无限增长，`contextTokens` 只用作展示/面板，不会触发轮换。
- 触发：主人私聊长期使用；`maxTurns`/`maxContextTokens` 在面板里设置也不会生效。
- 影响：上下文越滚越大，最终触发 DSH 自身的上下文压缩/截断（不可控）；配置项误导用户。
- 修复：主人私聊也应支持轮换（若担心记忆，可单独配置 `ownerMaxTurns`/`ownerMaxContextTokens`，默认更大）；至少将例外写进 UI 说明。
- 置信度：高（条件明确）。

---

## 4. P3（低风险 / 代码质量 / 兼容性）

### P2-13 `onMessage` 在 `scheduler.add` 前 await `quotedOf`/`expandForwards`：引用/转发慢时消息乱序

- 位置：`hub.js:1309`（`await quotedOf(...)`）、`hub.js:1325`（`await expandForwards(...)`）、`hub.js:1350`（最后才 `scheduler.add`）、`hub.js:1357-1385`（`quotedOf` 内 `onebot.call('get_msg',{...},{timeoutMs:8000})`）
- 代码证据：`onMessage` 在 `quotedOf`/`expandForwards` 上 `await` 后才 `scheduler.add`；同一 chat 后续不带引用/转发的消息可以更快走到 `scheduler.add`，先进入 `open`/`ready` 并先被 `dispatch`。`groupBuf` 已按 `recvSeq` 记录，但 scheduler entries 顺序变成完成顺序。
- 触发：用户引用一条不在主库/outbox 的消息（`get_msg` 8 秒超时），或合并转发 `get_forward_msg` 15 秒；随后同一群/私聊继续发普通消息。
- 影响：后发消息先被回答；引用消息最后才被当新问题回答，prompt 里顺序错乱；群聊里引用消息还可能作为 `older` 背景进入后一批，重复上下文。用户看到“她回答的是上一句/引用的那条被当成新消息”。
- 修复：`onMessage` 不要在关键路径 await 网络；先把消息以 `quotePending/forwardPending` 入 scheduler，在 `dispatch` 前用有界时间解析（或只查本地库）；同一 chat 的 scheduler 保持 `recvSeq` 顺序，后续消息不得越过 pending 的引用消息。
- 置信度：高（顺序与 await 位置明确）。

### P2-14 `wakeInbox.tick` 按 `key` 取前 100 条、账号不匹配的永久 `continue`：可饿死后续唤醒

- 位置：`src/runtime/wake-inbox.js:7`（`ORDER BY key ${state?'ASC':'DESC'} LIMIT ?`）、`:24-27`（account mismatch 直接 continue）、`:40-44`（start 只处理第一批 dispatching）
- 代码证据：`rows('queued',100)` 按 key 字典序取 100 条；`if(ctx.account!==String(getAccount()))continue` 不标记、不删除、不跳过排序，永久占住窗口；若这 100 条属于旧账号/长期 busy 的 chat，后续新事件永远进不了候选。
- 触发：account 更换后旧 `planner:inbox:*` 未清理；或 100 个 wait 目标 chat 同时忙/不可用。
- 影响：新 wait 的唤醒不执行（planner 等待看似已登记但永不恢复）；旧事件永久堆积。
- 修复：`ORDER BY json_extract(value,'$.createdAt')`；account mismatch 写 `canceled`/迁移；按 state+createdAt 建索引/独立表；每 tick 对可处理事件按 chat 去重，不因前 100 条阻塞。
- 置信度：高（排序与 continue 代码明确）。

### P2-15 `followups` / `participation` / `groupEngaged` 等按 chat 的运行时状态不随 epoch 清除，跨会话复用

- 位置：`hub.js:136`（`followups`）、`:144-147`（`participation`）、`:128-135`；`switchIdentity`/`resetChat` 只清 sessionNotes/imageNotes/turnState/sessionToChat（`:2128-2159`），`accountChanged` 才 `participation.reset()`（`:2271`）
- 代码证据：`followups` 的 key 包含 epoch（`src/chat/followup.js:8`），但 `participation` 的 `states` key 只有 account/chat（`src/runtime/participation.js:69`），`groupEngaged` 只有 groupId。换人设/重开不 reset，旧 persona 的 `targetRate`/cooldown/成功记录、engagedUntil 会带到新身份。
- 触发：换人设/重开后立即群聊。
- 影响：新身份继承旧身份的参与冷却/配额、群活跃窗口；可能一开始就不说话或过度插话；`followups` 旧 epoch 不会命中（还好），但 `participation` 会。
- 修复：`participation.reset({account,chatId})`、`groupEngaged.delete(gid)`、`groupSaid.delete(gid)` 放在统一 `switchIdentity`/`resetChat`；或者给 participation state 加 `personaId/epoch` key。
- 置信度：高。

### P3-01 纯 `<poke>` 回复不算“已送达”：请求被标记 ended/participation 记 skipped

- 位置：`hub.js:903-916`（poke 分支）、`:959`（`if (!confirmed.length) return {confirmed:false...}`）、`:985`（`completedTurn = expectedText ? ... : confirmed.some(sticker)`）
- 代码证据：`groups.push('poke',[])` 执行 `pokeBack`，但没有把 poke 加入 `confirmed`；`confirmed` 只来自 outbox rows（text/voice/sticker）。纯 poke 的 `expectedText=0`，`confirmed.some(sticker)=false` → `completedTurn=false`。
- 触发：模型只输出 `<poke>`（或只有 poke + 空文本）。
- 影响：`onSessionEvent` 把 request 状态设为 `ended`（`:1137`），不是 `answered`；`participation.observeReply` 记 `skipped`；统计/任务关联丢一次成功动作。
- 修复：poke 也作为 delivery 行为记入 `confirmed`/`deliveries`（至少返回 `confirmed:true, complete:true` 当 poke 成功）；或把 `pokeBack` 的返回结果纳入确认计数。
- 置信度：高。

### P3-02 `sendVoice` 在试运行/跳过时 `bump('voice')`，统计把“没发”计成“语音已发”

- 位置：`hub.js:660-669`（`if (r.delivered || r.skipped) { bump('voice'); return true }`）
- 触发：`dryRun` 或 `cfg.enabled=false` 时调用 `sendVoice`（模块/命令）。
- 影响：面板“今日语音”统计虚高；调用方以为语音已送达（返回 true），不会再回退文字。
- 修复：只在 `r.delivered` 时 bump/返回 true；`skipped` 返回 false 并让调用方决定是否回退。
- 置信度：高。

### P3-03 死代码/注释与实现不符：`groupInterjects`、`groupFedAt`、`ownerMessageRef`、`turnHasOwner` 别名

- 位置：`hub.js:129`（`groupInterjects` 注释“她主动开口的时间”但全仓无写入）、`hub.js:131`+`:1465`+`:1475`（`groupFedAt` 只写不读，`since` 仅用于 `Math.max(since,...)`）、`hub.js:2082-2092`（`ownerMessageRef` 定义后无调用）、`hub.js:2093-2094`（`turnHasOwner` 只是 `turnSendersAllOwner` 别名；`modules/API.md:120` 又说 `turnHasOwner` 不能单独授权，命名容易误导）
- 触发：维护者按注释理解行为；新增群策略代码读取 `groupFedAt`/`groupInterjects` 时发现永远为空。
- 影响：维护成本、误判限流行为；死代码掩盖真实逻辑。
- 修复：删除或实装；`groupFedAt` 若不需要就删；`ownerMessageRef` 未用删除；`turnHasOwner` 改名 `turnRequestsAllOwner` 并在 API 文档标注强约束。
- 置信度：高（grep 证明）。

### P3-04 `hub.js` 2302 行上帝类 + 直接 SQL 跨层 + 三套发送路径重复

- 位置：`src/chat/hub.js:1-2302`；`hub.js:817`（`SELECT kind,state FROM jobs`）、`:1301`（`SELECT value FROM meta ... planner:wait`）；发送路径 `sendText`（`:640`）、`sendSegments`（`:594`）、`deliver`（`:793`）、`transmit`（`:461`）、`pokeBack`（`:673`）、`sendVoiceFile`（`:688`）
- 代码证据：hub 同时负责入站解析、群策略、persona/agent 生命周期、媒体、工具挂载、planner、jobs 回执、outbox、命令、日志；多处绕过 storage repo 直接 `storage.db` 查询；发送/降级/重试/格式化在 `deliver`、`sendText`、`sendSegments`、`sendVoiceFile`、`image` 的 `sendImageAssets` 各自实现。
- 影响：任何状态修复都要改 2-3 处；`dryRun/force` 门分散导致 P0-01；`outbox`/job 状态分散导致 P2-09；测试只能靠整 hub fixture，难定位。
- 修复：拆 `chat/inbound`、`chat/router`、`chat/session-registry`、`chat/delivery`；所有发送只经一个 `MessageGateway`（含 effect policy、outbox、retry、format）；hub 只做编排。
- 置信度：高（结构性事实）。

### P3-05 `segmentsOf` 对字符串 CQ 码只保留纯文字：@、引用、图片、语音全部丢失

- 位置：`src/chat/inbound.js:4-8`
- 代码证据：`if (typeof m === 'string') return [{ type:'text', data:{text:m.replace(/\[CQ:[^\]]*\]/g,'')} }]`；对 CQ 字符串不解析 `CQ:at`、`CQ:reply`、`CQ:image`、`CQ:record`。
- 触发：OneBot 实现配置为字符串消息格式（v11 允许），不是所有实现都发 segment array。
- 影响：`mentioned` 永远 false、`replyId` 为空、`images/records/stickers` 为空；群聊 @ 她的消息被当普通 interject；语音消息完全丢失；图片不登记。
- 修复：实现 CQ 码解析器（`CQ:at,q=...`、`CQ:reply,id=...`、`CQ:image,file=...,url=...` 等），或启动时要求/检测 array 格式并给面板警告。
- 置信度：高（代码明确只取文字）。

### P3-06 私聊 `get_msg` 响应缺少 `message_type` 时 `historyScopeMatches` 会拒绝有效引用

- 位置：`src/chat/history-boundary.js:25-38`，尤其 `:38` `return !requireChat || raw.message_type === 'private' && other === peer`
- 触发：SnowLuma/其他网关 `get_msg` 返回私聊消息但不带 `message_type`（OneBot v11 并非所有实现都回填）；`quotedOf` 用 `requireChat:true`（`hub.js:1373`）。
- 影响：私聊引用消息解析失败，`repliedToBot` 无法识别；用户引用她的话，她按普通 interject 而非 must 处理；引用里的图片/文本缺失。
- 修复：当 `raw.message_type` 缺失时，结合 `group_id`/`sender`/`target_id` 推断私聊；只在能确认矛盾时拒绝；增加各网关兼容测试。
- 置信度：中（依赖网关响应形状）。

### P3-07 `deliver` 语音回落使用 `opts.epoch` 而非计算后的 `epoch`

- 位置：`hub.js:951` `const fallback = await sendItems(..., { epoch: opts.epoch, ... })`
- 代码证据：本函数前面已从 `toolScope`/`opts.epoch`/storage 计算了 `const epoch`（`:797-798`），但回落只传 `opts.epoch`；当 `opts.epoch` 为空（模块/工具路径）时，outbox 会按当前 epoch 入队。
- 触发：语音发送失败、触发 fallback，且 `deliver` 由 tool/`sendVoice` 调用未显式传 `opts.epoch`。
- 影响：理论上旧代次语音的 fallback 文本可能以当前 epoch 发送；实际窗口较窄，但会绕过代次保护。
- 修复：统一传 `epoch`（计算值），并对 fallback 的 `shouldSend`/`signal` 同样检查。
- 置信度：中高（代码直接可见；触发条件依赖 opt.epoch 缺省）。

### P3-08 `sendVoiceFile` 不检查 `files.enabled`/大小；`sendSegments` file 段也不校验

- 已在 P1-07 记录路径问题；此处补充：`sendVoiceFile` 即使 `cfg.files.enabled=false` 也会发语音文件，`readFileSync` 无 `maxMB`，与 `sendFile` 的 `files.maxMB` 不一致。
- 位置：`hub.js:688-697`、`hub.js:703-724`（`sendFile` 对照）
- 修复：统一走 `sendFile` 的文件策略（音频用 voice 段时也检查大小/目录）。
- 置信度：高。

---

## 5. 专项核查结论

### 5.1 试运行是否真的拦住所有外部副作用？

**没有。** `dryRun` 目前只是发送层的“最后一道门”，且还能被 `force` 绕过（P0-01）。矩阵：

| 副作用 | dryRun=true 时是否发生 | 证据 |
|---|---|---|
| LLM 聊天回合 | **发生** | `hub.onMessage` 只判 `enabled`（`hub.js:1274-1277`）；`pushToSession` 直接 `agent.followup/steer`（`:1942-1945`） |
| 插件工具执行（搜索/记忆/QQ 读取等） | **发生** | `mount` 无条件 `tools.register`（`:386-393`）；`buildTools` 不接收 dryRun |
| 生图 API 提交 | **发生（可能收费）** | `jobs/image.js:256-266` submit 无 dryRun；`modules/imagegen/index.js:186` enqueue |
| 生图结果发送 | 不发送，但会保存结果并把 job 留 `delivery_pending` | `jobs/image.js:305-307` |
| 媒体分析 vision API | **发生（可能收费）** | `media-analysis.js:297-315`/`:355-365` 无 dryRun |
| 搜索/扩展 HTTP | 多数**发生** | `search`/模块工具无统一 dryRun 门 |
| 模块直接 `api.onebot` | **发生** | `host.js:841` 注释明确 |
| 普通 QQ 消息发送 | 不发送 | `transmit` `cfg.dryRun`（`hub.js:503-506`） |
| 主人命令回复 | **会真实发送** | `force:true` → `transmit` `if(force){}`（P0-01） |
| `pokeBack` | 不戳 | `hub.js:678` 检查 |

建议：产品层面把 `dryRun` 定义为“只读试运行”并补全所有副作用门，或改名/文档说明“只是不真发，仍会调模型和外部 API”。

### 5.2 群聊是否可能借用主人权限？

- **正常单请求路径**：`turnSendersAllOwner` 对 `st.requests` 全为 owner 才 true（`hub.js:2065-2073`）；群聊中只有主人发言时，`qq_group_admin` 等确实可用，这是设计意图。`turnHasOwner` 只是严格别名（`:2093-2094`）。`group-admin` 的执行前还重复校验（`modules/group-admin/index.js:36,49`）。
- **条件放宽**：`st?.directOwner` / `st?.senders` 分支（P2-11）没有按 `private:owner` 限定；`turnActor` 的 `directOwner` 回退会直接返回 owner（`:2012`）。群聊 session 若收到 `user/message` 且 `source.kind==='user'`（`:1025`）且 `st.requests` 为空，会被视为 owner 回合。
- **旧会话映射**（P0-02）会让旧 owner session 的 `turnSendersAllOwner` 继续 true，并在旧 agent 工具仍 mounted 时执行。
- **`profilePerms.whitelist/qqFriendRequest` 设为 `all`** 时群聊 guest 可改白名单/处理好友申请（`access.js:57-70` + `modules/contacts`），这是显式 opt-in，但面板文案若没说清会成为“群友借主人权限”的入口。
- **结论**：没有发现“任意群友直接借 owner”的无条件漏洞；但 owner 判定不是 chat-type locked，旧映射/`directOwner`/`all` 权限是三处应加固的边界。

### 5.3 会话重置/切换人设时旧回合迟到消息是否串台？

**会，且不止一条路径：**

1. **P0-02**：`agentFor` 档位/preset 变化只新建 session，不删旧 `sessionToChat`/`turnState`、不 unmount、不 bump epoch；旧 turn/end 可释放新 turn、旧回复可发送。
2. **P1-05**：`switchIdentity`/`resetChat` 不清 `groupBuf/groupEngaged/groupSaid/participation`；旧群上下文/活跃状态会进入新身份。
3. **P1-06**：`outbox.cancelPending` 只取消 `pending`，已 `sending` 的旧消息仍可发。
4. **重置竞态**：`resetChat` 先 `scheduler.drop`，但 `onMessage` 在 `quotedOf/expandForwards/media.register` 的 await 之后才 `scheduler.add`（`hub.js:1309-1350`）；在 reset 前已进入 `onMessage` 的消息可能在 drop 后重新入队，进入新会话。消息/调度条目没有 epoch token，无法识别。
5. **`switchIdentity` 故意不 drop scheduler**（注释“攒着的新消息不丢”），但无法区分“切换前旧问题”和“切换后新消息”；旧问题会由新身份回答。

---

## 6. 该域最该先重构的 5 个点

1. **统一的 `EffectPolicy` / `MessageGateway`（先解决 P0-01、P1-04、P1-07）**
   - 把 `enabled/dryRun/canSend/force/file path/hooks.send` 收敛到单一发送入口；`force` 只能绕过 enabled，绝不能绕过 dryRun；所有模块/命令/jobs 的发送都走同一入口。
   - 把 `sendVoiceFile`/`sendSegments` 纳入 `checkLocalFile` 与 `files.enabled`。
2. **会话身份注册表（SessionRegistry：account+chatId+level+preset+persona+epoch+turnId）**
   - 解决 P0-02、P1-05、P1-10、P2-11；所有创建/切换/轮换/重置走唯一 `switchSession`；旧 session 必须同时 `cancel → unmount → archive → delete maps → bump epoch`；`turn/end` 必须验证 turnId+sessionId。
3. **调度器去掉 `BUSY_MAX_MS` 隐式开新轮，改成显式 turn token/refcount（P0-03、P1-01、P1-02）**
   - `busySince` 只能由同一个 `turnId` 的 `turnEnded` 清除；超时只能 `abort` 当前 turn 并产生显式失败事件；steer 必须验证 host 能力与当前 turn；dispatch 失败必须有死信/重试。
4. **Outbox + Jobs 单一投递状态机（P0-04、P1-06、P2-09、P2-10）**
   - `outbox` 批次作为 QQ 送达唯一事实；job `delivery` 只引用 outbox 状态做投影；恢复时先查 outbox rows 再决定 job 状态；`requiresGuard` 区分 sessionReply/job；终态 retention。
5. **群聊策略/参与控制器单一限流源（P1-08、P1-09、P2-04）**
   - 只保留一套 `maxPerHour/cooldown/burst`，实时写 `groupInterjects`；`groupBuf` 按 epoch + LRU；`ready` 按 chat 限批；`groupPrompt` 截断/摘要；`participation` 与 group-policy 不再各算一半。

---

## 7. 回归测试建议（按优先级）

### P0 回归
1. **force/dryRun 矩阵**：`enabled=false/false+dryRun=true/false/force=true` × `sendText/sendSegments/sendVoiceFile`，断言 `onebot.call` 调用次数为 0/1；`hooks.send` 之前检查 effect policy。
2. **长回合不并发**：scheduler 假时钟推进 >4 分钟、第一轮未 `turnEnded`，再 add；断言 dispatch 不增加；再发 `turnEnded(turnId1)` 不得释放 `turnId2`；断言 request→reply 对应正确。
3. **档位切换**：`ownerLevel full→social` 时旧 turn 未结束；断言旧 `chatOfSession(oldSid)==''`、旧 `mounted` 为空、旧 `turn/end` 不发送、旧 agent 工具不可执行。
4. **outbox 重启**：模拟 `sending`/`pending` guarded 批次，`recover()` 无 shouldSend；断言 pending 被安全恢复或明确 canceled，且 `summary.pending` 不为永久 1。
5. **人物切换串台**：群聊 `groupBuf/groupEngaged` + `switchIdentity`；断言新 persona 首轮 prompt 不含旧群消息、不继承 engaged；旧 outbox `sending` 不发送。

### P1 回归
6. **steer 失败**：host 无 `agent.steer` / turn 在 steer 前结束；断言 batch 回到 scheduler 或死信，不消失；`st.requests` 不丢。
7. **dispatch 异常**：`agentFor` 抛 `SOCIAL_SCOPE_UNAVAILABLE`/`requests.create` 抛错；断言死信记录、请求状态 `dispatch_failed`、日志含 messageIds。
8. **入站异常**：`media.register` 的 `occurrences.add` 抛错；断言消息进入 `inbound_deadletter` 或重试，而不是仅 duplicate return。
9. **群限流**：`participation.enabled=false` + `groupEngaged` + 100 条群消息；断言只按 `maxPerHour/cooldown` 回复；`groupInterjects` 有写入。
10. **backlog**：群聊 busy 时 100 条消息；断言 prompt 条数/字符有上限，`ready` 有上限，未超内存。
11. **文件路径**：`sendVoiceFile('/etc/passwd')`、`sendSegments([{type:'file',data:{file:'/etc/passwd'}}])`、`sendFile`；断言前两者拒绝，后者按 `checkLocalFile` 规则。
12. **reset in-flight**：消息在 `quotedOf` await 期间触发 `/reset`；断言不会在 reset 后入 scheduler，或明确标记为 `stale_epoch`。

### P2/P3 回归
13. **群名失败缓存**：`get_group_info` 抛错，连续 3 条群消息；断言只请求一次/短 TTL，响应不超时。
14. **meta retention**：模拟 1000 个 wait/wake/outbox；运行 tick/重启；断言旧终态被清理，查询耗时稳定。
15. **媒体 cap**：模型输出 20 个 `![x]` + 20 个 `<voice>`；断言只发送上限内媒体，outbox 行数受限。
16. **history boundary**：清空历史后写 boundary；断言 `seedHistory`/`quotedOf`/`qq_chat_history` 不返回边界前消息。
17. **deniedTools**：fake agent 直接执行 denied 工具；断言 guard 拒绝（不仅 schema 不展示）。
18. **danger guard**：`terminal`/`run_command` 等工具执行危险命令；断言被拦截/询问（或明确文档只保护 bash/pwsh）。

---

## 8. 补充探针（可复现）

### 8.1 Scheduler 4 分钟超时探针
```js
// fake timers + createScheduler
s.add(pm,{messageId:'a',actorId:'1',mode:'must'}); advance(2000);
// first dispatch: [{ids:['a'],steer:false}], busy true
advance(4*60_000+1);
s.add(pm,{messageId:'b',actorId:'1',mode:'must'}); advance(2000);
// 输出两个 dispatch：['a'] 和 ['b']，第一个从未 turnEnded
```

### 8.2 Outbox guarded recovery 探针
```js
const b=ob.enqueue({chatId:'group:1',items:[text('hi')],requiresGuard:true})
const r=await ob.recover({maxAgeMs:0})
// r = {stuck:0, stale:0, resumed:0}
// ob.summary(b).pending = 1, sent = 0
```

### 8.3 force 绕过 dryRun 探针
```js
const f=await hubFixture(...,{config:{dryRun:true,enabled:true}})
await f.hub.sendSegments(`private:${OWNER}`, [{type:'text',data:{text:'dry run force test'}}], 'x', {force:true})
// f.calls = ['send_private_msg']
```

> 说明：本文件为最终版；P0/P1 已覆盖并附可复现探针，P2/P3 为静态审计结论。未对源码做任何修改。

