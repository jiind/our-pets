#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connectors;
mod desktop_controls;
mod elevation;
mod gathering_layout;
mod locomotion;
mod message_bubbles;
mod pointer;
mod spatial;
mod system_notifications;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, PhysicalPosition};

#[derive(Clone, serde::Deserialize)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Clone)]
struct PetState {
    regions: Vec<Rect>,
    moving: bool,
    anchored: bool,
    dragging: bool,
    lift: elevation::LiftState,
    menu_open: bool,
    #[cfg(target_os = "linux")]
    menu_generation: u64,
    #[cfg(target_os = "linux")]
    menu_open_time: Option<u32>,
    input_active: bool,
    message_ready: bool,
    local_reacting: bool,
    visual_width: Option<f64>,
    nameplate_width: Option<f64>,
    gathering_overflow: bool,
    visual_height: Option<f64>,
    hand_reach: Option<f64>,
    hand_height: Option<f64>,
    motion: locomotion::MotionState,
    walking: bool,
    next_behavior: Instant,
    attachment: Option<desktop_controls::Attachment>,
    reduced_motion: bool,
    hidden: bool,
    direction: i32,
    ignored: bool,
    interacting_until: Instant,
    interaction_serial: u64,
}

struct DesktopState {
    interaction_serial: u64,
    windows: HashMap<String, PetState>,
    preferences: desktop_controls::Preferences,
    pet_registered: bool,
}

type Shared = Arc<Mutex<DesktopState>>;

// 각 펫 창에 독립적인 이동과 입력 상태를 부여한다.
fn initial_state(hidden: bool) -> PetState {
    PetState {
        regions: Vec::new(),
        moving: true,
        anchored: false,
        dragging: false,
        lift: elevation::LiftState::new(),
        menu_open: false,
        #[cfg(target_os = "linux")]
        menu_generation: 0,
        #[cfg(target_os = "linux")]
        menu_open_time: None,
        input_active: false,
        message_ready: false,
        local_reacting: false,
        visual_width: None,
        nameplate_width: None,
        gathering_overflow: false,
        visual_height: None,
        hand_reach: None,
        hand_height: None,
        motion: locomotion::MotionState::new(),
        walking: true,
        next_behavior: Instant::now() + Duration::from_secs(4),
        attachment: None,
        reduced_motion: false,
        hidden,
        direction: 1,
        ignored: false,
        interacting_until: Instant::now(),
        interaction_serial: 0,
    }
}

// 친구 펫 창인지 안정적인 펫 ID 형식으로 확인한다.
fn is_pet(label: &str) -> bool {
    label == "pet"
        || label
            .strip_prefix("peer-")
            .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum PairAction {
    Wave,
    Highfive,
}

// 접근과 복귀에 동일한 가감속을 사용해 출발·정지 시 속도가 튀지 않게 한다.
fn ease_in_out(progress: f64) -> f64 {
    if progress < 0.5 {
        4.0 * progress.powi(3)
    } else {
        1.0 - (-2.0 * progress + 2.0).powi(3) / 2.0
    }
}

// 각 창의 운영체제 동작 줄이기 설정을 자동 이동에 반영한다.
#[tauri::command]
fn set_motion_preference(
    window: tauri::WebviewWindow,
    state: tauri::State<Shared>,
    reduced: bool,
) -> Result<(), String> {
    if let Some(pet) = state
        .lock()
        .map_err(|e| e.to_string())?
        .windows
        .get_mut(window.label())
    {
        pet.reduced_motion = reduced;
        if reduced {
            pet.motion.stop();
            pet.motion.reset_observation();
        }
    }
    Ok(())
}

// 수신 펫의 위치를 기준으로 발신 펫의 접근·복귀와 양쪽의 반응을 같은 시계로 재생한다.
#[tauri::command]
fn animate_pair(
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    local_pet_id: String,
    from_id: String,
    to_id: String,
    action: PairAction,
    reduced_motion: bool,
) -> Result<(), String> {
    // 1. 숨김·직접 조작·모임 상태를 존중하고 두 펫의 반응 시작 시계를 한 번 확정한다.
    if !is_pet(&format!("peer-{local_pet_id}"))
        || !is_pet(&format!("peer-{from_id}"))
        || !is_pet(&format!("peer-{to_id}"))
        || from_id == to_id
        || (local_pet_id != from_id && local_pet_id != to_id)
    {
        return Err("잘못된 상호작용 대상".into());
    }
    // 발신·수신 PC 모두 수신 펫을 고정하고 발신 펫이 방문하는 같은 역할을 사용한다.
    let ordered = [&to_id, &from_id];
    let labels: Vec<String> = ordered
        .iter()
        .map(|id| {
            if id.as_str() == local_pet_id.as_str() {
                "pet".into()
            } else {
                format!("peer-{id}")
            }
        })
        .collect();
    let windows: Vec<_> = labels
        .iter()
        .filter_map(|label| app.get_webview_window(label))
        .filter(|window| window.is_visible().unwrap_or(false))
        .collect();
    let data = state.lock().map_err(|error| error.to_string())?;
    if labels.iter().any(|label| {
        data.windows.get(label).is_some_and(|pet| {
            pet.menu_open || pet.input_active || pet.dragging || pet.lift.active()
        })
    }) {
        return Ok(());
    }
    if labels.iter().any(|label| {
        data.windows
            .get(label)
            .is_some_and(|pet| pet.attachment.is_some())
    }) {
        return Err("함께하기를 마친 뒤 상호작용할 수 있습니다".into());
    }
    let body = match action {
        PairAction::Wave => "wave",
        PairAction::Highfive => "highfive",
    };
    if windows.len() != 2 || reduced_motion {
        drop(data);
        app.emit("pair-reaction", serde_json::json!({ "fromID": from_id, "toID": to_id, "leftID": to_id, "body": body, "startedAtUnixMs": locomotion::unix_millis(), "approachMs": 800, "holdMs": 1400, "returnMs": 1000 })).map_err(|error| error.to_string())?;
        return Ok(());
    }
    let states: Vec<_> = labels
        .iter()
        .map(|label| {
            data.windows
                .get(label)
                .cloned()
                .ok_or("펫 상태를 찾을 수 없습니다")
        })
        .collect::<Result<_, _>>()?;
    let pet_size = data.preferences.pet_size as f64;
    drop(data);

    // 2. 창별 DPI와 손 기준점을 물리 좌표로 바꿔 양쪽 손이 같은 지점에 닿도록 배치한다.
    let monitor = windows[0]
        .current_monitor()
        .map_err(|error| error.to_string())?
        .ok_or("화면 없음")?;
    let work = monitor.work_area().clone();
    let mut paths = Vec::new();
    for (window, pet) in windows.into_iter().zip(states) {
        desktop_controls::fit(&window)?;
        let start = window.outer_position().map_err(|error| error.to_string())?;
        let size = window.outer_size().map_err(|error| error.to_string())?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let greeting_gap = if matches!(action, PairAction::Wave) {
            18.0
        } else {
            0.0
        };
        let reach = (pet.hand_reach.unwrap_or(pet_size * 0.36) + greeting_gap) * scale;
        let hand_height = pet.hand_height.unwrap_or(pet_size * 0.5) * scale;
        paths.push((window, start, size, scale, reach, hand_height));
    }
    // 상대 펫은 현재 위치를 지키고 발신 펫은 가장 가까운 빈 쪽으로 접근한다.
    let anchor_center = paths[0].1.x as f64 + paths[0].2.width as f64 * 0.5;
    let visitor_center = paths[1].1.x as f64 + paths[1].2.width as f64 * 0.5;
    let separation = paths[0].4 + paths[1].4;
    let right_goal = anchor_center + separation - paths[1].2.width as f64 * 0.5;
    let left_goal = anchor_center - separation - paths[1].2.width as f64 * 0.5;
    let right_fits =
        right_goal + paths[1].2.width as f64 <= work.position.x as f64 + work.size.width as f64;
    let left_fits = left_goal >= work.position.x as f64;
    let visitor_right = if visitor_center >= anchor_center {
        right_fits || !left_fits
    } else {
        !left_fits && right_fits
    };
    let left_id = if visitor_right {
        to_id.clone()
    } else {
        from_id.clone()
    };
    // 3. 창 준비에 실패한 경우 반응 상태를 남기지 않고 준비가 끝난 시점에 공통 시계를 시작한다.
    let mut data = state.lock().map_err(|error| error.to_string())?;
    if labels.iter().any(|label| {
        data.windows.get(label).is_none_or(|pet| {
            pet.hidden
                || pet.menu_open
                || pet.input_active
                || pet.dragging
                || pet.lift.active()
                || pet.attachment.is_some()
        })
    }) {
        return Ok(());
    }
    data.interaction_serial = data.interaction_serial.wrapping_add(1);
    let serial = data.interaction_serial;
    let started = Instant::now();
    let started_at = locomotion::unix_millis();
    for label in &labels {
        if let Some(pet) = data.windows.get_mut(label) {
            pet.interaction_serial = serial;
            pet.interacting_until = started + Duration::from_millis(3300);
            pet.motion.stop();
        }
    }
    drop(data);
    app.emit("pair-reaction", serde_json::json!({ "fromID": from_id, "toID": to_id, "leftID": left_id, "body": body, "startedAtUnixMs": started_at, "approachMs": 800, "holdMs": 1400, "returnMs": 1000 })).map_err(|error| error.to_string())?;

    // 4. 상대는 제자리에 두고 발신 창의 접근·복귀와 두 펫의 반응을 같은 시간으로 진행한다.
    let shared = state.inner().clone();
    std::thread::spawn(move || {
        let mut previous = Instant::now();
        loop {
            let frame = Instant::now();
            let elapsed = frame.duration_since(started).as_secs_f64();
            let seconds = frame.duration_since(previous).as_secs_f64().max(0.001);
            previous = frame;
            let cancelled = shared
                .lock()
                .map(|all| {
                    paths.iter().any(|(window, _, _, _, _, _)| {
                        all.windows.get(window.label()).is_none_or(|pet| {
                            pet.interaction_serial != serial
                                || pet.hidden
                                || pet.reduced_motion
                                || pet.menu_open
                                || pet.input_active
                                || pet.dragging
                                || pet.lift.active()
                        })
                    })
                })
                .unwrap_or(true);
            if cancelled {
                for (window, _, _, _, _, _) in &paths {
                    let stopped = if let Ok(mut all) = shared.lock() {
                        if let Some(pet) = all
                            .windows
                            .get_mut(window.label())
                            .filter(|pet| pet.interaction_serial == serial)
                        {
                            pet.interacting_until = Instant::now();
                            pet.motion.stop();
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if stopped {
                        let _ = app.emit_to(window.label(), "pair-motion-cancelled", ());
                    }
                }
                return;
            }
            let progress = if elapsed < 0.8 {
                ease_in_out(elapsed / 0.8)
            } else if elapsed < 2.2 {
                1.0
            } else {
                ease_in_out(((3.2 - elapsed) / 1.0).clamp(0.0, 1.0))
            };
            // 모니터를 건너며 DPI가 바뀌어도 현재 창 크기와 손 높이로 접점을 다시 맞춘다.
            let metrics: Vec<_> = paths
                .iter()
                .map(|(window, _, size, scale, reach, height)| {
                    let actual_size = window.outer_size().unwrap_or(*size);
                    let actual_scale = window.scale_factor().unwrap_or(*scale);
                    (
                        actual_size,
                        actual_scale,
                        reach / scale * actual_scale,
                        height / scale * actual_scale,
                    )
                })
                .collect();
            let goals: Vec<_> = metrics
                .iter()
                .enumerate()
                .map(|(index, (size, scale, reach, _))| {
                    let anchor = paths[0].1;
                    if index == 0 {
                        return (anchor.x, anchor.y);
                    }
                    let center = anchor.x as f64
                        + metrics[0].0.width as f64 * 0.5
                        + (metrics[0].2 + *reach) * if visitor_right { 1.0 } else { -1.0 };
                    let floor = anchor.y as f64 + metrics[0].0.height as f64 - 30.0 * metrics[0].1;
                    clamp_position(
                        (center - size.width as f64 * 0.5).round() as i32,
                        (floor + 30.0 * scale - size.height as f64).round() as i32,
                        size.width,
                        size.height,
                        work.position.x,
                        work.position.y,
                        work.size.width,
                        work.size.height,
                    )
                })
                .collect();
            for (index, (window, start, _, _, _, _)) in paths.iter().enumerate() {
                let Ok(before) = window.outer_position() else {
                    continue;
                };
                let goal = goals[index];
                let target = (
                    start.x + ((goal.0 - start.x) as f64 * progress).round() as i32,
                    start.y + ((goal.1 - start.y) as f64 * progress).round() as i32,
                );
                let awaiting_layout = shared
                    .lock()
                    .map(|all| {
                        all.windows
                            .get(window.label())
                            .is_some_and(|pet| pet.motion.awaiting_layout())
                    })
                    .unwrap_or(false);
                if (before.x != target.0 || before.y != target.1) && !awaiting_layout {
                    let allowed = shared
                        .lock()
                        .map(|all| {
                            all.windows.get(window.label()).is_some_and(|pet| {
                                pet.interaction_serial == serial
                                    && !pet.hidden
                                    && !pet.menu_open
                                    && !pet.input_active
                                    && !pet.dragging
                                    && !pet.lift.active()
                            })
                        })
                        .unwrap_or(false);
                    if !allowed {
                        continue;
                    }
                    let _ = window.set_position(PhysicalPosition::new(target.0, target.1));
                }
                let mut motion_sample = None;
                let workspace = window.current_monitor().ok().flatten().map(|monitor| {
                    let area = monitor.work_area();
                    (
                        area.position.x,
                        area.position.y,
                        area.size.width,
                        area.size.height,
                    )
                });
                if let (Ok(after), Ok(scale), Ok(actual_size), Ok(mut all)) = (
                    window.outer_position(),
                    window.scale_factor(),
                    window.outer_size(),
                    shared.lock(),
                ) {
                    if let Some(pet) = all
                        .windows
                        .get_mut(window.label())
                        .filter(|pet| pet.interaction_serial == serial)
                    {
                        let direction = pet.direction;
                        pet.motion.velocity_x = (target.0 - before.x) as f64 / scale / seconds;
                        pet.motion.velocity_y = (target.1 - before.y) as f64 / scale / seconds;
                        let workspace_changed =
                            workspace.is_some_and(|bounds| pet.motion.observe_workspace(bounds));
                        let stable_geometry = !workspace_changed
                            && (scale - metrics[index].1).abs() < 0.001
                            && actual_size == metrics[index].0;
                        motion_sample = pet.motion.sample(
                            (before.x, before.y),
                            (after.x, after.y),
                            scale,
                            seconds,
                            direction,
                            true,
                            stable_geometry,
                        );
                        if let Some(actual_direction) = pet.motion.actual_direction {
                            pet.direction = actual_direction;
                        }
                        if elapsed >= 3.2 {
                            pet.interacting_until = Instant::now();
                            pet.motion.stop();
                        }
                    }
                }
                if let Some(sample) = motion_sample {
                    let _ = app.emit_to(window.label(), "pet-motion", sample);
                }
            }
            if elapsed >= 3.2 {
                break;
            }
            let remaining = Duration::from_secs_f64(1.0 / 30.0).saturating_sub(frame.elapsed());
            std::thread::sleep(remaining);
        }
    });
    Ok(())
}

// 현재 표시할 친구마다 별도의 투명 창을 만들고 숨겨진 친구 창을 정리한다.
#[tauri::command]
fn sync_peers(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    pet_ids: Vec<String>,
) -> Result<(), String> {
    // 1. 대표 펫 창에서만 친구 목록을 동기화할 수 있게 한다.
    if window.label() != "pet"
        || pet_ids.len() > 32
        || pet_ids.iter().any(|id| !is_pet(&format!("peer-{id}")))
    {
        return Err("잘못된 친구 펫 목록".into());
    }
    let labels: Vec<String> = pet_ids.iter().map(|id| format!("peer-{id}")).collect();
    for (label, old) in app.webview_windows() {
        if label.starts_with("peer-") && !labels.contains(&label) {
            old.destroy().map_err(|e| e.to_string())?;
            state
                .lock()
                .map_err(|e| e.to_string())?
                .windows
                .remove(&label);
        }
    }

    // 2. 신규 창은 포커스를 받지 않는 상태로 화면 안에 배치한다.
    for (index, id) in pet_ids.iter().enumerate() {
        let label = format!("peer-{id}");
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        state
            .lock()
            .map_err(|e| e.to_string())?
            .windows
            .insert(label.clone(), initial_state(true));
        let peer = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::App(format!("index.html?pet&target={id}").into()),
        )
        .title("우리 펫 · 친구")
        .inner_size(360.0, 560.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
        if let Some(monitor) = peer.primary_monitor().map_err(|e| e.to_string())? {
            let work = monitor.work_area();
            let size = &work.size;
            let scale = monitor.scale_factor();
            let x = work.position.x
                + (((index + 1) * 210) as i32)
                    .rem_euclid(size.width.saturating_sub((360.0 * scale) as u32).max(1) as i32);
            // 새 창의 배치 응답을 읽기 전에 초기 좌표를 바닥 정렬에 직접 전달한다.
            desktop_controls::align(&peer, Some(x))?;
            let mut all = state.lock().map_err(|e| e.to_string())?;
            if let Some(pet) = all.windows.get_mut(&label) {
                pet.anchored = true;
            }
        }
    }
    desktop_controls::apply(&app, &state, false, false)
}

// 현재 모집자의 화면에 표시하지 못한 참여자 수를 반환한다.
#[tauri::command]
fn gathering_overflow(
    window: tauri::WebviewWindow,
    state: tauri::State<Shared>,
) -> Result<usize, String> {
    // 1. 펫 창에서 요청한 모집 상태만 읽는다.
    if !is_pet(window.label()) {
        return Err("펫 창에서만 모집 상태를 확인할 수 있습니다".into());
    }

    // 2. 이 창의 모집에 참여하지만 화면에 표시되지 않은 펫을 센다.
    let all = state.lock().map_err(|error| error.to_string())?;
    Ok(all
        .windows
        .values()
        .filter(|pet| {
            pet.gathering_overflow
                && pet
                    .attachment
                    .as_ref()
                    .is_some_and(|attachment| attachment.host == window.label())
        })
        .count())
}

// 펫을 잡은 지점 기준으로 좌우 이동과 바닥 위 높이 드래그를 시작한다.
#[tauri::command]
fn drag_pet(window: tauri::WebviewWindow, state: tauri::State<Shared>) -> Result<(), String> {
    if !is_pet(window.label()) {
        return Err("펫 창에서만 이동할 수 있습니다".into());
    }
    elevation::begin(&window, &state)
}

// 펫을 놓으면 수동 이동을 끝내고 남은 높이에서 바닥으로 내려오게 한다.
#[tauri::command]
fn drop_pet(window: tauri::WebviewWindow, state: tauri::State<Shared>) -> Result<(), String> {
    if !is_pet(window.label()) {
        return Err("펫 창에서만 놓을 수 있습니다".into());
    }
    if let Some(pet) = state
        .lock()
        .map_err(|error| error.to_string())?
        .windows
        .get_mut(window.label())
    {
        pet.dragging = false;
        pet.lift.release();
    }
    Ok(())
}

// 펫의 실제 그림과 메뉴 영역에만 마우스 입력을 허용한다.
#[tauri::command]
fn set_regions(
    window: tauri::WebviewWindow,
    state: tauri::State<Shared>,
    regions: Vec<Rect>,
    menu_open: Option<bool>,
    reacting: Option<bool>,
    visual_width: Option<f64>,
    nameplate_width: Option<f64>,
    visual_height: Option<f64>,
    hand_reach: Option<f64>,
    hand_height: Option<f64>,
) -> Result<(), String> {
    // 1. 펫 창에서 전달한 유효한 논리 좌표만 보관한다.
    if !is_pet(window.label()) || regions.len() > 4096 {
        return Err("잘못된 입력 영역".into());
    }
    let regions: Vec<Rect> = regions
        .into_iter()
        .filter(|r| r.width > 0 && r.height > 0)
        .collect();
    #[cfg(target_os = "linux")]
    let menu_time = if menu_open.unwrap_or(false) {
        pointer::last_x11_user_time()
    } else {
        None
    };
    if let Some(data) = state
        .lock()
        .map_err(|e| e.to_string())?
        .windows
        .get_mut(window.label())
    {
        data.regions = regions.clone();
        #[cfg(target_os = "linux")]
        if data.menu_open != menu_open.unwrap_or(false) {
            data.menu_generation = data.menu_generation.wrapping_add(1);
            data.menu_open_time = menu_time;
        }
        data.menu_open = menu_open.unwrap_or(false);
        data.local_reacting = reacting.unwrap_or(false);
        if let Some(width) =
            visual_width.filter(|width| width.is_finite() && (1.0..=240.0).contains(width))
        {
            data.visual_width = Some(width);
        }
        if let Some(width) =
            nameplate_width.filter(|width| width.is_finite() && (0.0..=280.0).contains(width))
        {
            data.nameplate_width = Some(width);
        }
        if let Some(height) =
            visual_height.filter(|height| height.is_finite() && (1.0..=240.0).contains(height))
        {
            data.visual_height = Some(height);
        }
        data.hand_reach =
            hand_reach.filter(|value| value.is_finite() && (0.0..=240.0).contains(value));
        data.hand_height =
            hand_height.filter(|value| value.is_finite() && (0.0..=240.0).contains(value));
    }

    // 2. Linux에서는 GDK 입력 모양으로 빈 픽셀의 클릭을 직접 통과시킨다.
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let widget = window.gtk_window().map_err(|e| e.to_string())?;
        if let Some(surface) = widget.window() {
            let shape = cairo::Region::create();
            for r in regions {
                shape
                    .union_rectangle(&cairo::RectangleInt::new(r.x, r.y, r.width, r.height))
                    .map_err(|e| e.to_string())?;
            }
            surface.input_shape_combine_region(&shape, 0, 0);
        }
    }
    Ok(())
}

// 사용자가 펫 위에서 작성하는 동안만 해당 창의 키보드 입력을 허용한다.
#[tauri::command]
fn set_pet_input(
    window: tauri::WebviewWindow,
    state: tauri::State<Shared>,
    active: bool,
) -> Result<(), String> {
    // 1. 설정 창과 다른 창에서 포커스 정책을 바꾸지 못하게 제한한다.
    if !is_pet(window.label()) {
        return Err("펫 창에서만 작성할 수 있습니다".into());
    }
    window.set_focusable(active).map_err(|e| e.to_string())?;

    // 2. 직접 연 작성창에만 포커스를 주고 일반 수신에서는 요청하지 않는다.
    if active {
        window.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(pet) = state
        .lock()
        .map_err(|error| error.to_string())?
        .windows
        .get_mut(window.label())
    {
        pet.input_active = active;
    }
    Ok(())
}

// 현재 펫이 있는 OS 작업영역의 논리 크기를 팝업 배치에 제공한다.
#[tauri::command]
fn pet_work_area(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    // 1. 바뀐 모니터의 작업영역에 창을 맞춘 뒤 논리 좌표로 안내한다.
    if is_pet(window.label()) {
        desktop_controls::fit(&window)?;
    }
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or("화면을 찾을 수 없습니다")?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let position = window.outer_position().map_err(|error| error.to_string())?;

    // 2. 창 위쪽이 작업영역 밖이면 웹 팝업도 같은 여백을 피하도록 전달한다.
    Ok(
        serde_json::json!({ "width": work.size.width as f64 / scale, "height": work.size.height as f64 / scale, "scaleFactor": scale, "workTop": work.position.y, "overlayTop": ((work.position.y - position.y).max(0) as f64 / scale) }),
    )
}

// 사용자가 선택한 펫 표시·이동·설정 동작을 수행한다.
#[tauri::command]
fn pet_control(
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    action: String,
) -> Result<(), String> {
    // 1. 앱·트레이의 표시 옵션은 같은 설정 원본에서 변경한다.
    if matches!(
        action.as_str(),
        "show" | "hide" | "toggle" | "others" | "restore"
    ) {
        {
            let mut all = state.lock().map_err(|e| e.to_string())?;
            match action.as_str() {
                "show" => all.preferences.visible = true,
                "hide" => all.preferences.visible = false,
                "toggle" => all.preferences.visible = !all.preferences.visible,
                "others" => all.preferences.show_others = !all.preferences.show_others,
                _ => (),
            }
        }
        return desktop_controls::apply(&app, &state, false, true);
    }

    // 2. 사용자가 요청한 설정 열기에서만 키보드 포커스를 이동한다.
    match action.as_str() {
        "live-bubble" | "pet-menu" => {
            if let Some(pet) = app
                .get_webview_window("pet")
                .filter(|pet| pet.is_visible().unwrap_or(false))
            {
                pet.set_focusable(true).map_err(|error| error.to_string())?;
                pet.set_focus().map_err(|error| error.to_string())?;
                if let Some(data) = state
                    .lock()
                    .map_err(|error| error.to_string())?
                    .windows
                    .get_mut("pet")
                {
                    data.input_active = true;
                }
                let event = if action == "live-bubble" {
                    "focus-live-bubble"
                } else {
                    "focus-pet-menu"
                };
                app.emit_to("pet", event, ())
                    .map_err(|error| error.to_string())?;
            }
        }
        "retry-connection" => {
            app.emit_to("pet", "retry-pet-connection", ())
                .map_err(|error| error.to_string())?;
        }
        "settings" => {
            if let Some(settings) = app.get_webview_window("settings") {
                settings.show().map_err(|e| e.to_string())?;
                settings.set_focus().map_err(|e| e.to_string())?;
            }
        }
        "quit" => app.exit(0),
        _ => return Err("알 수 없는 제어".into()),
    }
    Ok(())
}

// 모니터 경계 안에 창 좌표를 보정한다.
#[expect(
    clippy::too_many_arguments,
    reason = "창과 모니터의 물리 좌표를 그대로 전달한다"
)]
fn clamp_position(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    mx: i32,
    my: i32,
    mw: u32,
    mh: u32,
) -> (i32, i32) {
    (
        x.clamp(mx, mx + mw.saturating_sub(width) as i32),
        y.clamp(my, my + mh.saturating_sub(height) as i32),
    )
}

// 실제 경과 시간으로 가감속하며 발 이동량과 네이티브 창의 위치를 함께 전달한다.
fn start_motion(app: tauri::AppHandle, state: Shared) {
    std::thread::spawn(move || {
        let mut previous = Instant::now();
        let mut next_layout_check = previous;
        let mut hover_states = HashMap::new();
        loop {
            // 1. 화면 보정을 먼저 마친 뒤 같은 프레임의 실제 위치와 경과 시간을 읽는다.
            let frame = Instant::now();
            let seconds = frame
                .duration_since(previous)
                .as_secs_f64()
                .clamp(0.001, 0.12);
            previous = frame;
            let mut active = false;
            let mut windows: Vec<_> = app.webview_windows().into_iter().collect();
            windows.sort_by(|(left, _), (right, _)| left.cmp(right));
            hover_states.retain(|label, _| windows.iter().any(|(current, _)| current == label));
            if frame >= next_layout_check {
                for (label, window) in &windows {
                    if is_pet(label) {
                        let _ = desktop_controls::fit(window);
                    }
                }
                next_layout_check = frame + Duration::from_millis(500);
            }
            let mut scene = spatial::snapshot(&app, &state);
            for (label, pet) in windows {
                if !is_pet(&label) {
                    continue;
                }
                let Some((mut data, pet_size, gathering_width)) =
                    state.lock().ok().and_then(|all| {
                        let pet = all.windows.get(&label)?.clone();
                        let host = pet
                            .attachment
                            .as_ref()
                            .map(|attachment| attachment.host.as_str());
                        let width = all
                            .windows
                            .values()
                            .filter(|other| {
                                !other.hidden
                                    && host.is_some()
                                    && other.attachment.as_ref().is_some_and(|attachment| {
                                        Some(attachment.host.as_str()) == host
                                    })
                            })
                            .map(|other| {
                                other
                                    .visual_width
                                    .unwrap_or(all.preferences.pet_size as f64)
                                    .max(other.nameplate_width.unwrap_or(0.0))
                            })
                            .fold(0.0_f64, f64::max);
                        Some((pet, all.preferences.pet_size, width))
                    })
                else {
                    continue;
                };
                if data.hidden || data.dragging || data.lift.active() {
                    if hover_states.insert(label.clone(), false) != Some(false) {
                        let _ = app.emit_to(&label, "pet-hover", false);
                    }
                    if data.hidden {
                        continue;
                    }
                }
                if data.dragging || data.lift.active() {
                    active = true;
                    if elevation::tick(&pet, &state, seconds).is_err() {
                        let mut sequence = 0;
                        if let Ok(mut all) = state.lock() {
                            if let Some(current) = all.windows.get_mut(&label) {
                                current.dragging = false;
                                sequence = current.lift.cancel();
                                current.motion.reset_observation();
                            }
                        }
                        let _ = pet.emit_to(
                            &label,
                            "pet-elevation",
                            serde_json::json!({ "height": 0, "carried": false, "landing": 0, "sequence": sequence }),
                        );
                    }
                    continue;
                }
                let observation_epoch = data.motion.observation_epoch;
                let (Ok(pos), Ok(size), Ok(scale), Ok(cursor)) = (
                    pet.outer_position(),
                    pet.outer_size(),
                    pet.scale_factor(),
                    pet.cursor_position(),
                ) else {
                    continue;
                };
                let point = (
                    (cursor.x - pos.x as f64) / scale,
                    (cursor.y - pos.y as f64) / scale,
                );
                let hit = data.regions.iter().any(|region| {
                    point.0 >= region.x as f64
                        && point.1 >= region.y as f64
                        && point.0 < (region.x + region.width) as f64
                        && point.1 < (region.y + region.height) as f64
                });
                // 실제 입력 픽셀 위의 포인터 상태가 바뀔 때만 이름표 표시 이벤트를 보낸다.
                if hover_states.insert(label.clone(), hit) != Some(hit) {
                    let _ = app.emit_to(&label, "pet-hover", hit);
                }
                #[cfg(not(target_os = "linux"))]
                if data.ignored == hit {
                    let _ = pet.set_ignore_cursor_events(!hit);
                    data.ignored = !hit;
                }
                if data.interacting_until > frame && data.attachment.is_none() {
                    continue;
                }

                // 2. 모임의 옆자리 또는 일상 보행 목표를 정하고 사용자 조작은 즉시 정지시킨다.
                let locked = data.menu_open
                    || data.input_active
                    || data.local_reacting
                    || hit
                    || data.motion.awaiting_layout();
                let mut goal = None;
                let mut overflow = None;
                let mut desired = (0.0, 0.0);
                let maximum_speed = (pet_size as f64 * 0.22).clamp(18.0, 48.0);
                if let Some(attachment) = &data.attachment {
                    if attachment.index > 0 && !locked {
                        if let Some(host) = app
                            .get_webview_window(&attachment.host)
                            .filter(|window| window.is_visible().unwrap_or(false))
                        {
                            if let (
                                Ok(host_pos),
                                Ok(host_size),
                                Ok(host_scale),
                                Ok(Some(monitor)),
                            ) = (
                                host.outer_position(),
                                host.outer_size(),
                                host.scale_factor(),
                                host.current_monitor(),
                            ) {
                                let work = monitor.work_area();
                                let y = host_pos.y + host_size.height as i32 - size.height as i32
                                    + (30.0 * (scale - host_scale)).round() as i32;
                                let stride_x = ((gathering_width + 16.0) * scale.max(host_scale))
                                    .ceil() as i32;
                                let stride_y = gathering_layout::row_stride(
                                    pet_size as f64,
                                    scale.max(host_scale),
                                );
                                let minimum_y = work.position.y - size.height as i32
                                    + ((pet_size as f64 + 64.0) * scale).ceil() as i32;
                                let destination = gathering_layout::position(
                                    (host_pos.x, y),
                                    (
                                        work.position.x,
                                        work.position.x
                                            + work.size.width.saturating_sub(size.width) as i32,
                                    ),
                                    minimum_y,
                                    stride_x,
                                    stride_y,
                                    attachment.index,
                                );
                                overflow = Some(destination.is_none());
                                if let Some((x, y)) = destination {
                                    goal = Some((x, y));
                                    desired =
                                        ((x - pos.x) as f64 / scale, (y - pos.y) as f64 / scale);
                                }
                            }
                        }
                    } else {
                        data.motion.stop();
                    }
                } else {
                    if frame >= data.next_behavior {
                        data.walking = !data.walking;
                        data.next_behavior = frame
                            + Duration::from_secs(3 + (uuid::Uuid::new_v4().as_u128() % 4) as u64);
                    }
                    let stopping_time = data.motion.velocity_x.abs() / 180.0;
                    if data.moving
                        && data.walking
                        && !locked
                        && data
                            .next_behavior
                            .saturating_duration_since(frame)
                            .as_secs_f64()
                            > stopping_time
                    {
                        desired.0 = data.direction as f64 * 1000.0;
                    }
                }
                // 자리가 부족한 창만 잠시 숨기고 자리가 생기거나 모집이 끝나면 복원한다.
                let overflow = overflow.or_else(|| data.attachment.is_none().then_some(false));
                if let Some(overflow) =
                    overflow.filter(|overflow| *overflow != data.gathering_overflow)
                {
                    let result = if overflow { pet.hide() } else { pet.show() };
                    if result.is_ok() {
                        let host = data
                            .attachment
                            .as_ref()
                            .map(|attachment| attachment.host.clone());
                        let count = state.lock().ok().map(|mut all| {
                            if let Some(current) = all.windows.get_mut(&label) {
                                current.gathering_overflow = overflow;
                            }
                            all.windows
                                .values()
                                .filter(|pet| {
                                    pet.gathering_overflow
                                        && pet.attachment.as_ref().is_some_and(|attachment| {
                                            Some(&attachment.host) == host.as_ref()
                                        })
                                })
                                .count()
                        });
                        if let (Some(host), Some(count)) = (host, count) {
                            let _ = app.emit_to(&host, "gathering-overflow", count);
                        }
                        data.gathering_overflow = overflow;
                    }
                }
                if locked || data.reduced_motion || (data.attachment.is_some() && goal.is_none()) {
                    data.motion.stop();
                }
                let movement = if data.reduced_motion || locked {
                    (0, 0)
                } else {
                    data.motion.step(desired, maximum_speed, seconds, scale)
                };
                let mut target = (pos.x + movement.0, pos.y + movement.1);
                let mut layout_warp = false;
                if let Some(destination) = goal {
                    if data.reduced_motion && !locked {
                        target = destination;
                    }
                    if (destination.0 - pos.x).abs() < movement.0.abs() {
                        target.0 = destination.0;
                    }
                    if (destination.1 - pos.y).abs() < movement.1.abs() {
                        target.1 = destination.1;
                    }
                    if target == destination {
                        data.motion.stop();
                    }
                }

                // 3. 작업영역과 주변 펫을 존중하고 충돌 직전에는 관성보다 안전한 양보를 우선한다.
                let monitor_window = data
                    .attachment
                    .as_ref()
                    .and_then(|attachment| app.get_webview_window(&attachment.host))
                    .unwrap_or_else(|| pet.clone());
                if let Ok(Some(monitor)) = monitor_window.current_monitor() {
                    let work = monitor.work_area();
                    layout_warp |= data.motion.observe_workspace((
                        work.position.x,
                        work.position.y,
                        work.size.width,
                        work.size.height,
                    ));
                    let mut bounded = clamp_position(
                        target.0,
                        target.1,
                        size.width,
                        size.height,
                        work.position.x,
                        work.position.y,
                        work.size.width,
                        work.size.height,
                    );
                    if data
                        .attachment
                        .as_ref()
                        .is_some_and(|attachment| attachment.index > 0)
                    {
                        let minimum_y = work.position.y - size.height as i32
                            + ((pet_size as f64 + 64.0) * scale).ceil() as i32;
                        bounded.1 = target
                            .1
                            .clamp(minimum_y.min(work.position.y), work.position.y);
                    }
                    if bounded != target {
                        let expected = maximum_speed * seconds * scale + 2.0 * scale;
                        layout_warp |= (bounded.0 - pos.x).abs() as f64 > expected
                            || (bounded.1 - pos.y).abs() as f64 > expected;
                        data.motion.stop();
                        if bounded.0 != target.0 {
                            data.direction *= -1;
                        }
                    }
                    target = bounded;
                    if data.attachment.is_none() && !locked {
                        let (safe, yielded) = spatial::avoid(
                            &scene,
                            &label,
                            target,
                            (
                                work.position.x,
                                work.position.y,
                                work.position.x + work.size.width.saturating_sub(size.width) as i32,
                                work.position.y
                                    + work.size.height.saturating_sub(size.height) as i32,
                            ),
                            data.reduced_motion,
                            maximum_speed * seconds,
                        );
                        if yielded {
                            if safe.0 == pos.x && data.motion.velocity_x.abs() > 0.1 {
                                data.direction *= -1;
                            }
                            data.motion.stop();
                            data.walking = false;
                            data.next_behavior = frame + Duration::from_secs(2);
                        }
                        target = safe;
                    }
                }
                if target != (pos.x, pos.y) {
                    if layout_warp && !data.motion.awaiting_layout() {
                        data.motion.reset_for_layout(target);
                    }
                    let allowed = state
                        .lock()
                        .map(|all| {
                            all.windows.get(&label).is_some_and(|current| {
                                current.interaction_serial == data.interaction_serial
                                    && !current.hidden
                                    && !current.dragging
                                    && !current.lift.active()
                                    && !current.menu_open
                                    && !current.input_active
                            })
                        })
                        .unwrap_or(false);
                    if allowed {
                        let _ = pet.set_position(PhysicalPosition::new(target.0, target.1));
                    }
                }
                let after = pet.outer_position().unwrap_or(pos);
                let actual_scale = pet.scale_factor().unwrap_or(scale);
                layout_warp |= (actual_scale - scale).abs() > 0.001
                    || pet.outer_size().is_ok_and(|actual| actual != size);
                if layout_warp && !data.motion.awaiting_layout() {
                    data.motion.reset_observation();
                }
                if let Some(occupied) = scene.iter_mut().find(|occupied| occupied.label == label) {
                    occupied.x = after.x;
                    occupied.y = after.y;
                }

                // 4. 실제 이동 거리만 발 위상에 반영하고 쉬는 32개 창에 매 프레임 이벤트를 보내지 않는다.
                active |=
                    after != pos || data.motion.velocity_x.hypot(data.motion.velocity_y) > 0.1;
                let sample = data.motion.sample(
                    (pos.x, pos.y),
                    (after.x, after.y),
                    actual_scale,
                    seconds,
                    data.direction,
                    false,
                    !data.reduced_motion && !layout_warp,
                );
                let publish = if let Ok(mut all) = state.lock() {
                    if let Some(current) = all.windows.get_mut(&label).filter(|current| {
                        current.interaction_serial == data.interaction_serial
                            && current.motion.observation_epoch == observation_epoch
                    }) {
                        current.direction = data.direction;
                        current.ignored = data.ignored;
                        current.walking = data.walking;
                        current.next_behavior = data.next_behavior;
                        current.motion = data.motion;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if publish {
                    if let Some(sample) = sample {
                        let _ = app.emit_to(&label, "pet-motion", sample);
                    }
                }
            }
            let interval = if active {
                Duration::from_secs_f64(1.0 / 30.0)
            } else {
                Duration::from_millis(100)
            };
            std::thread::sleep(interval.saturating_sub(frame.elapsed()));
        }
    });
}

// 트레이 메뉴와 두 창을 구성하고 데스크톱 앱을 실행한다.
fn main() {
    // 상태줄 수집은 GUI나 기존 데스크톱 세션을 만들지 않고 먼저 종료한다.
    if connectors::claude_bridge::handle_cli() {
        return;
    }
    // 1. Linux에서는 X11 또는 XWayland를 명시적으로 사용한다.
    #[cfg(target_os = "linux")]
    std::env::set_var("GDK_BACKEND", "x11");
    let state = Arc::new(Mutex::new(DesktopState {
        interaction_serial: 0,
        preferences: desktop_controls::Preferences::default(),
        pet_registered: false,
        windows: HashMap::from([("pet".to_string(), initial_state(true))]),
    }));

    // 2. 닫힌 설정 창은 숨기고 트레이에서 다시 열 수 있게 한다.
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![
            set_regions,
            set_pet_input,
            pet_work_area,
            pet_control,
            drag_pet,
            drop_pet,
            sync_peers,
            animate_pair,
            message_bubbles::register_message_bubbles,
            message_bubbles::route_message_bubble,
            connectors::local_list_sources,
            connectors::local_save_source,
            connectors::local_enable_source,
            connectors::local_remove_source,
            connectors::local_refresh_codex,
            connectors::local_refresh_claude,
            connectors::local_claude_bridge_info,
            connectors::local_configure_claude_bridge,
            set_motion_preference,
            desktop_controls::desktop_state,
            desktop_controls::set_desktop_preferences,
            desktop_controls::set_pet_registered,
            desktop_controls::sync_gatherings,
            gathering_overflow,
            connectors::local_notifications,
            connectors::local_ack_notification,
            system_notifications::system_notification_settings,
            system_notifications::set_system_notifications,
            system_notifications::show_system_notification
        ])
        .setup(move |app| {
            system_notifications::install(app.handle());
            desktop_controls::install(app.handle(), &state)?;
            connectors::install(app.handle());
            if app
                .state::<connectors::LocalEngine>()
                .get()
                .and_then(|engine| engine.store.sources())
                .map(|sources| sources.iter().any(|source| source.enabled))
                .unwrap_or(false)
            {
                pet_control(
                    app.handle().clone(),
                    app.state::<Shared>(),
                    "restore".into(),
                )?;
            }
            let handle = app.handle().clone();
            if let Some(settings) = app.get_webview_window("settings") {
                let win = settings.clone();
                settings.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }
            start_motion(handle.clone(), state.clone());
            pointer::start(handle.clone(), state.clone());
            let _ = handle.emit("desktop-ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("데스크톱 앱 실행 실패");
}

#[cfg(test)]
mod tests {
    use super::*;

    // 음수 좌표 모니터와 제거된 화면 위치를 올바르게 보정하는지 확인한다.
    #[test]
    fn clamps_monitor_edges() {
        assert_eq!(
            clamp_position(-3000, 2000, 360, 430, -1920, 0, 1920, 1080),
            (-1920, 650)
        );
        assert_eq!(
            clamp_position(9999, -20, 360, 430, 0, 0, 1280, 720),
            (920, 0)
        );
    }
}
