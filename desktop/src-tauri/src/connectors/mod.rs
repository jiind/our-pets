pub mod claude;
pub mod claude_bridge;
pub mod codex;
mod codex_usage;
pub mod docker;
pub mod secrets;
pub mod slack;
pub mod store;
#[cfg(test)]
mod tests;
pub mod types;

use secrets::{OsSecrets, Secrets};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager};
use tokio_util::sync::CancellationToken;
use types::{LocalEvent, Notification, Source, SourceDraft};

#[derive(Debug)]
pub struct RunError {
    pub message: String,
    pub retry_after: Option<Duration>,
}

impl RunError {
    // 정제된 설명만 전달하는 수집 오류를 만든다.
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry_after: None,
        }
    }
}

struct Running {
    cancel: CancellationToken,
    task: tauri::async_runtime::JoinHandle<()>,
    codex_refresh: Option<tokio::sync::mpsc::Sender<codex::RefreshRequest>>,
}

pub struct Engine {
    pub store: Arc<store::Store>,
    secrets: Arc<dyn Secrets>,
    notify: Arc<dyn Fn() + Send + Sync>,
    status_changed: Arc<dyn Fn() + Send + Sync>,
    runs: Mutex<HashMap<String, Running>>,
    control: tokio::sync::Mutex<()>,
}

pub struct LocalEngine(Result<Arc<Engine>, String>);

impl LocalEngine {
    // 개인 저장소 오류를 전체 앱 시작 실패와 분리해 설정 창에서만 보고한다.
    pub fn get(&self) -> Result<&Arc<Engine>, String> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

impl Engine {
    // 로컬 영속 저장소·보안 저장소·화면 알림 경계를 연결한다.
    pub fn new(
        store: Arc<store::Store>,
        secrets: Arc<dyn Secrets>,
        notify: Arc<dyn Fn() + Send + Sync>,
        status_changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Arc<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Arc::new(Self {
            store,
            secrets,
            notify,
            status_changed,
            runs: Mutex::new(HashMap::new()),
            control: tokio::sync::Mutex::new(()),
        })
    }

    // UI 상태 변경은 비밀 내용 없이 알리고 네트워크 수집을 계속 유지한다.
    pub fn status(&self, id: &str, state: &str, error: &str) {
        if self
            .store
            .source(id)
            .is_ok_and(|source| source.state == state && source.last_error == error)
        {
            return;
        }
        if self.store.status(id, state, error).is_ok() {
            (self.status_changed)();
        }
    }

    // 공급자 이벤트를 저장한 뒤 내 펫 창에 미전달 알림이 있음을 알린다.
    pub fn publish(
        &self,
        notification: Notification,
        cursor: Option<&str>,
    ) -> Result<(), RunError> {
        if self
            .store
            .publish(notification, cursor)
            .map_err(RunError::new)?
        {
            (self.notify)();
        }
        Ok(())
    }

    // 보안 저장소의 동기 API를 비동기 수집 스레드와 분리한다.
    pub async fn token(&self, id: &str) -> Result<String, RunError> {
        let id = id.to_string();
        let secrets = self.secrets.clone();
        tokio::task::spawn_blocking(move || secrets.get(&id))
            .await
            .map_err(|_| RunError::new("OS 자격증명 읽기에 실패했습니다"))?
            .map_err(RunError::new)
    }

    // 설정을 저장하고 연결별 수집 작업을 시작하며 비밀번호를 설정에 포함하지 않는다.
    pub async fn save(self: &Arc<Self>, draft: SourceDraft) -> Result<Source, String> {
        // 1. 현재 PC에서만 사용되는 설정과 기존 연결 ID를 검증한다.
        let _control = self.control.lock().await;
        draft.config.validate()?;
        if draft.name.trim().is_empty() || draft.name.len() > 80 {
            return Err("표시 이름은 1~80바이트로 입력하세요".into());
        }
        let id = draft
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        if draft.id.is_some() {
            let old = self.store.source(&id)?;
            if old.config.kind() != draft.config.kind() {
                return Err("기존 연결의 종류는 변경할 수 없습니다".into());
            }
        }
        if ["codex", "claude"].contains(&draft.config.kind())
            && self
                .store
                .sources()?
                .iter()
                .any(|source| source.id != id && source.config.kind() == draft.config.kind())
        {
            return Err(format!(
                "이 PC의 {} 연결이 이미 있어요. 기존 연결을 수정하세요.",
                if draft.config.kind() == "claude" {
                    "Claude"
                } else {
                    "Codex"
                }
            ));
        }

        // 2. Slack 비밀값은 OS에만 저장하고 중복 토큰의 이벤트 분산을 방지한다.
        let mut fingerprint = None;
        if draft.config.kind() == "slack" {
            if let Some(token) = draft.app_token.filter(|value| !value.is_empty()) {
                if !token.starts_with("xapp-")
                    || token.len() < 12
                    || token.len() > 4096
                    || token.chars().any(char::is_whitespace)
                {
                    return Err("Socket Mode용 xapp- 앱 토큰을 입력하세요".into());
                }
                let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
                if self.store.duplicate_secret(&id, &hash)? {
                    return Err(
                        "같은 Slack 앱 토큰의 연결이 이미 있습니다. 기존 연결을 수정하세요".into(),
                    );
                }
                let secrets = self.secrets.clone();
                let secret_id = id.clone();
                tokio::task::spawn_blocking(move || secrets.set(&secret_id, &token))
                    .await
                    .map_err(|_| "OS 자격증명 저장에 실패했습니다")??;
                fingerprint = Some(hash);
            } else if self.store.fingerprint(&id)?.is_none() {
                return Err("새 Slack 연결에는 앱 토큰이 필요합니다".into());
            }
        } else if draft.app_token.is_some_and(|value| !value.is_empty()) {
            return Err("Slack 이외의 연결에는 앱 토큰을 넣을 수 없습니다".into());
        }

        // 3. 기존 작업을 종료한 뒤 새 설정으로 한 번만 시작한다.
        self.stop(&id).await;
        self.store.save(
            &id,
            draft.name.trim(),
            &draft.config,
            fingerprint.as_deref(),
        )?;
        self.start(&id)?;
        self.store.source(&id)
    }

    // 사용자가 선택한 연결의 수집을 정지하거나 재개한다.
    pub async fn enable(self: &Arc<Self>, id: &str, enabled: bool) -> Result<(), String> {
        let _control = self.control.lock().await;
        self.store.source(id)?;
        self.stop(id).await;
        self.store.enable(id, enabled)?;
        if enabled {
            self.start(id)?;
        }
        Ok(())
    }

    // 로컬 수집·자격증명·알림 기록을 순서대로 삭제한다.
    pub async fn remove(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let _control = self.control.lock().await;
        let source = self.store.source(id)?;
        self.stop(id).await;
        self.store.enable(id, false)?;
        if source.config.kind() == "slack" {
            let secrets = self.secrets.clone();
            let id = id.to_string();
            tokio::task::spawn_blocking(move || secrets.delete(&id))
                .await
                .map_err(|_| "OS 자격증명 삭제에 실패했습니다")??;
        }
        self.store.remove(id)
    }

    // 앱 재시작 때 이 PC에서 켜 둔 연결만 복구한다.
    pub fn restore(self: &Arc<Self>) -> Result<(), String> {
        for source in self.store.sources()? {
            if source.enabled {
                self.start(&source.id)?;
            }
        }
        Ok(())
    }

    // 켜진 Codex 연결에서만 현재 사용량을 명시적으로 다시 조회한다.
    pub async fn refresh_codex(&self, id: &str) -> Result<types::CodexUsage, String> {
        self.refresh_usage(id, "codex").await
    }

    // 공급자별 수집 작업에 수동 확인을 맡기며 다른 연결을 재조회하지 못하게 한다.
    pub async fn refresh_usage(&self, id: &str, kind: &str) -> Result<types::CodexUsage, String> {
        // 1. 다른 공급자·중지·재접속 상태에서는 새 프로세스나 조회 요청을 만들지 않는다.
        let source = self.store.source(id)?;
        let provider = if kind == "claude" { "Claude" } else { "Codex" };
        if source.config.kind() != kind
            || !source.enabled
            || (source.state != "connected" && !(kind == "claude" && source.state == "waiting"))
        {
            return Err(format!("{provider} 연결 상태를 확인한 뒤 다시 조회하세요."));
        }
        let sender = self
            .runs
            .lock()
            .map_err(|_| "로컬 연결 상태 잠금 오류")?
            .get(id)
            .and_then(|running| running.codex_refresh.clone())
            .ok_or_else(|| format!("{provider} 사용량 연결이 준비되지 않았어요."))?;

        // 2. 수신기에서 조회를 직렬 처리하고 늦은 요청은 알림 없이 만료한다.
        let (reply, result) = tokio::sync::oneshot::channel();
        sender
            .try_send(codex::RefreshRequest {
                deadline: std::time::Instant::now() + Duration::from_secs(40),
                reply,
            })
            .map_err(|_| {
                format!("{provider} 사용량 확인이 이미 진행 중이거나 연결이 종료됐어요.")
            })?;
        tokio::time::timeout(Duration::from_secs(45), result)
            .await
            .map_err(|_| format!("{provider} 사용량 확인 시간이 초과됐어요."))?
            .map_err(|_| format!("{provider} 연결이 종료돼 확인을 마치지 못했어요."))?
    }

    // 중지 요청 후 실제 네트워크 작업이 끝나야 다음 작업을 시작한다.
    async fn stop(&self, id: &str) {
        let running = self.runs.lock().ok().and_then(|mut runs| runs.remove(id));
        if let Some(running) = running {
            running.cancel.cancel();
            let _ = running.task.await;
        }
    }

    // 연결마다 독립적으로 수집하며 취소 가능한 지수 지연으로 재접속한다.
    fn start(self: &Arc<Self>, id: &str) -> Result<(), String> {
        // 1. 같은 연결의 작업이 중복 생성되지 않게 한다.
        let mut runs = self.runs.lock().map_err(|_| "로컬 연결 상태 잠금 오류")?;
        if runs.contains_key(id) {
            return Ok(());
        }
        let source = self.store.source(id)?;
        let engine = self.clone();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let (refresh_sender, mut refresh_requests) =
            tokio::sync::mpsc::channel::<codex::RefreshRequest>(1);
        let codex_refresh = ["codex", "claude"]
            .contains(&source.config.kind())
            .then_some(refresh_sender);

        // 2. 공급자 오류를 내부 LAN 메시지와 격리하고 제한 시간 뒤 재시도한다.
        let task = tauri::async_runtime::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                engine.status(&source.id, "connecting", "");
                let result = tokio::select! {
                    _ = task_cancel.cancelled() => break,
                    result = async {
                        match &source.config {
                            types::SourceConfig::Docker {..} => docker::run(engine.clone(),&source,&task_cancel).await,
                            types::SourceConfig::Slack {..} => slack::run(engine.clone(),&source,&task_cancel).await,
                            types::SourceConfig::Codex {..} => codex::run(engine.clone(),&source,&task_cancel,&mut refresh_requests).await,
                            types::SourceConfig::Claude {..} => claude::run(engine.clone(),&source,&task_cancel,&mut refresh_requests).await,
                        }
                    } => result,
                };
                if task_cancel.is_cancelled() {
                    break;
                }
                let error = result
                    .err()
                    .unwrap_or_else(|| RunError::new("수신 연결이 종료되어 재접속합니다"));
                engine.status(&source.id, "reconnecting", &error.message);
                while let Ok(request) = refresh_requests.try_recv() {
                    let _ = request.reply.send(Err(
                        "사용량 연결이 재접속 중이라 확인을 마치지 못했어요.".into(),
                    ));
                }
                let wait = error.retry_after.unwrap_or(delay);
                tokio::select! {
                    _ = task_cancel.cancelled() => break,
                    _ = tokio::time::sleep(wait) => {}
                }
                delay = (delay * 2).min(Duration::from_secs(30));
            }
            engine.status(&source.id, "stopped", "");
        });
        runs.insert(
            id.into(),
            Running {
                cancel,
                task,
                codex_refresh,
            },
        );
        Ok(())
    }
}

// 친구 펫 창이나 원격 페이지가 개인 연결을 조작하지 못하게 한다.
fn settings_only(label: &str) -> Result<(), String> {
    if label != "settings" {
        return Err("개인 연결은 이 PC의 설정 창에서만 관리할 수 있습니다".into());
    }
    Ok(())
}

// 앱 시작 시 개인 연결 준비 결과를 LAN 기능과 독립적으로 등록한다.
pub fn install(app: &tauri::AppHandle) {
    // 1. 개인 저장소 준비 실패를 해당 기능의 상태로만 보관한다.
    let store = app
        .path()
        .app_data_dir()
        .map_err(|_| "개인 알림 저장 경로를 확인할 수 없습니다".to_string())
        .and_then(|directory| store::Store::open(&directory))
        .map(Arc::new);
    let handle = app.clone();
    let settings = app.clone();

    // 2. 준비된 개인 수집기만 복원하고 LAN 기능과 별도 상태로 등록한다.
    let engine = store.and_then(|store| {
        let engine = Engine::new(
            store,
            Arc::new(OsSecrets),
            Arc::new(move || {
                let _ = handle.emit_to("pet", "local-notifications-ready", ());
            }),
            Arc::new(move || {
                let _ = settings.emit_to("settings", "local-sources-updated", ());
            }),
        );
        engine.restore()?;
        Ok(engine)
    });
    app.manage(LocalEngine(engine));
}

// 내 PC에 저장한 연결 목록만 반환하며 토큰을 반환하지 않는다.
#[tauri::command]
pub fn local_list_sources(
    window: tauri::WebviewWindow,
    engine: tauri::State<LocalEngine>,
) -> Result<Vec<Source>, String> {
    settings_only(window.label())?;
    engine.get()?.store.sources()
}

// 사용자 입력을 네이티브 수집기와 OS 보안 저장소에 저장한다.
#[tauri::command]
pub async fn local_save_source(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    draft: SourceDraft,
) -> Result<Source, String> {
    settings_only(window.label())?;
    engine.get()?.save(draft).await
}

// 개인 연결을 중지하거나 다시 연결한다.
#[tauri::command]
pub async fn local_enable_source(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    settings_only(window.label())?;
    engine.get()?.enable(&id, enabled).await
}

// 개인 연결과 자격증명 및 로컬 알림 기록을 삭제한다.
#[tauri::command]
pub async fn local_remove_source(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    id: String,
) -> Result<(), String> {
    settings_only(window.label())?;
    engine.get()?.remove(&id).await
}

// 이 PC의 설정 창에서만 Codex 재조회 결과와 해당 알림을 요청할 수 있다.
#[tauri::command]
pub async fn local_refresh_codex(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    id: String,
) -> Result<types::CodexUsage, String> {
    settings_only(window.label())?;
    engine.get()?.refresh_codex(&id).await
}

// 설정 창만 선택한 Claude 세션의 최신 상태줄 관측값을 다시 확인할 수 있다.
#[tauri::command]
pub async fn local_refresh_claude(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    id: String,
) -> Result<types::CodexUsage, String> {
    settings_only(window.label())?;
    engine.get()?.refresh_usage(&id, "claude").await
}

// 설정 창에만 브리지 설치 여부와 비식별 사용량 세션을 제공한다.
#[tauri::command]
pub async fn local_claude_bridge_info(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
) -> Result<claude_bridge::BridgeInfo, String> {
    settings_only(window.label())?;
    let directory = engine.get()?.store.directory.join("claude-bridge");
    tokio::task::spawn_blocking(move || claude_bridge::info(&directory))
        .await
        .map_err(|_| "Claude 연결 상태를 확인하지 못했어요.")?
}

// 명시적인 적용·해제 버튼에서만 사용자 상태줄 설정을 변경한다.
#[tauri::command]
pub async fn local_configure_claude_bridge(
    window: tauri::WebviewWindow,
    engine: tauri::State<'_, LocalEngine>,
    enabled: bool,
) -> Result<claude_bridge::BridgeInfo, String> {
    settings_only(window.label())?;
    let engine = engine.get()?;
    let _control = engine.control.lock().await;
    let directory = engine.store.directory.join("claude-bridge");
    tokio::task::spawn_blocking(move || claude_bridge::configure(&directory, enabled))
        .await
        .map_err(|_| "Claude 상태줄 연결을 변경하지 못했어요.")?
}

// 설정 창에는 기록을, 내 펫 창에는 만료되지 않은 미전달 카드만 제공한다.
#[tauri::command]
pub fn local_notifications(
    window: tauri::WebviewWindow,
    engine: tauri::State<LocalEngine>,
    pending: bool,
) -> Result<Vec<LocalEvent>, String> {
    if !pending || window.label() != "pet" {
        return Err("이 창에서는 개인 알림을 조회할 수 없습니다".into());
    }
    engine.get()?.store.events(pending)
}

// 내 펫 창이 개인 알림을 앱에 수신했음을 확인한다.
#[tauri::command]
pub fn local_ack_notification(
    window: tauri::WebviewWindow,
    engine: tauri::State<LocalEngine>,
    id: String,
) -> Result<(), String> {
    if window.label() != "pet" {
        return Err("내 펫 창에서만 수신을 확인할 수 있습니다".into());
    }
    engine.get()?.store.ack(&id)
}
