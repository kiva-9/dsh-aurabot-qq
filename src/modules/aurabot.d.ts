// Aurabot 2.0.0-rc.1 · 扩展 API 2。
// 运行时复制到 modules/aurabot.d.ts；自己的模块引用 import('../aurabot').AurabotModule。
// 这些是接口提示，不是运行时授权。api.core/lib/dsh 内部能力不承诺稳定。

export type ChatId = `private:${string}` | `group:${string}` | `system:${string}`
export type ScopedChatId = `private:${string}` | `group:${string}`
export type MaybePromise<T> = T | Promise<T>
export type Off = () => void
export interface Scope { account: string; chat: ScopedChatId; persona: string }
export interface Scoped { scope: Scope; account: string; chat: ScopedChatId; persona: string }
export interface Chat { chatId: ChatId; kind: 'private' | 'group' | 'system'; userId?: string; groupId?: string; title?: string }
export interface Segment { type: string; data: Record<string, any> }
export interface Message {
  kind: 'private' | 'group'; chatId: ScopedChatId; userId: string; groupId: string
  nickname: string; role: string; messageId: string; text: string; mentioned: boolean; replyId: string
  /** 内部证据 ID；不是 QQ messageId。并非所有调用路径都会附带。 */
  sourceMessageId?: string
  images: any[]; stickers: any[]; records: any[]; forwards: any[]; raw: any
}
export interface ReplyItem { kind: 'text' | 'voice' | 'sticker' | 'poke' | 'image'; value: any; replyTo?: string }
export interface GroupDecision { reply: boolean; mode?: 'must' | 'engaged' | 'interject' | 'none'; reason?: string }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface PersonaSnapshot { personaId: string; revision?: number; name?: string; [key: string]: any }

/** 异步 Hook 的最后一个参数。正常返回后 signal 也会 abort，不能当作缓存寿命。 */
export interface HookExecution {
  readonly signal: AbortSignal
  /** 模块实例/可识别聊天 epoch 是否仍有效；不代替 signal、账号和请求核验。 */
  readonly isCurrent: () => boolean
}
export type HookMode = 'observe' | 'claim' | 'filter' | 'sync'
export interface HookOptions {
  mode?: HookMode
  /** 升序，-10..10。 */ phase?: number
  /** 升序，-100..100。 */ priority?: number
  /** 异步调用 10..30000ms；不抢占同步 JavaScript。 */ timeoutMs?: number
}
/** 同步 context 只保证这两个字段。persona 从 hub.turnPersona(sessionId) 解析。 */
export interface ContextArgs { chat: Chat; sessionId: string }
export interface PrepareContextArgs extends ContextArgs, HookExecution {
  chatId: ChatId; text: string; account: string; persona: string
  personaSnapshot?: PersonaSnapshot | null; requestIds: string[]
  /** 独立集成可传；当前 hub 不保证提供。 */ epoch?: number
}
export interface Activity {
  kind: 'in' | 'out'; chatId: ChatId; userId?: string; nickname?: string
  text?: string; reply?: string; direct?: boolean; owner?: boolean; confirmed?: boolean
  account?: string; persona?: string; personaId?: string; sessionId?: string
  sourceMessageIds?: string[]; messageId?: string; epoch?: number; personaRevision?: number
}
export interface Events {
  message: (msg: Readonly<Message>, execution: HookExecution) => MaybePromise<boolean | void>
  poke: (event: any, execution: HookExecution) => MaybePromise<boolean | void>
  'group/decide': (decision: Readonly<GroupDecision>, info: {msg: Readonly<Message>; policy: any; recentTexts: string[]; memScore: number}, execution: HookExecution) => MaybePromise<GroupDecision | null | void>
  prompt: (content: readonly any[], info: {chat: Chat; senderId: string; queryText?: string}, execution: HookExecution) => MaybePromise<any[] | null | void>
  reply: (text: string, info: {chatId: ChatId; userText: string}, execution: HookExecution) => MaybePromise<string | null | void>
  'reply/items': (items: readonly ReplyItem[], info: {chatId: ChatId; text: string; userText: string}, execution: HookExecution) => MaybePromise<ReplyItem[] | null | void>
  send: (message: readonly Segment[], info: {chatId: ChatId; note: string; force: boolean}, execution: HookExecution) => MaybePromise<Segment[] | null | void>
  /** 同步 Hook 不传 execution；Promise 会被拒绝。 */
  model: (selection: ModelSelection | null, chat: Chat) => ModelSelection | null | void
  persona: (text: string) => string | null | void
  rules: (text: string, kind: 'private' | 'social') => string | null | void
  /** 直接 on 时 execution 独立传入；推荐 api.prepareContext 包装入口。 */
  'context/prepare': (args: Omit<PrepareContextArgs, 'isCurrent' | 'signal'> & {signal?: AbortSignal}, execution: HookExecution) => MaybePromise<unknown>
  activity: (activity: Readonly<Activity>, execution: HookExecution) => MaybePromise<unknown>
  onebot: (event: any, execution: HookExecution) => MaybePromise<unknown>
  'onebot/state': (state: string, execution: HookExecution) => MaybePromise<unknown>
  config: (cfg: any, before: any, execution: HookExecution) => MaybePromise<unknown>
  'module/start': (id: string, execution: HookExecution) => MaybePromise<unknown>
  'module/stop': (id: string, execution: HookExecution) => MaybePromise<unknown>
  'song/sung': (info: {title: string; chatId: ChatId}, execution: HookExecution) => MaybePromise<unknown>
  [custom: string]: (...args: any[]) => any
}
export interface Where { chat: Chat; level: 'full' | 'social' | 'chat'; sessionId: string }
/** DSH 工具执行信息，不是 HookExecution；具体能力取决于宿主。 */
export interface ToolExecution { signal?: AbortSignal; abortSignal?: AbortSignal; [key: string]: any }
export interface Tool {
  name: string; description: string; parameters: any; output: any
  execute(args: any, execution?: ToolExecution): Promise<any>
}
export interface ToolSpec {
  name: string; description: string; properties?: Record<string, any>; required?: string[]
  execute(args: any, execution?: ToolExecution): MaybePromise<any>
}
export interface Command { name: string; aliases?: string[]; desc?: string; run(arg: string, msg: Message): MaybePromise<string | void> }
export interface Logger { debug(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void }

export type FactStatus = 'active' | 'conflicted' | 'superseded' | 'retracted'
export type FactCategory = 'fact' | 'experience'
export type ProfileSection = 'identity' | 'relationships' | 'stableFacts' | 'preferences' | 'recentInteractions' | 'uncertain'
export interface FactFields {
  text?: string; subject: string; predicate: string; value: string | number | boolean; speakerId: string
  polarity: 'positive' | 'negative'
  modality: 'asserted' | 'reported' | 'hypothetical' | 'plan' | 'joke' | 'uncertain'
  /** null 未知；[] 无条件。 */ conditions: string[] | null
  eventTime: number | null; validFrom: number | null; validTo: number | null
  stability: 'stable' | 'temporal' | 'uncertain'
  status?: FactStatus; slot?: 'single' | 'multi'; profileSection?: ProfileSection
  aboutName?: string; tags?: string[]; importance?: number; extractorVersion?: string
}
export interface ManualEvidence {
  kind?: 'manual' | 'event'; text: string; speakerId: string; actorId: string
  sourceId?: string; confirmed?: boolean; eventTime?: number
}
export interface EvidenceInput { evidenceMessageIds?: string[]; evidenceIds?: string[]; manualEvidence?: ManualEvidence }
export interface FactInput extends FactFields, EvidenceInput { scope: Scope; category?: FactCategory; source?: string; actorId?: string }
export interface Evidence extends Scoped {
  id: string; kind: string; messageId: string | null; speakerId: string; text: string
  eventTime: number; revision: number; contentHash: string
}
export interface FactSource { id: string; messageId: string | null; speakerId: string; date: number; scope: Scope; kind: string }
export interface MemoryFact extends FactFields, Scoped {
  id: string; text: string; category: FactCategory; status: FactStatus; revision: number
  createdAt: number; updatedAt: number; supersedes: string[]; supersededBy?: string
  conflicts?: string[]; possibleDuplicates?: string[]; about: string; at: number
  evidence: Evidence[]; evidenceIds: string[]; evidenceMessageIds: string[]; sources: FactSource[]
  validity: 'current' | 'future' | 'expired'
}
export interface MemoryReadOptions {
  scope: Scope; includeInactive?: boolean; at?: number
}
export interface MemoryQueryOptions {
  limit?: number; q?: string; subject?: string; category?: FactCategory; categories?: FactCategory[]
  status?: FactStatus; statuses?: FactStatus[]; includeInactive?: boolean; currentOnly?: boolean
  ownScope?: boolean; order?: 'created' | 'updated'; at?: number
  /** list 的候选预算，上限 20000；完整枚举请用 page。 */ scanLimit?: number
}
export interface MemoryPageOptions extends Omit<MemoryQueryOptions, 'q' | 'scanLimit'> { cursor?: string | null }
export interface MemoryPage extends Scoped {
  items: MemoryFact[]; nextCursor: string | null; done: boolean; scanned: number
  visibilityStamp: string; revision: number
}
export interface AuditMeta extends EvidenceInput {
  scope: Scope; actorId: string; reason: string; expectedRevision?: number; approved?: boolean
}
export interface MemoryFailure { ok: false; code: string; message: string }
export interface FactWriteResult extends Scoped { ok: true; id: string; item: MemoryFact }
export interface ProfileOverrideEntry { section: ProfileSection; text: string; factIds: string[] }
export interface ProfileOverride { aliases: string[]; entries: ProfileOverrideEntry[]; revision: number }
export interface ProfileEntry { text: string; factIds: string[]; evidenceIds: string[]; dates: number[]; confirmed: boolean }
export interface MemoryProfile extends Scoped {
  subject: string; text: string; sections: Record<ProfileSection, ProfileEntry[]>
  fingerprint: string; override: ProfileOverride; [key: string]: any
}
export interface RecallOptions {
  scope: Scope; about?: string | string[]; limit?: number; context?: string; minScore?: number
  includeUncertain?: boolean; includeHistory?: boolean
}
export interface RecallHit extends Scoped { it: MemoryFact; score: number; why: string[]; sources: FactSource[]; date: number }
export interface MemoryCheckpoint extends Scoped {
  recvSeq: number; watermark: number; lastSuccessAt: number | null; state: string
  error?: string | null; attempts?: number
}
export interface MemoryApi {
  create(input: FactInput): FactWriteResult
  add(input: FactInput): FactWriteResult | MemoryFailure
  addEvent(input: {scope: Scope; text: string; sourceId: string; confirmed: true; eventTime?: number; about?: string; aboutName?: string; speakerId?: string; actorId?: string; tags?: string[]; importance?: number; predicate?: string}): FactWriteResult | MemoryFailure
  get(id: string, options: MemoryReadOptions): MemoryFact | null
  /** 最多 200 个无重复 ID；遗漏项不可见或不存在。 */
  getFactsByIds(ids: string[], options: MemoryReadOptions): MemoryFact[]
  /** 默认 300，最多 5000 返回项；不是全库读取。 */
  list(options: MemoryQueryOptions & {scope: Scope}): MemoryFact[]
  list(scope: Scope, options?: MemoryQueryOptions): MemoryFact[]
  list(query: string, options: MemoryQueryOptions & {scope: Scope}): MemoryFact[]
  /** 单页最多 1000 候选；空 items 也要按 nextCursor 继续。 */
  page(scope: Scope, options?: MemoryPageOptions): MemoryPage
  revision(scope: Scope): number
  visibilityStamp(scope: Scope): string
  recall(query: string, options: RecallOptions): RecallHit[]
  recalls(options: {scope: Scope}): Array<Scoped & {at: number; query: string; hits: Array<{id: string; score: number; why: string[]}>}>
  recentEvents(options: {scope: Scope; hours?: number; limit?: number}): MemoryFact[]
  contextFor(chat: Chat, sessionId: string, options: {scope: Scope; about?: string | string[]}): string
  recallHint(chat: Chat, queryText: string, prevText?: string, options?: {scope: Scope; about?: string | string[]}): string
  topicScore(text: string, options: RecallOptions): number
  update(id: string, patch: Partial<FactFields>, meta: AuditMeta & {expectedRevision: number}): any
  correct(id: string, replacement: FactFields & EvidenceInput, meta: AuditMeta & {expectedRevision: number}): any
  retract(id: string, meta: AuditMeta): any
  remove(id: string, meta: AuditMeta): any
  restore(id: string, meta: AuditMeta): any
  approve(id: string, meta: AuditMeta & {approved: true}): any
  changeScope(id: string, targetScope: Scope, meta: AuditMeta & {expectedRevision: number}): any
  evidence(id: string, options: {scope: Scope}): Evidence[]
  evidenceReview(id: string, options: {scope: Scope}): Array<{id: string; revision: number; [key: string]: any}>
  audit(id: string, options: {scope: Scope}): any[]
  reviewList(options: {scope: Scope}): any[]
  deleteEvidence(id: string, meta: AuditMeta): any
  refreshEvidence(id: string, meta: AuditMeta): any
  approveEvidence(id: string, meta: AuditMeta & {expectedRevision: number; approved: true}): any
  profileOf(subject: string, options: {scope: Scope; includeUncertain?: boolean}): MemoryProfile | null
  buildProfile(subject: string, options: {scope: Scope; includeUncertain?: boolean}): Promise<MemoryProfile | null>
  profiles(options: {scope: Scope; includeUncertain?: boolean}): MemoryProfile[]
  profileFingerprint(subject: string, options: {scope: Scope}): string
  getOverrides(subject: string, options: {scope: Scope}): Scoped & {subject: string; override: ProfileOverride}
  setOverrides(subject: string, value: Omit<ProfileOverride, 'revision'>, meta: AuditMeta & {expectedRevision: number}): Scoped & {ok: true; subject: string; revision: number}
  enqueue(scope: Scope): any
  status(scope: Scope | {scope: Scope}): MemoryCheckpoint
  due(scope: Scope): boolean
  /** 仅为旧宿主保留：无 scope 返回 null。 */
  lastConsolidate(options?: {scope: Scope}): MemoryCheckpoint | null
  tick(options: {scope: Scope}): Promise<any>
  consolidate(options: {scope: Scope}): Promise<any>
  registeredScopes(): Scope[]
  recentPending(options: {scope: Scope}): any[]
  episodes(options: {scope: Scope}): any[]
  quarantineImport(payload: unknown, options: {scope: Scope; sourceKey?: string}): any
  quarantineList(options: {scope: Scope}): any[]
  unassignedQuarantine(options: {scope: Scope; includeUnassigned: true}): any[]
  approveLegacy(id: string, fact: FactFields & EvidenceInput, meta: AuditMeta & {approved: true}): FactWriteResult
  legacyStatus(): any[]
  stats(options: {scope: Scope}): Scoped & {count: number; conflicted: number; outdated: number; auto: number; events: number; quarantined: number}
  lexicalCacheStats(): {builds: number; hits: number; entries: number; documents: number}
  /** 逻辑取消并等待领域工作；不关闭宿主 SQLite，不保证撤销外部收费。 */
  dispose(): Promise<{ok: true; stopped: true}>
  stop(): Promise<{ok: true; stopped: true}>
}
export interface MoodState { scope: Scope | null; value: number; label: string; reason: string; revision: number; history: any[]; at?: number }
export type StickerState = 'pending' | 'approved' | 'rejected' | 'disabled' | 'deleted'
export interface StickerOptions {
  chatId: ScopedChatId; accountId?: string
  /** 只供受信任管理端，不能从模型参数照搬。 */ admin?: boolean
  actorId?: string; reason?: string; expectedRevision?: number; reviewedOriginal?: boolean
}
export interface StickerItem {
  id: string; scope: {account: string; chat: ScopedChatId; persona?: string; category?: string}
  assetId: string; sha256: string; md5: string; state: StickerState; revision: number
  name: string; tags: string[]; description: string; ocr: string; animated: boolean
  analysis: {state: string; error?: string | null; [key: string]: any}
  qq: {state?: string; emojiId?: string; [key: string]: any}
  [key: string]: any
}
export interface StickerApi {
  list(options: StickerOptions & {query?: string; status?: StickerState | 'all' | 'quarantined'; offset?: number; limit?: number}): {items: any[]; total: number; offset?: number; limit?: number}
  get(id: string, options: StickerOptions): StickerItem | null
  selectForReply(text: string, options: StickerOptions, extra?: {intent?: string; mood?: any}): {decision: 'match' | 'no_match'; item: StickerItem | null; reason: string; candidateIds: string[]}
  pickForReply(text: string, options: StickerOptions, extra?: {intent?: string; mood?: any}): StickerItem | null
  match(query: string, options: StickerOptions): StickerItem | null
  segmentFor(item: StickerItem, options: StickerOptions): Segment | null
  /** bytes 在运行时要求 Node Buffer；必须绑定目标聊天。 */
  addFromBuffer(bytes: any, options: StickerOptions & {name?: string; tags?: string[]; from?: string; toQQ?: boolean}): Promise<any>
  collect(segment: Segment, options: StickerOptions, extra?: any): Promise<any>
  approve(id: string, options: StickerOptions): any
  reject(id: string, options: StickerOptions): any
  disable(id: string, options: StickerOptions): any
  remove(id: string, options: StickerOptions): any
  edit(id: string, patch: any, options: StickerOptions): any
  queueStatus(options: StickerOptions & {limit?: number}): any
  retryTask(taskId: string, options: StickerOptions): any
  /** unknown 必须先核对外部结果，不能直接 retry。 */
  reconcileSync(taskId: string, options: StickerOptions & {confirmedApplied?: boolean; confirmedNotApplied?: boolean; emojiId?: string}): any
  stop(): Promise<any>
}
export interface MoodEffects { sticker: number; voice: number; delay: number; chatty: number }
export interface MoodApi {
  state(scope: Scope): MoodState; current(scope: Scope): number; label(scope: Scope): string
  nudge(scope: Scope, delta: number, reason: string, options?: {expectedRevision?: number; evidenceMessageIds?: string[]; origin?: string}): any
  reset(scope: Scope, options?: {expectedRevision?: number}): any
  effects(scope: Scope, options?: {explicitRequest?: boolean; taskPending?: boolean}): MoodEffects
  contextLine(scope: Scope): string
  observe(scope: Scope, input: {messageId: string; direct?: boolean; owner?: boolean}): any
  judge(scope: Scope, input: {sourceMessageIds: string[]; reply?: string; epoch?: number; personaRevision?: number}): Promise<any>
  stop(): Promise<any>
}
export type LearningKind = 'expression' | 'jargon'
export type LearningStatus = 'pending' | 'approved' | 'disabled' | 'deleted'
export interface LearningApi {
  list(scope: Scope, options?: {kind?: LearningKind; status?: LearningStatus; limit?: number; includeDeleted?: boolean; includeShared?: boolean}): any[]
  get(scope: Scope, id: string): any
  enqueue(scope: Scope, kind: LearningKind): any
  learn(scope: Scope, kind: LearningKind): Promise<any>
  checkpoint(scope: Scope, kind: LearningKind): any
  contextFor(scope: Scope, query: string, options?: {requestId?: string}): string
  sources(scope: Scope, options?: {kind?: LearningKind; q?: string; limit?: number}): any
  evidence(scope: Scope, id: string): any[]
  history(scope: Scope, id: string): any[]
  upsert(scope: Scope, kind: LearningKind, data: any, options: {actorId: string}): any
  update(scope: Scope, id: string, patch: any, options: {actorId: string; expectedRevision: number}): any
  transition(scope: Scope, id: string, status: LearningStatus, options: {actorId: string; expectedRevision: number}): any
  stop(): Promise<any>
}
/** 由可信宿主构造，模型不能传入或改写这些授权字段。 */
export interface RequestContext {
  account: string; chatId: ScopedChatId; actorId: string; requestId?: string
  personaId?: string; epoch?: number; policyRevision?: number; signal?: AbortSignal
  authority?: 'owner-panel'; assertActive?: () => void
}
export interface RetrievalApi {
  ready: Promise<any>
  status(): {enabled: boolean; ready: boolean; initializing: boolean; lastError: string | null; pending: number}
  health(): Promise<any>
  prepareContext(args: PrepareContextArgs): Promise<any>
  contextFor(chat: Chat, sessionId: string): string
  recall(input: {query: string; limit?: number; category?: string; subject?: string; from?: number; to?: number}, context: RequestContext): Promise<any>
  queryImages(input: {query?: string; occurrenceId?: string; limit?: number}, context: RequestContext): Promise<any>
  materializeReference(input: {occurrenceId: string; role?: string}, context: RequestContext): Promise<any>
  assertReferences(references: any[], context: RequestContext): any[]
  dispose(): Promise<void>
}
export interface TokenUsageCounts {
  calls: number; callsWithUsage: number; incompleteCalls: number
  inputTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number
}
export interface TokenMeterApi {
  summary(options?: {range?: 'today' | '7d' | '30d' | 'all'; chatId?: string; groupBy?: 'none' | 'day' | 'model' | 'role' | 'provider'; now?: number}): {
    account: string; chatId: string | null; from: number; to: number; range: string
    totals: TokenUsageCounts; buckets: Array<TokenUsageCounts & {key: string}>; generatedAt: number; note: string
  }
}

export interface TaskApi {
  planner: any
  authorize(context: RequestContext): any
  wait(context: RequestContext, options: {condition: 'job' | 'request' | 'media' | 'time'; jobIds?: string[]; requestId?: string; timeoutMs?: number; mode?: 'all' | 'any'; resultReady?: boolean}): any
  stop(context: RequestContext, reason?: string): any
  listTasks(context: RequestContext, options?: {id?: string; kind?: string; limit?: number}): any[]
  cancelTask(context: RequestContext, id: string): any
  dispose(): MaybePromise<any>
}
export interface StoredMessage { id: string; account: string; chatId: ScopedChatId; authorId: string; text: string; recvSeq: number; recalledAt?: number | null; [key: string]: any }
export interface StoredRequest { id: string; chatId: ScopedChatId; actorId: string; sourceMessageIds: string[]; epoch: number; policyRevision: number; state: string; [key: string]: any }
export interface StorageApi {
  /** 同步事务，回调不能返回 Promise。存储实例属于宿主，模块不要 close。 */
  tx<T>(fn: () => T extends PromiseLike<any> ? never : T): T
  db: any
  messages: {get(id: string): StoredMessage | null; [key: string]: any}
  requests: {get(id: string): StoredRequest | null; appendSource(id: string, messageId: string): StoredRequest; [key: string]: any}
  epochs: {current(chatId: ChatId): number; bump(chatId: ChatId, reason?: string): number}
  meta: {get(key: string, fallback?: any): any; set(key: string, value: any): any}
  [repository: string]: any
}
/** 只传提供方实际用量/本地计数；不放正文、密钥或完整响应。未知数值用 null。 */
export interface UsageTokens {
  inputTokens?: number | null; input_tokens?: number | null; prompt_tokens?: number | null
  outputTokens?: number | null; output_tokens?: number | null; completion_tokens?: number | null
  cachedTokens?: number | null; cacheReadTokens?: number | null; cache_read_input_tokens?: number | null
}
export interface UsageRecord {
  /** 同一次调用的稳定 ID 幂等；再次传入不更新旧凭据。 */ id?: string
  account?: string; chatId?: ChatId; requestId?: string; requestIds?: string[]
  context?: {account?: string; chatId?: ChatId; chat?: ChatId; requestId?: string; role?: string}
  service?: string; model?: string | null; role?: string | null; status?: string; billing?: string
  startedAt?: number; durationMs?: number | null; tokens?: UsageTokens; usage?: UsageTokens
  inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null
  inputCount?: number | null; inputChars?: number | null; credits?: number | null
  /** 不从 tokens 或 charged 推算金额，不跨币种相加。 */ amount?: number | null; currency?: string | null
}
export interface UsageItem {
  id: string; chatId: string | null; requestId: string | null; service: string; status: string; billing: string
  startedAt: number; durationMs: number | null
  /** 任务尝试回退行可能缺省这些字段，仍代表未知。 */
  model?: string | null; role?: string | null; inputTokens?: number | null; outputTokens?: number | null
  cachedTokens?: number | null; inputCount?: number | null; inputChars?: number | null
  credits?: number | null; amount?: number | null; currency?: string | null
}
export interface UsageReport {
  totals: Array<{service: string; calls: number; unknownAmountCalls: number; inputTokens?: number | null; outputTokens?: number | null; cachedTokens?: number | null; credits?: number | null}>
  amounts: Array<{currency: string; amount: number}>
  items: UsageItem[]; note: string
}
export interface UsageLedger {
  /** 请求来源账号核验失败时返回 undefined；它不代替授权、额度预留或提交账本。 */
  record(input?: UsageRecord): string | undefined
  /** 当前账号；limit 默认 50、整数 1..200。共享调用不按关联请求重复计入总账。 */
  report(options?: {requestId?: string; chatId?: ChatId; limit?: number}): UsageReport
}
export interface Api {
  id: string; source: 'builtin' | 'user'; dir: string; apiVersion: number; version: string
  /** 停用/热重载触发；不能撤销已发生的外部操作。 */ readonly signal: AbortSignal
  log: Logger
  config(): any; setConfig(patch: any | ((cfg: any) => any)): any
  settings(): Record<string, any>; saveSettings(patch: Record<string, any>): Record<string, any>
  dataDir(...parts: string[]): string
  send(chatId: ChatId | string, text: string): Promise<any>
  sendText(chatId: ChatId | string, text: string): Promise<any>
  reply(msg: Message, text: string): Promise<any>
  sendImage(chatId: ChatId | string, src: string): Promise<any>
  sendSegments(chatId: ChatId | string, segments: Segment[], note?: string): Promise<any>
  sendFile(chatId: ChatId | string, file: string, name?: string): Promise<any>
  sendVoiceFile(chatId: ChatId | string, file: string, note?: string): Promise<any>
  onebot(action: string, params?: any, options?: {timeoutMs?: number}): Promise<any>
  isOwner(userId: string | number): boolean
  ask(options: string | {system?: string; text: string; maxTokens?: number}): Promise<string>
  think(prompt: string, options?: {title?: string; timeoutMs?: number}): Promise<string>
  on<K extends keyof Events>(event: K, fn: Events[K], options?: HookOptions): Off
  emit(event: string, ...args: any[]): void
  tool(builder: Tool | Tool[] | ((where: Where) => Tool | Tool[] | null | undefined)): Off
  defineTool(spec: ToolSpec): Tool
  context(fn: (args: ContextArgs) => string | void): Off
  prepareContext(fn: (args: PrepareContextArgs) => MaybePromise<unknown>, options?: HookOptions): Off
  rule(fn: string | ((kind: 'private' | 'social', cfg: any) => string | string[] | void)): Off
  command(command: Command): Off
  every(ms: number, fn: () => any, label?: string): Off
  later(ms: number, fn: () => any): Off
  route(path: string, handler: (req: any, res: any) => any): Off
  /** 返回登记的清理函数，不是取消登记函数。 */
  onDispose<T extends () => MaybePromise<any>>(fn: T): T
  dshTool(tool: any): Off
  use(id: 'memory'): MemoryApi | null
  use(id: 'mood'): MoodApi | null
  use(id: 'learning'): LearningApi | null
  use(id: 'retrieval'): RetrievalApi | null
  use(id: 'tasks'): TaskApi | null
  use(id: 'stickers'): StickerApi | null
  use<T = any>(id: string): T | null
  lazy<T = any>(id: string): Partial<T>
  has(id: string): boolean
  core: {
    storage: StorageApi; usage: UsageLedger; hub: any; planner?: any; jobRunners?: Map<string, any>
    onebot: {call(action: string, params?: any, opts?: any): Promise<any>; state: string}
    snowluma: any; local: any; groupRoles: any; personas: any; modules: any; logger: any; root: string
    mutes: {muted(chatId: string): boolean; set(chatId: string, minutes: number): void; clear(chatId: string): void}
    ask(opts: any): Promise<string>
    listModels(): Promise<{provider: string; model: string; name: string}[]>
    defaultModel(): ModelSelection | null
    http: {body(req: any): Promise<any>; raw(req: any, max: number): Promise<Uint8Array>; query(req: any): Record<string, string>; send(res: any, code: number, body: any, type?: string): void}
    getConfig(): any; setConfig(cfg: any): any
    [key: string]: any
  }
  dsh: any
  lib(path: string): any
}
export interface Setting {
  key: string; label?: string; type?: 'text' | 'number' | 'switch' | 'select' | 'textarea' | 'password'
  hint?: string; placeholder?: string; min?: number; max?: number; step?: number
  options?: (string | {value: any; label: string})[]
}
export interface AurabotModule {
  /** 保留原模块 ID 才是替换；改 ID 会并存。 */ id: string
  name?: string; version?: string
  /** 新模块用 2；当前仍接受 1，但不恢复旧的不安全业务接口。 */ api?: 1 | 2
  description?: string; defaults?: Record<string, any>; settings?: Setting[]
  panel?: string | boolean; tab?: string
  /** fork 使用的相对 src/ 精确文件清单；不接受目录/glob。 */ files?: string[]
  setup(api: Api): any
}
