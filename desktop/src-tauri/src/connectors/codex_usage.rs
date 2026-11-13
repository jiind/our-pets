use super::types::{
    bounded, CodexUsage, CodexWindow, Notification, Source, SourceConfig, UsageMode,
};
use super::RunError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
#[path = "codex_usage_tests.rs"]
mod tests;

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct WindowState {
    reset: Option<i64>,
    used: u8,
    highest: u8,
    once_sent: bool,
    exhausted_sent: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    version: u8,
    signature: String,
    epoch: String,
    sequence: u64,
    windows: BTreeMap<String, WindowState>,
    last_allowed: Option<bool>,
    had_exhaustion: bool,
    backend_seen: bool,
    claude_exhausted: BTreeSet<String>,
    usage: Option<CodexUsage>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bucket {
    limit_id: Option<String>,
    limit_name: Option<String>,
    primary: Option<Window>,
    secondary: Option<Window>,
    rate_limit_reached_type: Option<String>,
    spend_control_reached: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    used_percent: i64,
    resets_at: Option<i64>,
    window_duration_mins: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    rate_limits: Bucket,
    rate_limits_by_limit_id: Option<BTreeMap<String, Bucket>>,
    ordinary_usage_allowed: Option<bool>,
}

pub struct Decision {
    pub cursor: String,
    pub notifications: Vec<Notification>,
    pub usage: CodexUsage,
}

// 계정·설정은 되돌릴 수 없는 지문으로만 비교하고 인증정보를 저장하지 않는다.
pub fn fingerprint(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// 공급자 설정과 관측 대상을 동일한 기준으로 구분한다.
fn context_signature(source: &Source, identity: &str) -> String {
    fingerprint(&format!(
        "{}:{identity}",
        serde_json::to_string(&source.config).unwrap_or_default()
    ))
}

// 같은 설정과 대상에 속한 이전 관측 시각만 반환한다.
pub(super) fn previous_checked_at(source: &Source, identity: &str, previous: &str) -> Option<i64> {
    let state: State = serde_json::from_str(previous).ok()?;
    (state.version == 1 && state.signature == context_signature(source, identity))
        .then_some(state.usage?)
        .map(|usage| usage.checked_at)
}

// 서버가 제공한 한도 길이를 고정된 5시간·주간 가정 없이 표시한다.
fn duration_label(minutes: Option<i64>, fallback: &str) -> String {
    match minutes.filter(|value| *value > 0) {
        Some(value) if value % 1440 == 0 => format!("{}일", value / 1440),
        Some(value) if value % 60 == 0 => format!("{}시간", value / 60),
        Some(value) => format!("{value}분"),
        None => fallback.into(),
    }
}

// 신뢰한 전체 조회만 정규화하며 부분 이벤트의 null로 기존 한도를 덮어쓰지 않는다.
fn normalize(raw: Value, now: i64) -> Result<(CodexUsage, bool), RunError> {
    // 1. 단일·다중 한도 형식을 구분하고 호환 필드로 같은 한도를 중복 표시하지 않는다.
    let snapshot: Snapshot = serde_json::from_value(raw).map_err(|_| {
        RunError::new("Codex 사용량 응답 형식을 확인할 수 없습니다. Codex를 업데이트하세요.")
    })?;
    let buckets = snapshot
        .rate_limits_by_limit_id
        .filter(|buckets| !buckets.is_empty())
        .unwrap_or_else(|| BTreeMap::from([("codex".into(), snapshot.rate_limits)]));
    if buckets.len() > 32 {
        return Err(RunError::new("Codex 한도 목록이 지원 범위를 초과했습니다."));
    }
    let mut windows = Vec::new();
    let mut reached = false;

    // 2. 계정 ID·크레딧·원본 오류를 제외하고 표시할 사용률과 시각만 추린다.
    for (key, bucket) in buckets {
        reached |= bucket.spend_control_reached == Some(true)
            || bucket
                .rate_limit_reached_type
                .as_deref()
                .is_some_and(|value| {
                    [
                        "rate_limit_reached",
                        "workspace_owner_credits_depleted",
                        "workspace_member_credits_depleted",
                        "workspace_owner_usage_limit_reached",
                        "workspace_member_usage_limit_reached",
                    ]
                    .contains(&value)
                });
        let id = bounded(bucket.limit_id.as_deref().unwrap_or(&key), 100);
        let label =
            bounded(bucket.limit_name.as_deref().unwrap_or(&id), 60).replace(['\n', '\r'], " ");
        for (role, window) in [("primary", bucket.primary), ("secondary", bucket.secondary)] {
            if let Some(window) = window {
                windows.push(CodexWindow {
                    key: format!("{id}/{role}"),
                    label: format!(
                        "{label} · {}",
                        duration_label(
                            window.window_duration_mins,
                            if role == "primary" {
                                "1차 한도"
                            } else {
                                "2차 한도"
                            }
                        )
                    ),
                    used_percent: window.used_percent.clamp(0, 100) as u8,
                    resets_at: window.resets_at.filter(|value| *value > 0),
                    window_duration_mins: window.window_duration_mins.filter(|value| *value > 0),
                });
            }
        }
    }
    Ok((
        CodexUsage {
            checked_at: now,
            ordinary_usage_allowed: snapshot.ordinary_usage_allowed,
            windows,
        },
        reached,
    ))
}

// 현재 전체 조회와 영속 기준을 비교해 한 번의 알림 및 새 기준을 함께 결정한다.
pub fn evaluate(
    source: &Source,
    identity: &str,
    raw: Value,
    previous: Option<&str>,
    manual: bool,
    now: i64,
) -> Result<Decision, RunError> {
    let (usage, backend_reached) = normalize(raw, now)?;
    evaluate_snapshot(
        source,
        identity,
        usage,
        backend_reached,
        previous,
        manual,
        now,
    )
}

// 정규화된 사용량에 공통 간격·주기·중복 정책을 적용하고 공급자별 복구 근거를 구분한다.
pub fn evaluate_snapshot(
    source: &Source,
    identity: &str,
    usage: CodexUsage,
    backend_reached: bool,
    previous: Option<&str>,
    manual: bool,
    now: i64,
) -> Result<Decision, RunError> {
    // 1. 다른 계정이나 수정한 규칙의 과거 상태를 섞지 않는다.
    let (mode, usage_percent, notify_exhausted, notify_recovered, notify_on_refresh) =
        match &source.config {
            SourceConfig::Codex {
                mode,
                usage_percent,
                notify_exhausted,
                notify_recovered,
                notify_on_refresh,
                ..
            }
            | SourceConfig::Claude {
                mode,
                usage_percent,
                notify_exhausted,
                notify_recovered,
                notify_on_refresh,
                ..
            } => (
                mode,
                usage_percent,
                notify_exhausted,
                notify_recovered,
                notify_on_refresh,
            ),
            _ => return Err(RunError::new("사용량 연결이 아닙니다.")),
        };
    let kind = source.config.kind();
    let provider = if kind == "claude" { "Claude" } else { "Codex" };
    if !(1..=100).contains(usage_percent) {
        return Err(RunError::new("사용량 알림 기준은 1~100%로 설정하세요."));
    }
    let signature = context_signature(source, identity);
    let mut state = previous
        .and_then(|value| serde_json::from_str::<State>(value).ok())
        .filter(|value| value.version == 1 && value.signature == signature)
        .unwrap_or_else(|| State {
            version: 1,
            signature,
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            ..State::default()
        });
    let previous_allowed = state.last_allowed;
    let mut usage_changes = Vec::new();
    let mut new_exhaustion = backend_reached && !state.backend_seen && !state.had_exhaustion;

    // 2. 리셋 시각의 단순 이동은 새 주기로 세지 않고 실제 주기 전환만 재무장한다.
    for window in &usage.windows {
        if kind == "claude" {
            if window.used_percent >= 100 {
                state.claude_exhausted.insert(window.key.clone());
            } else if window.resets_at.is_some_and(|reset| reset > now / 1000) {
                state.claude_exhausted.remove(&window.key);
            }
        }
        let existed = state.windows.contains_key(&window.key);
        let item = state.windows.entry(window.key.clone()).or_default();
        let reset = if existed {
            match (item.reset, window.resets_at) {
                (Some(old), Some(next)) => {
                    next > old && (old <= now / 1000 || window.used_percent + 1 < item.used)
                }
                (None, _) => item.used > 0 && window.used_percent == 0,
                _ => false,
            }
        } else {
            false
        };
        if reset {
            *item = WindowState::default();
        }
        let step = window.used_percent / *usage_percent;
        if *mode == UsageMode::Interval {
            if (existed || reset) && step > item.highest && step > 0 {
                usage_changes.push(format!(
                    "{}: 사용 {}% 구간 통과 · {}% 남음",
                    window.label,
                    step * *usage_percent,
                    100 - window.used_percent
                ));
            }
            item.highest = item.highest.max(step);
        } else if !item.once_sent && window.used_percent >= *usage_percent {
            usage_changes.push(format!(
                "{}: 설정한 사용 {}% 도달 · {}% 남음",
                window.label,
                usage_percent,
                100 - window.used_percent
            ));
            item.once_sent = true;
        }
        if window.used_percent >= 100 && !item.exhausted_sent {
            new_exhaustion = true;
            item.exhausted_sent = true;
        }
        item.reset = window.resets_at.or(item.reset);
        item.used = window.used_percent;
    }

    // 3. Codex의 명시적 허용과 Claude의 실제 잔여량 전달을 구분하고 예상 리셋은 쓰지 않는다.
    new_exhaustion |=
        usage.ordinary_usage_allowed == Some(false) && previous_allowed != Some(false);
    if new_exhaustion {
        state.had_exhaustion = true;
    }
    let confirmed = if kind == "claude" {
        state.claude_exhausted.is_empty()
            && !usage.windows.is_empty()
            && usage.windows.iter().all(|window| {
                window.used_percent < 100
                    && window.resets_at.is_some_and(|reset| reset > now / 1000)
            })
    } else {
        usage.ordinary_usage_allowed == Some(true)
            && (previous_allowed == Some(false)
                || (!backend_reached
                    && usage.windows.iter().all(|window| window.used_percent < 100)))
    };
    let recovered = state.had_exhaustion && confirmed;
    if recovered {
        state.had_exhaustion = false;
    }
    state.backend_seen =
        backend_reached || (state.backend_seen && usage.ordinary_usage_allowed != Some(true));
    if let Some(allowed) = usage.ordinary_usage_allowed {
        state.last_allowed = Some(allowed);
    }
    let mut lines: Vec<_> = usage
        .windows
        .iter()
        .map(|window| format!("{}: {}% 남음", window.label, 100 - window.used_percent))
        .collect();
    lines.push(if kind == "claude" {
        "Claude Code 상태줄이 전달한 값이에요. 원격 사용 허용 여부는 별도로 확인하지 않아요.".into()
    } else {
        match usage.ordinary_usage_allowed {
            Some(true) => "Codex가 사용 가능 상태를 확인했어요.",
            Some(false) => "Codex가 현재 사용을 허용하지 않아요.",
            None => "현재 사용 가능 여부는 제공되지 않았어요.",
        }
        .into()
    });

    // 4. 같은 조회의 여러 조건은 한 카드로 합치고 수동 조회는 현재 상태를 우선한다.
    let title = if manual && *notify_on_refresh {
        Some(if kind == "claude" {
            "최신 사용량 확인"
        } else {
            "사용량 재조회"
        })
    } else if new_exhaustion && *notify_exhausted {
        Some("한도 소진")
    } else if recovered && *notify_recovered {
        Some(if kind == "claude" {
            "사용량 여유 확인"
        } else {
            "사용 가능 확인"
        })
    } else if !usage_changes.is_empty() {
        Some("사용량 알림")
    } else {
        None
    };
    state.sequence = state.sequence.wrapping_add(1);
    let notifications = title
        .map(|title| Notification {
            schema_version: 1,
            event_id: format!("{kind}:{}:{}", state.epoch, state.sequence),
            source_kind: kind.into(),
            connection_id: source.id.clone(),
            connection_name: source.name.clone(),
            occurred_at: now,
            title: format!("{provider} {title}"),
            body: bounded(
                &if title == "사용량 알림" {
                    usage_changes.join("\n")
                } else {
                    lines.join("\n")
                },
                6000,
            ),
            resource: format!("{kind}://account/rate-limits"),
            data: BTreeMap::new(),
        })
        .into_iter()
        .collect();
    state.usage = Some(usage.clone());
    let cursor = serde_json::to_string(&state)
        .map_err(|_| RunError::new("사용량 기준을 저장하지 못했어요."))?;
    Ok(Decision {
        cursor,
        notifications,
        usage,
    })
}
