use crate::{is_pet, Shared};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub visible: bool,
    pub show_others: bool,
    pub pet_size: u32,
}

impl Default for Preferences {
    // 현재 PC의 표시·크기 기본값을 제공한다.
    fn default() -> Self {
        Self {
            visible: true,
            show_others: true,
            pet_size: 160,
        }
    }
}

pub struct TrayControls {
    visible: tauri::menu::MenuItem<tauri::Wry>,
    own_only: tauri::menu::MenuItem<tauri::Wry>,
}

// 등록 전이나 로그아웃 상태에서는 사용자 표시 옵션을 바꾸지 않고 실제 펫 창을 숨긴다.
#[tauri::command]
pub fn set_pet_registered(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    registered: bool,
) -> Result<(), String> {
    // 1. 설정 창과 대표 펫 창만 현재 계정의 등록 여부를 반영한다.
    if window.label() != "settings" && window.label() != "pet" {
        return Err("대표 펫의 등록 상태만 변경할 수 있습니다".into());
    }
    {
        let mut all = state.lock().map_err(|e| e.to_string())?;
        if all.pet_registered == registered {
            return Ok(());
        }
        all.pet_registered = registered;
    }

    // 2. 트레이의 표시 설정은 유지하고 현재 창의 실제 표시 여부만 갱신한다.
    apply(&app, &state, false, false)
}

// 표시·크기 설정을 현재 OS 사용자에게만 보관한다.
fn save(app: &tauri::AppHandle, preferences: &Preferences) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let temporary = directory.join("desktop-preferences.next");
    std::fs::write(
        &temporary,
        serde_json::to_vec(preferences).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, directory.join("desktop-preferences.json"))
        .map_err(|e| e.to_string())
}

// 트레이와 앱이 동일한 설정을 사용하도록 시작 시 한 번 복원한다.
pub fn install(app: &tauri::AppHandle, state: &Shared) -> Result<(), Box<dyn std::error::Error>> {
    // 1. 비밀값 없는 표시 설정만 읽고 손상되면 기본값을 사용한다.
    let preferences = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|path| std::fs::read(path.join("desktop-preferences.json")).ok())
        .and_then(|raw| serde_json::from_slice::<Preferences>(&raw).ok())
        .unwrap_or_default();
    let preferences = Preferences {
        pet_size: preferences.pet_size.clamp(80, 240),
        ..preferences
    };
    state.lock().map_err(|_| "표시 설정 잠금 실패")?.preferences = preferences.clone();

    // 2. 표시 옵션과 앱 열기·종료만 같은 트레이에 등록한다.
    let visible = tauri::menu::MenuItem::with_id(
        app,
        "toggle",
        if preferences.visible {
            "펫 숨기기"
        } else {
            "펫 표시"
        },
        true,
        None::<&str>,
    )?;
    let own_only = tauri::menu::MenuItem::with_id(
        app,
        "others",
        if preferences.show_others {
            "내 펫만 보기"
        } else {
            "친구 펫도 보기"
        },
        true,
        None::<&str>,
    )?;
    let settings =
        tauri::menu::MenuItem::with_id(app, "settings", "설정 열기", true, None::<&str>)?;
    let quit = tauri::menu::MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = tauri::menu::Menu::with_items(app, &[&visible, &own_only, &settings, &quit])?;
    app.manage(TrayControls { visible, own_only });
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("앱 아이콘이 없습니다")?;
    tauri::tray::TrayIconBuilder::new()
        .icon(icon)
        .tooltip("우리 펫")
        .menu(&menu)
        .on_menu_event(|app, event| {
            let _ = crate::pet_control(
                app.clone(),
                app.state::<Shared>(),
                event.id().as_ref().to_string(),
            );
        })
        .build(app)?;
    Ok(())
}

// 비동기 배치가 보행 이동으로 집계되지 않도록 관측 기준과 입력 대기를 먼저 갱신한다.
fn reset_layout_observation(
    window: &tauri::WebviewWindow,
    position: (i32, i32),
) -> Result<(), String> {
    let state = window.app_handle().state::<Shared>();
    let mut all = state.lock().map_err(|error| error.to_string())?;
    if let Some(pet) = all.windows.get_mut(window.label()) {
        pet.motion.reset_for_layout(position);
    }
    Ok(())
}

// 창을 작업영역 바닥에 정렬하며 새 창은 비동기 배치 전의 좌표 대신 지정한 수평 위치를 사용한다.
pub fn align(window: &tauri::WebviewWindow, initial_x: Option<i32>) -> Result<(), String> {
    // 1. 작은 작업영역에서는 투명 창 자체를 줄여 메뉴가 작업 표시줄 밖으로 나가지 않게 한다.
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
    {
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let work = monitor.work_area();
        let scale = monitor.scale_factor();
        let size = PhysicalSize::new(
            work.size.width.min((360.0 * scale).round() as u32),
            work.size.height,
        );
        // 2. 같은 물리 좌표의 작업영역 바닥에 발 기준선을 정렬한다.
        let (x, y) = crate::clamp_position(
            initial_x.unwrap_or(position.x),
            work.position.y + work.size.height.saturating_sub(size.height) as i32,
            size.width,
            size.height,
            work.position.x,
            work.position.y,
            work.size.width,
            work.size.height,
        );
        reset_layout_observation(window, (x, y))?;
        if window.outer_size().map_err(|error| error.to_string())? != size {
            window.set_size(size).map_err(|error| error.to_string())?;
        }
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// 모니터·배율 변경 시 창 크기와 발 위치를 작업영역에 맞추고 수동 배치는 가능한 한 보존한다.
pub fn fit(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window
        .app_handle()
        .state::<Shared>()
        .lock()
        .map_err(|error| error.to_string())?
        .windows
        .get(window.label())
        .is_some_and(|pet| pet.dragging || pet.lift.active())
    {
        return Ok(());
    }
    // 1. 모니터의 논리 최대 크기를 물리 크기로 바꾸고 현재 창과 비교한다.
    let monitor = match window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        Some(monitor) => Some(monitor),
        None => window
            .primary_monitor()
            .map_err(|error| error.to_string())?,
    };
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = PhysicalSize::new(
        work.size.width.min((360.0 * scale).round() as u32),
        work.size.height,
    );
    let previous = window.outer_size().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;

    // 2. 크기 변경 전의 발 높이를 유지한 뒤 작업영역 밖 부분만 보정한다.
    let (x, y) = crate::clamp_position(
        position.x,
        position.y + previous.height as i32 - size.height as i32,
        size.width,
        size.height,
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
    );
    let resized = previous != size;
    let moved = position.x != x || position.y != y;
    if !resized && !moved {
        return Ok(());
    }
    reset_layout_observation(window, (x, y))?;
    if resized {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    if moved {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

// 공유 설정을 실제 모든 펫 창·앱 버튼·트레이 문구에 반영한다.
pub fn apply(
    app: &tauri::AppHandle,
    state: &Shared,
    align_feet: bool,
    publish: bool,
) -> Result<(), String> {
    // 1. 창 API를 호출하는 동안 상태 잠금을 잡지 않는다.
    let (preferences, registered) = {
        let all = state.lock().map_err(|e| e.to_string())?;
        (all.preferences.clone(), all.pet_registered)
    };
    for (label, window) in app.webview_windows() {
        if !is_pet(&label) {
            continue;
        }
        let hidden =
            !registered || !preferences.visible || (label != "pet" && !preferences.show_others);
        let mut reset_sequence = None;
        let needs_alignment = {
            let mut all = state.lock().map_err(|e| e.to_string())?;
            if let Some(pet) = all.windows.get_mut(&label) {
                pet.hidden = hidden;
                if hidden {
                    pet.dragging = false;
                    reset_sequence = Some(pet.lift.cancel());
                    pet.input_active = false;
                    pet.menu_open = false;
                    pet.motion.stop();
                    pet.motion.reset_observation();
                }
                let needs = !pet.anchored || align_feet;
                pet.anchored = true;
                needs
            } else {
                false
            }
        };
        if needs_alignment {
            align(&window, None)?;
        }
        if hidden {
            let _ = window.emit_to(
                window.label(),
                "pet-elevation",
                serde_json::json!({ "height": 0, "carried": false, "landing": 0, "sequence": reset_sequence.unwrap_or(0) }),
            );
            window
                .set_focusable(false)
                .map_err(|error| error.to_string())?;
            window.hide().map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
        }
    }

    // 2. 같은 원본 상태로 다음 동작을 나타내는 트레이 문구와 앱 표시를 함께 갱신한다.
    if let Some(tray) = app.try_state::<TrayControls>() {
        tray.visible
            .set_text(if preferences.visible {
                "펫 숨기기"
            } else {
                "펫 표시"
            })
            .map_err(|e| e.to_string())?;
        tray.own_only
            .set_text(if preferences.show_others {
                "내 펫만 보기"
            } else {
                "친구 펫도 보기"
            })
            .map_err(|e| e.to_string())?;
    }
    if publish {
        app.emit("desktop-preferences-changed", &preferences)
            .map_err(|e| e.to_string())?;
        save(app, &preferences)?;
    }
    Ok(())
}

// 현재 창들이 공유하는 실제 표시·크기 설정을 반환한다.
#[tauri::command]
pub fn desktop_state(state: tauri::State<Shared>) -> Result<Preferences, String> {
    Ok(state.lock().map_err(|e| e.to_string())?.preferences.clone())
}

// 앱의 크기 조절과 표시 토글을 트레이와 같은 설정 원본에 적용한다.
#[tauri::command]
pub fn set_desktop_preferences(
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    visible: Option<bool>,
    show_others: Option<bool>,
    pet_size: Option<u32>,
    persist: Option<bool>,
) -> Result<(), String> {
    // 1. 모든 펫에 동일하게 적용할 크기 범위를 검증한다.
    if pet_size.is_some_and(|size| !(80..=240).contains(&size)) {
        return Err("펫 크기는 80~240px로 지정하세요".into());
    }
    let persist = persist.unwrap_or(true);
    if !persist && (visible.is_some() || show_others.is_some() || pet_size.is_none()) {
        return Err("미리보기는 펫 크기만 변경할 수 있습니다".into());
    }
    {
        let mut all = state.lock().map_err(|e| e.to_string())?;
        if let Some(value) = visible {
            all.preferences.visible = value;
        }
        if let Some(value) = show_others {
            all.preferences.show_others = value;
        }
        if let Some(value) = pet_size {
            all.preferences.pet_size = value;
        }
    }

    // 2. 연속 크기는 파일 저장·창 재배치 없이 모든 펫과 미리보기에 바로 전달한다.
    if !persist {
        let preferences = state.lock().map_err(|e| e.to_string())?.preferences.clone();
        return app
            .emit("desktop-preferences-changed", &preferences)
            .map_err(|e| e.to_string());
    }

    // 3. 고정 크기 투명 창 안의 발 기준점은 유지하고 마지막 설정만 영속화한다.
    apply(&app, &state, false, true)
}

#[derive(Clone)]
pub struct Attachment {
    pub host: String,
    pub index: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub host_pet_id: String,
    pub members: Vec<Member>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub pet_id: String,
}

// 제안자는 멈추고 수락한 펫은 해당 PC의 제안자 창 옆에 머무르게 한다.
#[tauri::command]
pub fn sync_gatherings(
    state: tauri::State<Shared>,
    local_pet_id: String,
    groups: Vec<Group>,
) -> Result<(), String> {
    // 1. 네트워크에서 받은 안정적인 펫 ID만 로컬 창 이름으로 바꾼다.
    if groups.len() > 32
        || !is_pet(&format!("peer-{local_pet_id}"))
        || groups.iter().any(|group| {
            group.members.len() > 1000
                || !is_pet(&format!("peer-{}", group.host_pet_id))
                || group
                    .members
                    .iter()
                    .any(|member| !is_pet(&format!("peer-{}", member.pet_id)))
        })
    {
        return Err("모임의 펫 대상을 확인하세요".into());
    }
    let label = |id: &str| {
        if id == local_pet_id {
            "pet".to_string()
        } else {
            format!("peer-{id}")
        }
    };
    let mut all = state.lock().map_err(|e| e.to_string())?;
    for pet in all.windows.values_mut() {
        pet.attachment = None;
    }

    // 2. 동일 모임의 창들에 제안자와 자리 순서를 연결한다.
    for group in groups {
        let host = label(&group.host_pet_id);
        if let Some(pet) = all.windows.get_mut(&host) {
            pet.attachment = Some(Attachment {
                host: host.clone(),
                index: 0,
            });
            pet.interaction_serial = pet.interaction_serial.wrapping_add(1);
        }
        for (index, member) in group.members.iter().enumerate() {
            if let Some(pet) = all.windows.get_mut(&label(&member.pet_id)) {
                pet.attachment = Some(Attachment {
                    host: host.clone(),
                    index: index + 1,
                });
                pet.interaction_serial = pet.interaction_serial.wrapping_add(1);
            }
        }
    }
    Ok(())
}

// 화면 가장자리에서는 빈 방향부터 자리를 배정해 제안자 위로 겹쳐 쌓이지 않게 한다.
pub fn neighbor_x(host: i32, minimum: i32, maximum: i32, stride: i32, index: usize) -> i32 {
    let stride = stride.max(1);
    let right_capacity = (maximum - host).max(0) / stride;
    let left_capacity = (host - minimum).max(0) / stride;
    let mut left = 0;
    let mut right = 0;
    let mut offset = 0;
    for _ in 0..index {
        if right <= left && right < right_capacity {
            right += 1;
            offset = right;
        } else if left < left_capacity {
            left += 1;
            offset = -left;
        } else if right < right_capacity {
            right += 1;
            offset = right;
        }
    }
    (host + offset * stride).clamp(minimum, maximum.max(minimum))
}
