use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::Mutex;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInvitation {
    url: String,
    local_url: String,
    invite: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalSession {
    local_url: String,
    session: serde_json::Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostReply {
    local_url: String,
    url: Option<String>,
    invite: Option<String>,
    session: Option<serde_json::Value>,
}

struct RunningHost {
    child: Child,
    stdout: BufReader<ChildStdout>,
}

#[derive(Default)]
pub(crate) struct Hosting(Mutex<Option<RunningHost>>);

const LOCAL_FAILED: &str = "우리 펫을 시작하지 못했어요. 다시 시도해 주세요.";
const SHARE_FAILED: &str =
    "친구 초대를 시작하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.";

// 설정 창에서 비공개 펫을 시작하고 이 기기에 사용할 세션을 받는다.
#[tauri::command]
pub(crate) async fn start_local(
    window: WebviewWindow,
    hosting: State<'_, Hosting>,
    display_name: String,
    device_id: String,
) -> Result<LocalSession, String> {
    let reply = host_command(
        &window,
        &hosting,
        serde_json::json!({"action": "open", "displayName": display_name, "deviceId": device_id}),
        LOCAL_FAILED,
    )
    .await?;
    Ok(LocalSession {
        local_url: reply.local_url,
        session: reply.session.ok_or(LOCAL_FAILED)?,
    })
}

// 설정 창에서 이미 실행 중인 서버에 LAN 공유를 열고 초대 정보를 받는다.
#[tauri::command]
pub(crate) async fn start_host(
    window: WebviewWindow,
    hosting: State<'_, Hosting>,
) -> Result<HostInvitation, String> {
    let reply = host_command(
        &window,
        &hosting,
        serde_json::json!({"action": "share"}),
        SHARE_FAILED,
    )
    .await?;
    Ok(HostInvitation {
        local_url: reply.local_url,
        url: reply.url.ok_or(SHARE_FAILED)?,
        invite: reply.invite.ok_or(SHARE_FAILED)?,
    })
}

// LAN 공유를 닫고 이 PC의 서버와 펫은 계속 실행한다.
#[tauri::command]
pub(crate) async fn stop_host(
    window: WebviewWindow,
    hosting: State<'_, Hosting>,
) -> Result<(), String> {
    host_command(
        &window,
        &hosting,
        serde_json::json!({"action": "unshare"}),
        "외부 접속을 차단하지 못했어요. 다시 시도해 주세요.",
    )
    .await?;
    Ok(())
}

// 두 창의 요청이 섞이지 않게 하나의 자식 프로세스와 명령 파이프를 유지한다.
async fn host_command(
    window: &WebviewWindow,
    hosting: &Hosting,
    request: serde_json::Value,
    failure: &'static str,
) -> Result<HostReply, String> {
    if window.label() != "settings" {
        return Err("This action is only available in the settings window".into());
    }
    let mut state = hosting.0.lock().await;
    if !state
        .as_mut()
        .is_some_and(|host| host.child.try_wait().is_ok_and(|status| status.is_none()))
    {
        *state = Some(launch(window.app_handle()).await.map_err(|_| failure)?);
    }
    let host = state.as_mut().ok_or(failure)?;
    let reply = tokio::time::timeout(Duration::from_secs(12), async {
        let mut data = serde_json::to_vec(&request).map_err(|_| ())?;
        data.push(b'\n');
        host.child
            .stdin
            .as_mut()
            .ok_or(())?
            .write_all(&data)
            .await
            .map_err(|_| ())?;
        read_reply(&mut host.stdout).await
    })
    .await;
    match reply {
        Ok(Ok(reply)) if !reply.local_url.is_empty() => Ok(reply),
        Ok(Ok(_)) => Err(failure.into()),
        _ => {
            *state = None;
            Err(failure.into())
        }
    }
}

// 패키지에 포함된 서버를 루프백에서만 실행하고 시작 응답을 기다린다.
async fn launch(app: &AppHandle) -> Result<RunningHost, ()> {
    let executable = std::env::current_exe()
        .map_err(|_| ())?
        .with_file_name(if cfg!(windows) {
            "our-pets-host.exe"
        } else {
            "our-pets-host"
        });
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| ())?
        .join("host");
    let mut command = Command::new(executable);
    command
        .arg("--desktop-local")
        .arg(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("OURPETS_")
        {
            command.env_remove(key);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command.spawn().map_err(|_| ())?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or(())?);
    let ready = tokio::time::timeout(Duration::from_secs(12), read_reply(&mut stdout))
        .await
        .map_err(|_| ())??;
    if ready.local_url.is_empty() {
        return Err(());
    }
    Ok(RunningHost { child, stdout })
}

// Go 서버가 한 줄로 전송하는 시작 결과와 각 명령 응답을 읽는다.
async fn read_reply(stdout: &mut BufReader<ChildStdout>) -> Result<HostReply, ()> {
    let mut line = String::new();
    stdout.read_line(&mut line).await.map_err(|_| ())?;
    serde_json::from_str(&line).map_err(|_| ())
}

// 초대 링크로 앱이 처음 실행된 경우 설정 창에 해당 링크를 전달한다.
#[tauri::command]
pub(crate) fn launch_invitation(window: WebviewWindow) -> Option<String> {
    if window.label() != "settings" {
        return None;
    }
    window
        .deep_link()
        .get_current()
        .ok()??
        .into_iter()
        .find(|url| url.scheme() == "ourpets")
        .map(|url| url.to_string())
}
