use crate::{is_pet, Shared};
use serde_json::Value;
use tauri::{Emitter, Manager};

// 수신 말풍선에 필요한 현재 텍스트만 허용하고 발신자·만료·전송 확인 이벤트를 구분한다.
fn valid_message(sender_id: &str, message: &Value, now: i64) -> bool {
    is_pet(&format!("peer-{sender_id}"))
        && message["type"].as_str() == Some("message")
        && message["kind"].as_str() == Some("text")
        && message.get("outgoing").is_none_or(Value::is_null)
        && message["sender"]["petId"].as_str() == Some(sender_id)
        && message["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id.len() <= 100)
        && message["body"]
            .as_str()
            .is_some_and(|body| !body.trim().is_empty() && body.chars().count() <= 2000)
        && message["expiresAt"]
            .as_i64()
            .is_some_and(|expires| expires > now && expires <= now + 15000)
        && message.to_string().len() <= 32768
}

// 친구 창의 수신기가 준비된 이후에만 본문 전달 대상으로 등록한다.
#[tauri::command]
pub fn register_message_bubbles(
    window: tauri::WebviewWindow,
    state: tauri::State<Shared>,
    ready: bool,
) -> Result<(), String> {
    // 1. 실제 친구 창만 자기 수신 준비 상태를 바꿀 수 있다.
    if !window.label().starts_with("peer-") || !is_pet(window.label()) {
        return Err("친구 펫 창만 말풍선 수신을 준비할 수 있습니다.".into());
    }
    // 2. 창 재생성 시 초기화되는 펫 상태에 준비 여부를 기록한다.
    if let Some(pet) = state
        .lock()
        .map_err(|_| "펫 상태를 확인하지 못했어요.")?
        .windows
        .get_mut(window.label())
    {
        pet.message_ready = ready;
    }
    Ok(())
}

// 대표 펫이 이미 수신한 메시지를 같은 PC의 발신자 펫 창에만 전달한다.
#[tauri::command]
pub fn route_message_bubble(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<Shared>,
    recipient_pet_id: String,
    sender_pet_id: String,
    message: Value,
) -> Result<bool, String> {
    // 1. 설정·친구 창이 다른 메시지를 전달하거나 외부 알림을 이동하지 못하게 한다.
    let now = crate::locomotion::unix_millis() as i64;
    if window.label() != "pet"
        || !is_pet(&format!("peer-{recipient_pet_id}"))
        || !valid_message(&sender_pet_id, &message, now)
    {
        return Err("현재 받은 텍스트 메시지만 발신 펫에 표시할 수 있습니다.".into());
    }
    let label = format!("peer-{sender_pet_id}");
    let allowed = {
        let data = state.lock().map_err(|_| "펫 상태를 확인하지 못했어요.")?;
        data.pet_registered
            && data.preferences.visible
            && data.preferences.show_others
            && data
                .windows
                .get(&label)
                .is_some_and(|pet| pet.message_ready && !pet.hidden)
    };

    // 2. 숨김·미접속·준비 전 창에는 보내지 않고 대표 펫의 OS 알림만 유지한다.
    if !allowed
        || !app
            .get_webview_window(&label)
            .is_some_and(|peer| peer.is_visible().unwrap_or(false))
    {
        return Ok(false);
    }
    app.emit_to(
        label,
        "sender-message-bubble",
        serde_json::json!({"recipientPetId":recipient_pet_id,"message":message}),
    )
    .map_err(|_| "발신 펫에 말풍선을 전달하지 못했어요.")?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // 같은 발신자의 현재 메시지는 허용하고 다른 발신자·만료·발신 확인은 거절한다.
    #[test]
    fn routing_requires_matching_live_incoming_message() {
        // 1. 등록 가능한 펫 ID와 현재 텍스트를 구성한다.
        let sender = "a".repeat(32);
        let mut event = json!({"id":"message-one","type":"message","kind":"text","body":"안녕 👋","sender":{"petId":sender},"expiresAt":2000});
        assert!(valid_message(&sender, &event, 1000));

        // 2. 다른 발신자나 만료 이벤트와 발신 확인은 같은 창에 재전달하지 않는다.
        assert!(!valid_message(&"b".repeat(32), &event, 1000));
        assert!(!valid_message(&sender, &event, 2000));
        event["outgoing"] = json!({"mode":"all","recipientCount":2});
        assert!(!valid_message(&sender, &event, 1000));
    }

    // 개인 외부 연결 알림은 친구 펫의 말풍선으로 이동하지 않는다.
    #[test]
    fn external_notifications_are_not_routable() {
        let sender = "a".repeat(32);
        let event = json!({"id":"notice","type":"notification","kind":"external","body":"private","sender":{"petId":sender},"expiresAt":2000});
        assert!(!valid_message(&sender, &event, 1000));
    }
}
