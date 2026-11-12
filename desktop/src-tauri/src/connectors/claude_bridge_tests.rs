use super::*;

// 공통 라벨은 유지하면서 기본 상태줄의 공급자 이름 중복을 제거한다.
#[test]
fn statusline_displays_provider_once() {
    let raw = json!({"session_id":"session","rate_limits":{"five_hour":{"used_percentage":20,"resets_at":2000}}});
    let snapshot = normalize(&raw, 1_000_000).unwrap();
    assert_eq!(snapshot.usage.windows[0].label, "Claude · 5시간");
    assert_eq!(
        format!("Claude{}", statusline_window(&snapshot.usage.windows[0])),
        "Claude · 5시간 80% 남음"
    );
}

// 상태줄에서 인증·대화·프로젝트 값을 제외하고 소수 사용률을 안전하게 정규화한다.
#[test]
fn payload_keeps_only_usage_and_hashed_session() {
    // 1. 공식 한도와 저장하면 안 되는 원본 필드를 함께 제공한다.
    let raw = json!({"session_id":"private-session","cwd":"private-project","token":"private-token","last_assistant_message":"private-content","rate_limits":{"five_hour":{"used_percentage":23.8,"resets_at":2000}}});
    let snapshot = normalize(&raw, 1_000_000).unwrap();
    assert_eq!(snapshot.usage.windows[0].used_percent, 23);
    assert_eq!(snapshot.session_key.len(), 64);

    // 2. 직렬화한 저장값에 원본 식별자·비밀값이 남지 않는다.
    let saved = serde_json::to_string(&snapshot).unwrap();
    assert!(!saved.contains("private-"));
    assert!(!saved.contains("token"));
    assert_eq!(snapshot.usage.ordinary_usage_allowed, None);
}

// null·만료 한도를 0%로 바꾸지 않아 거짓 복구 알림을 만들지 않는다.
#[test]
fn expired_and_missing_windows_remain_absent() {
    let raw = json!({"session_id":"session","rate_limits":{"five_hour":{"used_percentage":100,"resets_at":1000},"seven_day":null}});
    let snapshot = normalize(&raw, 1_000_000).unwrap();
    assert!(snapshot.usage.windows.is_empty());
}

// 정상적인 0%는 누락과 구분해 유효한 잔여량으로 전달한다.
#[test]
fn zero_is_valid_when_future_window_is_present() {
    let raw = json!({"session_id":"session","rate_limits":{"five_hour":{"used_percentage":0,"resets_at":2000}}});
    let snapshot = normalize(&raw, 1_000_000).unwrap();
    assert_eq!(snapshot.usage.windows.len(), 1);
    assert_eq!(snapshot.usage.windows[0].used_percent, 0);
}

// 설치 명령의 경로를 셸 확장 없이 리터럴 한 인자로 유지한다.
#[test]
fn unix_path_quoting_covers_spaces_quotes_and_substitutions() {
    assert_eq!(quote("/home/a b/pet"), "'/home/a b/pet'");
    assert_eq!(quote("/a'b/$(secret)"), "'/a'\"'\"'b/$(secret)'");
}

static CONFIG_ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct ConfigEnvironment(Option<std::ffi::OsString>);

impl Drop for ConfigEnvironment {
    // 실패한 검사에서도 실제 사용자의 환경 변수 값을 되돌린다.
    fn drop(&mut self) {
        if let Some(value) = &self.0 {
            std::env::set_var("CLAUDE_CONFIG_DIR", value);
        } else {
            std::env::remove_var("CLAUDE_CONFIG_DIR");
        }
    }
}

// 임시 사용자 설정에서만 상태줄 설치·재적용·복원·변경 보호를 검증한다.
#[test]
fn installation_roundtrip_preserves_existing_settings() {
    // 1. 실제 HOME 대신 전용 임시 설정 경로와 자동 복구 가드를 사용한다.
    let _lock = CONFIG_ENVIRONMENT.lock().unwrap();
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("claude config's directory");
    std::fs::create_dir_all(&config).unwrap();
    let _environment = ConfigEnvironment(std::env::var_os("CLAUDE_CONFIG_DIR"));
    std::env::set_var("CLAUDE_CONFIG_DIR", &config);
    let settings = config.join("settings.json");
    let directory = root.path().join("private bridge");
    let original = json!({"theme":"test-theme","statusLine":{"type":"command","command":"printf original-status","padding":1},"permissions":{"allow":[]}});
    std::fs::write(&settings, serde_json::to_vec(&original).unwrap()).unwrap();

    // 2. 반복 설치해도 기존 명령을 중첩하지 않고 무관한 설정과 인자를 보존한다.
    assert!(configure(&directory, true).unwrap().installed);
    let first: Value = read_json(&settings).unwrap();
    assert_eq!(first["theme"], original["theme"]);
    assert_eq!(first["permissions"], original["permissions"]);
    assert_eq!(first["statusLine"]["padding"], 1);
    assert!(first["statusLine"]["command"]
        .as_str()
        .unwrap()
        .contains("--claude-statusline"));
    assert!(configure(&directory, true).unwrap().installed);
    assert!(!configure(&directory, false).unwrap().installed);
    let restored: Value = read_json(&settings).unwrap();
    assert_eq!(restored, original);
    assert!(!directory.join("installation.json").exists());

    // 3. 이후 사용자가 바꾼 명령과 잘못된 JSON은 자동으로 덮어쓰지 않는다.
    configure(&directory, true).unwrap();
    let mut changed: Value = read_json(&settings).unwrap();
    changed["statusLine"]["command"] = json!("printf user-changed");
    std::fs::write(&settings, serde_json::to_vec(&changed).unwrap()).unwrap();
    assert!(configure(&directory, false).is_err());
    assert_eq!(read_json::<Value>(&settings).unwrap(), changed);
    std::fs::write(&settings, b"invalid json").unwrap();
    assert!(configure(&directory, true).is_err());
    assert_eq!(std::fs::read(&settings).unwrap(), b"invalid json");

    // 4. 링크 대상과 상대 경로를 통해 사용자 설정 밖으로 쓰지 않는다.
    #[cfg(unix)]
    {
        let target = root.path().join("original settings.json");
        std::fs::write(&target, b"keep-original").unwrap();
        std::fs::remove_file(&settings).unwrap();
        std::os::unix::fs::symlink(&target, &settings).unwrap();
        assert!(configure(&directory, true).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep-original");
    }
    std::env::set_var("CLAUDE_CONFIG_DIR", "relative-test-only");
    assert!(configure(&directory, true).is_err());
}
