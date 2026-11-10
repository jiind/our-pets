-- 답장의 원본 관계를 보존하며 보관 기간이 지난 원본 삭제는 새 답장을 삭제하지 않는다.
ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to_message_id);
INSERT INTO schema_versions VALUES(2);
