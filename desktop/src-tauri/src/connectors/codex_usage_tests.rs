use super::*;
use serde_json::json;

// 실제 계정이나 네트워크 없이 기본 알림 정책을 사용하는 연결을 만든다.
fn source(mode: &str) -> Source {
    Source {
        id: "usage-source".into(),
        name: "내 Codex".into(),
        config: serde_json::from_value(json!({"kind":"codex","mode":mode})).unwrap(),
        enabled: true,
        state: "connected".into(),
        last_error: String::new(),
        codex_usage: None,
        claude_usage: None,
    }
}

// 공개 규격의 전체 조회를 만들며 허용 여부 null도 그대로 표현한다.
fn snapshot(percent: u8, reset: i64, allowed: Option<bool>) -> Value {
    json!({"rateLimits":{"limitId":"codex","primary":{"usedPercent":percent,"resetsAt":reset,"windowDurationMins":300}},"ordinaryUsageAllowed":allowed})
}

// 최초 기준·새 구간·재접속·큰 증가를 구분해 같은 구간을 반복 알리지 않는다.
#[test]
fn interval_baselines_and_coalesces_without_reconnect_duplicates() {
    // 1. 처음 연결한 현재 구간은 알리지 않는다.
    let source = source("interval");
    let first = evaluate(
        &source,
        "account-a",
        snapshot(27, 1000, None),
        None,
        false,
        100_000,
    )
    .unwrap();
    assert!(first.notifications.is_empty());

    // 2. 새 구간은 한 번만 알리고 영속 기준을 복원해도 중복하지 않는다.
    let crossing = evaluate(
        &source,
        "account-a",
        snapshot(30, 1000, None),
        Some(&first.cursor),
        false,
        110_000,
    )
    .unwrap();
    assert_eq!(crossing.notifications.len(), 1);
    let reconnect = evaluate(
        &source,
        "account-a",
        snapshot(31, 1000, None),
        Some(&crossing.cursor),
        false,
        120_000,
    )
    .unwrap();
    assert!(reconnect.notifications.is_empty());
    let jump = evaluate(
        &source,
        "account-a",
        snapshot(71, 1000, None),
        Some(&reconnect.cursor),
        false,
        130_000,
    )
    .unwrap();
    assert_eq!(jump.notifications.len(), 1);
    assert!(jump.notifications[0].body.contains("70%"));
    assert!(jump.notifications[0].body.contains("29% 남음"));
    assert_ne!(
        crossing.notifications[0].event_id,
        jump.notifications[0].event_id
    );
}

// 1회 모드는 리셋 시각의 단순 변경으로 반복하지 않고 실제 새 주기에만 다시 알린다.
#[test]
fn once_rearms_only_after_cycle_transition() {
    let source = source("once");
    let first = evaluate(&source, "a", snapshot(20, 1000, None), None, false, 100_000).unwrap();
    assert_eq!(first.notifications.len(), 1);
    let drift = evaluate(
        &source,
        "a",
        snapshot(25, 1010, None),
        Some(&first.cursor),
        false,
        110_000,
    )
    .unwrap();
    assert!(drift.notifications.is_empty());
    let reset = evaluate(
        &source,
        "a",
        snapshot(0, 2000, None),
        Some(&drift.cursor),
        false,
        1_020_000,
    )
    .unwrap();
    assert!(reset.notifications.is_empty());
    let next = evaluate(
        &source,
        "a",
        snapshot(10, 2000, None),
        Some(&reset.cursor),
        false,
        1_030_000,
    )
    .unwrap();
    assert_eq!(next.notifications.len(), 1);
}

// 소진·복구는 각각 한 번이며 사용률 감소나 null만으로 복구했다고 알리지 않는다.
#[test]
fn recovery_requires_explicit_permission_after_exhaustion() {
    let source = source("interval");
    let exhausted = evaluate(
        &source,
        "a",
        snapshot(100, 1000, Some(false)),
        None,
        false,
        100_000,
    )
    .unwrap();
    assert_eq!(exhausted.notifications[0].title, "Codex 한도 소진");
    let repeated = evaluate(
        &source,
        "a",
        snapshot(100, 1000, Some(false)),
        Some(&exhausted.cursor),
        false,
        110_000,
    )
    .unwrap();
    assert!(repeated.notifications.is_empty());
    let unknown = evaluate(
        &source,
        "a",
        snapshot(0, 2000, None),
        Some(&repeated.cursor),
        false,
        1_010_000,
    )
    .unwrap();
    assert!(unknown.notifications.is_empty());
    let recovered = evaluate(
        &source,
        "a",
        snapshot(0, 2000, Some(true)),
        Some(&unknown.cursor),
        false,
        1_020_000,
    )
    .unwrap();
    assert_eq!(recovered.notifications[0].title, "Codex 사용 가능 확인");
    let steady = evaluate(
        &source,
        "a",
        snapshot(0, 2000, Some(true)),
        Some(&recovered.cursor),
        false,
        1_030_000,
    )
    .unwrap();
    assert!(steady.notifications.is_empty());
}

// 명시적 사용 불가가 사용률 없이 제공돼도 소진을 감지하고 같은 원인을 중복하지 않는다.
#[test]
fn explicit_block_and_backend_reason_share_one_exhaustion() {
    let source = source("interval");
    let blocked = evaluate(
        &source,
        "a",
        json!({"rateLimits":{},"ordinaryUsageAllowed":false}),
        None,
        false,
        100_000,
    )
    .unwrap();
    assert_eq!(blocked.notifications[0].title, "Codex 한도 소진");
    let reason = evaluate(&source, "a", json!({"rateLimits":{"rateLimitReachedType":"workspace_owner_credits_depleted"},"ordinaryUsageAllowed":false}), Some(&blocked.cursor), false, 110_000).unwrap();
    assert!(reason.notifications.is_empty());
}

// 호환 단일 버킷과 다중 버킷을 함께 받아도 같은 사용량을 이중으로 표시하지 않는다.
#[test]
fn multi_bucket_view_takes_precedence() {
    let source = source("interval");
    let mut raw = snapshot(90, 1000, None);
    raw["rateLimitsByLimitId"] =
        json!({"codex":{"limitId":"codex","primary":{"usedPercent":20,"windowDurationMins":300}}});
    let result = evaluate(&source, "a", raw, None, true, 100_000).unwrap();
    assert_eq!(result.usage.windows.len(), 1);
    assert_eq!(result.usage.windows[0].used_percent, 20);
    assert_eq!(result.notifications.len(), 1);
    assert_eq!(result.notifications[0].title, "Codex 사용량 재조회");
}

// 다른 계정의 과거 사용량은 새 계정의 구간 통과로 해석하지 않는다.
#[test]
fn account_switch_starts_fresh_baseline() {
    let source = source("interval");
    let old = evaluate(&source, "a", snapshot(5, 1000, None), None, false, 100_000).unwrap();
    let current = evaluate(
        &source,
        "b",
        snapshot(80, 1000, None),
        Some(&old.cursor),
        false,
        110_000,
    )
    .unwrap();
    assert!(current.notifications.is_empty());
    assert!(!current.cursor.contains("accountId"));
}

// 수동 결과 알림을 끄면 수치를 갱신하되 별도 결과 알림은 만들지 않는다.
#[test]
fn manual_summary_can_be_disabled() {
    let mut source = source("interval");
    if let SourceConfig::Codex {
        notify_on_refresh, ..
    } = &mut source.config
    {
        *notify_on_refresh = false;
    }
    let result = evaluate(&source, "a", snapshot(25, 1000, None), None, true, 100_000).unwrap();
    assert!(result.notifications.is_empty());
    assert_eq!(result.usage.windows[0].used_percent, 25);
}

// Claude는 소진된 창의 누락·만료를 여유로 보지 않고 실제 전달된 새 잔여량만 확인한다.
#[test]
fn claude_recovery_waits_for_all_exhausted_windows() {
    // 1. 같은 세션의 두 한도를 소진한 상태로 시작한다.
    let mut source = source("interval");
    source.config =
        serde_json::from_value(json!({"kind":"claude","sessionKey":"a".repeat(64)})).unwrap();
    let usage = CodexUsage {
        checked_at: 100_000,
        ordinary_usage_allowed: None,
        windows: vec![
            CodexWindow {
                key: "five_hour".into(),
                label: "5시간".into(),
                used_percent: 100,
                resets_at: Some(1000),
                window_duration_mins: Some(300),
            },
            CodexWindow {
                key: "seven_day".into(),
                label: "7일".into(),
                used_percent: 100,
                resets_at: Some(2000),
                window_duration_mins: Some(10080),
            },
        ],
    };
    let first = evaluate_snapshot(
        &source,
        "session",
        usage.clone(),
        false,
        None,
        false,
        100_000,
    )
    .unwrap();
    assert_eq!(first.notifications[0].title, "Claude 한도 소진");

    // 2. 일부 한도만 전달되면 다른 소진 한도가 남았으므로 복구하지 않는다.
    let mut partial = usage.clone();
    partial.windows.truncate(1);
    partial.windows[0].used_percent = 0;
    let missing = evaluate_snapshot(
        &source,
        "session",
        partial,
        false,
        Some(&first.cursor),
        false,
        110_000,
    )
    .unwrap();
    assert!(missing.notifications.is_empty());

    // 3. 모든 소진 한도에 실제 여유가 전달되면 한 번만 확인 알림을 보낸다.
    let mut recovered = usage;
    for window in &mut recovered.windows {
        window.used_percent = 0;
    }
    let confirmed = evaluate_snapshot(
        &source,
        "session",
        recovered.clone(),
        false,
        Some(&missing.cursor),
        false,
        120_000,
    )
    .unwrap();
    assert_eq!(confirmed.notifications[0].title, "Claude 사용량 여유 확인");
    let repeated = evaluate_snapshot(
        &source,
        "session",
        recovered,
        false,
        Some(&confirmed.cursor),
        false,
        130_000,
    )
    .unwrap();
    assert!(repeated.notifications.is_empty());
}
