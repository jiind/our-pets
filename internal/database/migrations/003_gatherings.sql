-- 실시간 제안과 수락한 참여자만 현재 모임 상태로 관리한다.
CREATE TABLE IF NOT EXISTS gatherings (
 id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 host_pet_id TEXT NOT NULL REFERENCES pets(id), kind TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gathering_members (
 gathering_id TEXT NOT NULL REFERENCES gatherings(id) ON DELETE CASCADE,
 pet_id TEXT NOT NULL REFERENCES pets(id), accepted_at INTEGER NOT NULL,
 PRIMARY KEY(gathering_id,pet_id)
);
CREATE INDEX IF NOT EXISTS gathering_hosts ON gatherings(host_pet_id,status);
INSERT OR IGNORE INTO schema_versions VALUES(3);
