use crate::{is_pet, Shared};
use tauri::Manager;

pub struct Occupant {
    pub label: String,
    pub x: i32,
    pub y: i32,
    pub width: f64,
    pub height: f64,
    pub visual_width: f64,
    pub body_height: f64,
    pub scale: f64,
    pub protected: bool,
}

// 숨기지 않은 펫의 실제 몸 크기와 메뉴 보호 영역을 물리 좌표로 모은다.
pub fn snapshot(app: &tauri::AppHandle, state: &Shared) -> Vec<Occupant> {
    // 1. 창 API를 부르기 전에 공유 상태 복사와 잠금 해제를 마친다.
    let Some((states, pet_size)) = state
        .lock()
        .ok()
        .map(|all| (all.windows.clone(), all.preferences.pet_size as f64))
    else {
        return Vec::new();
    };
    let mut scene = Vec::new();

    // 2. 투명 창 전체 폭 대신 캐릭터의 논리 폭을 해당 창의 배율로 변환한다.
    for (label, window) in app.webview_windows() {
        let Some(data) = states
            .get(&label)
            .filter(|data| is_pet(&label) && !data.hidden)
        else {
            continue;
        };
        if !window.is_visible().unwrap_or(false) {
            continue;
        }
        if let (Ok(position), Ok(size), Ok(scale)) = (
            window.outer_position(),
            window.outer_size(),
            window.scale_factor(),
        ) {
            scene.push(Occupant {
                label,
                x: position.x,
                y: position.y,
                width: size.width as f64,
                height: size.height as f64,
                visual_width: data.visual_width.unwrap_or(pet_size * 0.8) * scale,
                body_height: data.visual_height.unwrap_or(pet_size) * scale,
                scale,
                protected: data.menu_open || data.input_active || data.dragging,
            });
        }
    }
    scene
}

// 캐릭터는 몸의 범위로, 조작 중인 펫은 메뉴까지 포함한 보호 범위로 변환한다.
fn bounds(pet: &Occupant, x: i32, y: i32, protect: bool) -> (f64, f64, f64, f64) {
    let width = if protect && pet.protected {
        pet.visual_width.max(296.0 * pet.scale)
    } else {
        pet.visual_width
    };
    let bottom = y as f64 + pet.height - 30.0 * pet.scale;
    let top = if protect && pet.protected {
        y as f64
    } else {
        bottom - pet.body_height
    };
    let center = x as f64 + pet.width / 2.0;
    (
        center - width / 2.0,
        top,
        center + width / 2.0,
        bottom + 20.0 * pet.scale,
    )
}

// 몸이나 열린 메뉴와 겹치지 않는지 같은 물리 좌표에서 비교한다.
fn available(scene: &[Occupant], own: &Occupant, x: i32, y: i32) -> bool {
    let (left, top, right, bottom) = bounds(own, x, y, false);
    scene
        .iter()
        .filter(|other| other.label != own.label)
        .all(|other| {
            let (other_left, other_top, other_right, other_bottom) =
                bounds(other, other.x, other.y, true);
            let gap = 14.0 * own.scale.max(other.scale);
            right + gap <= other_left
                || left >= other_right + gap
                || bottom + gap <= other_top
                || top >= other_bottom + gap
        })
}

// 간격을 포함한 두 점유 영역의 겹침 넓이를 같은 물리 좌표에서 구한다.
fn overlap(own: &Occupant, x: i32, y: i32, other: &Occupant) -> f64 {
    let (left, top, right, bottom) = bounds(own, x, y, false);
    let (other_left, other_top, other_right, other_bottom) = bounds(other, other.x, other.y, true);
    let gap = 14.0 * own.scale.max(other.scale);
    (right.min(other_right + gap) - left.max(other_left - gap)).max(0.0)
        * (bottom.min(other_bottom + gap) - top.max(other_top - gap)).max(0.0)
}

// 기존 겹침을 줄이면서 다른 펫이나 열린 메뉴에 새로 침범하지 않는 걸음만 허용한다.
fn improves(scene: &[Occupant], own: &Occupant, x: i32, y: i32) -> bool {
    let mut decreased = false;
    for other in scene.iter().filter(|other| other.label != own.label) {
        let before = overlap(own, own.x, own.y, other);
        let after = overlap(own, x, y, other);
        if after > before + 0.01 {
            return false;
        }
        decreased |= after + 0.01 < before;
    }
    decreased
}

// 일반 보행은 다른 펫 앞에서 양보하고 이미 겹쳤다면 가까운 빈자리로 벗어난다.
pub fn avoid(
    scene: &[Occupant],
    label: &str,
    target: (i32, i32),
    limits: (i32, i32, i32, i32),
    reduced: bool,
    step_distance: f64,
) -> ((i32, i32), bool) {
    // 1. 제안한 걸음이 안전하면 유지하고 새 충돌만 생기면 현재 자리에서 양보한다.
    let Some(own) = scene.iter().find(|pet| pet.label == label) else {
        return (target, false);
    };
    if available(scene, own, target.0, target.1) {
        return (target, false);
    }
    if available(scene, own, own.x, own.y) {
        return ((own.x, own.y), true);
    }

    // 2. 현재 발 높이를 유지하며 몸의 양옆에서 가장 가까운 빈자리만 찾는다.
    let (minimum_x, _, maximum_x, _) = limits;
    let mut xs = vec![own.x, minimum_x, maximum_x];
    for other in scene.iter().filter(|other| other.label != own.label) {
        let (left, _, right, _) = bounds(other, other.x, other.y, true);
        let gap = 14.0 * own.scale.max(other.scale);
        xs.push((left - gap - own.visual_width / 2.0 - own.width / 2.0).floor() as i32);
        xs.push((right + gap + own.visual_width / 2.0 - own.width / 2.0).ceil() as i32);
    }
    xs.iter_mut()
        .for_each(|x| *x = (*x).clamp(minimum_x, maximum_x));
    xs.sort_unstable();
    xs.dedup();
    let mut nearest = None;
    for x in &xs {
        if available(scene, own, *x, own.y) {
            let distance = (*x as i64 - own.x as i64).abs();
            if nearest.is_none_or(|(_, best)| distance < best) {
                nearest = Some((*x, distance));
            }
        }
    }

    // 3. 겹침 해소는 짧은 걸음으로 진행하고 동작 줄이기에서는 한 번만 정렬한다.
    if let Some((x, _)) = nearest {
        if reduced {
            return ((x, own.y), true);
        }
        let step = (step_distance * own.scale).round().max(1.0) as i32;
        let next_x = own.x + (x - own.x).clamp(-step, step);
        if improves(scene, own, next_x, own.y) {
            return ((next_x, own.y), true);
        }
    }
    ((own.x, own.y), true)
}
