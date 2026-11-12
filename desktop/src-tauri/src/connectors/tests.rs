use super::types::{now_ms, SourceConfig};
use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

// 격리된 가짜 CLI의 사용량을 실제 수집기와 공통 알림 저장소까지 전달한다.
#[cfg(unix)]
#[tokio::test]
async fn codex_simulated_stdio_refresh_reaches_notifications() {
    use std::os::unix::fs::PermissionsExt;

    // 1. 허용된 읽기 요청만 응답하는 독립 실행 파일을 준비한다.
    let (directory, engine, _, _) = fixture();
    let executable = directory.path().join("fake-codex");
    std::fs::write(&executable, r##"#!/usr/bin/python3
import json, sys
assert sys.argv[1:] == ['app-server', '--listen', 'stdio://']
queries = 0
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialized':
        continue
    assert method in ('initialize', 'account/read', 'account/rateLimits/read')
    if method == 'account/read':
        assert request['params'] == {'refreshToken': False}
        result = {'account': {'type': 'chatgpt', 'email': 'synthetic@example.invalid'}}
    elif method == 'account/rateLimits/read':
        queries += 1
        result = {'rateLimits': {'limitId': 'codex', 'primary': {'usedPercent': 20 if queries == 1 else 35, 'windowDurationMins': 300}}}
    else:
        result = {}
    print(json.dumps({'id': request['id'], 'result': result}), flush=True)
"##).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config: SourceConfig =
        serde_json::from_value(json!({"kind":"codex","executable":executable})).unwrap();
    engine
        .store
        .save("codex-one", "Codex", &config, None)
        .unwrap();

    // 2. 최초 기준과 수동 재조회 결과를 실제 엔진에서 확인한다.
    engine.start("codex-one").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.store.source("codex-one").unwrap().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(engine.store.events(true).unwrap().is_empty());
    let usage = engine.refresh_codex("codex-one").await.unwrap();
    assert_eq!(usage.windows[0].used_percent, 35);
    assert!(!engine.store.events(true).unwrap().is_empty());
    engine.stop("codex-one").await;
}

// 없는 실행 파일은 외부 프로세스나 계정 조회 없이 정제된 오류로 처리한다.
#[tokio::test]
async fn codex_missing_executable_reports_error_without_starting_process() {
    let (directory, engine, _, _) = fixture();
    let missing = directory.path().join("missing-codex");
    let config: SourceConfig =
        serde_json::from_value(json!({"kind":"codex","executable":missing})).unwrap();
    engine
        .store
        .save("codex-one", "Codex", &config, None)
        .unwrap();
    let source = engine.store.source("codex-one").unwrap();
    let (_sender, mut requests) = tokio::sync::mpsc::channel(1);
    let error = codex::run(engine, &source, &CancellationToken::new(), &mut requests)
        .await
        .unwrap_err();
    assert!(error.message.contains("실행 파일"));
    assert!(!error
        .message
        .contains(&missing.to_string_lossy().to_string()));
}

// 서로 다른 상태줄 세션을 선택할 때 사용량과 알림 기준을 섞지 않는다.
#[tokio::test]
async fn claude_selected_session_uses_its_own_snapshot_and_baseline() {
    // 1. 세션별 상태줄 입력을 정규화하고 독립 파일에 저장한다.
    let (_directory, engine, _, _) = fixture();
    let directory = engine.store.directory.join("claude-bridge");
    std::fs::create_dir_all(&directory).unwrap();
    let now = now_ms();
    let first = claude_bridge::normalize(&json!({"session_id":"session-a","rate_limits":{"five_hour":{"used_percentage":20,"resets_at":now/1000+3600}}}), now).unwrap();
    let second = claude_bridge::normalize(&json!({"session_id":"session-b","rate_limits":{"five_hour":{"used_percentage":80,"resets_at":now/1000+3600}}}), now).unwrap();
    assert_ne!(first.session_key, second.session_key);
    for snapshot in [&first, &second] {
        std::fs::write(
            directory.join(format!("{}.json", snapshot.session_key)),
            serde_json::to_vec(snapshot).unwrap(),
        )
        .unwrap();
    }
    let config = |key: &str| {
        serde_json::from_value::<SourceConfig>(json!({"kind":"claude","sessionKey":key})).unwrap()
    };
    engine
        .store
        .save("claude-one", "Claude", &config(&first.session_key), None)
        .unwrap();

    // 2. 첫 세션을 수집하고 수동 조회의 실제 값과 알림을 확인한다.
    engine.start("claude-one").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.store.source("claude-one").unwrap().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        engine
            .refresh_usage("claude-one", "claude")
            .await
            .unwrap()
            .windows[0]
            .used_percent,
        20
    );
    let old_cursor = engine.store.cursor("claude-one").unwrap().unwrap();
    let old_count = engine.store.events(true).unwrap().len();

    // 3. 세션 교체 후 기존 기준을 재사용하지 않고 선택한 값만 반환한다.
    engine.stop("claude-one").await;
    engine
        .store
        .save("claude-one", "Claude", &config(&second.session_key), None)
        .unwrap();
    engine.start("claude-one").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.store.source("claude-one").unwrap().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(
        engine.store.cursor("claude-one").unwrap().unwrap(),
        old_cursor
    );
    assert_eq!(engine.store.events(true).unwrap().len(), old_count);
    assert_eq!(
        engine
            .refresh_usage("claude-one", "claude")
            .await
            .unwrap()
            .windows[0]
            .used_percent,
        80
    );
    assert_eq!(engine.store.events(true).unwrap().len(), old_count + 1);
    let same_cursor = engine.store.cursor("claude-one").unwrap().unwrap();
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(
        engine.store.cursor("claude-one").unwrap().unwrap(),
        same_cursor
    );
    assert_eq!(engine.store.events(true).unwrap().len(), old_count + 1);

    // 4. 같은 관측값이라도 설정을 바꾸면 새 기준을 세운다.
    engine.stop("claude-one").await;
    let changed: SourceConfig = serde_json::from_value(
        json!({"kind":"claude","sessionKey":second.session_key,"usagePercent":20}),
    )
    .unwrap();
    engine
        .store
        .save("claude-one", "Claude", &changed, None)
        .unwrap();
    engine.start("claude-one").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.store.source("claude-one").unwrap().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_ne!(
        engine.store.cursor("claude-one").unwrap().unwrap(),
        same_cursor
    );
    assert_eq!(engine.store.events(true).unwrap().len(), old_count + 1);
    engine.stop("claude-one").await;

    // 5. 더 오래된 유효 관측값도 다른 세션을 선택하면 새 기준으로 읽는다.
    let mut older = first.clone();
    older.usage.checked_at = now - 1000;
    std::fs::write(
        directory.join(format!("{}.json", older.session_key)),
        serde_json::to_vec(&older).unwrap(),
    )
    .unwrap();
    engine
        .store
        .save("claude-one", "Claude", &config(&first.session_key), None)
        .unwrap();
    engine.start("claude-one").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while engine.store.source("claude-one").unwrap().state != "connected" {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let cursor: Value =
        serde_json::from_str(&engine.store.cursor("claude-one").unwrap().unwrap()).unwrap();
    assert_eq!(cursor["usage"]["windows"][0]["usedPercent"], 20);
    assert_eq!(cursor["usage"]["checkedAt"], now - 1000);
    assert_eq!(engine.store.events(true).unwrap().len(), old_count + 1);
    engine.stop("claude-one").await;
}

// 갱신 후 새 소켓에서 중복 제거와 수신 확인을 검증한다.
#[tokio::test]
async fn slack_refresh_reopens_local_socket() {
    // 1. 서로 다른 티켓을 발급하는 로컬 HTTP와 WebSocket 서버를 준비한다.
    let (_directory, engine, _, count) = fixture();
    let source = slack_source(&engine);
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", http.local_addr().unwrap());
    let address = ws.local_addr().unwrap();
    let http_task = tokio::spawn(async move {
        for index in 0..2 {
            let (mut socket, _) = http.accept().await.unwrap();
            assert!(read_request(&mut socket).await.starts_with("POST "));
            response(
                &mut socket,
                "200 OK",
                "",
                &json!({"ok":true,"url":format!("ws://{address}/?ticket={index}")}).to_string(),
            )
            .await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(300), http.accept())
                .await
                .is_err()
        );
    });
    let ws_task = tokio::spawn(async move {
        for index in 0..2 {
            let (socket, _) = ws.accept().await.unwrap();
            let mut socket = accept_async(socket).await.unwrap();
            for event in if index == 0 {
                vec!["Ev1"]
            } else {
                vec!["Ev1", "Ev2"]
            } {
                let envelope = format!("{index}-{event}");
                socket.send(Message::Text(json!({"type":"events_api","envelope_id":envelope,"payload":payload(event,"C123","test")}).to_string().into())).await.unwrap();
                let ack = socket.next().await.unwrap().unwrap().into_text().unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&ack).unwrap(),
                    json!({"envelope_id":envelope})
                );
            }
            if index == 0 {
                socket
                    .send(Message::Text(
                        json!({"type":"disconnect","reason":"refresh_requested"})
                            .to_string()
                            .into(),
                    ))
                    .await
                    .unwrap();
            } else {
                let _ = socket.next().await;
            }
        }
    });

    // 2. 갱신 후 다시 연결하고 두 번째 이벤트 수신 뒤 작업을 취소한다.
    let client = reqwest::Client::new();
    let cancel = CancellationToken::new();
    assert!(slack::stream(
        engine.clone(),
        &source,
        &cancel,
        &client,
        &endpoint,
        "xapp-fake",
        true
    )
    .await
    .is_err());
    let second_cancel = cancel.clone();
    let second_engine = engine.clone();
    let second_source = source.clone();
    let second = tokio::spawn(async move {
        slack::stream(
            second_engine,
            &second_source,
            &second_cancel,
            &client,
            &endpoint,
            "xapp-fake",
            true,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while count.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    let _ = second.await.unwrap();
    ws_task.await.unwrap();
    http_task.await.unwrap();
    assert_eq!(engine.store.events(true).unwrap().len(), 2);
    assert_eq!(count.load(Ordering::SeqCst), 2);
}

#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<String, String>>);

impl Secrets for MemorySecrets {
    // 단위 테스트에서는 실제 사용자 자격증명 저장소를 변경하지 않는다.
    fn get(&self, id: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "토큰 없음".into())
    }
    // 비밀값 원문은 테스트용 메모리에만 저장한다.
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }
    // 테스트 연결의 토큰만 삭제한다.
    fn delete(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

#[derive(Default)]
struct FailingSecrets {
    values: Mutex<HashMap<String, String>>,
    fail_set: std::sync::atomic::AtomicBool,
    fail_delete: std::sync::atomic::AtomicBool,
}

impl Secrets for FailingSecrets {
    // 실패 주입 검사에서 격리된 메모리 비밀값만 조회한다.
    fn get(&self, id: &str) -> Result<String, String> {
        self.values
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "토큰 없음".into())
    }

    // 설정에 비밀값을 쓰지 않고 저장 실패를 제어한다.
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        if self.fail_set.load(Ordering::SeqCst) {
            return Err("모의 비밀 저장 실패".into());
        }
        self.values.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }

    // 삭제 실패를 주입한 뒤 재시도에서 메모리 비밀값을 지운다.
    fn delete(&self, id: &str) -> Result<(), String> {
        if self.fail_delete.load(Ordering::SeqCst) {
            return Err("모의 비밀 삭제 실패".into());
        }
        self.values.lock().unwrap().remove(id);
        Ok(())
    }
}

// 독립적인 로컬 DB와 비밀 저장소를 사용하는 엔진을 만든다.
fn fixture() -> (
    tempfile::TempDir,
    Arc<Engine>,
    Arc<MemorySecrets>,
    Arc<AtomicUsize>,
) {
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(store::Store::open(directory.path()).unwrap());
    let secrets = Arc::new(MemorySecrets::default());
    let count = Arc::new(AtomicUsize::new(0));
    let notifications = count.clone();
    let engine = Engine::new(
        store,
        secrets.clone(),
        Arc::new(move || {
            notifications.fetch_add(1, Ordering::SeqCst);
        }),
        Arc::new(|| {}),
    );
    (directory, engine, secrets, count)
}

// 실제 HTTP 서버에서 헤더가 완료될 때까지 제한된 요청을 읽는다.
async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut data = Vec::new();
    let mut buffer = [0; 1024];
    while !data.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0 && data.len() < 16384);
        data.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8(data).unwrap()
}

// 테스트 HTTP 응답을 실제 소켓으로 기록한다.
async fn response(socket: &mut tokio::net::TcpStream, status: &str, headers: &str, body: &str) {
    let value = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",body.len());
    socket.write_all(value.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}

// 테스트용 Slack 연결을 비밀값 없는 설정으로 등록한다.
fn slack_source(engine: &Engine) -> Source {
    let config = SourceConfig::Slack {
        team_id: "T123".into(),
        channels: vec!["C123".into()],
        event_types: vec![
            "message".into(),
            "app_mention".into(),
            "reaction_added".into(),
            "reaction_removed".into(),
        ],
    };
    engine
        .store
        .save("slack-one", "내 Slack", &config, None)
        .unwrap();
    engine.store.source("slack-one").unwrap()
}

// 대표적인 실제 Slack 이벤트 형식을 생성한다.
fn payload(id: &str, channel: &str, text: &str) -> Value {
    let now = now_ms();
    let timestamp = format!("{}.{:06}", now / 1000, (now % 1000) * 1000);
    json!({"type":"event_callback","event_id":id,"team_id":"T123","event_time":now/1000,"token":"not-for-clients","event":{"type":"message","channel":channel,"user":"U123","text":text,"ts":timestamp},"response_url":"https://secret.invalid"})
}

// Docker의 연속 이벤트·필터·재접속 중복·읽기 전용 API 호출을 실제 HTTP로 검증한다.
#[tokio::test]
async fn docker_stream_reconnect_and_cursor_are_durable() {
    // 1. 컨테이너 두 개와 민감 라벨을 포함한 가짜 엔진을 준비한다.
    let (_directory, engine, _, count) = fixture();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let config = SourceConfig::Docker {
        endpoint,
        containers: vec!["wanted".into()],
        actions: vec!["start".into(), "die".into()],
    };
    engine
        .store
        .save("docker-one", "내 Docker", &config, None)
        .unwrap();
    engine.store.seed_cursor("docker-one", "1").unwrap();
    let source = engine.store.source("docker-one").unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let lower_bound = now_ms() / 1000;
    let saved_cursor = Arc::new(Mutex::new(String::new()));
    let expected_cursor = saved_cursor.clone();
    let server = tokio::spawn(async move {
        let mut events = None;
        for _ in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_request(&mut socket).await;
            assert!(request.starts_with("GET "), "컨트롤 메서드가 호출됨");
            captured
                .lock()
                .unwrap()
                .push(request.lines().next().unwrap().to_string());
            if request.lines().next().unwrap().contains("/version ") {
                response(&mut socket,"200 OK","",r#"{"ApiVersion":"1.53","MinAPIVersion":"1.44","Version":"29.0.0","Os":"linux"}"#).await;
            } else {
                assert!(request.contains("/events?"));
                let path = request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap();
                let url = reqwest::Url::parse(&format!("http://localhost{path}")).unwrap();
                let since = url
                    .query_pairs()
                    .find(|(key, _)| key == "since")
                    .unwrap()
                    .1
                    .parse::<i64>()
                    .unwrap();
                assert!(
                    since >= lower_bound && since <= now_ms() / 1000,
                    "재접속이 과거 커서를 재생함"
                );
                let events = events.get_or_insert_with(|| {
                    let now = now_ms();
                    let nanos = now * 1_000_000;
                    *expected_cursor.lock().unwrap() = (now / 1000).to_string();
                    vec![
                        json!({"Type":"container","Action":"start","Actor":{"ID":"aaa","Attributes":{"name":"wanted","secret":"must-not-leak"}},"time":now/1000,"timeNano":nanos}),
                        json!({"Type":"container","Action":"start","Actor":{"ID":"bbb","Attributes":{"name":"other"}},"time":now/1000,"timeNano":nanos}),
                        json!({"Type":"container","Action":"die","Actor":{"ID":"aaa","Attributes":{"name":"wanted","exitCode":"1"}},"time":now/1000,"timeNano":nanos+1}),
                    ]
                });
                let body = events
                    .iter()
                    .map(|event| format!("{event}\n"))
                    .collect::<String>();
                response(&mut socket, "200 OK", "", &body).await;
            }
        }
    });

    // 2. 같은 스트림을 재접속해도 선택한 두 이벤트만 저장되고 커서는 보존된다.
    for _ in 0..2 {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            docker::run(engine.clone(), &source, &CancellationToken::new()),
        )
        .await
        .unwrap();
        assert!(result.is_err());
    }
    server.await.unwrap();
    let events = engine.store.events(true).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    assert_eq!(
        engine.store.cursor("docker-one").unwrap().as_deref(),
        Some(saved_cursor.lock().unwrap().as_str())
    );
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("must-not-leak"));
    assert!(requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request.starts_with("GET ")));
}

// Slack 실제 전송 형식에서 영속화 이후 ACK·필터·중복·소켓 갱신을 검증한다.
#[tokio::test]
async fn slack_socket_persists_before_ack_and_filters_private_scope() {
    // 1. 소켓 URL 개설 API와 프레임 서버를 격리된 루프백에 만든다.
    let (_directory, engine, _, count) = fixture();
    let source = slack_source(&engine);
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/apps.connections.open",
        http.local_addr().unwrap()
    );
    let ws_url = format!("ws://{}/?ticket=do-not-leak", ws.local_addr().unwrap());
    let http_task = tokio::spawn(async move {
        let (mut socket, _) = http.accept().await.unwrap();
        let request = read_request(&mut socket).await;
        assert!(request.starts_with("POST /apps.connections.open "));
        assert!(request
            .to_lowercase()
            .contains("authorization: bearer xapp-test-secret"));
        response(
            &mut socket,
            "200 OK",
            "",
            &json!({"ok":true,"url":ws_url}).to_string(),
        )
        .await;
    });
    let stored = engine.clone();
    let ws_task = tokio::spawn(async move {
        let (socket, _) = ws.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        socket
            .send(Message::Text(json!({"type":"hello"}).to_string().into()))
            .await
            .unwrap();
        for (index, event) in [
            payload("Ev1", "C123", "coffee?"),
            payload("Ev1", "C123", "coffee?"),
            payload("Ev2", "C999", "private"),
            {
                let mut mention = payload("Ev3", "C123", "hello");
                mention["event"]["type"] = json!("app_mention");
                mention
            },
        ]
        .into_iter()
        .enumerate()
        {
            let envelope = format!("envelope-{index}");
            socket
                .send(Message::Text(
                    json!({"type":"events_api","envelope_id":envelope,"payload":event})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let ack = socket.next().await.unwrap().unwrap().into_text().unwrap();
            let ack: Value = serde_json::from_str(&ack).unwrap();
            assert_eq!(ack, json!({"envelope_id":envelope}));
            if index < 2 {
                assert_eq!(
                    stored.store.events(true).unwrap().len(),
                    1,
                    "영속화 전에 ACK함"
                );
            }
        }
        socket
            .send(Message::Text(
                json!({"type":"disconnect","reason":"refresh_requested"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    });

    // 2. 수신 프로토콜을 실행하고 채널 밖 메시지·비밀 메타데이터가 배달되지 않는지 확인한다.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        slack::stream(
            engine.clone(),
            &source,
            &CancellationToken::new(),
            &client,
            &endpoint,
            "xapp-test-secret",
            true,
        ),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    http_task.await.unwrap();
    ws_task.await.unwrap();
    let events = engine.store.events(true).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    let serialized = serde_json::to_string(&events).unwrap();
    for secret in [
        "private",
        "not-for-clients",
        "response_url",
        "do-not-leak",
        "xapp-",
    ] {
        assert!(!serialized.contains(secret));
    }
}

// Slack의 요청 제한·외부 소켓 URL·오류 응답에서 비밀 노출을 방지한다.
#[tokio::test]
async fn slack_rate_limit_and_ticket_validation() {
    let (_directory, _engine, _, _) = fixture();
    for (status, headers, body, delay) in [
        (
            "429 Too Many Requests",
            "Retry-After: 120\r\n",
            r#"{"error":"xapp-secret"}"#,
            Some(120),
        ),
        (
            "200 OK",
            "",
            r#"{"ok":true,"url":"wss://attacker.example/?ticket=secret-ticket"}"#,
            None,
        ),
        ("200 OK", "", r#"{"ok":false,"error":"xapp-secret"}"#, None),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_request(&mut socket).await;
            response(&mut socket, status, headers, body).await;
        });
        let error = slack::open_socket(&reqwest::Client::new(), &endpoint, "xapp-secret", false)
            .await
            .unwrap_err();
        assert_eq!(error.retry_after.map(|value| value.as_secs()), delay);
        assert!(!error.message.contains("xapp-secret") && !error.message.contains("secret-ticket"));
        task.await.unwrap();
    }
}

// 로컬 DB 재시작·앱 수신·기기 격리·연결 삭제를 검증한다.
#[test]
fn local_store_reopen_ack_and_delete() {
    // 1. 현재 PC에만 전달하고 ACK 이후에는 본문을 보관하지 않는다.
    let (directory, engine, _, _) = fixture();
    let source = slack_source(&engine);
    let notification = slack::normalize(&source, &payload("Ev1", "C123", "coffee"))
        .unwrap()
        .unwrap();
    engine.publish(notification.clone(), None).unwrap();
    let event = engine.store.events(true).unwrap().pop().unwrap();
    assert!(event.local);
    let other_pc = tempfile::tempdir().unwrap();
    assert!(store::Store::open(other_pc.path())
        .unwrap()
        .events(true)
        .unwrap()
        .is_empty());
    engine.store.ack(&event.id).unwrap();
    assert!(engine.store.events(true).unwrap().is_empty());
    assert!(engine.store.events(false).unwrap().is_empty());
    assert!(!engine.store.publish(notification.clone(), None).unwrap());

    // 2. 재시작은 미확인 본문도 버리되 중복 이벤트 키를 유지한다.
    let pending = slack::normalize(&source, &payload("Ev2", "C123", "pending"))
        .unwrap()
        .unwrap();
    engine.publish(pending.clone(), None).unwrap();
    assert_eq!(engine.store.events(true).unwrap().len(), 1);
    drop(engine);
    let store = store::Store::open(directory.path()).unwrap();
    assert!(store.events(true).unwrap().is_empty());
    assert!(!store.publish(notification, None).unwrap());
    assert!(!store.publish(pending, None).unwrap());

    // 3. 새 이벤트는 전달하고 연결 삭제 시 큐와 중복 키를 함께 제거한다.
    let fresh = slack::normalize(&source, &payload("Ev3", "C123", "fresh"))
        .unwrap()
        .unwrap();
    assert!(store.publish(fresh, None).unwrap());
    assert_eq!(store.events(true).unwrap().len(), 1);
    store.remove(&source.id).unwrap();
    assert!(store.events(true).unwrap().is_empty());
    assert!(store.sources().unwrap().is_empty());
}

// 같은 앱 토큰을 중복 연결하지 않으며 저장 설정에 원문이 남지 않는지 검증한다.
#[tokio::test]
async fn personal_secrets_and_lifecycle_do_not_reach_configuration() {
    let (directory, engine, secrets, _) = fixture();
    let source = slack_source(&engine);
    let hash = format!("{:x}", Sha256::digest(b"xapp-test-secret"));
    engine
        .store
        .save(&source.id, &source.name, &source.config, Some(&hash))
        .unwrap();
    secrets.set(&source.id, "xapp-test-secret").unwrap();
    let error = engine
        .save(SourceDraft {
            id: None,
            name: "duplicate".into(),
            config: source.config.clone(),
            app_token: Some("xapp-test-secret".into()),
        })
        .await
        .err()
        .unwrap();
    assert!(error.contains("이미"));
    assert!(!serde_json::to_string(&engine.store.sources().unwrap())
        .unwrap()
        .contains("xapp-test-secret"));
    for entry in std::fs::read_dir(directory.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(!bytes
            .windows(b"xapp-test-secret".len())
            .any(|chunk| chunk == b"xapp-test-secret"));
    }
    engine.enable(&source.id, false).await.unwrap();
    assert_eq!(engine.store.source(&source.id).unwrap().state, "disabled");
    engine.remove(&source.id).await.unwrap();
    assert!(secrets.get(&source.id).is_err());
    assert!(engine.store.sources().unwrap().is_empty());
}

// OS 비밀 저장 실패 때 Slack 설정이나 비밀 원문이 기록되지 않는지 확인한다.
#[tokio::test]
async fn secret_store_failure_does_not_persist_slack_configuration() {
    // 1. 실패를 주입한 메모리 비밀 저장소와 임시 로컬 DB를 준비한다.
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(store::Store::open(directory.path()).unwrap());
    let secrets = Arc::new(FailingSecrets::default());
    secrets.fail_set.store(true, Ordering::SeqCst);
    let engine = Engine::new(store, secrets, Arc::new(|| {}), Arc::new(|| {}));
    let draft = SourceDraft {
        id: None,
        name: "비밀 저장 실패".into(),
        config: SourceConfig::Slack {
            team_id: "T123".into(),
            channels: vec!["C123".into()],
            event_types: vec!["message".into()],
        },
        app_token: Some("xapp-private-test-secret".into()),
    };

    // 2. 저장 오류와 DB·파일의 비밀 원문 부재를 확인한다.
    assert!(engine.save(draft).await.is_err());
    assert!(engine.store.sources().unwrap().is_empty());
    for entry in std::fs::read_dir(directory.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let bytes = std::fs::read(path).unwrap();
            assert!(!bytes
                .windows(b"xapp-private-test-secret".len())
                .any(|chunk| chunk == b"xapp-private-test-secret"));
        }
    }
}

// OS 비밀 삭제 실패 뒤 연결이 중지 상태로 남고 안전하게 재시도되는지 확인한다.
#[tokio::test]
async fn secret_delete_failure_leaves_disabled_source_for_retry() {
    // 1. 네트워크 수집을 시작하지 않은 Slack 연결과 실패 제어 저장소를 준비한다.
    let directory = tempfile::tempdir().unwrap();
    let store = Arc::new(store::Store::open(directory.path()).unwrap());
    let secrets = Arc::new(FailingSecrets::default());
    let engine = Engine::new(store, secrets.clone(), Arc::new(|| {}), Arc::new(|| {}));
    let config = SourceConfig::Slack {
        team_id: "T123".into(),
        channels: vec!["C123".into()],
        event_types: vec!["message".into()],
    };
    let fingerprint = format!("{:x}", Sha256::digest(b"xapp-private-test-secret"));
    engine
        .store
        .save("retry-source", "삭제 재시도", &config, Some(&fingerprint))
        .unwrap();
    secrets
        .set("retry-source", "xapp-private-test-secret")
        .unwrap();
    secrets.fail_delete.store(true, Ordering::SeqCst);

    // 2. 삭제 실패 후 연결이 비활성 상태로 보존되는지 확인한다.
    assert!(engine.remove("retry-source").await.is_err());
    let retained = engine.store.source("retry-source").unwrap();
    assert!(!retained.enabled);
    assert_eq!(retained.state, "disabled");
    assert_eq!(
        secrets.get("retry-source").unwrap(),
        "xapp-private-test-secret"
    );

    // 3. 실패를 해제해 재시도하고 연결과 비밀값이 제거되는지 확인한다.
    secrets.fail_delete.store(false, Ordering::SeqCst);
    engine.remove("retry-source").await.unwrap();
    assert!(engine.store.source("retry-source").is_err());
    assert!(secrets.get("retry-source").is_err());
}

// 친구 창의 관리 권한과 잘못된 설정·범위 입력을 거부한다.
#[test]
fn config_and_window_boundaries() {
    assert!(settings_only("settings").is_ok());
    assert!(settings_only("pet").is_err());
    assert!(settings_only("peer-other").is_err());
    let token_in_config =
        json!({"kind":"slack","teamId":"T123","channels":["C123"],"appToken":"xapp-secret"});
    assert!(serde_json::from_value::<SourceConfig>(token_in_config).is_err());
    for endpoint in [
        "file:///etc/passwd",
        "http://user:secret@host:2375",
        "http://host:2375/containers/start",
    ] {
        assert!(SourceConfig::Docker {
            endpoint: endpoint.into(),
            containers: vec![],
            actions: vec![]
        }
        .validate()
        .is_err());
    }
    assert!(SourceConfig::Slack {
        team_id: "T123".into(),
        channels: vec![],
        event_types: vec!["message".into()]
    }
    .validate()
    .is_err());
}

// 수신 중지 때 재접속 대기와 소켓이 함께 취소되는지 검증한다.
#[tokio::test]
async fn manager_cancels_reconnect_and_restores_enabled_sources() {
    // 1. 연결할 수 없는 엔진의 오류가 재접속 상태로 격리되는지 확인한다.
    let (_directory, engine, _, _) = fixture();
    let source = engine
        .save(SourceDraft {
            id: None,
            name: "offline engine".into(),
            config: SourceConfig::Docker {
                endpoint: "http://127.0.0.1:1".into(),
                containers: vec![],
                actions: vec![],
            },
            app_token: None,
        })
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if engine.store.source(&source.id).unwrap().state == "reconnecting" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    // 2. 재접속 대기는 즉시 중지되고 다시 켠 작업은 하나만 실행된다.
    tokio::time::timeout(Duration::from_millis(500), engine.enable(&source.id, false))
        .await
        .unwrap()
        .unwrap();
    assert!(engine.runs.lock().unwrap().is_empty());
    engine.enable(&source.id, true).await.unwrap();
    engine.restore().unwrap();
    assert_eq!(engine.runs.lock().unwrap().len(), 1);
    engine.remove(&source.id).await.unwrap();
    assert!(engine.runs.lock().unwrap().is_empty());
}

// 영속 저장이 실패한 Slack 이벤트는 수신 확인하지 않고 재전송 가능하게 남긴다.
#[tokio::test]
async fn slack_does_not_ack_failed_persistence() {
    let (_directory, engine, _, _) = fixture();
    let source = slack_source(&engine);
    engine.store.remove(&source.id).unwrap();
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ws = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", http.local_addr().unwrap());
    let ws_url = format!("ws://{}", ws.local_addr().unwrap());
    let http_task = tokio::spawn(async move {
        let (mut socket, _) = http.accept().await.unwrap();
        read_request(&mut socket).await;
        response(
            &mut socket,
            "200 OK",
            "",
            &json!({"ok":true,"url":ws_url}).to_string(),
        )
        .await;
    });
    let ws_task = tokio::spawn(async move {
        let (socket, _) = ws.accept().await.unwrap();
        let mut socket = accept_async(socket).await.unwrap();
        socket.send(Message::Text(json!({"type":"events_api","envelope_id":"persist-failure","payload":payload("Ev1","C123","coffee")}).to_string().into())).await.unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .unwrap();
        assert!(
            !matches!(reply, Some(Ok(Message::Text(_)))),
            "실패한 저장을 ACK함"
        );
    });
    let result = slack::stream(
        engine.clone(),
        &source,
        &CancellationToken::new(),
        &reqwest::Client::new(),
        &endpoint,
        "xapp-fake",
        true,
    )
    .await;
    assert!(result.is_err());
    assert!(engine.store.events(false).unwrap().is_empty());
    http_task.await.unwrap();
    ws_task.await.unwrap();
}

// 명시적으로 요청한 경우에만 실제 Docker의 버전과 보관된 이벤트를 읽는다.
#[tokio::test]
#[ignore = "OURPETS_DOCKER_LIVE=1인 환경에서 읽기 전용 실제 엔진 검증"]
async fn live_docker_read_only() {
    assert_eq!(std::env::var("OURPETS_DOCKER_LIVE").as_deref(), Ok("1"));
    let docker = docker::client("local")
        .unwrap()
        .negotiate_version()
        .await
        .unwrap();
    assert!(docker.version().await.unwrap().api_version.is_some());
    let until = (now_ms() / 1000).to_string();
    let since = (now_ms() / 1000 - 3600).to_string();
    let options = bollard::query_parameters::EventsOptionsBuilder::default()
        .since(&since)
        .until(&until)
        .build();
    let mut events = docker.events(Some(options));
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut count = 0;
        while let Some(event) = events.next().await {
            event.unwrap();
            count += 1;
        }
        count
    })
    .await
    .unwrap();
    println!("실제 Docker Events API의 기존 이벤트 {result}개를 읽었습니다. 외부 상태 변경 없음");
}
