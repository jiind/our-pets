use super::codex_usage::{evaluate, fingerprint};
use super::types::{now_ms, CodexUsage, Source, SourceConfig};
use super::{Engine, RunError};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
};
use tokio_util::sync::CancellationToken;

const RESPONSE_LIMIT: usize = 256 * 1024;

pub struct RefreshRequest {
    pub deadline: Instant,
    pub reply: oneshot::Sender<Result<CodexUsage, String>>,
}

struct Rpc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    partial: Vec<u8>,
    sequence: u64,
}

// GUI의 짧은 PATH에서도 사용자 Codex 설치를 찾고 셸·추가 인자를 사용하지 않는다.
fn executable(value: &str) -> Result<PathBuf, RunError> {
    // 1. 명시적인 절대 경로는 사용자가 지정한 실행 파일로만 다룬다.
    if value != "codex" {
        let path = PathBuf::from(value);
        return path.is_file().then_some(path).ok_or_else(|| {
            RunError::new("Codex 실행 파일을 찾을 수 없습니다. 절대 경로를 확인하세요.")
        });
    }
    let names: &[&str] = if cfg!(windows) {
        &["codex.exe", "codex.cmd", "codex"]
    } else {
        &["codex"]
    };
    let mut directories: Vec<_> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();

    // 2. 일반 사용자 설치 경로만 보완하고 로그인 정보 파일은 읽지 않는다.
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        directories.extend([home.join(".local/bin"), home.join(".npm-global/bin")]);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(appdata).join("npm"));
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    directories
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            RunError::new(
                "Codex CLI를 찾지 못했어요. 이 PC에 설치하거나 실행 파일의 절대 경로를 지정하세요.",
            )
        })
}

impl Rpc {
    // 전용 stdio 클라이언트만 시작하며 모델 작업·로그인·한도 변경 요청은 만들지 않는다.
    async fn open(path: &str) -> Result<Self, RunError> {
        // 1. 원본 stderr를 화면·로그로 전달하지 않고 자식 프로세스를 수명에 묶는다.
        let mut command = Command::new(executable(path)?);
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.as_std_mut().creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| {
            RunError::new(
                "Codex 사용량 연결을 시작하지 못했어요. 실행 파일과 실행 권한을 확인하세요.",
            )
        })?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| RunError::new("Codex 입력 연결을 열지 못했어요."))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| RunError::new("Codex 출력 연결을 열지 못했어요."))?,
        );
        let mut rpc = Self {
            child,
            input,
            output,
            partial: Vec::new(),
            sequence: 0,
        };

        // 2. 공식 초기화 후 읽기 전용 계정 조회만 허용한다.
        rpc.call("initialize", json!({"clientInfo":{"name":"our_pets_usage","title":"우리 펫 사용량 알림","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}})).await?;
        rpc.write(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(rpc)
    }

    // 제한된 크기의 JSON 한 줄만 stdio에 쓴다.
    async fn write(&mut self, value: Value) -> Result<(), RunError> {
        let mut data = serde_json::to_vec(&value)
            .map_err(|_| RunError::new("Codex 조회 요청을 구성하지 못했어요."))?;
        data.push(b'\n');
        self.input
            .write_all(&data)
            .await
            .map_err(|_| RunError::new("Codex 사용량 연결이 끊겼어요."))
    }

    // 대기 취소 후에도 부분 프레임을 보존하며 응답 크기와 JSON 형식을 제한한다.
    async fn frame(&mut self) -> Result<Value, RunError> {
        loop {
            let chunk = self
                .output
                .fill_buf()
                .await
                .map_err(|_| RunError::new("Codex 조회 응답을 읽지 못했어요."))?;
            if chunk.is_empty() {
                return Err(RunError::new(
                    "Codex 사용량 연결이 종료됐어요. CLI 버전과 로그인을 확인하세요.",
                ));
            }
            let end = chunk.iter().position(|byte| *byte == b'\n');
            let count = end.unwrap_or(chunk.len());
            if self.partial.len() + count > RESPONSE_LIMIT {
                return Err(RunError::new("Codex 사용량 응답이 지원 크기를 초과했어요."));
            }
            self.partial.extend_from_slice(&chunk[..count]);
            self.output.consume(count + usize::from(end.is_some()));
            if end.is_some() {
                let raw = std::mem::take(&mut self.partial);
                if raw.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                return serde_json::from_slice(&raw).map_err(|_| {
                    RunError::new("Codex 응답 형식을 읽지 못했어요. CLI를 업데이트하세요.")
                });
            }
        }
    }

    // 사용량 클라이언트에 도착한 실행·인증 변경 요청은 항상 거절한다.
    async fn reject_request(&mut self, value: &Value) -> Result<(), RunError> {
        if value.get("method").is_some() && value.get("id").is_some() {
            self.write(json!({"id":value["id"],"error":{"code":-32601,"message":"Read-only usage client"}})).await?;
        }
        Ok(())
    }

    // 허용한 세 가지 RPC 외에는 전송하지 않으며 지연·공급자 오류를 정제한다.
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, RunError> {
        if !["initialize", "account/read", "account/rateLimits/read"].contains(&method) {
            return Err(RunError::new("허용되지 않은 Codex 요청입니다."));
        }
        self.sequence = self.sequence.wrapping_add(1);
        let id = self.sequence;
        tokio::time::timeout(Duration::from_secs(10), async {
            self.write(json!({"id":id,"method":method,"params":params})).await?;
            loop {
                let value = self.frame().await?;
                if value.get("method").is_some() {
                    self.reject_request(&value).await?;
                    continue;
                }
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if value.get("error").is_some() {
                    return Err(RunError::new("Codex 사용량 조회에 실패했어요. ChatGPT 계정 로그인·인터넷 연결·CLI 업데이트를 확인하세요."));
                }
                return value.get("result").cloned().ok_or_else(|| RunError::new("Codex 사용량 결과가 비어 있어요."));
            }
        }).await.map_err(|_| RunError::new("Codex 사용량 조회 시간이 초과됐어요."))?
    }

    // 조회 전후 계정 일치를 확인하고 인증 원문 대신 지문만 반환한다.
    async fn snapshot(&mut self) -> Result<(String, Value), RunError> {
        tokio::time::timeout(Duration::from_secs(20), async {
            let before = self.call("account/read", json!({"refreshToken":false})).await?;
            let account = before.get("account").filter(|account| !account.is_null()).ok_or_else(|| RunError::new("이 PC에서 codex login으로 ChatGPT 계정에 로그인하세요."))?;
            if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
                return Err(RunError::new("Codex 구독 사용량에는 ChatGPT 로그인이 필요해요. API 키 비용 조회와는 별개예요."));
            }
            let limits = self.call("account/rateLimits/read", Value::Null).await?;
            let after = self.call("account/read", json!({"refreshToken":false})).await?;
            let before_id = json!([account.get("type"), account.get("email"), account.get("workspaceName")]);
            let current = &after["account"];
            if before_id != json!([current.get("type"), current.get("email"), current.get("workspaceName")]) {
                return Err(RunError::new("조회 중 Codex 계정이 변경됐어요. 다시 조회합니다."));
            }
            if limits.get("accountId").and_then(Value::as_str).is_none() && account.get("email").and_then(Value::as_str).is_none() {
                return Err(RunError::new("Codex 계정을 구분할 정보를 제공받지 못했어요."));
            }
            Ok((fingerprint(&format!("{before_id}:{}", limits.get("accountId").unwrap_or(&Value::Null))), limits))
        }).await.map_err(|_| RunError::new("Codex 전체 사용량 조회 시간이 초과됐어요."))?
    }

    // 이 연결이 시작한 자식만 종료하고 기존 Codex 작업·공유 데몬에는 종료 요청을 보내지 않는다.
    async fn close(&mut self) {
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

// 전체 재조회 결과·임계값 기준·알림을 원자적으로 반영한다.
async fn refresh(
    engine: &Engine,
    source: &Source,
    rpc: &mut Rpc,
    manual: Option<&RefreshRequest>,
) -> Result<CodexUsage, RunError> {
    // 1. 공식 읽기 응답만 해석하고 앞선 계정의 기준을 섞지 않는다.
    let (identity, raw) = rpc.snapshot().await?;
    let previous = engine.store.cursor(&source.id).map_err(RunError::new)?;
    let manual_alert = manual
        .is_some_and(|request| request.deadline > Instant::now() && !request.reply.is_closed());
    let decision = evaluate(
        source,
        &identity,
        raw,
        previous.as_deref(),
        manual_alert,
        now_ms(),
    )?;

    // 2. 알림이 없을 때도 기준을 저장하고 실제 새 이벤트가 있을 때만 내 펫을 깨운다.
    let changed = engine
        .store
        .publish_many(&source.id, decision.notifications, Some(&decision.cursor))
        .map_err(RunError::new)?;
    if changed > 0 {
        (engine.notify)();
    }
    (engine.status_changed)();
    engine.status(&source.id, "connected", "");
    Ok(decision.usage)
}

// 백그라운드 조회·변경 신호·사용자 재조회를 하나의 읽기 전용 클라이언트에서 직렬 처리한다.
pub async fn run(
    engine: Arc<Engine>,
    source: &Source,
    cancel: &CancellationToken,
    requests: &mut mpsc::Receiver<RefreshRequest>,
) -> Result<(), RunError> {
    // 1. 프로세스와 초기 전체 조회를 준비하고 과거 구간을 몰아서 알리지 않는다.
    source.config.validate().map_err(RunError::new)?;
    let SourceConfig::Codex {
        executable,
        poll_seconds,
        ..
    } = &source.config
    else {
        return Err(RunError::new("Codex 연결이 아닙니다."));
    };
    let mut rpc = Rpc::open(executable).await?;
    refresh(&engine, source, &mut rpc, None).await?;
    let mut poll = tokio::time::interval(Duration::from_secs(*poll_seconds));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll.tick().await;
    let mut next_event_query = Instant::now() + Duration::from_secs(5);

    // 2. 부분 이벤트는 숫자를 덮어쓰는 대신 전체 조회를 유발하고 반복 신호는 제한한다.
    let result = loop {
        let manual = tokio::select! {
            _ = cancel.cancelled() => break Ok(()),
            _ = poll.tick() => None,
            request = requests.recv() => {
                let Some(request) = request else { break Ok(()); };
                if request.deadline <= Instant::now() || request.reply.is_closed() {
                    continue;
                }
                Some(request)
            },
            frame = rpc.frame() => {
                match frame {
                    Ok(value) => {
                        if let Err(error) = rpc.reject_request(&value).await {
                            break Err(error);
                        }
                        let method = value.get("method").and_then(Value::as_str);
                        if !matches!(method, Some("account/rateLimits/updated" | "account/updated")) || Instant::now() < next_event_query {
                            continue;
                        }
                        None
                    },
                    Err(error) => break Err(error),
                }
            }
        };
        let current = refresh(&engine, source, &mut rpc, manual.as_ref()).await;
        next_event_query = Instant::now() + Duration::from_secs(5);
        if let Some(request) = manual {
            let _ = request.reply.send(
                current
                    .as_ref()
                    .cloned()
                    .map_err(|error| error.message.clone()),
            );
        }
        if let Err(error) = current {
            break Err(error);
        }
    };
    rpc.close().await;
    result
}
