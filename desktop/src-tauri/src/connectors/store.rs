use super::types::{now_ms, LocalEvent, Notification, Source, SourceConfig};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    db: Mutex<Connection>,
    started_at: i64,
    pub directory: PathBuf,
}

// 로컬 저장소 오류에서 SQL·경로·개인 정보를 노출하지 않는다.
fn storage_error(_: impl std::fmt::Display) -> String {
    "이 PC의 알림 저장소를 사용할 수 없습니다".into()
}

impl Store {
    // PC별 연결·미전달 이벤트·복구 지점을 비공개 로컬 DB에 준비한다.
    pub fn open(directory: &Path) -> Result<Self, String> {
        // 1. 운영체제 사용자 전용 저장 경로와 DB를 만든다.
        std::fs::create_dir_all(directory).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
                .map_err(storage_error)?;
        }
        let path = directory.join("local-notifications.sqlite3");
        let db = Connection::open(&path).map_err(storage_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(storage_error)?;
        }

        // 2. 기존 데이터에 멱등적으로 로컬 스키마를 적용한다.
        db.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(storage_error)?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS local_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,config TEXT NOT NULL,enabled INTEGER NOT NULL,state TEXT NOT NULL,last_error TEXT NOT NULL DEFAULT '',credential_fingerprint TEXT UNIQUE,cursor TEXT);
          CREATE TABLE IF NOT EXISTS local_events(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES local_sources(id) ON DELETE CASCADE,event_key TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,received_at INTEGER,UNIQUE(source_id,event_key));
          CREATE INDEX IF NOT EXISTS local_pending ON local_events(received_at,expires_at);
          CREATE INDEX IF NOT EXISTS local_event_retention ON local_events(created_at);
          CREATE TABLE IF NOT EXISTS local_event_keys(source_id TEXT NOT NULL REFERENCES local_sources(id) ON DELETE CASCADE,event_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(source_id,event_key));
          DELETE FROM local_events;
          PRAGMA user_version=2;").map_err(storage_error)?;
        Ok(Self {
            db: Mutex::new(db),
            started_at: now_ms(),
            directory: directory.to_path_buf(),
        })
    }

    // 비밀값이 없는 로컬 연결 설정과 정제된 상태를 조회한다.
    pub fn sources(&self) -> Result<Vec<Source>, String> {
        let db = self.db.lock().map_err(storage_error)?;
        let mut query = db.prepare("SELECT id,name,config,enabled,state,last_error,cursor FROM local_sources ORDER BY name,id").map_err(storage_error)?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(storage_error)?;
        let mut result = Vec::new();
        for row in rows {
            let (id, name, raw, enabled, state, last_error, cursor) = row.map_err(storage_error)?;
            let config: SourceConfig = serde_json::from_str(&raw).map_err(storage_error)?;
            let kind = config.kind();
            let usage: Option<super::types::CodexUsage> = if ["codex", "claude"].contains(&kind) {
                cursor
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|state| state.get("usage").cloned())
                    .and_then(|usage| serde_json::from_value(usage).ok())
            } else {
                None
            };
            result.push(Source {
                id,
                name,
                config,
                enabled,
                state,
                last_error,
                codex_usage: if kind == "codex" { usage.clone() } else { None },
                claude_usage: if kind == "claude" { usage } else { None },
            });
        }
        Ok(result)
    }

    // 같은 Slack 앱 토큰이 여러 로컬 수집 연결로 분산되는 것을 방지한다.
    pub fn duplicate_secret(&self, id: &str, fingerprint: &str) -> Result<bool, String> {
        self.db.lock().map_err(storage_error)?.query_row("SELECT EXISTS(SELECT 1 FROM local_sources WHERE credential_fingerprint=? AND id<>?)",params![fingerprint,id],|r| r.get(0)).map_err(storage_error)
    }

    // 비밀값 원문을 제외한 연결 설정과 토큰 지문을 저장한다.
    pub fn save(
        &self,
        id: &str,
        name: &str,
        config: &SourceConfig,
        fingerprint: Option<&str>,
    ) -> Result<(), String> {
        let raw = serde_json::to_string(config).map_err(storage_error)?;
        self.db.lock().map_err(storage_error)?.execute("INSERT INTO local_sources(id,name,config,enabled,state,credential_fingerprint) VALUES(?,?,?,1,'connecting',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,enabled=1,state='connecting',last_error='',credential_fingerprint=COALESCE(excluded.credential_fingerprint,local_sources.credential_fingerprint)",params![id,name,raw,fingerprint]).map_err(storage_error)?;
        Ok(())
    }

    // 수집기 시작·중지 설정을 앱 재시작 뒤에도 유지한다.
    pub fn enable(&self, id: &str, enabled: bool) -> Result<(), String> {
        let count = self
            .db
            .lock()
            .map_err(storage_error)?
            .execute(
                "UPDATE local_sources SET enabled=?,state=?,last_error='' WHERE id=?",
                params![enabled, if enabled { "connecting" } else { "disabled" }, id],
            )
            .map_err(storage_error)?;
        if count != 1 {
            return Err("로컬 연결을 찾을 수 없습니다".into());
        }
        Ok(())
    }

    // 사용자가 삭제한 연결의 설정·알림·복구 지점을 제거한다.
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .execute("DELETE FROM local_sources WHERE id=?", [id])
            .map_err(storage_error)?;
        Ok(())
    }

    // 원본 네트워크 오류 대신 공급자와 정제된 연결 상태만 보관한다.
    pub fn status(&self, id: &str, state: &str, error: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .execute(
                "UPDATE local_sources SET state=?,last_error=? WHERE id=?",
                params![state, error, id],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    // 연결의 마지막 수신 지점 또는 Codex 알림 판단 상태를 읽는다.
    pub fn cursor(&self, id: &str) -> Result<Option<String>, String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .query_row("SELECT cursor FROM local_sources WHERE id=?", [id], |r| {
                r.get(0)
            })
            .map_err(storage_error)
    }

    // 아직 이벤트가 없는 최초 연결도 복구 시작 시점을 보관한다.
    #[cfg(test)]
    pub fn seed_cursor(&self, id: &str, cursor: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .execute(
                "UPDATE local_sources SET cursor=COALESCE(cursor,?) WHERE id=?",
                params![cursor, id],
            )
            .map_err(storage_error)?;
        Ok(())
    }

    // 공급자 이벤트 한 건을 기존의 공통 전달 경계로 저장한다.
    pub fn publish(
        &self,
        notification: Notification,
        cursor: Option<&str>,
    ) -> Result<bool, String> {
        let id = notification.connection_id.clone();
        self.publish_many(&id, vec![notification], cursor)
            .map(|count| count > 0)
    }

    // 같은 조회에서 결정한 알림과 기준 상태를 한 트랜잭션으로 저장한다.
    pub fn publish_many(
        &self,
        source_id: &str,
        notifications: Vec<Notification>,
        cursor: Option<&str>,
    ) -> Result<usize, String> {
        // 1. 연결 경계를 확인하고 만료 이벤트를 정리한다.
        if notifications.len() > 32
            || notifications
                .iter()
                .any(|event| event.connection_id != source_id)
        {
            return Err("알림 연결 범위가 일치하지 않습니다".into());
        }
        let now = now_ms();
        let mut db = self.db.lock().map_err(storage_error)?;
        let tx = db.transaction().map_err(storage_error)?;
        tx.execute("DELETE FROM local_events WHERE expires_at<=?", [now])
            .map_err(storage_error)?;
        let mut changed = 0;

        // 2. 중복 이벤트는 버리고 새로운 알림만 15초 임시 전달 큐에 넣는다.
        for notification in notifications {
            let event = LocalEvent {
                id: format!("local:{}", uuid::Uuid::new_v4().simple()),
                r#type: "notification".into(),
                kind: "external".into(),
                body: String::new(),
                created_at: now,
                expires_at: now + 15000,
                local: true,
                notification,
            };
            let raw = serde_json::to_string(&event).map_err(storage_error)?;
            let seen = tx.execute("INSERT OR IGNORE INTO local_event_keys(source_id,event_key,created_at) VALUES(?,?,?)",params![source_id,event.notification.event_id,now]).map_err(storage_error)?;
            if seen > 0 && event.notification.occurred_at >= self.started_at {
                changed += tx.execute("INSERT OR IGNORE INTO local_events(id,source_id,event_key,payload,created_at,expires_at) VALUES(?,?,?,?,?,?)",params![event.id,source_id,event.notification.event_id,raw,now,event.expires_at]).map_err(storage_error)?;
            }
        }

        // 3. 알림이 없어도 기준 상태는 저장하고 실패하면 전체 결정을 되돌린다.
        if let Some(cursor) = cursor {
            tx.execute(
                "UPDATE local_sources SET cursor=? WHERE id=?",
                params![cursor, source_id],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(changed)
    }

    // 내 펫 창 또는 보관함에 필요한 로컬 카드만 조회한다.
    pub fn events(&self, pending: bool) -> Result<Vec<LocalEvent>, String> {
        let db = self.db.lock().map_err(storage_error)?;
        db.execute(
            "DELETE FROM local_events WHERE expires_at<=? OR received_at IS NOT NULL",
            [now_ms()],
        )
        .map_err(storage_error)?;
        db.execute(
            "DELETE FROM local_event_keys WHERE created_at<?",
            [now_ms() - 24 * 60 * 60 * 1000],
        )
        .map_err(storage_error)?;
        if !pending {
            return Ok(Vec::new());
        }
        let sql = "SELECT payload FROM local_events WHERE received_at IS NULL AND expires_at>? ORDER BY created_at,id LIMIT 100";
        let mut query = db.prepare(sql).map_err(storage_error)?;
        let cutoff = now_ms();
        let rows = query
            .query_map([cutoff], |r| r.get::<_, String>(0))
            .map_err(storage_error)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(serde_json::from_str(&row.map_err(storage_error)?).map_err(storage_error)?);
        }
        Ok(events)
    }

    // 로컬 펫 앱 수신을 사용자 읽음과 구분해 기록한다.
    pub fn ack(&self, id: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .execute("DELETE FROM local_events WHERE id=?", params![id])
            .map_err(storage_error)?;
        Ok(())
    }

    // 삭제·중지 대상이 실제로 존재하는지 확인한다.
    pub fn source(&self, id: &str) -> Result<Source, String> {
        self.sources()?
            .into_iter()
            .find(|source| source.id == id)
            .ok_or_else(|| "로컬 연결을 찾을 수 없습니다".into())
    }

    // 설정 수정 시 기존 토큰 지문의 존재를 조회한다.
    pub fn fingerprint(&self, id: &str) -> Result<Option<String>, String> {
        self.db
            .lock()
            .map_err(storage_error)?
            .query_row(
                "SELECT credential_fingerprint FROM local_sources WHERE id=?",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)
            .map(Option::flatten)
    }
}
