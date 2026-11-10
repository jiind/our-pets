<p align="center">
  <img src="desktop/src-tauri/icons/icon.png" width="88" height="88" alt="우리 펫 앱 아이콘">
</p>

<h1 align="center">우리 펫 · Our Pets</h1>

<p align="center">
  화면 위의 작은 친구들, 같은 로컬망에서 함께.<br>
  Desktop companions for your local network.
</p>

<p align="center">
  <a href="https://github.com/jiind/our-pets/releases"><img src="https://img.shields.io/badge/status-beta-eab308" alt="베타"></a>
  <a href="https://github.com/jiind/our-pets/actions/workflows/ci.yml"><img src="https://github.com/jiind/our-pets/actions/workflows/ci.yml/badge.svg" alt="CI 상태"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="프로젝트 코드: Apache 2.0"></a>
</p>

<p align="center">
  <a href="https://github.com/jiind/our-pets/releases"><strong>베타 다운로드</strong></a> ·
  <a href="docs/usage.md">사용 방법</a> ·
  <a href="https://github.com/jiind/our-pets/issues">버그·기능 제안</a> ·
  <a href="CONTRIBUTING.md">기여하기</a>
</p>

우리 펫은 Windows·macOS·Linux를 위한 데스크톱 펫 앱입니다. 내 펫이 친구 펫에게 다가가 인사하고, 메시지를 건네고, 커피나 산책에 함께할 사람을 모읍니다. Docker·Slack·개발 도구의 소식도 펫에게 받아볼 수 있습니다.

같은 로컬망의 서버 하나에 각 PC의 앱을 연결합니다. 집·친구 모임·회사 어디서든 사용할 수 있고, 기본 펫과 사용자 간 메시지는 인터넷이나 외부 클라우드 계정 없이 동작합니다.

## 다운로드

[GitHub Releases](https://github.com/jiind/our-pets/releases)에서 OS에 맞는 베타 패키지를 선택하세요. 함께 사용할 로컬망에는 서버 패키지도 한 개 필요합니다.

| Windows | macOS | Linux |
| --- | --- | --- |
| [x64 설치 파일 · NSIS](https://github.com/jiind/our-pets/releases) | [Intel·Apple Silicon · DMG](https://github.com/jiind/our-pets/releases) | [x64 · DEB / AppImage](https://github.com/jiind/our-pets/releases) |
| WebView2 런타임 | 시스템 WKWebView | GTK 3·WebKitGTK 4.1·AppIndicator·X11·컴포지터 |

> **베타 안내:** Windows·macOS·Linux가 지원 대상입니다. 빌드 성공과 실제 OS 동작 검증은 구분합니다. Linux 네이티브 Wayland 창 제어는 지원하지 않으며, Wayland 세션은 XWayland 경로의 환경별 확인이 필요합니다. Windows 코드 서명과 macOS 서명·공증은 아직 구성하지 않았습니다. [플랫폼별 실행 조건](docs/platforms.md)을 확인해 주세요.

서버 패키징 대상은 Linux amd64·arm64, Windows amd64, macOS amd64·arm64입니다.

## 주요 기능

| | 할 수 있는 일 |
| --- | --- |
| **내 펫** | 고양이·강아지·고퍼·페리스 또는 직접 만든 PNG·스프라이트 시트를 선택합니다. 외형을 바꿔도 펫 ID는 유지됩니다. |
| **함께 놀기** | 클릭으로 쓰다듬고 드래그로 들어 올립니다. 인사·하이파이브는 내 펫이 친구에게 다가가 양쪽이 함께 반응합니다. |
| **메시지** | 우클릭 메뉴에서 바로 작성합니다. 내 펫에서는 접속 중인 모두에게, 친구 펫에서는 그 친구에게 보냅니다. 이모지와 답장을 지원합니다. |
| **모집** | 커피·담배·밥·수다·산책을 제안합니다. 참여한 펫은 모집자 곁에 모여 완료할 때까지 함께 있습니다. |
| **실시간 알림** | 말풍선과 OS 알림으로 소식을 받습니다. 같은 사용자의 여러 접속 기기는 각각 실시간 메시지를 받습니다. |
| **표시 설정** | 펫 크기·표시 여부·친구 펫 표시를 조절합니다. 앱과 트레이 설정은 동기화됩니다. |

메시지와 알림은 접속 중 받은 내용만 표시하며 오프라인 재생·보관함은 제공하지 않습니다. 친구 펫을 숨기면 그 친구의 메시지는 OS 알림으로만 표시합니다.

## 빠른 시작

1. **서버 준비:** 한 PC에서 서버를 실행합니다. [설정 예제](examples/server.env.example)에 맞춰 가입 코드·바인딩 주소·허용 CIDR을 설정합니다.
2. **앱 연결:** 각 PC에서 앱을 열고 서버 주소를 입력합니다. 계정을 만들거나 로그인한 뒤 캐릭터를 선택해 내 펫을 등록합니다.
3. **함께 사용:** 접속 중인 친구 펫을 우클릭해 메시지를 보내거나 상호작용합니다.

기본 서버는 같은 PC의 `127.0.0.1:9377`만 허용합니다. 다른 PC와 사용하려면 실제 로컬망 주소·접속 범위·방화벽을 설정하세요. 서버는 `.env`를 자동으로 읽지 않으므로 환경 변수를 주입하거나 예제 서비스의 환경 파일을 사용합니다. 설치·TLS·백업은 [서버 운영 안내](docs/operations.md), 펫 조작은 [사용 방법](docs/usage.md)을 참고해 주세요.

## 개인 알림 연결

로그인 후 `알림 → 외부 연결`에서 추가합니다. 연결은 **내 PC에서 직접 수집**하며 개인 자격증명과 소식을 로컬망 서버나 친구에게 공유하지 않습니다.

| 소스 | 받을 수 있는 소식 |
| --- | --- |
| Docker Events API | 선택한 컨테이너의 시작·종료·재시작·상태 변경 |
| Slack Socket Mode | 허용된 워크스페이스·대화의 메시지·앱 멘션·반응 |
| Codex CLI | 계정 한도 잔여량, 설정한 사용률 기준·소진·복구·재조회 알림 |
| Claude Code | 로컬 상태줄 브리지로 전달받은 사용량과 한도 알림 |

외부 연결은 알림 수신용입니다. 컨테이너 제어·명령 실행·Slack 메시지 작성은 제공하지 않습니다. Slack과 Codex 계정 조회에는 인터넷이 필요하며, Claude의 최신 값 확인은 마지막 상태줄 전달값을 사용합니다. [연결 설정·인증·저장 범위](docs/connectors.md)를 확인해 주세요.

## 개발

Go 서버와 Tauri 2·Rust·TypeScript 앱으로 구성합니다. 무료 Pretendard 폰트와 기본 캐릭터는 앱에 포함되어 런타임 CDN 접속이 필요하지 않습니다.

<details>
<summary><strong>소스에서 실행하기</strong></summary>

Go 1.25 이상, Node.js 24, Rust stable, Python 3.10 이상과 [Tauri 플랫폼 필수 패키지](https://v2.tauri.app/start/prerequisites/)가 필요합니다. 최초 의존성 설치에는 인터넷이 필요합니다.

```bash
git clone https://github.com/jiind/our-pets.git
cd our-pets
```

첫 번째 터미널에서 서버를 실행합니다. 가입 코드는 실제 사용할 비공개 값으로 바꾸세요.

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

앱에서 `http://127.0.0.1:9377`에 연결합니다. `npm run dev`는 설정 UI 개발용이며 실제 데스크톱 펫은 Tauri 앱에서 실행합니다.

</details>

검사 명령·코드 규칙은 [기여 안내](CONTRIBUTING.md)에 있습니다. CI는 Gitleaks의 현재 파일·Git 전체 이력 검사, Go race 검사, TypeScript·UI 검사, 세 OS의 Rust 검사·빌드를 수행합니다. 버전 태그는 전체 CI와 플랫폼별 패키징을 통과하면 체크섬·고지를 포함한 초안 릴리즈를 생성합니다. 베타 태그는 prerelease로 표시합니다. [CI·릴리즈 절차](docs/releasing.md)를 참고해 주세요.

## 기여하기

버그 수정, 새 커넥터, 펫 디자인, 문서 개선 등 다양한 기여를 환영합니다.

- **버그·기능 제안:** [Issues](https://github.com/jiind/our-pets/issues)에서 기존 논의를 확인하고 재현 단계나 사용 사례를 남겨 주세요.
- **코드·문서:** [기여 안내](CONTRIBUTING.md)를 읽고 PR에 변경 동작과 검증 결과를 적어 주세요.
- **펫·에셋:** 원작자·출처·라이선스와 재배포 조건을 함께 확인해 주세요.
- **보안 문제:** 실제 자격증명이나 취약점은 공개 이슈 대신 [비공개 보안 신고](SECURITY.md)를 이용해 주세요.

## 문서

| 사용·운영 | 개발·확장 |
| --- | --- |
| [사용 방법](docs/usage.md) | [아키텍처](docs/architecture.md) |
| [PNG·애니메이션 등록](docs/pet-design.md) | [HTTP·WebSocket·IPC](docs/api.md) |
| [서버·네트워크·백업](docs/operations.md) | [커넥터 작성·설정](docs/connectors.md) |
| [플랫폼별 실행 조건](docs/platforms.md) | [UI·모션 규칙](docs/design-system.md) |
| [캐릭터와 출처](docs/character-assets.md) | [CI·릴리즈](docs/releasing.md) |

## 라이선스

프로젝트 자체 코드는 [Apache License 2.0](LICENSE)으로 제공합니다. 캐릭터·폰트·라이브러리는 각각의 라이선스를 따릅니다. 고퍼·페리스의 원안과 참고 에셋, Pretendard, GSAP 등의 출처·조건은 [제삼자 고지](THIRD_PARTY_NOTICES.md)를 확인해 주세요. GSAP 런타임의 Standard “No Charge” License는 프로젝트 코드나 GSAP Skills 문서의 라이선스와 별개입니다.
