use super::types::{bounded, now_ms, Notification, Source, SourceConfig};
use super::{Engine, RunError};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use tokio_util::sync::CancellationToken;

const OPEN_URL: &str = "https://slack.com/api/apps.connections.open";

#[derive(Deserialize)]
struct OpenResponse {
    ok: bool,
    url: Option<String>,
}

#[derive(Deserialize)]
pub struct Envelope {
    #[serde(default)]
    pub r#type: String,
    pub envelope_id: Option<String>,
    pub payload: Option<Value>,
    pub reason: Option<String>,
}

#[derive(Serialize)]
struct Ack<'a> {
    envelope_id: &'a str,
}

// Slack 앱 토큰으로 수신 소켓 URL만 발급받고 비밀 응답을 오류에 포함하지 않는다.
pub async fn open_socket(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    test_transport: bool,
) -> Result<String, RunError> {
    // 1. 연결 개설 전용 POST에 토큰을 헤더로만 전달한다.
    let response = client
        .post(endpoint)
        .bearer_auth(token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body("")
        .send()
        .await
        .map_err(|_| RunError::new("Slack 연결 개설에 실패했습니다"))?;
    if response.status().as_u16() == 429 {
        let delay = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(30)
            .clamp(1, 86400);
        return Err(RunError {
            message: "Slack 요청 제한으로 대기합니다".into(),
            retry_after: Some(Duration::from_secs(delay)),
        });
    }
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 65536) {
        return Err(RunError::new("Slack 연결 인증 또는 응답을 확인하세요"));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RunError::new("Slack 연결 응답을 읽지 못했습니다"))?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err(RunError::new("Slack 연결 응답이 너무 큽니다"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let result: OpenResponse = serde_json::from_slice(&bytes)
        .map_err(|_| RunError::new("Slack 연결 응답 형식이 올바르지 않습니다"))?;
    let url = result
        .url
        .filter(|_| result.ok)
        .ok_or_else(|| RunError::new("Slack 앱 토큰 또는 Socket Mode 권한을 확인하세요"))?;

    // 2. 발급된 수신 소켓도 Slack의 암호화된 주소인지 검증한다.
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| RunError::new("Slack 소켓 주소가 올바르지 않습니다"))?;
    if !test_transport
        && (parsed.scheme() != "wss"
            || !parsed.host_str().is_some_and(|h| h.ends_with(".slack.com"))
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some_and(|port| port != 443))
    {
        return Err(RunError::new("Slack에서 허용된 수신 소켓 주소가 아닙니다"));
    }
    Ok(url)
}

// Slack Socket Mode를 개인 PC에서 직접 실행한다.
pub async fn run(
    engine: Arc<Engine>,
    source: &Source,
    cancel: &CancellationToken,
) -> Result<(), RunError> {
    let token = engine.token(&source.id).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| RunError::new("Slack HTTP 클라이언트를 준비하지 못했습니다"))?;
    stream(engine, source, cancel, &client, OPEN_URL, &token, false).await
}

// 수신 전용 프로토콜을 테스트 가능한 HTTP·WebSocket 경계로 실행한다.
pub async fn stream(
    engine: Arc<Engine>,
    source: &Source,
    cancel: &CancellationToken,
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    test_transport: bool,
) -> Result<(), RunError> {
    // 1. 임시 소켓을 개설하고 대용량 프레임과 무응답 연결을 제한한다.
    let connected_at = now_ms();
    let url = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = open_socket(client,endpoint,token,test_transport) => result?,
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let (mut socket, _) = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        result = tokio::time::timeout(Duration::from_secs(15),connect_async_with_config(&url,Some(config),false)) => result.map_err(|_|RunError::new("Slack 소켓 연결 시간이 초과됐습니다"))?.map_err(|_|RunError::new("Slack 수신 소켓을 열지 못했습니다"))?,
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut waiting_pong: Option<tokio::time::Instant> = None;

    // 2. 알림은 로컬 영속 저장 후 확인하며 외부 메시지·작업 응답을 보내지 않는다.
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = heartbeat.tick() => {
                if waiting_pong.is_some() {
                    return Err(RunError::new("Slack 연결 응답이 없어 재접속합니다"));
                }
                tokio::time::timeout(Duration::from_secs(5),socket.send(Message::Ping(Vec::new().into()))).await.map_err(|_|RunError::new("Slack 연결 확인 시간이 초과됐습니다"))?.map_err(|_|RunError::new("Slack 연결 확인에 실패했습니다"))?;
                waiting_pong = Some(tokio::time::Instant::now());
            }
            frame = socket.next() => {
                let message = frame.ok_or_else(||RunError::new("Slack 연결이 종료되어 재접속합니다"))?.map_err(|_|RunError::new("Slack 수신 연결이 끊겼습니다"))?;
                match message {
                    Message::Pong(_) => waiting_pong=None,
                    Message::Ping(data) => {
                        socket.send(Message::Pong(data)).await.map_err(|_|RunError::new("Slack 연결 응답 실패"))?;
                    }
                    Message::Text(data) => {
                        let envelope: Envelope = serde_json::from_str(&data).map_err(|_|RunError::new("Slack 수신 형식이 올바르지 않습니다"))?;
                        if envelope.r#type=="hello" {
                            engine.status(&source.id,"connected","");
                            continue;
                        }
                        if envelope.r#type=="disconnect" {
                            let description = if envelope.reason.as_deref()==Some("link_disabled") {"Slack Socket Mode가 비활성화되었습니다"} else {"Slack 연결을 갱신합니다"};
                            return Err(RunError::new(description));
                        }
                        let Some(envelope_id) = envelope.envelope_id.as_deref().filter(|id|!id.is_empty() && id.len()<=256) else {
                            continue;
                        };
                        if envelope.r#type=="events_api" {
                            if let Some(payload) = envelope.payload {
                                if let Some(notification) = normalize(source,&payload)? {
                                    if notification.occurred_at>=connected_at {
                                        engine.publish(notification,None)?;
                                    }
                                }
                            }
                        }
                        let ack = serde_json::to_string(&Ack { envelope_id }).map_err(|_|RunError::new("Slack 수신 확인 생성 실패"))?;
                        tokio::time::timeout(Duration::from_secs(3),socket.send(Message::Text(ack.into()))).await.map_err(|_|RunError::new("Slack 수신 확인 시간이 초과됐습니다"))?.map_err(|_|RunError::new("Slack 수신 확인이 끊겼습니다"))?;
                    }
                    Message::Close(_) => return Err(RunError::new("Slack 연결이 종료되어 재접속합니다")),
                    _ => {}
                }
            }
        }
    }
}

// 사용자가 지정한 워크스페이스·채널·이벤트만 공통 알림으로 변환한다.
pub fn normalize(source: &Source, payload: &Value) -> Result<Option<Notification>, RunError> {
    // 1. 앱 접근 범위에 더해 사용자가 선택한 수신 범위를 적용한다.
    let SourceConfig::Slack {
        team_id,
        channels,
        event_types,
    } = &source.config
    else {
        return Err(RunError::new("Slack 연결 설정이 필요합니다"));
    };
    if payload["type"] != "event_callback" || payload["team_id"].as_str() != Some(team_id.as_str())
    {
        return Ok(None);
    }
    let event = &payload["event"];
    let kind = event["type"].as_str().unwrap_or_default();
    let channel = event["channel"]
        .as_str()
        .or_else(|| event["item"]["channel"].as_str())
        .unwrap_or_default();
    if !event_types.iter().any(|name| name == kind) || !channels.iter().any(|id| id == channel) {
        return Ok(None);
    }
    let subtype = event["subtype"].as_str().unwrap_or_default();
    let content = if subtype == "message_changed" {
        &event["message"]
    } else {
        event
    };
    let user = content["user"].as_str().unwrap_or("Slack");
    let text = match kind {
        "message" | "app_mention" if subtype == "message_deleted" => {
            "메시지가 삭제되었습니다".to_string()
        }
        "message" | "app_mention" => {
            if ![
                "",
                "bot_message",
                "me_message",
                "file_share",
                "thread_broadcast",
                "message_changed",
            ]
            .contains(&subtype)
            {
                return Ok(None);
            }
            let text = content["text"].as_str().unwrap_or_default();
            if text.is_empty() {
                return Ok(None);
            }
            format!("{user}: {text}")
        }
        "reaction_added" | "reaction_removed" => {
            if event["item"]["type"] != "message" {
                return Ok(None);
            }
            format!(
                "{user}: :{}: 반응 {}",
                event["reaction"].as_str().unwrap_or_default(),
                if kind == "reaction_added" {
                    "추가"
                } else {
                    "삭제"
                }
            )
        }
        _ => return Ok(None),
    };

    // 2. 공급자 이벤트 ID로 중복을 판별하고 토큰·응답 URL을 제외한 데이터만 만든다.
    let event_id = payload["event_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "fallback:{:x}",
                Sha256::digest(format!("{team_id}\0{event}"))
            )
        });
    let occurred_at = event["event_ts"]
        .as_str()
        .or_else(|| event["ts"].as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| (value * 1000.0) as i64)
        .or_else(|| payload["event_time"].as_i64().map(|value| value * 1000))
        .unwrap_or_else(now_ms);
    let ts = content["ts"]
        .as_str()
        .or_else(|| event["item"]["ts"].as_str())
        .or_else(|| event["deleted_ts"].as_str())
        .unwrap_or_default();
    let data = BTreeMap::from([
        ("teamId".into(), team_id.clone()),
        ("channelId".into(), channel.to_string()),
        ("userId".into(), bounded(user, 128)),
        ("eventType".into(), kind.to_string()),
        ("subtype".into(), bounded(subtype, 128)),
        ("messageTs".into(), bounded(ts, 64)),
    ]);
    Ok(Some(Notification {
        schema_version: 1,
        event_id: bounded(&event_id, 256),
        source_kind: "slack".into(),
        connection_id: source.id.clone(),
        occurred_at,
        title: format!(
            "Slack · {}",
            if kind == "app_mention" {
                "멘션"
            } else if kind.starts_with("reaction_") {
                "반응"
            } else {
                "메시지"
            }
        ),
        body: bounded(&text, 8000),
        resource: format!("slack://channel?team={team_id}&id={channel}"),
        data,
    }))
}
