use super::types::{bounded, now_ms, Notification, Source, SourceConfig};
use super::{Engine, RunError};
use bollard::models::EventMessage;
use bollard::query_parameters::EventsOptionsBuilder;
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

// PC 로컬 소켓 또는 사용자가 입력한 호스트로 읽기 전용 호출에 사용할 클라이언트를 만든다.
pub fn client(endpoint: &str) -> Result<Docker, RunError> {
    // 1. 로컬 엔진은 Docker Desktop·루트리스 소켓과 Windows 파이프를 지원한다.
    if endpoint == "local" {
        #[cfg(unix)]
        for candidate in [
            std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .map(|p| format!("{p}/docker.sock")),
            std::env::var("HOME")
                .ok()
                .map(|p| format!("{p}/.docker/run/docker.sock")),
        ]
        .into_iter()
        .flatten()
        {
            if std::path::Path::new(&candidate).exists() {
                return Docker::connect_with_unix(&candidate, 15, API_DEFAULT_VERSION)
                    .map_err(|_| RunError::new("Docker 로컬 소켓을 열 수 없습니다"));
            }
        }
        return Docker::connect_with_local_defaults()
            .map_err(|_| RunError::new("Docker Desktop 또는 로컬 엔진 소켓을 확인하세요"));
    }

    // 2. SDK에 연결만 위임하고 외부 제어 API는 호출하지 않는다.
    Docker::connect_with_host(endpoint)
        .map_err(|_| RunError::new("Docker 주소 또는 로컬 인증서 설정을 확인하세요"))
}

// Docker Events 스트림을 수신하고 영속 커서 이후의 이벤트를 중복 제거한다.
pub async fn run(
    engine: Arc<Engine>,
    source: &Source,
    cancel: &CancellationToken,
) -> Result<(), RunError> {
    // 1. 마지막 수신 시점을 복구하고 엔진과 API 버전을 협상한다.
    let SourceConfig::Docker {
        endpoint,
        containers,
        actions,
    } = &source.config
    else {
        return Err(RunError::new("Docker 연결 종류가 일치하지 않습니다"));
    };
    let connected_at = now_ms();
    let since = (connected_at / 1000).to_string();
    let docker = client(endpoint)?;
    let docker = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = docker.negotiate_version() => result.map_err(|_|RunError::new("Docker Events API 연결에 실패했습니다. 엔진 실행·소켓 권한·API 버전을 확인하세요"))?,
    };
    let mut filters = HashMap::from([("type".to_string(), vec!["container".to_string()])]);
    if !containers.is_empty() {
        filters.insert("container".into(), containers.clone());
    }
    if !actions.is_empty() {
        filters.insert("event".into(), actions.clone());
    }
    let options = EventsOptionsBuilder::default()
        .since(&since)
        .filters(&filters)
        .build();
    let mut stream = docker.events(Some(options));
    engine.status(&source.id, "connected", "");

    // 2. 수신 알림과 커서를 같은 로컬 트랜잭션으로 저장한다.
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            next = stream.next() => next,
        };
        let event = next
            .ok_or_else(|| RunError::new("Docker 이벤트 스트림이 종료되어 재접속합니다"))?
            .map_err(|_| RunError::new("Docker 이벤트 수신이 끊겨 재접속합니다"))?;
        if let Some((notification, cursor)) = normalize(source, &event)? {
            if notification.occurred_at >= connected_at {
                engine.publish(notification, Some(&cursor))?;
            }
        }
    }
}

// 컨테이너 이벤트를 비밀 라벨·원본 엔드포인트가 없는 공통 알림으로 변환한다.
pub fn normalize(
    source: &Source,
    event: &EventMessage,
) -> Result<Option<(Notification, String)>, RunError> {
    // 1. 공급자 ID·시각과 필터를 검증한다.
    let SourceConfig::Docker {
        containers,
        actions,
        ..
    } = &source.config
    else {
        return Err(RunError::new("Docker 설정이 필요합니다"));
    };
    if serde_json::to_value(event.typ.as_ref())
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .as_deref()
        != Some("container")
    {
        return Ok(None);
    }
    let Some(actor) = &event.actor else {
        return Ok(None);
    };
    let id = actor.id.clone().unwrap_or_default();
    let action = event.action.clone().unwrap_or_default();
    let attributes = actor.attributes.clone().unwrap_or_default();
    let name = attributes
        .get("name")
        .cloned()
        .unwrap_or_else(|| id.chars().take(12).collect());
    if id.is_empty()
        || action.is_empty()
        || !containers.is_empty()
            && !containers.iter().any(|value| {
                id.starts_with(value)
                    || name == *value
                    || name.trim_start_matches('/') == value.trim_start_matches('/')
            })
        || !actions.is_empty()
            && !actions
                .iter()
                .any(|value| action == *value || action.starts_with(&format!("{value}:")))
    {
        return Ok(None);
    }
    let nano = event
        .time_nano
        .filter(|n| *n > 0)
        .unwrap_or_else(|| event.time.unwrap_or_default().saturating_mul(1_000_000_000));
    if nano <= 0 {
        return Err(RunError::new("Docker 이벤트 발생 시각이 올바르지 않습니다"));
    }

    // 2. 안정적인 중복 키를 만들고 알림에 필요한 속성만 복사한다.
    let key = format!(
        "docker:{:x}",
        Sha256::digest(format!("{id}\0{action}\0{nano}"))
    );
    let mut data = BTreeMap::from([
        ("containerId".into(), id.clone()),
        ("containerName".into(), bounded(&name, 256)),
        ("action".into(), bounded(&action, 256)),
    ]);
    for field in ["image", "exitCode"] {
        if let Some(value) = attributes.get(field) {
            data.insert(field.into(), bounded(value, 512));
        }
    }
    let notification = Notification {
        schema_version: 1,
        event_id: key,
        source_kind: "docker".into(),
        connection_id: source.id.clone(),
        occurred_at: nano / 1_000_000,
        title: bounded(&format!("Docker · {name}"), 200),
        body: bounded(&format!("{name}: {action}"), 8000),
        resource: format!("docker://container/{id}"),
        data,
    };
    Ok(Some((notification, (nano / 1_000_000_000).to_string())))
}
