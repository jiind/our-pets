-- 최초 스키마: 펫 식별자와 디자인·기기·전달 상태를 독립적으로 보관한다.
CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
 password_hash BLOB NOT NULL, salt BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 UNIQUE(id,user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
 device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS designs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), version INTEGER NOT NULL,
 name TEXT NOT NULL, image_hash TEXT NOT NULL, manifest TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(owner_id,version)
);
CREATE TABLE IF NOT EXISTS pets (
 id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 design_id TEXT REFERENCES designs(id), active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, sender_pet_id TEXT NOT NULL REFERENCES pets(id), kind TEXT NOT NULL,
 body TEXT NOT NULL, mode TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 sender_snapshot TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(sender_pet_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS message_recipients (
 message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 pet_id TEXT NOT NULL REFERENCES pets(id), received_at INTEGER,
 PRIMARY KEY(message_id,pet_id)
);
CREATE TABLE IF NOT EXISTS connector_connections (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, schema_version INTEGER NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id), config TEXT NOT NULL, credential_ref TEXT,
 state TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notification_subscriptions (
 connection_id TEXT NOT NULL REFERENCES connector_connections(id), pet_id TEXT NOT NULL REFERENCES pets(id),
 PRIMARY KEY(connection_id,pet_id)
);
CREATE TABLE IF NOT EXISTS external_notifications (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connector_connections(id),
 event_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 UNIQUE(connection_id,event_id)
);
CREATE TABLE IF NOT EXISTS notification_recipients (
 notification_id TEXT NOT NULL REFERENCES external_notifications(id) ON DELETE CASCADE,
 pet_id TEXT NOT NULL REFERENCES pets(id), received_at INTEGER,
 PRIMARY KEY(notification_id,pet_id)
);
CREATE TABLE IF NOT EXISTS device_receipts (
 event_id TEXT NOT NULL, device_id TEXT NOT NULL REFERENCES devices(id),
 received_at INTEGER NOT NULL, PRIMARY KEY(event_id,device_id)
);
CREATE INDEX IF NOT EXISTS message_pending ON message_recipients(pet_id,received_at);
CREATE INDEX IF NOT EXISTS notification_pending ON notification_recipients(pet_id,received_at);
INSERT OR IGNORE INTO schema_versions VALUES(1);
