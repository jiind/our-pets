use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum SourceConfig {
    Docker {
        endpoint: String,
        #[serde(default)]
        containers: Vec<String>,
        #[serde(default)]
        actions: Vec<String>,
    },
    Slack {
        #[serde(rename = "teamId")]
        team_id: String,
        channels: Vec<String>,
        #[serde(default = "slack_events", rename = "eventTypes")]
        event_types: Vec<String>,
    },
    Codex {
        #[serde(default = "codex_executable")]
        executable: String,
        #[serde(default)]
        mode: UsageMode,
        #[serde(default = "usage_percent", rename = "usagePercent")]
        usage_percent: u8,
        #[serde(default = "poll_seconds", rename = "pollSeconds")]
        poll_seconds: u64,
        #[serde(default = "enabled", rename = "notifyExhausted")]
        notify_exhausted: bool,
        #[serde(default = "enabled", rename = "notifyRecovered")]
        notify_recovered: bool,
        #[serde(default = "enabled", rename = "notifyOnRefresh")]
        notify_on_refresh: bool,
    },
    Claude {
        #[serde(rename = "sessionKey")]
        session_key: String,
        #[serde(default)]
        mode: UsageMode,
        #[serde(default = "usage_percent", rename = "usagePercent")]
        usage_percent: u8,
        #[serde(default = "enabled", rename = "notifyExhausted")]
        notify_exhausted: bool,
        #[serde(default = "enabled", rename = "notifyRecovered")]
        notify_recovered: bool,
        #[serde(default = "enabled", rename = "notifyOnRefresh")]
        notify_on_refresh: bool,
    },
}

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UsageMode {
    Once,
    #[default]
    Interval,
}

// 사용자가 별도 경로를 지정하지 않으면 설치된 Codex 명령을 찾는다.
fn codex_executable() -> String {
    "codex".into()
}

// 사용량 알림은 기본 10퍼센트 간격으로 설정한다.
fn usage_percent() -> u8 {
    10
}

// 모델을 호출하지 않는 한도 조회의 기본 간격을 제공한다.
fn poll_seconds() -> u64 {
    60
}

// 소진·복구·수동 재조회 결과 알림은 기본으로 켠다.
fn enabled() -> bool {
    true
}

// Slack에서 처리할 초기 수신 이벤트 종류를 반환한다.
fn slack_events() -> Vec<String> {
    [
        "message",
        "app_mention",
        "reaction_added",
        "reaction_removed",
    ]
    .map(String::from)
    .to_vec()
}

impl SourceConfig {
    // 연결 설정의 종류를 비밀값 없이 식별한다.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Docker { .. } => "docker",
            Self::Slack { .. } => "slack",
            Self::Codex { .. } => "codex",
            Self::Claude { .. } => "claude",
        }
    }

    // 사용자 입력의 형식과 수신 범위를 네트워크 연결 전에 검증한다.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Docker {
                endpoint,
                containers,
                actions,
            } => {
                if endpoint.len() > 1024 || containers.len() > 100 || actions.len() > 100 {
                    return Err("Docker 연결 설정이 너무 큽니다".into());
                }
                if endpoint != "local" {
                    let url =
                        reqwest::Url::parse(endpoint).map_err(|_| "Docker 주소를 확인하세요")?;
                    if !["unix", "npipe", "http", "https", "tcp"].contains(&url.scheme())
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.query().is_some()
                        || url.fragment().is_some()
                    {
                        return Err(
                            "Docker는 local·unix·npipe·http(s)·tcp 주소만 지원합니다".into()
                        );
                    }
                    if ["http", "https", "tcp"].contains(&url.scheme())
                        && (url.host_str().is_none() || url.path() != "/" && !url.path().is_empty())
                    {
                        return Err("Docker 호스트 주소에는 API 경로를 넣지 마세요".into());
                    }
                }
                if containers
                    .iter()
                    .chain(actions)
                    .any(|v| v.is_empty() || v.len() > 256 || v.chars().any(char::is_control))
                {
                    return Err("Docker 컨테이너와 동작 필터를 확인하세요".into());
                }
            }
            Self::Slack {
                team_id,
                channels,
                event_types,
            } => {
                if !slack_id(team_id, b"T")
                    || channels.is_empty()
                    || channels.len() > 100
                    || channels.iter().any(|id| !slack_id(id, b"CDG"))
                {
                    return Err("Slack 워크스페이스 ID와 수신할 채널 ID를 입력하세요".into());
                }
                if event_types.is_empty()
                    || event_types.len() > 4
                    || event_types
                        .iter()
                        .any(|name| !slack_events().contains(name))
                {
                    return Err("Slack 수신 이벤트 종류를 확인하세요".into());
                }
            }
            Self::Codex {
                executable,
                usage_percent,
                poll_seconds,
                ..
            } => {
                if executable.is_empty()
                    || executable.len() > 1024
                    || executable.chars().any(char::is_control)
                {
                    return Err("Codex 실행 파일 경로를 확인하세요".into());
                }
                if executable != "codex" && !std::path::Path::new(executable).is_absolute() {
                    return Err("Codex는 codex 또는 실행 파일의 절대 경로로 지정하세요".into());
                }
                if !(1..=100).contains(usage_percent) || !(30..=3600).contains(poll_seconds) {
                    return Err("사용량은 1~100%, 조회 간격은 30~3600초로 설정하세요".into());
                }
            }
            Self::Claude {
                session_key,
                usage_percent,
                ..
            } => {
                if session_key.len() != 64
                    || !session_key.bytes().all(|value| value.is_ascii_hexdigit())
                {
                    return Err("Claude Code 상태줄에서 전달받은 세션을 선택하세요.".into());
                }
                if !(1..=100).contains(usage_percent) {
                    return Err("사용량 알림 기준은 1~100%로 설정하세요.".into());
                }
            }
        }
        Ok(())
    }
}

// Slack 식별자가 제한된 영문 대문자·숫자 형식인지 확인한다.
fn slack_id(id: &str, prefixes: &[u8]) -> bool {
    (3..=64).contains(&id.len())
        && prefixes.contains(&id.as_bytes()[0])
        && id
            .bytes()
            .all(|v| v.is_ascii_uppercase() || v.is_ascii_digit())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDraft {
    pub id: Option<String>,
    pub name: String,
    pub config: SourceConfig,
    pub app_token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub config: SourceConfig,
    pub enabled: bool,
    pub state: String,
    pub last_error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_usage: Option<CodexUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_usage: Option<CodexUsage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub checked_at: i64,
    pub ordinary_usage_allowed: Option<bool>,
    pub windows: Vec<CodexWindow>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindow {
    pub key: String,
    pub label: String,
    pub used_percent: u8,
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub schema_version: u8,
    pub event_id: String,
    pub source_kind: String,
    pub connection_id: String,
    #[serde(default)]
    pub connection_name: String,
    pub occurred_at: i64,
    pub title: String,
    pub body: String,
    pub resource: String,
    pub data: BTreeMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEvent {
    pub id: String,
    pub r#type: String,
    pub kind: String,
    pub body: String,
    pub notification: Notification,
    pub created_at: i64,
    pub expires_at: i64,
    pub local: bool,
}

// 로컬 이벤트·연결 시각을 UTC Unix 밀리초로 계산한다.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// 공급자 본문을 UTF-8 경계를 유지하며 공통 알림 크기로 제한한다.
pub fn bounded(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max.saturating_sub(3);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}
