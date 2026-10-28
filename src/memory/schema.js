// Domain-local schema: deliberately does not change the host's PRAGMA user_version.
// Integrate this initializer into the main migration registry when the host is ready.
export function ensureSchema(storage) {
  const db = storage?.db
  if (!db?.tx || !db?.exec) throw new Error('memory requires api.core.storage')
  db.tx(() => db.exec(`
    CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, persona TEXT NOT NULL,
      category TEXT NOT NULL, body TEXT NOT NULL, revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','conflicted','superseded','retracted','quarantined','deleted')),
      fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_facts_scope ON memory_facts(account,chat,persona,status);
    CREATE INDEX IF NOT EXISTS memory_facts_account_id ON memory_facts(account,id);
    CREATE INDEX IF NOT EXISTS memory_facts_fingerprint ON memory_facts(account,chat,persona,fingerprint);
    CREATE INDEX IF NOT EXISTS memory_facts_page ON memory_facts(account,chat,category,persona,status,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS memory_facts_subject_page ON memory_facts(account,chat,json_extract(body,'$.subject'),category,persona,status,created_at DESC,id);
    CREATE INDEX IF NOT EXISTS memory_facts_subject_updated ON memory_facts(account,chat,json_extract(body,'$.subject'),category,persona,status,updated_at DESC,id);
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, persona TEXT NOT NULL,
      message_id TEXT, body TEXT NOT NULL, revision INTEGER NOT NULL, deleted_at INTEGER,
      UNIQUE(account,chat,persona,message_id)
    );
    CREATE TABLE IF NOT EXISTS memory_fact_evidence (
      fact_id TEXT NOT NULL REFERENCES memory_facts(id), evidence_id TEXT NOT NULL REFERENCES memory_evidence(id),
      PRIMARY KEY(fact_id,evidence_id)
    );
    CREATE INDEX IF NOT EXISTS memory_evidence_facts ON memory_fact_evidence(evidence_id);
    CREATE TABLE IF NOT EXISTS memory_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, fact_id TEXT NOT NULL, account TEXT NOT NULL,
      chat TEXT NOT NULL, persona TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_tombstones (
      kind TEXT NOT NULL, key TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL,
      persona TEXT NOT NULL, deleted_at INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(kind,key,account,chat,persona)
    );
    CREATE TABLE IF NOT EXISTS memory_scope_revisions (
      scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memory_revision_origin ON memory_scope_revisions(json_extract(scope_key,'$.account'),json_extract(scope_key,'$.chat'));
    CREATE TRIGGER IF NOT EXISTS memory_message_update AFTER UPDATE ON messages BEGIN
      UPDATE memory_scope_revisions SET revision=revision+1
      WHERE (json_extract(scope_key,'$.account')=OLD.account_id AND json_extract(scope_key,'$.chat')=OLD.chat_id)
         OR (json_extract(scope_key,'$.account')=NEW.account_id AND json_extract(scope_key,'$.chat')=NEW.chat_id);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_message_delete AFTER DELETE ON messages BEGIN
      UPDATE memory_scope_revisions SET revision=revision+1
      WHERE json_extract(scope_key,'$.account')=OLD.account_id AND json_extract(scope_key,'$.chat')=OLD.chat_id;
    END;
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      scope_key TEXT PRIMARY KEY, scope TEXT NOT NULL, recv_seq INTEGER NOT NULL DEFAULT 0,
      watermark INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER,
      state TEXT NOT NULL DEFAULT 'pending', lease_token TEXT, lease_until INTEGER,
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope TEXT NOT NULL,
      from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_profiles (
      scope_key TEXT NOT NULL, subject TEXT NOT NULL, fingerprint TEXT NOT NULL,
      body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope_key,subject)
    );
    CREATE TABLE IF NOT EXISTS memory_overrides (
      scope_key TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
      revision INTEGER NOT NULL, PRIMARY KEY(scope_key,subject)
    );
    CREATE TABLE IF NOT EXISTS memory_quarantine (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, chat TEXT NOT NULL, persona TEXT NOT NULL,
      source_key TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'quarantined', approved_fact_id TEXT,
      UNIQUE(account,chat,persona,source_key)
    );
  `))
  return { domain: 'memory', version: 1 }
}
