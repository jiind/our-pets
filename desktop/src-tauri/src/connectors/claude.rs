use super::claude_bridge::read_snapshot;
use super::codex::RefreshRequest;
use super::codex_usage::{evaluate_snapshot, previous_checked_at};
use super::types::{now_ms, CodexUsage, Source, SourceConfig};
use super::{Engine, RunError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

// 새 상태줄 관측값만 평가하고 오래된 캐시를 새로운 원격 조회로 표현하지 않는다.
fn refresh(
    engine: &Engine,
    source: &Source,
    manual: Option<&RefreshRequest>,
) -> Result<Option<CodexUsage>, RunError> {
    // 1. 사용자가 선택한 세션만 읽으며 누락·만료 한도를 사용 가능으로 추정하지 않는다.
    let SourceConfig::Claude { session_key, .. } = &source.config else {
        return Err(RunError::new("Claude 연결이 아닙니다."));
    };
    let snapshot = read_snapshot(&engine.store.directory.join("claude-bridge"), session_key).ok();
    let now = now_ms();
    let snapshot = snapshot.filter(|snapshot| {
        snapshot.usage.checked_at <= now + 5000
            && snapshot.usage.checked_at >= now - 60000
            && !snapshot.usage.windows.is_empty()
            && snapshot
                .usage
                .windows
                .iter()
                .all(|window| window.resets_at.is_some_and(|reset| reset > now / 1000))
    });
    let Some(snapshot) = snapshot else {
        engine.status(
            &source.id,
            "waiting",
            "Claude 상태줄의 최신 사용량을 기다리고 있어요. Claude Code의 활동 후 다시 확인하세요.",
        );
        return Ok(None);
    };
    let previous = engine.store.cursor(&source.id).map_err(RunError::new)?;
    let previous_at = previous
        .as_deref()
        .and_then(|value| previous_checked_at(source, session_key, value));
    if manual.is_none() && previous_at.is_some_and(|at| at >= snapshot.usage.checked_at) {
        engine.status(&source.id, "connected", "");
        return Ok(Some(snapshot.usage));
    }

    // 2. 수동 결과·구간·소진·여유 확인을 공통 원자 저장 및 말풍선·OS 경로로 전달한다.
    let manual_alert = manual
        .is_some_and(|request| request.deadline > Instant::now() && !request.reply.is_closed());
    let observed = snapshot.usage.checked_at;
    let decision = evaluate_snapshot(
        source,
        session_key,
        snapshot.usage,
        false,
        previous.as_deref(),
        manual_alert,
        if manual_alert { now } else { observed },
    )?;
    let changed = engine
        .store
        .publish_many(&source.id, decision.notifications, Some(&decision.cursor))
        .map_err(RunError::new)?;
    if changed > 0 {
        (engine.notify)();
    }
    (engine.status_changed)();
    engine.status(&source.id, "connected", "");
    Ok(Some(decision.usage))
}

// 로컬 상태줄 파일을 감시하며 모델 호출·외부 네트워크·Claude 로그인 변경을 수행하지 않는다.
pub async fn run(
    engine: Arc<Engine>,
    source: &Source,
    cancel: &CancellationToken,
    requests: &mut mpsc::Receiver<RefreshRequest>,
) -> Result<(), RunError> {
    // 1. 고정 지문과 알림 기준을 검증하고 가벼운 로컬 감시 주기를 준비한다.
    source.config.validate().map_err(RunError::new)?;
    let mut poll = tokio::time::interval(Duration::from_secs(2));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // 2. 중지·수동 확인·새 관측값을 직렬 처리해 같은 세션의 중복 평가를 막는다.
    loop {
        let manual = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = poll.tick() => None,
            request = requests.recv() => {
                let Some(request) = request else {
                    return Ok(());
                };
                if request.deadline <= Instant::now() || request.reply.is_closed() {
                    continue;
                }
                Some(request)
            }
        };
        let result = refresh(&engine, source, manual.as_ref());
        if let Some(request) = manual {
            let response = match &result {
                Ok(Some(usage)) => Ok(usage.clone()),
                Ok(None) => Err(
                    "새 Claude 사용량이 없어요. Claude Code 상태줄의 다음 전달 후 확인하세요."
                        .into(),
                ),
                Err(error) => Err(error.message.clone()),
            };
            let _ = request.reply.send(response);
        }
        result?;
    }
}
