# 우리 펫 · Our Pets

**같은 로컬망에서 펫으로 인사하고, 메시지를 나누고, 함께할 사람을 모으세요.**

우리 펫은 Windows·macOS·Linux를 위한 데스크톱 펫 앱입니다. 화면 위를 걷는 내 펫과 친구 펫을 통해 소통하고, Docker·Slack·개발 도구의 소식을 말풍선과 OS 알림으로 받아볼 수 있습니다.

Go 서버 하나와 각 PC의 Tauri 데스크톱 앱으로 구성합니다. 집·친구 모임·회사 등 같은 로컬망에서 사용할 수 있으며, 기본 펫과 사용자 간 메시지는 인터넷이나 외부 클라우드 계정 없이 동작합니다.

[베타 다운로드](https://github.com/jiind/our-pets/releases) · [사용 방법](docs/usage.md) · [버그 신고](https://github.com/jiind/our-pets/issues) · [기여 안내](CONTRIBUTING.md)

> 베타 단계입니다. 지원 대상은 세 OS이며, 빌드 성공과 각 OS의 실제 데스크톱 동작 검증은 구분합니다. 플랫폼별 실행 조건은 [플랫폼 안내](docs/platforms.md)를 확인해 주세요.

## 할 수 있는 일

- **나만의 펫:** 고양이·강아지·고퍼·페리스 또는 직접 만든 PNG를 선택합니다. 스프라이트 시트 애니메이션도 등록할 수 있습니다. 외형을 바꿔도 내 펫의 ID는 유지됩니다.
- **화면 위 상호작용:** 클릭으로 쓰다듬고 드래그로 들어 올립니다. 친구 펫에게 인사하거나 하이파이브하면 내 펫이 다가가 양쪽이 함께 반응합니다.
- **바로 메시지 보내기:** 펫 우클릭 메뉴에서 작성합니다. 내 펫에서는 접속 중인 모두에게, 친구 펫에서는 그 친구에게 보냅니다. 이모지 입력과 답장을 지원합니다.
- **함께할 사람 모집:** 커피·담배·밥·수다·산책을 제안합니다. 참여한 펫은 모집자 곁에 모여 완료할 때까지 함께 있습니다.
- **실시간 소식:** 메시지·모집·개인 연결 소식을 말풍선과 OS 알림으로 받습니다. 같은 사용자가 여러 기기에 접속하면 각 기기가 실시간 메시지를 받습니다.
- **내 화면에 맞게:** 펫 크기·표시 여부·친구 펫 표시를 조절합니다. 앱과 트레이의 표시 설정은 동기화됩니다.

메시지와 알림은 접속 중 받은 내용만 표시합니다. 오프라인 중 도착한 내용의 재생이나 받은 소식 보관함은 제공하지 않습니다. 친구 펫을 숨기면 그 친구의 메시지는 OS 알림으로만 표시합니다.

## 플랫폼

| 데스크톱 | 패키징 대상 | 실행 조건 |
| --- | --- | --- |
| Windows x64 | NSIS 설치 파일 | WebView2 런타임 |
| macOS Intel·Apple Silicon | Universal DMG | 시스템 WKWebView |
| Linux x64 | DEB·AppImage | GTK 3·WebKitGTK 4.1·AppIndicator·X11·컴포지터 |

Linux의 Wayland 세션에서는 XWayland 경로를 사용하며 데스크톱 환경별 확인이 필요합니다. 네이티브 Wayland 창 제어는 지원하지 않습니다. Windows 코드 서명과 macOS 서명·공증은 아직 구성하지 않았습니다.

서버는 Linux amd64·arm64, Windows amd64, macOS amd64·arm64를 패키징 대상으로 합니다. 자세한 설치 조건과 모니터·배율·포커스 제약은 [플랫폼 안내](docs/platforms.md)를 참고해 주세요.

## 시작하기

### 설치 파일로 사용

1. [Releases](https://github.com/jiind/our-pets/releases)에서 사용할 OS의 데스크톱 패키지와 서버 패키지를 받습니다. 서버는 함께 사용할 로컬망의 PC 한 곳에서 실행합니다.
2. 서버의 가입 코드·바인딩 주소·허용 CIDR을 설정합니다. [설정 예제](examples/server.env.example)와 [운영 안내](docs/operations.md)를 참고하세요.
3. 각 PC에서 앱을 열고 서버 주소를 입력합니다. 계정을 만들거나 로그인한 뒤 캐릭터를 선택해 내 펫을 등록합니다.
4. 접속 중인 친구 펫을 우클릭해 메시지를 보내거나 상호작용합니다.

서버 기본 주소는 `127.0.0.1:9377`이며 기본 허용 범위도 같은 PC뿐입니다. 다른 PC와 사용하려면 실제 로컬망 주소·접속 범위·방화벽을 설정해야 합니다. 서버의 `.env` 파일 자동 로드는 제공하지 않으므로 환경 변수를 주입하거나 예제 서비스의 환경 파일을 사용합니다. 운영 전송에는 TLS를 구성해 주세요.

### 소스에서 개발 실행

필요한 도구는 Go 1.25 이상, Node.js 24, Rust stable, Python 3.10 이상과 [Tauri 플랫폼 필수 패키지](https://v2.tauri.app/start/prerequisites/)입니다. 최초 의존성 설치에는 인터넷이 필요합니다.

```bash
git clone https://github.com/jiind/our-pets.git
cd our-pets
```

첫 번째 터미널에서 서버를 실행합니다. 아래 Bash 예제의 가입 코드는 실제 사용할 비공개 값으로 바꾸세요.

```bash
export OURPETS_INVITE='replace-with-your-private-invite'
go run ./cmd/our-pets
```

Windows PowerShell에서는 다음과 같이 실행합니다.

```powershell
$env:OURPETS_INVITE = 'replace-with-your-private-invite'
go run ./cmd/our-pets
```

두 번째 터미널에서 데스크톱 앱을 실행합니다.

```bash
cd desktop
npm ci
npm run tauri dev
```

앱의 서버 연결 단계에서 `http://127.0.0.1:9377`을 입력합니다. `npm run dev`는 설정 UI 개발용이고, 실제 데스크톱 펫은 Tauri 앱에서 실행합니다. 무료 Pretendard 폰트와 기본 캐릭터는 앱에 포함되어 런타임 CDN 접속이 필요하지 않습니다.

## 개인 알림 연결

로그인 후 `알림 → 외부 연결`의 + 버튼에서 설정합니다. 각 연결은 **내 PC에서 직접 수집**하며 개인 자격증명과 소식을 로컬망 서버나 친구에게 공유하지 않습니다.

| 소스 | 받을 수 있는 소식 |
| --- | --- |
| Docker Events API | 선택한 컨테이너의 시작·종료·재시작·상태 변경 이벤트 |
| Slack Socket Mode | 허용된 워크스페이스·대화의 메시지·앱 멘션·반응 이벤트 |
| Codex CLI | 계정 한도의 잔여량, 설정한 사용률 기준·소진·복구·재조회 알림 |
| Claude Code | 로컬 상태줄 브리지로 전달받은 사용량과 한도 알림 |

외부 연결은 알림 수신용입니다. 컨테이너 제어·명령 실행·Slack 메시지 작성은 제공하지 않습니다. Slack과 Codex 계정 조회에는 인터넷이 필요하며, Claude의 최신 값 확인은 마지막 상태줄 전달값을 사용합니다. 연결별 인증·권한·저장 범위는 [커넥터 안내](docs/connectors.md)를 확인해 주세요.

## 개발과 기여

버그 재현, 기능 제안, 문서 개선을 환영합니다. [Issues](https://github.com/jiind/our-pets/issues)에서 기존 논의를 확인하고, PR 전에 [기여 안내](CONTRIBUTING.md)의 코드 규칙과 검사 절차를 읽어 주세요. 취약점이나 실제 자격증명은 공개 이슈 대신 [보안 신고 절차](SECURITY.md)를 이용해 주세요.

CI는 Gitleaks의 현재 파일·Git 전체 이력 검사, Go race 검사, TypeScript·UI 검사, 세 OS의 Rust 검사·빌드를 수행합니다. 버전 태그는 전체 CI와 플랫폼별 패키징을 통과한 뒤 체크섬·고지를 포함한 초안 릴리즈를 생성합니다. 베타 태그는 prerelease로 표시합니다. 상세 절차는 [CI·릴리즈 안내](docs/releasing.md)에 있습니다.

## 문서

| 목적 | 문서 |
| --- | --- |
| 펫 조작·메시지·모집·알림 설정 | [사용 방법](docs/usage.md) |
| PNG·스프라이트 시트 등록 | [펫 디자인과 애니메이션](docs/pet-design.md) |
| 서버 설치·네트워크·백업 | [로컬망 운영](docs/operations.md) |
| OS별 실행 조건·제약 | [플랫폼 안내](docs/platforms.md) |
| 모듈·데이터·전달 정책 | [아키텍처](docs/architecture.md) |
| HTTP·WebSocket·로컬 IPC | [API 규격](docs/api.md) |
| 개인 연결 설정·커넥터 작성 | [커넥터 안내](docs/connectors.md) |
| UI·접근성·모션 | [디자인 규칙](docs/design-system.md) |
| 캐릭터 제작·출처 | [기본 캐릭터와 출처](docs/character-assets.md) |

## 라이선스

프로젝트 자체 코드는 [Apache License 2.0](LICENSE)으로 제공합니다. 캐릭터·폰트·라이브러리는 각각의 라이선스를 따릅니다. 고퍼·페리스의 원안과 참고 에셋, Pretendard, GSAP 등의 출처·조건은 [제삼자 고지](THIRD_PARTY_NOTICES.md)를 확인해 주세요. GSAP 런타임의 Standard “No Charge” License는 프로젝트 코드나 GSAP Skills 문서의 라이선스와 별개입니다.
