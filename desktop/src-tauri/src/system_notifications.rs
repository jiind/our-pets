use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    enabled: bool,
}

impl Default for Settings {
    // 요청한 OS 알림을 기본으로 켜고 이 PC의 명시적 선택을 우선한다.
    fn default() -> Self {
        Self { enabled: true }
    }
}

struct State {
    settings: Settings,
    seen: HashSet<String>,
    order: VecDeque<String>,
}

struct Center(Mutex<State>);

// 서버 계정과 독립적인 이 PC의 OS 알림 설정과 중복 색인을 준비한다.
pub fn install(app: &tauri::AppHandle) {
    let settings = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|path| std::fs::read(path.join("system-notifications.json")).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    app.manage(Center(Mutex::new(State {
        settings,
        seen: HashSet::new(),
        order: VecDeque::new(),
    })));
}

// 설정 창에 현재 PC의 OS 알림 사용 여부만 반환한다.
#[tauri::command]
pub fn system_notification_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Settings, String> {
    if window.label() != "settings" {
        return Err("설정 창에서만 OS 알림 설정을 조회할 수 있습니다".into());
    }
    let center = app.state::<Center>();
    let state = center.0.lock().map_err(|_| "OS 알림 설정 잠금 실패")?;
    Ok(state.settings.clone())
}

// 설정 창의 명시적 선택만 원자적으로 저장하고 OS 권한 요청도 같은 동작에 묶는다.
#[tauri::command]
pub fn set_system_notifications(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<Settings, String> {
    // 1. 다른 펫 창이 표시 설정을 바꾸지 못하게 하고 켤 때 권한을 확인한다.
    if window.label() != "settings" {
        return Err("설정 창에서만 OS 알림을 변경할 수 있습니다".into());
    }
    if enabled
        && app
            .notification()
            .request_permission()
            .map_err(|_| "OS 알림 권한을 확인하지 못했습니다")?
            != PermissionState::Granted
    {
        return Err("OS 알림 설정에서 우리 펫의 알림을 허용해 주세요".into());
    }

    // 2. 파일 저장에 성공한 상태만 수신 경로가 사용하도록 잠금 안에서 교체한다.
    let center = app.state::<Center>();
    let mut state = center.0.lock().map_err(|_| "OS 알림 설정 잠금 실패")?;
    let settings = Settings { enabled };
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "설정 경로 확인 실패")?;
    std::fs::create_dir_all(&directory).map_err(|_| "OS 알림 설정 폴더 생성 실패")?;
    let temporary = directory.join("system-notifications.next");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&settings).map_err(|_| "OS 알림 설정 변환 실패")?,
    )
    .map_err(|_| "OS 알림 설정 저장 실패")?;
    std::fs::rename(temporary, directory.join("system-notifications.json"))
        .map_err(|_| "OS 알림 설정 저장 실패")?;
    state.settings = settings.clone();
    Ok(settings)
}

// OS에 넘기는 표시 문자열의 제어 문자를 제거하고 길이를 제한한다.
fn plain_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\n')
        .take(limit)
        .collect()
}

// 대표 펫 창이 받은 현재 이벤트만 OS 알림으로 요청하고 중복·만료는 무시한다.
#[tauri::command]
pub fn show_system_notification(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: String,
    title: String,
    body: String,
    expires_at: i64,
) -> Result<bool, String> {
    // 1. 친구 펫·설정 창의 중복 표시와 만료된 실시간 이벤트를 차단한다.
    if window.label() != "pet" || id.is_empty() || id.len() > 1024 {
        return Err("대표 펫의 현재 수신 이벤트만 OS 알림으로 표시할 수 있습니다".into());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "시각 확인 실패")?
        .as_millis() as i64;
    if expires_at <= now {
        return Ok(false);
    }
    if app
        .notification()
        .permission_state()
        .map_err(|_| "OS 알림 권한 확인 실패")?
        != PermissionState::Granted
    {
        return Err("OS 알림 설정에서 우리 펫의 알림을 허용해 주세요".into());
    }
    let center = app.state::<Center>();
    {
        let mut state = center.0.lock().map_err(|_| "OS 알림 상태 잠금 실패")?;
        if !state.settings.enabled || !state.seen.insert(id.clone()) {
            return Ok(false);
        }
        state.order.push_back(id.clone());
        while state.order.len() > 4096 {
            if let Some(previous) = state.order.pop_front() {
                state.seen.remove(&previous);
            }
        }
    }

    // 2. 표시 문자열만 넘기며 Linux 본문의 마크업은 문자 그대로 표시한다.
    let title = plain_text(&title, 160).replace('\n', " ");
    let body = plain_text(&body, 1500);
    #[cfg(target_os = "linux")]
    let body = body
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let result = app.notification().builder().title(title).body(body).show();
    if result.is_err() {
        let mut state = center.0.lock().map_err(|_| "OS 알림 상태 잠금 실패")?;
        state.seen.remove(&id);
        state.order.retain(|previous| previous != &id);
        return Err("OS 알림 요청을 전달하지 못했습니다".into());
    }
    Ok(true)
}
