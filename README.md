# 우리 펫 · Our Pets

같은 로컬망의 사용자끼리 메시지를 주고받고 함께 노는 데스크톱 펫입니다. Go 서버와 Tauri 2·Rust·TypeScript 앱으로 구성하며, 캐릭터는 브라우저 안이 아닌 실제 투명 데스크톱 창에 표시됩니다. 회사망 외에도 집·친구 사이의 로컬망에서 사용할 수 있습니다.

## 현재 기능

- 고양이·강아지·고퍼·페리스와 사용자 PNG·스프라이트 시트 등록. 대표 펫 ID를 유지하며 외형을 바꿉니다. 이름표는 사용자 닉네임을 표시합니다.
- 왼쪽 클릭으로 쓰다듬기, 드래그로 들기·착지, 우클릭 메뉴로 메시지·모집·친구와 상호작용.
- 내 펫의 입력칸은 전체 전송, 친구 펫의 입력칸은 그 친구에게만 전송. 이모지는 메시지 내용에 입력합니다.
- 커피·담배·밥·수다·산책 모집과 참여·완료. 메시지·모집·개인 연결 소식은 실시간 말풍선과 OS 알림을 사용합니다.
- 사용자 한 명의 여러 접속 기기는 각각 실시간 메시지를 받습니다. 오프라인 기록·받은 소식 보관함은 제공하지 않습니다.
- Docker Events API·Slack Socket Mode·Codex·Claude 개인 알림 연결. 로그인 후 `알림 → 외부 연결`에서 설정하고 이 PC가 직접 수집합니다. 외부 시스템 제어나 Slack 메시지 발송은 없습니다.

친구 펫을 숨기면 해당 발신자의 메시지는 OS 알림으로만 표시합니다. 메시지의 수신을 사용자 읽음으로 간주하지 않습니다. [사용 방법](docs/usage.md)과 [커넥터 설정](docs/connectors.md)을 참고해 주세요.

## 개발 실행

Go 1.25+, Node.js 24, Rust stable과 [Tauri 플랫폼 필수 패키지](https://v2.tauri.app/start/prerequisites/)가 필요합니다. Linux는 GTK 3·WebKitGTK 4.1·AppIndicator·X11·컴포지터를 사용합니다. 빌드와 스크립트 검사에는 Python 3.10+가 필요합니다. 기본 LAN 기능의 실행에는 인터넷·외부 인증·CDN이 필요하지 않습니다. 최초 의존성 설치와 Slack 같은 외부 연결은 별도입니다.

```bash
# 터미널 1: 가입 코드는 실제 환경에서 별도로 설정합니다.
export OURPETS_INVITE='replace-with-your-private-invite'
go run ./cmd/our-pets

# 터미널 2
cd desktop
npm ci
npm run tauri dev
```

앱을 처음 열면 서버 연결 단계에서 `http://127.0.0.1:9377`을 확인한 뒤 로그인하거나 닉네임으로 계정을 만듭니다. 이후에는 저장한 서버를 사용하며 인증 화면의 서버 변경 링크로 다시 선택할 수 있습니다. 펫 화면에서는 외형만 골라 등록합니다. 다른 기기는 운영자가 설정한 서버 주소·허용 CIDR·가입 코드를 사용합니다. 실제 환경 파일·토큰·개인 메시지·DB는 커밋하지 않습니다.

`npm run dev`는 설정 UI 개발용입니다. 실제 데스크톱 펫은 Tauri 앱에서 실행합니다. 무료 Pretendard 폰트와 기본 이미지는 번들에 포함합니다.

## 검사와 배포

개발 검사 명령과 코드 규칙은 [기여 안내](CONTRIBUTING.md), CI·버전 태그·초안 릴리즈와 설치 파일 생성은 [릴리즈 절차](docs/releasing.md)를 참고해 주세요. 모든 CI 작업이 성공해야 `CI required`가 성공합니다. 세 OS 빌드는 실제 창·클릭 통과·포커스 검증을 대체하지 않습니다.

수동 설치 파일은 대상 OS에서 `cd desktop && npm run tauri -- build --ci -- --locked`로 만듭니다. Linux 개발 바이너리만 만들 때는 `npm run tauri -- build --debug --no-bundle -- --locked`를 사용합니다. Windows·macOS 서명·공증은 아직 구성하지 않았습니다.

## 문서와 참여

- [기여하기](CONTRIBUTING.md) · [보안 문제 비공개 신고](SECURITY.md)
- [설계](docs/architecture.md) · [HTTP·WebSocket 규격](docs/api.md)
- [PNG·애니메이션 등록](docs/pet-design.md) · [기본 캐릭터와 출처](docs/character-assets.md)
- [커넥터 작성·설정](docs/connectors.md) · [로컬망 운영](docs/operations.md)
- [사용 방법](docs/usage.md) · [플랫폼과 실행 조건](docs/platforms.md)
- [UI·모션 규칙](docs/design-system.md) · [CI·릴리즈](docs/releasing.md)

## 라이선스

프로젝트 자체 코드는 [Apache-2.0](LICENSE)입니다. 캐릭터·폰트·라이브러리는 각각의 라이선스를 따릅니다. GSAP 런타임의 Standard “No Charge” License는 Apache-2.0이나 GSAP Skills의 MIT 라이선스와 별개입니다. 포함된 자료와 변경·출처는 [제삼자 고지](THIRD_PARTY_NOTICES.md)를 확인해 주세요.
