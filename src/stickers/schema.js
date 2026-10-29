// 领域内初始化，不推进主库 user_version；可由主迁移调用同一份 SQL。
export const STICKER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sticker_items (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL,
    sha256 TEXT NOT NULL, md5 TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','disabled','deleted')),
    revision INTEGER NOT NULL, body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(account,chat,sha256)
  );
  CREATE INDEX IF NOT EXISTS sticker_scope ON sticker_items(account,chat,state);
  CREATE INDEX IF NOT EXISTS sticker_md5 ON sticker_items(account,md5);
  CREATE INDEX IF NOT EXISTS sticker_account_hash ON sticker_items(account,sha256);
  CREATE TABLE IF NOT EXISTS sticker_quota (
    item_id TEXT PRIMARY KEY REFERENCES sticker_items(id), account TEXT NOT NULL, reserved_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sticker_quota_hour ON sticker_quota(account,reserved_at);
  CREATE TABLE IF NOT EXISTS sticker_sources (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, source_key TEXT NOT NULL,
    item_id TEXT REFERENCES sticker_items(id), body_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(account,chat,source_key)
  );
  CREATE TABLE IF NOT EXISTS sticker_tasks (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, kind TEXT NOT NULL,
    task_key TEXT NOT NULL, item_id TEXT REFERENCES sticker_items(id),
    state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','unknown','canceled')),
    attempts INTEGER NOT NULL DEFAULT 0, owner_json TEXT, input_json TEXT NOT NULL,
    output_json TEXT, error TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(account,chat,kind,task_key)
  );
  CREATE INDEX IF NOT EXISTS sticker_tasks_ready ON sticker_tasks(account,state,created_at);
  CREATE TABLE IF NOT EXISTS sticker_qq (
    account TEXT NOT NULL, sha256 TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY(account,sha256)
  );
  CREATE TABLE IF NOT EXISTS sticker_uses (
    account TEXT NOT NULL, chat TEXT NOT NULL, sha256 TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL,
    PRIMARY KEY(account,chat,sha256)
  );
  CREATE TABLE IF NOT EXISTS sticker_legacy (
    id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
`

export function ensureStickerSchema(storage) {
  if (!storage?.db?.tx || !storage?.assets) throw new Error('表情库需要 api.core.storage')
  storage.db.tx(() => storage.db.exec(STICKER_SCHEMA))
}
