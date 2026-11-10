pub trait Secrets: Send + Sync {
    // 운영체제 보안 저장소에서 해당 연결의 자격증명을 읽는다.
    fn get(&self, id: &str) -> Result<String, String>;
    // 비밀값을 일반 설정 파일이나 서버에 보내지 않고 저장한다.
    fn set(&self, id: &str, secret: &str) -> Result<(), String>;
    // 사용자가 지운 연결의 자격증명도 함께 삭제한다.
    fn delete(&self, id: &str) -> Result<(), String>;
}

pub struct OsSecrets;

// 플랫폼 오류의 경로·계정 정보를 공개하지 않는 보안 저장소 설명을 반환한다.
fn unavailable(_: keyring::Error) -> String {
    "OS 자격증명 저장소를 열 수 없습니다. macOS Keychain, Windows 자격증명 관리자 또는 Linux Secret Service 잠금을 확인하세요".into()
}

impl Secrets for OsSecrets {
    // OS 사용자 소유의 Slack 앱 토큰만 반환한다.
    fn get(&self, id: &str) -> Result<String, String> {
        keyring::Entry::new("com.ourpets.desktop.local-sources", id)
            .map_err(unavailable)?
            .get_password()
            .map_err(unavailable)
    }

    // Slack 토큰을 OS 자격증명 저장소에 저장한다.
    fn set(&self, id: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new("com.ourpets.desktop.local-sources", id)
            .map_err(unavailable)?
            .set_password(secret)
            .map_err(unavailable)
    }

    // 이미 지워진 토큰은 정상적인 삭제 결과로 취급한다.
    fn delete(&self, id: &str) -> Result<(), String> {
        match keyring::Entry::new("com.ourpets.desktop.local-sources", id)
            .map_err(unavailable)?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(unavailable(error)),
        }
    }
}
