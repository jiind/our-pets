-- 수다·산책 모집을 허용하고 기존 모집·참여자·멱등 요청의 식별자와 관계를 보존한다.
CREATE TABLE gatherings_v5 (
 id TEXT PRIMARY KEY,
 host_pet_id TEXT NOT NULL REFERENCES pets(id), kind TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'message' CHECK(origin IN ('message','recruitment')),
 message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 CHECK((origin='message' AND message_id IS NOT NULL) OR (origin='recruitment' AND message_id IS NULL AND kind IN ('coffee','smoke','meal','chat','walk') AND expires_at=0))
);
CREATE TABLE gathering_members_v5 (
 gathering_id TEXT NOT NULL REFERENCES gatherings_v5(id) ON DELETE CASCADE,
 pet_id TEXT NOT NULL REFERENCES pets(id), accepted_at INTEGER NOT NULL,
 PRIMARY KEY(gathering_id,pet_id)
);
CREATE TABLE gathering_requests_v5 (
 host_pet_id TEXT NOT NULL REFERENCES pets(id), idempotency_key TEXT NOT NULL,
 gathering_id TEXT NOT NULL REFERENCES gatherings_v5(id),
 PRIMARY KEY(host_pet_id,idempotency_key)
);
INSERT INTO gatherings_v5 SELECT id,host_pet_id,kind,origin,message_id,status,created_at,expires_at FROM gatherings;
INSERT INTO gathering_members_v5 SELECT gathering_id,pet_id,accepted_at FROM gathering_members;
INSERT INTO gathering_requests_v5 SELECT host_pet_id,idempotency_key,gathering_id FROM gathering_requests;
DROP TABLE gathering_requests;
DROP TABLE gathering_members;
DROP TABLE gatherings;
ALTER TABLE gatherings_v5 RENAME TO gatherings;
ALTER TABLE gathering_members_v5 RENAME TO gathering_members;
ALTER TABLE gathering_requests_v5 RENAME TO gathering_requests;
CREATE INDEX gathering_hosts ON gatherings(host_pet_id,status);
CREATE UNIQUE INDEX gathering_open_recruitments ON gatherings(host_pet_id) WHERE origin='recruitment' AND status='open';
CREATE INDEX gathering_members_pet ON gathering_members(pet_id,gathering_id);
INSERT OR IGNORE INTO schema_versions VALUES(5);
