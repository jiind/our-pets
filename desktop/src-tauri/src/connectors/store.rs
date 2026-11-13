use super::types::{now_ms, LocalEvent, Notification, Source, SourceConfig};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Store {
    db: Mutex<Connection>,
    pending: Mutex<Vec<LocalEvent>>,
    started_at: i64,
    pub directory: PathBuf,
}

// 로컬 저장소 오류에서 SQL·경로·개인 정보를 노출하지 않는다.
fn storage_error(_: impl std::fmt::Display) -> String {
    "이 PC의 알림 저장소를 사용할 수 없습니다".into()
}

impl Store {
    // 연결 설정·복구 지점은 DB에, 알림 본문은 프로세스 메모리에만 준비한다.
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

        // 2. 기존 평문 전달 큐를 지우고 DB에는 설정과 중복 방지 지문만 남긴다.
        db.busy_timeout(std::time::Duration::from_secs(3))
            .map_err(storage_error)?;
        let legacy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_events')", [], |row| row.get(0)).map_err(storage_error)?;
        db.execute_batch("PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS local_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,config TEXT NOT NULL,enabled INTEGER NOT NULL,state TEXT NOT NULL,last_error TEXT NOT NULL DEFAULT '',credential_fingerprint TEXT UNIQUE,cursor TEXT);
          CREATE TABLE IF NOT EXISTS local_event_keys(source_id TEXT NOT NULL REFERENCES local_sources(id) ON DELETE CASCADE,event_key TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(source_id,event_key));
          DROP TABLE IF EXISTS local_events;
          PRAGMA user_version=3;").map_err(storage_error)?;
        if legacy {
            db.execute("DELETE FROM local_event_keys", [])
                .map_err(storage_error)?;
            db.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .map_err(storage_error)?;
        }
        Ok(Self {
            db: Mutex::new(db),
            pending: Mutex::new(Vec::new()),
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
        if !enabled {
            self.pending
                .lock()
                .map_err(storage_error)?
                .retain(|event| event.notification.connection_id != id);
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
        self.pending
            .lock()
            .map_err(storage_error)?
            .retain(|event| event.notification.connection_id != id);
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

    // 공급자 이벤트 한 건을 메모리 전달 큐와 영속 중복 방지 경계로 전달한다.
    pub fn publish(
        &self,
        notification: Notification,
        cursor: Option<&str>,
    ) -> Result<bool, String> {
        let id = notification.connection_id.clone();
        self.publish_many(&id, vec![notification], cursor)
            .map(|count| count > 0)
    }

    // 본문은 메모리에만 두고 이벤트 지문과 조회 기준 상태를 원자적으로 저장한다.
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
        tx.execute(
            "DELETE FROM local_event_keys WHERE created_at<?",
            [now - 24 * 60 * 60 * 1000],
        )
        .map_err(storage_error)?;
        let mut pending = self.pending.lock().map_err(storage_error)?;
        pending.retain(|event| event.expires_at > now);
        let mut added = Vec::new();
        let connection_name: String = tx
            .query_row(
                "SELECT name FROM local_sources WHERE id=?",
                [source_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;

        // 2. 중복 이벤트는 버리고 새로운 알림만 15초 임시 전달 큐에 넣는다.
        for mut notification in notifications {
            notification.connection_name.clone_from(&connection_name);
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
            let key = format!(
                "{:x}",
                Sha256::digest(event.notification.event_id.as_bytes())
            );
            let seen = tx.execute("INSERT OR IGNORE INTO local_event_keys(source_id,event_key,created_at) VALUES(?,?,?)",params![source_id,key,now]).map_err(storage_error)?;
            if seen > 0 && event.notification.occurred_at >= self.started_at {
                added.push(event);
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
        if pending.len() + added.len() > 2048 {
            return Err("알림 처리 대기열이 가득 찼습니다. 잠시 후 다시 시도합니다".into());
        }
        tx.commit().map_err(storage_error)?;
        let changed = added.len();
        pending.extend(added);
        Ok(changed)
    }

    // 현재 프로세스에서 아직 만료·수신되지 않은 메모리 알림만 반환한다.
    pub fn events(&self, pending_only: bool) -> Result<Vec<LocalEvent>, String> {
        // 1. 영속 중복 방지 지문은 하루 후 정리하고 본문 큐는 15초 만료를 적용한다.
        let db = self.db.lock().map_err(storage_error)?;
        db.execute(
            "DELETE FROM local_event_keys WHERE created_at<?",
            [now_ms() - 24 * 60 * 60 * 1000],
        )
        .map_err(storage_error)?;
        let mut pending = self.pending.lock().map_err(storage_error)?;
        pending.retain(|event| event.expires_at > now_ms());

        // 2. 보관함은 제공하지 않으며 한 번에 최대 100개를 현재 펫으로 전달한다.
        if !pending_only {
            return Ok(Vec::new());
        }
        Ok(pending.iter().take(100).cloned().collect())
    }

    // 앱이 수신한 본문은 메모리에서 제거하되 읽음 상태로 간주하지 않는다.
    pub fn ack(&self, id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(storage_error)?
            .retain(|event| event.id != id);
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
