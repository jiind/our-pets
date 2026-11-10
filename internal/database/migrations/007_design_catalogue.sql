-- 선택 목록에서 제거한 외형도 기존 메시지·타 사용자 참조를 위해 보존한다.
CREATE TABLE design_retirements (
 design_id TEXT PRIMARY KEY REFERENCES designs(id), created_at INTEGER NOT NULL
);
INSERT INTO schema_versions VALUES(7);
