use std::process::Stdio;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostInvitation {
    url: String,
    local_url: String,
    invite: String,
}

struct RunningHost {
    child: Child,
    invitation: HostInvitation,
}

#[derive(Default)]
pub(crate) struct Hosting(Mutex<Option<RunningHost>>);

// 설정 창만 서버를 시작하고 실행 중인 서버의 초대 정보를 받을 수 있다.
#[tauri::command]
pub(crate) async fn start_host(
    window: WebviewWindow,
    hosting: State<'_, Hosting>,
) -> Result<HostInvitation, String> {
    if window.label() != "settings" {
        return Err("This action is only available in the settings window".into());
    }
    let mut state = hosting.0.lock().await;
    if let Some(host) = state.as_mut() {
        if host.child.try_wait().is_ok_and(|status| status.is_none()) {
            return Ok(host.invitation.clone());
        }
    }
    let host = launch(window.app_handle()).await?;
    let invitation = host.invitation.clone();
    *state = Some(host);
    Ok(invitation)
}

// 패키지에 포함된 서버를 실행하고 시작 응답을 받은 다음 자식 프로세스를 보관한다.
async fn launch(app: &AppHandle) -> Result<RunningHost, String> {
    const START_FAILED: &str =
        "친구 초대를 시작하지 못했어요. 네트워크 연결을 확인하고 다시 시도해 주세요.";
    let executable = std::env::current_exe()
        .map_err(|_| START_FAILED)?
        .with_file_name(if cfg!(windows) {
            "our-pets-host.exe"
        } else {
            "our-pets-host"
        });
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| START_FAILED)?
        .join("host");
    let mut command = Command::new(executable);
    command
        .arg("--desktop-host")
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

    let mut child = command.spawn().map_err(|_| START_FAILED)?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or(START_FAILED)?);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(12), stdout.read_line(&mut line))
        .await
        .map_err(|_| START_FAILED)?
        .map_err(|_| START_FAILED)?;
    let invitation = serde_json::from_str(&line).map_err(|_| START_FAILED)?;
    Ok(RunningHost { child, invitation })
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
