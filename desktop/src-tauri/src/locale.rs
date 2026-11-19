use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Locale {
    Ko,
    #[default]
    En,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct LocaleState {
    preference: Locale,
    locale: Locale,
}

static CURRENT: AtomicU8 = AtomicU8::new(0);
static CHANGE: Mutex<()> = Mutex::new(());
static ENGLISH: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/en.json"))
        .expect("embedded locale catalogue must be valid JSON")
});

// 첫 실행에 OS 언어로 초기값을 정하고 이후에는 저장된 언어를 복원한다.
pub fn install(app: &tauri::AppHandle) {
    let locale = app
        .path()
        .app_data_dir()
        .map(|directory| load_locale(&directory, sys_locale::get_locale))
        .unwrap_or_else(|_| resolve_system(sys_locale::get_locale().as_deref()));
    update(locale);
    apply_window_titles(app);
}

// 이전의 자동 설정 값은 첫 실행처럼 처리하고 현재 OS 언어로 한 번만 초기화한다.
fn load_locale(directory: &Path, system: impl FnOnce() -> Option<String>) -> Locale {
    if let Some(saved) = std::fs::read(directory.join("locale.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Locale>(&raw).ok())
    {
        return saved;
    }
    let initial = resolve_system(system().as_deref());
    let _ = save_locale(directory, initial);
    initial
}

// 시스템 언어의 지역·인코딩 접미사와 관계없이 지원 언어만 선택한다.
fn resolve_system(system: Option<&str>) -> Locale {
    let language = system
        .unwrap_or("")
        .trim()
        .split(['-', '_', '.', '@'])
        .next()
        .unwrap_or("");
    if language.eq_ignore_ascii_case("ko") {
        Locale::Ko
    } else {
        Locale::En
    }
}

// 저장 중 실패해도 이전 언어 설정 파일을 유지한다.
fn save_locale(directory: &Path, locale: Locale) -> Result<(), &'static str> {
    const SAVE_ERROR: &str = "언어 설정을 저장하지 못했습니다";
    std::fs::create_dir_all(directory).map_err(|_| SAVE_ERROR)?;
    let next = directory.join("locale.next");
    let raw = serde_json::to_vec(&locale).map_err(|_| SAVE_ERROR)?;
    std::fs::write(&next, raw).map_err(|_| SAVE_ERROR)?;
    std::fs::rename(next, directory.join("locale.json")).map_err(|_| SAVE_ERROR)
}

// 같은 프로세스의 창·트레이·커넥터가 사용하는 언어를 갱신한다.
fn update(locale: Locale) {
    CURRENT.store(u8::from(locale == Locale::En), Ordering::Relaxed);
}

// 모든 창과 로컬 커넥터가 공유하는 현재 프로세스의 언어를 반환한다.
pub fn current() -> Locale {
    if CURRENT.load(Ordering::Relaxed) == 1 {
        Locale::En
    } else {
        Locale::Ko
    }
}

// 번역된 문구의 자리표시자에 값만 넣으며 값 안의 자리표시자는 다시 처리하지 않는다.
fn format_for(locale: Locale, source: &str, values: &[String]) -> String {
    // 1. 원문 키로 고정 앱 문구만 고르고 사용자 값은 조회 키에 사용하지 않는다.
    let template = if locale == Locale::En {
        ENGLISH.get(source).map(String::as_str).unwrap_or(source)
    } else {
        source
    };
    let mut result = String::new();
    let mut rest = template;

    // 2. 템플릿을 한 번만 읽어 사용자 이름에 들어 있는 중괄호도 원문 그대로 보존한다.
    while let Some(start) = rest.find('{') {
        result.push_str(&rest[..start]);
        let token = &rest[start..];
        if let Some(end) = token.find('}') {
            if let Ok(index) = token[1..end].parse::<usize>() {
                if let Some(value) = values.get(index) {
                    result.push_str(value);
                    rest = &token[end + 1..];
                    continue;
                }
            }
        }
        result.push('{');
        rest = &token[1..];
    }
    result.push_str(rest);
    result
}

// 현재 PC 언어로 고정 앱 문구를 반환한다.
pub fn text(source: &str) -> String {
    format_for(current(), source, &[])
}

// 현재 PC 언어로 커넥터가 만든 안내를 보간하고 외부 원문 값은 보존한다.
pub fn message(source: &str, values: &[String]) -> String {
    format_for(current(), source, values)
}

// 각 창이 같은 PC의 언어를 조회하도록 공개한다.
#[tauri::command]
pub fn get_locale() -> LocaleState {
    let locale = current();
    LocaleState {
        preference: locale,
        locale,
    }
}

// 설정 창의 명시적 언어 선택만 저장하고 연결·펫 위치를 유지한 채 모든 창에 알린다.
#[tauri::command]
pub fn set_locale(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    locale: Locale,
) -> Result<LocaleState, String> {
    // 1. 펫 창은 앱 언어를 바꾸지 못하고 저장 실패 시 현재 언어도 유지한다.
    if window.label() != "settings" {
        return Err("설정 창에서만 언어를 변경할 수 있습니다".into());
    }
    let _change = CHANGE.lock().map_err(|_| "언어 설정 잠금 실패")?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "언어 설정 경로를 읽지 못했습니다")?;
    save_locale(&directory, locale)?;

    // 2. 트레이·창 제목과 웹뷰만 갱신하며 WebSocket·모집·커넥터는 재시작하지 않는다.
    update(locale);
    let state = get_locale();
    let _ = crate::desktop_controls::refresh_locale(&app);
    apply_window_titles(&app);
    app.emit("locale-changed", state)
        .map_err(|_| "언어 변경을 전달하지 못했습니다")?;
    Ok(state)
}

// 사용자 닉네임이 들어가는 친구 창 제목은 보존하고 앱 자체 제목만 번역한다.
fn apply_window_titles(app: &tauri::AppHandle) {
    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.set_title(&text("우리 펫 · 함께하는 데스크톱"));
    }
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_title(&text("우리 펫"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 처음 설정할 때 OS 언어를 읽고 미지원·누락 언어는 영어로 지정한다.
    #[test]
    fn resolves_initial_system_language_with_english_fallback() {
        for system in [Some("ko-KR"), Some("ko_KR.UTF-8"), Some("KO")] {
            assert_eq!(resolve_system(system), Locale::Ko);
        }
        for system in [None, Some("en-US"), Some("ja-JP"), Some("fr-FR"), Some("C")] {
            assert_eq!(resolve_system(system), Locale::En);
        }
    }

    // 저장 값이 없거나 이전 버전의 자동 설정이면 한 번만 초기화한다.
    #[test]
    fn persists_initial_and_explicit_language() {
        for previous in [None, Some("\"system\"")] {
            let directory = tempfile::tempdir().unwrap();
            if let Some(raw) = previous {
                std::fs::write(directory.path().join("locale.json"), raw).unwrap();
            }
            assert_eq!(
                load_locale(directory.path(), || Some("ko-KR".into())),
                Locale::Ko
            );
            assert_eq!(
                load_locale(directory.path(), || panic!("saved locale should win")),
                Locale::Ko
            );
            save_locale(directory.path(), Locale::En).unwrap();
            assert_eq!(
                load_locale(directory.path(), || panic!("saved locale should win")),
                Locale::En
            );
        }
    }

    // 번역 문구 안의 보간 값은 언어 사전과 재귀 치환을 거치지 않는다.
    #[test]
    fn preserves_interpolated_user_content() {
        let values = vec!["고양이 {1} <script>".into()];
        assert_eq!(
            format_for(Locale::En, "{0}에게", &values),
            "To 고양이 {1} <script>"
        );
        assert_eq!(
            format_for(Locale::Ko, "{0}에게", &values),
            "고양이 {1} <script>에게"
        );
    }
}
