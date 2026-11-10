-- 메시지와 모집의 식별자를 분리하고 기존 모임과 참여자를 외래 키를 켠 상태로 보존한다.
CREATE TABLE gatherings_v4 (
 id TEXT PRIMARY KEY,
 host_pet_id TEXT NOT NULL REFERENCES pets(id), kind TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'message' CHECK(origin IN ('message','recruitment')),
 message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 CHECK((origin='message' AND message_id IS NOT NULL) OR (origin='recruitment' AND message_id IS NULL AND kind IN ('coffee','smoke','meal') AND expires_at=0))
);
CREATE TABLE gathering_members_v4 (
 gathering_id TEXT NOT NULL REFERENCES gatherings_v4(id) ON DELETE CASCADE,
 pet_id TEXT NOT NULL REFERENCES pets(id), accepted_at INTEGER NOT NULL,
 PRIMARY KEY(gathering_id,pet_id)
);
INSERT INTO gatherings_v4(id,host_pet_id,kind,origin,message_id,status,created_at,expires_at)
 SELECT id,host_pet_id,kind,'message',id,status,created_at,expires_at FROM gatherings;
INSERT INTO gathering_members_v4 SELECT gathering_id,pet_id,accepted_at FROM gathering_members;
DROP TABLE gathering_members;
DROP TABLE gatherings;
ALTER TABLE gatherings_v4 RENAME TO gatherings;
ALTER TABLE gathering_members_v4 RENAME TO gathering_members;
CREATE INDEX gathering_hosts ON gatherings(host_pet_id,status);
CREATE UNIQUE INDEX gathering_open_recruitments ON gatherings(host_pet_id) WHERE origin='recruitment' AND status='open';
CREATE INDEX gathering_members_pet ON gathering_members(pet_id,gathering_id);
CREATE TABLE gathering_requests (
 host_pet_id TEXT NOT NULL REFERENCES pets(id), idempotency_key TEXT NOT NULL,
 gathering_id TEXT NOT NULL REFERENCES gatherings(id),
 PRIMARY KEY(host_pet_id,idempotency_key)
);
INSERT OR IGNORE INTO schema_versions VALUES(4);
