use super::codex_usage::fingerprint;
use super::types::{now_ms, CodexUsage, CodexWindow};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const INPUT_LIMIT: u64 = 256 * 1024;

#[cfg(test)]
#[path = "claude_bridge_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_key: String,
    pub usage: CodexUsage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub installed: bool,
    pub settings_path: String,
    pub sessions: Vec<Snapshot>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    settings_path: PathBuf,
    original_status_line: Option<Value>,
    command: String,
}

// 인증·대화·프로젝트 경로를 제외하고 공식 상태줄의 한도와 세션 지문만 추린다.
pub fn normalize(raw: &Value, now: i64) -> Result<Snapshot, String> {
    // 1. 임의 경로 대신 고정 길이의 세션 지문을 사용한다.
    let session = raw
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        })
        .ok_or("Claude 상태줄 세션을 확인하지 못했어요.")?;
    let mut windows = Vec::new();

    // 2. null·만료 창을 0%로 바꾸지 않고 공급자가 전달한 유효한 창만 저장한다.
    for (key, label, minutes) in [
        ("five_hour", "5시간", Some(300)),
        ("seven_day", "7일", Some(10080)),
        ("spend_limit", "지출 한도", None),
    ] {
        let window = &raw["rate_limits"][key];
        let Some(percent) = window["used_percentage"]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.0)
        else {
            continue;
        };
        let reset = window["resets_at"]
            .as_i64()
            .filter(|value| *value > now / 1000);
        if reset.is_none() {
            continue;
        }
        windows.push(CodexWindow {
            key: key.into(),
            label: format!("Claude · {label}"),
            used_percent: percent.min(100.0).floor() as u8,
            resets_at: reset,
            window_duration_mins: minutes,
        });
    }
    Ok(Snapshot {
        session_key: fingerprint(session),
        usage: CodexUsage {
            checked_at: now,
            ordinary_usage_allowed: None,
            windows,
        },
    })
}

// 상태줄 연결 파일을 사용자 전용 권한으로 원자 교체한다.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // 1. 완성 전 파일은 고유 이름과 제한된 권한으로 쓴다.
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Claude 연결 파일을 만들지 못했어요.")?;
        file.write_all(bytes)
            .map_err(|_| "Claude 연결 파일을 저장하지 못했어요.")?;
        file.sync_all()
            .map_err(|_| "Claude 연결 파일을 반영하지 못했어요.")?;

        // 2. 독자가 부분 JSON을 읽지 않도록 완성 파일만 교체한다.
        std::fs::rename(&temporary, path).map_err(|_| "Claude 연결 파일을 교체하지 못했어요.")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(String::from)
}

// 전용 디렉터리를 준비하고 일반 설정·인증 저장소와 분리한다.
fn prepare(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|_| "Claude 연결 저장소를 만들지 못했어요.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "Claude 연결 저장소 권한을 설정하지 못했어요.")?;
    }
    Ok(())
}

// 크기 제한이 있는 JSON 파일만 읽고 원문 오류를 노출하지 않는다.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = std::fs::File::open(path).map_err(|_| "Claude 연결 파일을 읽지 못했어요.")?;
    let mut bytes = Vec::new();
    file.take(INPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Claude 연결 파일을 읽지 못했어요.")?;
    if bytes.len() as u64 > INPUT_LIMIT {
        return Err("Claude 연결 파일이 너무 커요.".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Claude 연결 파일 형식을 확인하세요.".into())
}

// 세션 지문을 검증해 전용 폴더 외부를 조회하지 못하게 한다.
pub fn read_snapshot(directory: &Path, key: &str) -> Result<Snapshot, String> {
    if key.len() != 64 || !key.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("Claude 세션을 선택하세요.".into());
    }
    let snapshot: Snapshot = read_json(&directory.join(format!("{key}.json")))?;
    let mut keys = std::collections::HashSet::new();
    if snapshot.session_key != key
        || snapshot.usage.windows.len() > 3
        || snapshot.usage.ordinary_usage_allowed.is_some()
        || snapshot.usage.windows.iter().any(|window| {
            window.used_percent > 100
                || !["five_hour", "seven_day", "spend_limit"].contains(&window.key.as_str())
                || !keys.insert(&window.key)
        })
    {
        return Err("Claude 세션 정보가 일치하지 않아요.".into());
    }
    Ok(snapshot)
}

// Claude 설정 디렉터리는 공식 환경 변수 또는 현재 사용자 기본 경로만 사용한다.
fn settings_path() -> Result<PathBuf, String> {
    if let Some(directory) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        let path = PathBuf::from(directory);
        if !path.is_absolute() {
            return Err("CLAUDE_CONFIG_DIR은 절대 경로여야 해요.".into());
        }
        return Ok(path.join("settings.json"));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join(".claude/settings.json"))
        .ok_or_else(|| "Claude 사용자 설정 경로를 찾지 못했어요.".into())
}

// 기존 상태줄 명령은 비공개 복원 기록으로만 보관한다.
fn installation(directory: &Path) -> Result<Installation, String> {
    read_json(&directory.join("installation.json"))
}

// 원문 설정 대신 설치 여부와 최근 세션의 공개 사용량만 반환한다.
pub fn info(directory: &Path) -> Result<BridgeInfo, String> {
    // 1. 현재 명령이 앱이 설치한 명령인지 확인한다.
    let path = settings_path()?;
    let current = read_json::<Value>(&path).unwrap_or(Value::Null);
    let installed = installation(directory).is_ok_and(|value| {
        value.settings_path == path
            && current["statusLine"]["command"].as_str() == Some(&value.command)
    });
    let mut sessions = Vec::new();

    // 2. 하루 내의 고정 지문 파일만 제한된 개수로 읽고 오래된 세션은 정리한다.
    if let Ok(entries) = std::fs::read_dir(directory) {
        for entry in entries.flatten().take(512) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_suffix(".json").filter(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) else {
                continue;
            };
            if let Ok(snapshot) = read_snapshot(directory, key) {
                if snapshot.usage.checked_at < now_ms() - 86400000 {
                    let _ = std::fs::remove_file(entry.path());
                } else if !snapshot.usage.windows.is_empty() {
                    sessions.push(snapshot);
                }
            }
        }
    }
    sessions.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.usage.checked_at));
    sessions.truncate(64);
    Ok(BridgeInfo {
        installed,
        settings_path: path.to_string_lossy().into_owned(),
        sessions,
    })
}

// 셸에 전달할 로컬 실행 경로를 리터럴 한 인자로 인용한다.
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

// 사용자의 명시적 설치·해제 버튼에서 상태줄만 변경하고 기존 명령·나머지 설정을 보존한다.
pub fn configure(directory: &Path, enabled: bool) -> Result<BridgeInfo, String> {
    // 1. 설정 원본을 읽고 잘못된 JSON·심볼릭 링크는 덮어쓰지 않는다.
    prepare(directory)?;
    let path = settings_path()?;
    let parent = path.parent().ok_or("Claude 설정 경로를 확인하세요.")?;
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("심볼릭 링크 설정은 직접 상태줄을 구성하세요.".into());
    }
    let original = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() as u64 <= INPUT_LIMIT => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        _ => return Err("Claude 설정을 읽지 못했어요. 크기와 접근 권한을 확인하세요.".into()),
    };
    let mut settings: Value = original
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|_| "Claude 설정 JSON을 먼저 확인하세요.")?
        .unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        return Err("Claude 설정은 JSON 객체여야 해요.".into());
    }

    // 2. 이전 상태줄을 복원할 수 있게 보관하고 중간에 사용자가 바꾼 명령은 건드리지 않는다.
    if enabled {
        let executable = std::env::current_exe().map_err(|_| "앱 실행 경로를 찾지 못했어요.")?;
        #[cfg(not(windows))]
        let command = format!(
            "{} --claude-statusline --directory {}",
            quote(&executable.to_string_lossy()),
            quote(&directory.to_string_lossy())
        );
        #[cfg(windows)]
        let command = format!("powershell -NoProfile -NonInteractive -Command \"& '{}' '--claude-statusline' '--directory' '{}'\"", executable.to_string_lossy().replace('\\', "/").replace('\'', "''"), directory.to_string_lossy().replace('\\', "/").replace('\'', "''"));
        let previous = installation(directory).ok();
        let current = settings
            .get("statusLine")
            .filter(|value| !value.is_null())
            .cloned();
        let original_status_line = if let Some(previous) = previous.filter(|value| {
            current.as_ref().and_then(|line| line["command"].as_str()) == Some(&value.command)
        }) {
            previous.original_status_line
        } else {
            current
        };
        if original_status_line.as_ref().is_some_and(|value| {
            value["type"].as_str() != Some("command") || value["command"].as_str().is_none()
        }) {
            return Err(
                "기존 Claude 상태줄 형식은 자동 연결할 수 없어요. 상태줄 설정을 확인하세요.".into(),
            );
        }
        if original_status_line
            .as_ref()
            .and_then(|value| value["command"].as_str())
            .is_some_and(|command| command.contains("--claude-statusline"))
        {
            return Err(
                "다른 앱 저장소의 Claude 상태줄 연결이 있어요. 기존 연결에서 해제한 뒤 적용하세요."
                    .into(),
            );
        }
        let record = Installation {
            settings_path: path.clone(),
            original_status_line: original_status_line.clone(),
            command: command.clone(),
        };
        write_private(
            &directory.join("installation.json"),
            &serde_json::to_vec_pretty(&record)
                .map_err(|_| "Claude 연결 기록을 구성하지 못했어요.")?,
        )?;
        let mut line = original_status_line.unwrap_or_else(|| json!({"type":"command"}));
        line["command"] = Value::String(command);
        settings["statusLine"] = line;
    } else {
        let record = installation(directory)?;
        if record.settings_path != path
            || settings["statusLine"]["command"].as_str() != Some(&record.command)
        {
            return Err(
                "Claude 상태줄이 이후 변경되어 자동 해제하지 않았어요. 현재 설정을 확인하세요."
                    .into(),
            );
        }
        if let Some(previous) = record.original_status_line {
            settings["statusLine"] = previous;
        } else {
            settings.as_object_mut().unwrap().remove("statusLine");
        }
    }

    // 3. 조회 이후 설정이 바뀌었으면 중단하고 아니면 상태줄만 원자적으로 반영한다.
    if std::fs::read(&path).ok() != original {
        return Err("Claude 설정이 변경됐어요. 다시 적용하세요.".into());
    }
    if !parent.exists() {
        prepare(parent)?;
    }
    write_private(
        &path,
        &serde_json::to_vec_pretty(&settings).map_err(|_| "Claude 설정을 구성하지 못했어요.")?,
    )?;
    if !enabled {
        let _ = std::fs::remove_file(directory.join("installation.json"));
    }
    info(directory)
}

// 기존 명령의 입력·출력을 유지하되 느린 상태줄이 앱용 브리지를 계속 붙잡지 못하게 한다.
fn previous_output(command: &str, bytes: Vec<u8>) {
    // 1. 사용자가 이미 설정한 명령에 동일한 원본 stdin을 메모리로만 전달한다.
    #[cfg(not(windows))]
    let mut shell = Command::new("sh");
    #[cfg(not(windows))]
    shell.args(["-c", command]);
    #[cfg(windows)]
    let mut shell = Command::new(
        std::env::var_os("CLAUDE_CODE_GIT_BASH_PATH").unwrap_or_else(|| "bash".into()),
    );
    #[cfg(windows)]
    shell.args(["-c", command]);
    let Ok(mut child) = shell
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::null())
        .spawn()
    else {
        println!("Claude");
        return;
    };
    if let Some(mut input) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = input.write_all(&bytes);
        });
    }

    // 2. 종료를 기다리는 동안 기존 명령의 출력은 그대로 터미널에 전달한다.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Err(_) => break,
            _ if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

// CLI 상태줄 모드에서는 GUI·네트워크·인증 저장소를 열지 않고 선언형 사용량만 기록한다.
pub fn handle_cli() -> bool {
    // 1. 전용 인자일 때만 stdin을 읽고 일반 데스크톱 실행과 분리한다.
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args
        .first()
        .is_none_or(|value| value != "--claude-statusline")
    {
        return false;
    }
    if args.len() != 3 || args[1] != "--directory" {
        return true;
    }
    let directory = PathBuf::from(&args[2]);
    if !directory.is_absolute() {
        return true;
    }
    let mut bytes = Vec::new();
    let _ = std::io::stdin()
        .take(INPUT_LIMIT + 1)
        .read_to_end(&mut bytes);
    let mut display = "Claude".to_string();

    // 2. 허용 필드만 원자 저장하며 원본 stdin은 파일·로그에 남기지 않는다.
    if bytes.len() as u64 <= INPUT_LIMIT {
        if let Ok(snapshot) = serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| ())
            .and_then(|value| normalize(&value, now_ms()).map_err(|_| ()))
        {
            if prepare(&directory).is_ok() {
                if let Ok(data) = serde_json::to_vec(&snapshot) {
                    let _ = write_private(
                        &directory.join(format!("{}.json", snapshot.session_key)),
                        &data,
                    );
                }
            }
            for window in snapshot.usage.windows {
                display.push_str(&format!(
                    " · {} {}% 남음",
                    window.label,
                    100 - window.used_percent
                ));
            }
        }
    }

    // 3. 기존 상태줄이 있으면 그대로 실행하고 없으면 최소 사용량 표시를 제공한다.
    if let Ok(record) = installation(&directory) {
        if let Some(command) = record
            .original_status_line
            .as_ref()
            .and_then(|value| value["command"].as_str())
        {
            previous_output(command, bytes);
            return true;
        }
    }
    println!("{display}");
    true
}
