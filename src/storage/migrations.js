// 数据库结构迁移。版本号记在 PRAGMA user_version；每一步在一个事务里做完才推进版本。
// 库的版本比程序认识的新（用户装回了旧版插件）时拒绝打开，不能拿旧代码去读新结构。
// 以后改结构只能往 MIGRATIONS 末尾追加新的一步，已经发布的步骤不要改。

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

export const MIGRATIONS = [
  {
    version: 1,
    name: '核心：聊天、消息、资产、请求、会话代次',
    up: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE sequences (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,                -- private:QQ号 / group:群号 / system:名字
        account_id TEXT NOT NULL,           -- 机器人 QQ 号
        kind TEXT NOT NULL CHECK (kind IN ('private', 'group', 'system')),
        platform_id TEXT NOT NULL,          -- 对方 QQ 号或群号
        title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL REFERENCES chats(id),
        event_kind TEXT NOT NULL,           -- message / poke / self（她自己发的）
        platform_msg_id TEXT,               -- QQ 消息 ID；拿不到时为空
        dedupe_key TEXT UNIQUE,             -- 只有来源 ID 可靠时才有，用来挡住重放的事件
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL DEFAULT '',
        platform_time INTEGER,              -- 平台给的时间（毫秒），只当内容证据，不拿来计时
        received_at INTEGER NOT NULL,       -- 本机收到的时间
        recv_seq INTEGER NOT NULL UNIQUE,   -- 本机单调递增的接收序号
        text TEXT NOT NULL DEFAULT '',
        segments_json TEXT NOT NULL DEFAULT '[]',
        reply_to TEXT,                      -- 引用的 QQ 消息 ID
        forwards_json TEXT NOT NULL DEFAULT '[]',
        mentioned INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT NOT NULL,
        recalled_at INTEGER
      );
      CREATE INDEX messages_chat_seq ON messages(chat_id, recv_seq);
      CREATE INDEX messages_platform ON messages(chat_id, platform_msg_id);
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        path TEXT NOT NULL,                 -- 数据目录下的相对路径
        source_kind TEXT NOT NULL,          -- inbound / generated / upload / legacy
        state TEXT NOT NULL DEFAULT 'stored' CHECK (state IN ('stored', 'unavailable', 'deleted')),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE asset_occurrences (
        id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id),
        chat_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        seg_index INTEGER NOT NULL,         -- 在原消息里是第几段
        kind TEXT NOT NULL,                 -- image / sticker / record / video / file / generated
        asset_id TEXT REFERENCES assets(id),
        remote_json TEXT NOT NULL DEFAULT '{}', -- 下载用的原始段数据（url、file）
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready', 'failed', 'unavailable')),
        error TEXT,
        scope_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (message_id, seg_index)
      );
      CREATE INDEX occurrences_asset ON asset_occurrences(asset_id);
      CREATE INDEX occurrences_chat ON asset_occurrences(chat_id, created_at);
      CREATE TABLE chat_epochs (
        chat_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id),
        actor_id TEXT NOT NULL,             -- 提出请求的人（由接收层确定，模型不能改）
        source_message_ids_json TEXT NOT NULL,
        reply_target TEXT,
        policy_revision INTEGER NOT NULL DEFAULT 0,
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        trace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX requests_chat ON requests(chat_id, created_at);
      CREATE TABLE legacy_migrations (
        step TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        report_json TEXT NOT NULL DEFAULT '{}',
        error TEXT
      );
    `,
  },
  {
    version: 2,
    name: '发送记录（outbox）：每一段单独记状态和 QQ 回执',
    up: `
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,             -- 同一次回复的几段
        seq INTEGER NOT NULL,               -- 段在这次回复里的顺序
        chat_id TEXT NOT NULL,
        request_id TEXT,
        epoch INTEGER NOT NULL,             -- 生成时的会话代次；代次变了就不发
        kind TEXT NOT NULL,                 -- text / voice / sticker / image / poke / other
        payload_json TEXT NOT NULL,         -- { message: OneBot 消息段, note, delayMs }
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'delivered', 'failed', 'unknown', 'canceled', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        platform_msg_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (batch_id, seq)
      );
      CREATE INDEX outbox_state ON outbox(state, created_at);
      CREATE INDEX outbox_chat ON outbox(chat_id, created_at);
    `,
  },
  {
    version: 3,
    name: '出现记录的识别结果（语音转写等）',
    up: `
      ALTER TABLE asset_occurrences ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 4,
    name: '人设：卡片、不可变的发布版本、草稿、绑定、删除记录',
    up: `
      CREATE TABLE personas (
        id TEXT PRIMARY KEY,                -- 稳定 ID，只能是字母数字 - _（不合法直接拒绝，不删字符凑别名）
        name TEXT NOT NULL,
        origin TEXT NOT NULL,               -- builtin / user / legacy / import
        current_revision INTEGER,           -- 当前发布版本（没发布过为空）
        draft_json TEXT,                    -- 草稿（没有未发布的改动时为空）
        draft_base INTEGER,                 -- 草稿是从哪个版本改的
        edit_revision INTEGER NOT NULL DEFAULT 1, -- 每次保存 +1；保存时带旧值，对不上就拒绝（防止覆盖别人的改动）
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE persona_revisions (
        persona_id TEXT NOT NULL REFERENCES personas(id),
        revision INTEGER NOT NULL,
        layers_json TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (persona_id, revision)
      );
      CREATE TABLE persona_bindings (
        scope TEXT PRIMARY KEY,             -- chat:group:123 / chat:private:456 / kind:group / kind:private / global
        persona_id TEXT NOT NULL REFERENCES personas(id),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE persona_tombstones (
        id TEXT PRIMARY KEY,                -- 用户删掉的卡（内置卡不会因此再被自动导入）
        deleted_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 5,
    name: '可恢复任务：任务、每次外部尝试、生成血缘、额度预留',
    up: `
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,                 -- image / ……
        chat_id TEXT NOT NULL,
        request_id TEXT,
        actor_id TEXT NOT NULL,             -- 谁要的（取消、额度都按这个人）
        epoch INTEGER NOT NULL,
        state TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL DEFAULT '{}',
        parent_job_id TEXT,
        profile_id TEXT,
        lease_owner TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        not_before INTEGER NOT NULL DEFAULT 0,
        provider_task_id TEXT,
        error_kind TEXT,
        error TEXT,
        trace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX jobs_state ON jobs(state, not_before);
      CREATE INDEX jobs_chat ON jobs(chat_id, created_at);
      CREATE INDEX jobs_actor ON jobs(chat_id, actor_id, created_at);
      CREATE TABLE job_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        n INTEGER NOT NULL,
        provider_task_id TEXT,
        billing TEXT NOT NULL DEFAULT 'unknown', -- charged / free / unknown / none（确定没执行）
        state TEXT NOT NULL,                -- running / done / failed / unknown / canceled
        error_kind TEXT,
        error TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX job_attempts_job ON job_attempts(job_id, n);
      CREATE TABLE generation_lineage (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id),
        parent_job_id TEXT,
        inputs_json TEXT NOT NULL,          -- [{ assetId, role, occurrenceId, sourceMessageId, selectionReason }]
        outputs_json TEXT NOT NULL,         -- [assetId]
        intent TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE quota_reservations (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        scope TEXT NOT NULL,                -- user:QQ号 / chat:聊天
        day TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'used', 'released')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX quota_scope ON quota_reservations(scope, day, state);
    `,
  },
]

MIGRATIONS.push({
  version: 6,
  name: '生图任务冻结服务配置，重试和查进度沿用提交时的配置',
  up: `CREATE TABLE image_job_configs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id),
    profile_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
})

MIGRATIONS.push({
  version: 7,
  name: '请求诊断与可回放决策记录',
  up: `CREATE TABLE diagnostic_events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    trace_id TEXT, request_id TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, payload_json TEXT NOT NULL
  );
  CREATE INDEX diagnostic_trace ON diagnostic_events(account_id,trace_id,at);
  CREATE INDEX diagnostic_chat ON diagnostic_events(account_id,chat_id,at);`,
})

export const LATEST_VERSION = MIGRATIONS.at(-1).version

export function schemaVersion(db) {
  return Number(db.get('PRAGMA user_version').user_version) || 0
}

/**
 * 把库升到最新版本。已有数据的库升级前先在旁边做一份备份（VACUUM INTO），返回 { from, to, backup }。
 */
export function migrate(db, { log, backupDir, migrations = MIGRATIONS } = {}) {
  const latest = migrations.at(-1).version
  const from = schemaVersion(db)
  if (from > latest) {
    throw Object.assign(new Error(`数据库版本 ${from} 比这个插件认识的 ${latest} 新：可能装回了旧版插件。请换回新版，或从升级前的备份恢复。`), { code: 'DB_TOO_NEW' })
  }
  const pending = migrations.filter((m) => m.version > from)
  if (!pending.length) return { from, to: from, backup: '' }
  let backup = ''
  if (from > 0 && db.file !== ':memory:') {
    const dir = backupDir || join(dirname(db.file), 'backups')
    mkdirSync(dir, { recursive: true })
    backup = join(dir, `${basename(db.file, '.db')}-v${from}-${Date.now()}.db`)
    if (!existsSync(backup)) db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
    log?.info?.(`数据库从 v${from} 升级前做了备份：${backup}`)
  }
  for (const m of pending) {
    db.tx(() => {
      db.exec(m.up)
      db.exec(`PRAGMA user_version = ${m.version}`)
    })
    log?.info?.(`数据库升级到 v${m.version}：${m.name}`)
  }
  return { from, to: latest, backup }
}
