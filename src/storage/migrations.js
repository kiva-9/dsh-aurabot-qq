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
]

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
