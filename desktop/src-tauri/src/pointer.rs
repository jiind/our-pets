use crate::{is_pet, Shared};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{Emitter, Manager};

#[cfg(target_os = "windows")]
#[link(name = "user32")]
extern "system" {
    // 다른 앱의 입력을 가로채지 않고 마우스 버튼의 현재 상태만 조회한다.
    fn GetAsyncKeyState(key: i32) -> i16;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // 이벤트 기록이나 후킹 없이 마우스 버튼 상태만 조회한다.
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

// 운영체제의 포인터 버튼 상태만 읽고 입력을 소비하거나 변경하지 않는다.
fn pressed() -> (bool, bool) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        if let (Some(screen), Some(display)) =
            (gtk::gdk::Screen::default(), gtk::gdk::Display::default())
        {
            if let Some(pointer) = display.default_seat().and_then(|seat| seat.pointer()) {
                if let Some(root) = screen.root_window() {
                    let (_, _, _, mask) = root.device_position(&pointer);
                    return (
                        mask.contains(gtk::gdk::ModifierType::BUTTON1_MASK),
                        mask.contains(gtk::gdk::ModifierType::BUTTON3_MASK),
                    );
                }
            }
        }
        (false, false)
    }
    #[cfg(target_os = "windows")]
    unsafe {
        (GetAsyncKeyState(1) < 0, GetAsyncKeyState(2) < 0)
    }
    #[cfg(target_os = "macos")]
    unsafe {
        (
            CGEventSourceButtonState(0, 0),
            CGEventSourceButtonState(0, 1),
        )
    }
}

// 메뉴가 열렸을 때만 배경 클릭을 관찰해 뒤쪽 프로그램 입력을 보존한 채 메뉴를 닫는다.
pub fn start(app: tauri::AppHandle, state: Shared) {
    #[cfg(target_os = "linux")]
    {
        std::thread::spawn(move || {
            if x11::observe(app.clone(), state.clone()).is_err() {
                eprintln!("X11 포인터 이벤트 관찰 실패, 폴링으로 전환합니다.");
                start_polling(app, state);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    start_polling(app, state);
}

// 이벤트 관찰을 사용할 수 없는 환경에서 포인터 상태를 주기적으로 확인한다.
fn start_polling(app: tauri::AppHandle, state: Shared) {
    let previous = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || loop {
        // 1. 메뉴가 없으면 빠른 포인터 조회를 쉬어 상주 앱의 유휴 부하를 줄인다.
        let active = state
            .lock()
            .map(|all| {
                all.windows
                    .values()
                    .any(|pet| (pet.menu_open || pet.dragging) && !pet.hidden)
            })
            .unwrap_or(false);
        if !active {
            previous.store(false, Ordering::Relaxed);
            std::thread::sleep(Duration::from_millis(100));
            continue;
        }
        let handle = app.clone();
        let shared = state.clone();
        let last = previous.clone();

        // 2. GTK·창 API는 메인 스레드에서 읽고 새 클릭의 실제 입력 영역만 비교한다.
        let _ = app.run_on_main_thread(move || {
            let (left, right) = pressed();
            let down = left || right;
            if !left {
                if let Ok(mut all) = shared.lock() {
                    for pet in all.windows.values_mut() {
                        if pet.dragging {
                            pet.dragging = false;
                            pet.lift.release();
                        }
                    }
                }
            }
            if !down || last.swap(down, Ordering::Relaxed) {
                if !down {
                    last.store(false, Ordering::Relaxed);
                }
                return;
            }
            for (label, window) in handle.webview_windows() {
                if !is_pet(&label) {
                    continue;
                }
                let pet = shared
                    .lock()
                    .ok()
                    .and_then(|all| all.windows.get(&label).cloned());
                let Some(pet) = pet.filter(|pet| pet.menu_open && !pet.hidden) else {
                    continue;
                };
                if let (Ok(cursor), Ok(position), Ok(scale)) = (
                    window.cursor_position(),
                    window.outer_position(),
                    window.scale_factor(),
                ) {
                    let x = (cursor.x - position.x as f64) / scale;
                    let y = (cursor.y - position.y as f64) / scale;
                    let inside = pet.regions.iter().any(|region| {
                        x >= region.x as f64
                            && y >= region.y as f64
                            && x < (region.x + region.width) as f64
                            && y < (region.y + region.height) as f64
                    });
                    if !inside {
                        let _ = handle.emit_to(&label, "dismiss-pet-menu", ());
                    }
                }
            }
        });
        std::thread::sleep(Duration::from_millis(16));
    });
}

// 메인 스레드에서 X11의 최근 사용자 입력 시각을 조회한다.
#[cfg(target_os = "linux")]
pub fn last_x11_user_time() -> Option<u32> {
    use gtk::prelude::*;
    gtk::gdk::Display::default()
        .and_then(|display| display.downcast::<gdkx11::X11Display>().ok())
        .map(|display| display.user_time())
        .filter(|time| *time != 0)
}

#[cfg(target_os = "linux")]
mod x11 {
    use super::*;
    use x11rb::connection::{Connection, RequestConnection};
    use x11rb::protocol::record::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::{self, ConnectionExt as _};
    use x11rb::x11_utils::TryParse;

    // X11 서버에서 버튼 이벤트만 수신해 다른 프로그램의 입력을 보존한다.
    pub(super) fn observe(
        app: tauri::AppHandle,
        state: Shared,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // 1. 제어 연결에서 RECORD 확장과 버튼 이벤트 수집 범위를 설정한다.
        let (control, screen) = x11rb::connect(None)?;
        let root = control.setup().roots[screen].root;
        let (data, _) = x11rb::connect(None)?;
        if control
            .extension_information(record::X11_EXTENSION_NAME)?
            .is_none()
        {
            return Err("X11 RECORD 확장을 사용할 수 없습니다".into());
        }
        control
            .record_query_version(
                record::X11_XML_VERSION.0 as _,
                record::X11_XML_VERSION.1 as _,
            )?
            .reply()?;
        let context = control.generate_id()?;
        let empty = record::Range8 { first: 0, last: 0 };
        let empty_ext = record::ExtRange {
            major: empty,
            minor: record::Range16 { first: 0, last: 0 },
        };
        let range = record::Range {
            core_requests: empty,
            core_replies: empty,
            ext_requests: empty_ext,
            ext_replies: empty_ext,
            delivered_events: empty,
            device_events: record::Range8 {
                first: xproto::BUTTON_PRESS_EVENT,
                last: xproto::BUTTON_RELEASE_EVENT,
            },
            errors: empty,
            client_started: false,
            client_died: false,
        };
        control
            .record_create_context(context, 0, &[record::CS::ALL_CLIENTS.into()], &[range])?
            .check()?;

        // 2. 별도 연결에서 이벤트를 대기하고 버튼 누름을 관찰한 즉시 좌표를 조회한다.
        for reply in data.record_enable_context(context)? {
            let reply = reply?;
            if reply.category != 0 {
                continue;
            }
            if reply.client_swapped {
                return Err("바이트 순서가 다른 X11 이벤트는 지원하지 않습니다".into());
            }
            for event in parse_buttons(&reply.data)? {
                match (event.response_type & 0x7f, event.detail) {
                    (xproto::BUTTON_PRESS_EVENT, 1 | 3) => {
                        let menus = open_menus(&state, event.time);
                        if !menus.is_empty() {
                            let position = control.query_pointer(root)?.reply()?;
                            dismiss_at(&app, &state, menus, position.root_x, position.root_y);
                        }
                    }
                    (xproto::BUTTON_RELEASE_EVENT, 1) => {
                        release_drag(&app, &state);
                    }
                    _ => {}
                }
            }
        }
        Err("X11 이벤트 연결이 종료되었습니다".into())
    }

    // 한 응답에 함께 들어온 버튼 이벤트를 순서대로 해석한다.
    fn parse_buttons(
        mut data: &[u8],
    ) -> Result<Vec<xproto::ButtonPressEvent>, x11rb::errors::ParseError> {
        // 1. 각 X11 이벤트를 길이 단위로 해석해 원래 순서를 유지한다.
        let mut events = Vec::new();
        while !data.is_empty() {
            let (event, rest) = xproto::ButtonPressEvent::try_parse(data)?;
            events.push(event);
            data = rest;
        }

        // 2. 모든 이벤트를 반환해 짧은 누름과 놓침도 각각 처리한다.
        Ok(events)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        // X 서버 시각의 동일 값과 순환 경계를 비교한다.
        #[test]
        fn compares_wrapping_server_timestamps() {
            assert!(!later_than(10, 10));
            assert!(!later_than(9, 10));
            assert!(later_than(11, 10));
            assert!(later_than(2, u32::MAX - 1));
            assert!(!later_than(u32::MAX - 1, 2));
        }

        // 한 응답에 담긴 빠른 누름과 놓침이 순서대로 보존되는지 확인한다.
        #[test]
        fn parses_press_and_release_in_one_reply() {
            let mut bytes = [0_u8; 64];
            bytes[0] = xproto::BUTTON_PRESS_EVENT;
            bytes[1] = 1;
            bytes[32] = xproto::BUTTON_RELEASE_EVENT;
            bytes[33] = 1;
            let events = parse_buttons(&bytes).unwrap();
            assert_eq!(events.len(), 2);
            assert_eq!(events[0].response_type, xproto::BUTTON_PRESS_EVENT);
            assert_eq!(events[1].response_type, xproto::BUTTON_RELEASE_EVENT);
            assert!(parse_buttons(&bytes[..63]).is_err());
        }
    }

    // 32비트 X 서버 시각의 순환을 고려해 입력이 기준 시각보다 나중인지 확인한다.
    fn later_than(event_time: u32, reference_time: u32) -> bool {
        (event_time.wrapping_sub(reference_time) as i32) > 0
    }

    // 이벤트를 관찰한 시점에 열려 있는 메뉴와 상호작용 상태를 보관한다.
    fn open_menus(state: &Shared, event_time: u32) -> Vec<(String, u64)> {
        state
            .lock()
            .map(|all| {
                all.windows
                    .iter()
                    .filter(|(_, pet)| {
                        pet.menu_open
                            && !pet.hidden
                            && pet
                                .menu_open_time
                                .is_none_or(|time| later_than(event_time, time))
                    })
                    .map(|(label, pet)| (label.clone(), pet.menu_generation))
                    .collect()
            })
            .unwrap_or_default()
    }

    // 클릭 수신 시 열려 있던 메뉴의 바깥 클릭만 메인 스레드에서 닫는다.
    fn dismiss_at(
        app: &tauri::AppHandle,
        state: &Shared,
        menus: Vec<(String, u64)>,
        root_x: i16,
        root_y: i16,
    ) {
        // 1. 클릭을 관찰한 시점의 메뉴 목록과 좌표를 전달한다.
        let handle = app.clone();
        let shared = state.clone();

        // 2. 현재 메뉴 상태와 창 좌표를 확인하고 입력 영역 밖이면 닫기 이벤트를 보낸다.
        let _ = app.run_on_main_thread(move || {
            for (label, serial) in menus {
                let pet = shared
                    .lock()
                    .ok()
                    .and_then(|all| all.windows.get(&label).cloned());
                let Some(pet) =
                    pet.filter(|pet| pet.menu_open && !pet.hidden && pet.menu_generation == serial)
                else {
                    continue;
                };
                let Some(window) = handle.get_webview_window(&label) else {
                    continue;
                };
                if let (Ok(position), Ok(scale)) = (window.outer_position(), window.scale_factor())
                {
                    let x = (f64::from(root_x) - f64::from(position.x)) / scale;
                    let y = (f64::from(root_y) - f64::from(position.y)) / scale;
                    if !pet.regions.iter().any(|region| {
                        x >= f64::from(region.x)
                            && y >= f64::from(region.y)
                            && x < f64::from(region.x + region.width)
                            && y < f64::from(region.y + region.height)
                    }) {
                        let _ = handle.emit_to(&label, "dismiss-pet-menu", ());
                    }
                }
            }
        });
    }

    // 왼쪽 버튼을 놓을 때 수신 시점에 끌고 있던 펫의 드래그를 종료한다.
    fn release_drag(app: &tauri::AppHandle, state: &Shared) {
        let dragging: Vec<_> = state
            .lock()
            .map(|all| {
                all.windows
                    .iter()
                    .filter(|(_, pet)| pet.dragging)
                    .map(|(label, pet)| (label.clone(), pet.interaction_serial))
                    .collect()
            })
            .unwrap_or_default();
        if dragging.is_empty() {
            return;
        }
        let shared = state.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(mut all) = shared.lock() {
                for (label, serial) in dragging {
                    if let Some(pet) = all
                        .windows
                        .get_mut(&label)
                        .filter(|pet| pet.dragging && pet.interaction_serial == serial)
                    {
                        pet.dragging = false;
                        pet.lift.release();
                    }
                }
            }
        });
    }
}
