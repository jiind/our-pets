use crate::Shared;
use std::time::{Duration, Instant};
use tauri::{Emitter, PhysicalPosition, PhysicalSize};

#[derive(Clone)]
pub struct LiftState {
    height: f64,
    velocity: f64,
    grab_x: f64,
    grab_y: f64,
    landing: Option<Instant>,
    publish_pending: bool,
    sequence: u64,
}

impl LiftState {
    // 펫의 바닥 기준 높이와 잡은 지점을 초기화한다.
    pub fn new() -> Self {
        Self {
            height: 0.0,
            velocity: 0.0,
            grab_x: 0.0,
            grab_y: 0.0,
            landing: None,
            publish_pending: false,
            sequence: 0,
        }
    }

    // 공중 이동이나 착지 연출 중인지 확인한다.
    pub fn active(&self) -> bool {
        self.height > 0.0 || self.landing.is_some() || self.publish_pending
    }

    // 놓는 순간에는 수평 관성 없이 낙하만 시작한다.
    pub fn release(&mut self) {
        self.velocity = 0.0;
        self.publish_pending = true;
    }

    // 숨기거나 창을 정리할 때 남은 높이와 착지를 없앤다.
    pub fn cancel(&mut self) -> u64 {
        self.height = 0.0;
        self.velocity = 0.0;
        self.landing = None;
        self.publish_pending = false;
        self.sequence = self.sequence.wrapping_add(1);
        self.sequence
    }
}

// 현재 포인터 아래의 모니터를 우선 사용하고 화면 제거 시 남은 화면으로 복구한다.
fn monitor(window: &tauri::WebviewWindow, dragging: bool) -> Result<tauri::Monitor, String> {
    let pointed = if dragging {
        let cursor = window
            .cursor_position()
            .map_err(|error| error.to_string())?;
        window
            .monitor_from_point(cursor.x, cursor.y)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    pointed
        .or(window
            .current_monitor()
            .map_err(|error| error.to_string())?)
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or_else(|| "펫을 표시할 화면을 찾지 못했어요".into())
}

// 잡은 그림의 위치를 유지하며 창 이동 대신 바닥 위 높이 드래그를 시작한다.
pub fn begin(window: &tauri::WebviewWindow, state: &Shared) -> Result<(), String> {
    // 1. 실제 포인터·창 좌표를 읽고 잡은 지점을 논리 단위로 보존한다.
    let cursor = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    {
        let mut all = state.lock().map_err(|error| error.to_string())?;
        let pet = all.windows.get_mut(window.label()).ok_or("없는 펫입니다")?;
        if pet.hidden {
            return Ok(());
        }
        let feet = position.y as f64 + size.height as f64 - (30.0 + pet.lift.height) * scale;
        pet.lift.grab_x = (cursor.x - position.x as f64) / scale;
        pet.lift.grab_y = (feet - cursor.y) / scale;
        pet.lift.velocity = 0.0;
        pet.lift.landing = None;
        pet.dragging = true;
        pet.motion.stop();
        pet.motion.reset_observation();
        pet.interaction_serial = pet.interaction_serial.wrapping_add(1);
        pet.interacting_until = Instant::now();
    }

    // 2. 실제 높이와 창 배치는 단일 이동 루프에서만 갱신해 첫 프레임 경합을 피한다.
    Ok(())
}

// 포인터를 놓으면 보행 거리와 분리된 중력·착지를 진행하고 실제 입력 픽셀만 유지한다.
pub fn tick(window: &tauri::WebviewWindow, state: &Shared, seconds: f64) -> Result<bool, String> {
    // 1. 창 API는 공유 상태 잠금 밖에서 읽어 메인 스레드와의 교착을 피한다.
    let Some((dragging, serial)) = state.lock().ok().and_then(|all| {
        all.windows
            .get(window.label())
            .filter(|pet| !pet.hidden && (pet.dragging || pet.lift.active()))
            .map(|pet| (pet.dragging, pet.interaction_serial))
    }) else {
        return Ok(false);
    };
    let monitor = monitor(window, dragging)?;
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    let cursor = window
        .cursor_position()
        .map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let previous_size = window.outer_size().map_err(|error| error.to_string())?;
    let now = Instant::now();

    // 2. 잡은 동안에는 포인터 높이, 놓은 뒤에는 중력으로 발의 높이를 정한다.
    let (height, carried, landing, x, direction, regions, sequence) = {
        let mut all = state.lock().map_err(|error| error.to_string())?;
        let pet_size = all.preferences.pet_size as f64;
        let pet = all.windows.get_mut(window.label()).ok_or("없는 펫입니다")?;
        if pet.hidden || pet.interaction_serial != serial {
            return Ok(false);
        }
        pet.lift.publish_pending = false;
        let maximum = (work.size.height as f64 / scale - pet_size - 100.0).max(0.0);
        if pet.dragging {
            let floor = work.position.y as f64 + work.size.height as f64 - 30.0 * scale;
            pet.lift.height = ((floor - cursor.y) / scale - pet.lift.grab_y).clamp(0.0, maximum);
            pet.lift.velocity = 0.0;
        } else if pet.lift.height > 0.0 {
            pet.lift.velocity += 1700.0 * seconds;
            pet.lift.height = if pet.reduced_motion {
                0.0
            } else {
                (pet.lift.height.min(maximum) - pet.lift.velocity * seconds).max(0.0)
            };
            if pet.lift.height == 0.0 && !pet.reduced_motion {
                pet.lift.landing = Some(now);
            }
        }
        let landing = pet
            .lift
            .landing
            .map(|start| {
                let progress = now.duration_since(start).as_secs_f64() / 0.2;
                if progress >= 1.0 || pet.reduced_motion {
                    0.0
                } else {
                    (progress * std::f64::consts::PI).sin()
                }
            })
            .unwrap_or(0.0);
        if pet
            .lift
            .landing
            .is_some_and(|start| now.duration_since(start) >= Duration::from_millis(200))
            || pet.reduced_motion
        {
            pet.lift.landing = None;
        }
        let x = if pet.dragging {
            (cursor.x - pet.lift.grab_x * scale).round() as i32
        } else {
            position.x
        };
        pet.motion.stop();
        let finished = !pet.dragging && !pet.lift.active();
        if finished {
            pet.motion.reset_observation();
            pet.walking = false;
            pet.next_behavior = now + Duration::from_secs(2);
        }
        pet.lift.sequence = pet.lift.sequence.wrapping_add(1);
        (
            pet.lift.height,
            pet.dragging,
            landing,
            x,
            pet.direction,
            pet.regions.clone(),
            pet.lift.sequence,
        )
    };

    // 3. 같은 작업영역 창을 유지하고 선택한 펫 창에만 높이와 보행 정지를 전달한다.
    let size = PhysicalSize::new(
        work.size.width.min((360.0 * scale).round() as u32),
        work.size.height,
    );
    let x = x.clamp(
        work.position.x,
        work.position.x + work.size.width.saturating_sub(size.width) as i32,
    );
    let y = work.position.y + work.size.height.saturating_sub(size.height) as i32;
    if previous_size != size {
        window.set_size(size).map_err(|error| error.to_string())?;
    }
    if position.x != x || position.y != y {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let point = ((cursor.x - x as f64) / scale, (cursor.y - y as f64) / scale);
        let hit = regions.iter().any(|r| {
            point.0 >= r.x as f64
                && point.0 < (r.x + r.width) as f64
                && point.1 >= r.y as f64
                && point.1 < (r.y + r.height) as f64
        });
        window
            .set_ignore_cursor_events(!hit)
            .map_err(|error| error.to_string())?;
        if let Ok(mut all) = state.lock() {
            if let Some(pet) = all
                .windows
                .get_mut(window.label())
                .filter(|pet| pet.interaction_serial == serial)
            {
                pet.ignored = !hit;
            }
        }
    }
    #[cfg(target_os = "linux")]
    let _ = regions;
    window
        .emit_to(
            window.label(),
            "pet-elevation",
            serde_json::json!({ "height": height, "carried": carried, "landing": landing, "sequence": sequence }),
        )
        .map_err(|error| error.to_string())?;
    window
        .emit_to(
            window.label(),
            "pet-motion",
            serde_json::json!({ "walking": false, "direction": direction, "speed": 0 }),
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}
