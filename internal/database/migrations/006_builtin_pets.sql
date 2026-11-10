-- 사용자 이미지 참조와 독립적으로 기본 캐릭터 선택을 보존한다.
ALTER TABLE pets ADD COLUMN builtin_id TEXT NOT NULL DEFAULT 'cat';
INSERT INTO schema_versions VALUES(6);
