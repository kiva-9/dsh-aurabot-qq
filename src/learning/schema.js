import { ensureRuntime } from './runtime.js'

// 模块自有表，避免与主线程的 storage migrations 或 memory 迁移互相覆盖。
export function ensureSchema(db) {
  ensureRuntime(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wp6_learning_records(
      id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,persona_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('expression','jargon')),item_key TEXT NOT NULL,data_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','disabled','deleted')),
      manual_lock INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL DEFAULT 0,uses INTEGER NOT NULL DEFAULT 0,invalid_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(scope_key,kind,item_key));
    CREATE INDEX IF NOT EXISTS wp6_learning_scope ON wp6_learning_records(scope_key,kind,status);
    CREATE INDEX IF NOT EXISTS wp6_learning_read ON wp6_learning_records(account_id,kind,status,chat_id,persona_id);
    CREATE TABLE IF NOT EXISTS wp6_learning_evidence(
      record_id TEXT NOT NULL REFERENCES wp6_learning_records(id) ON DELETE CASCADE,message_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      author_id TEXT NOT NULL,spam_key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(record_id,message_id));
    CREATE INDEX IF NOT EXISTS wp6_learning_source ON wp6_learning_evidence(message_id);
    CREATE TABLE IF NOT EXISTS wp6_learning_audit(
      id INTEGER PRIMARY KEY,record_id TEXT NOT NULL,scope_key TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,
      revision INTEGER NOT NULL,at INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS wp6_learning_versions(
      record_id TEXT NOT NULL REFERENCES wp6_learning_records(id) ON DELETE CASCADE,revision INTEGER NOT NULL,snapshot_json TEXT NOT NULL,
      PRIMARY KEY(record_id,revision));
    CREATE TABLE IF NOT EXISTS wp6_learning_checkpoints(
      scope_key TEXT NOT NULL,account_id TEXT NOT NULL,chat_id TEXT NOT NULL,persona_id TEXT NOT NULL,kind TEXT NOT NULL,
      scan_seq INTEGER NOT NULL DEFAULT 0,processed_seq INTEGER NOT NULL DEFAULT 0,overflow_from INTEGER,overflow_to INTEGER,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,last_attempt_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT 'idle',last_error TEXT NOT NULL DEFAULT '',lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope_key,kind));
    CREATE TABLE IF NOT EXISTS wp6_learning_queue(
      scope_key TEXT NOT NULL,kind TEXT NOT NULL,message_id TEXT NOT NULL,recv_seq INTEGER NOT NULL,spam_key TEXT NOT NULL,
      PRIMARY KEY(scope_key,kind,message_id),UNIQUE(scope_key,kind,spam_key));
    CREATE INDEX IF NOT EXISTS wp6_learning_queue_order ON wp6_learning_queue(scope_key,kind,recv_seq);
    CREATE TABLE IF NOT EXISTS wp6_learning_seen(
      scope_key TEXT NOT NULL,kind TEXT NOT NULL,spam_key TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope_key,kind,spam_key));
    CREATE TABLE IF NOT EXISTS wp6_learning_uses(
      record_id TEXT NOT NULL REFERENCES wp6_learning_records(id) ON DELETE CASCADE,request_id TEXT NOT NULL,at INTEGER NOT NULL,
      PRIMARY KEY(record_id,request_id));
    CREATE TABLE IF NOT EXISTS wp6_learning_shared_usage(
      record_id TEXT NOT NULL REFERENCES wp6_learning_records(id) ON DELETE CASCADE,viewer_scope TEXT NOT NULL,
      last_used_at INTEGER NOT NULL,uses INTEGER NOT NULL,PRIMARY KEY(record_id,viewer_scope));
  `)
}
