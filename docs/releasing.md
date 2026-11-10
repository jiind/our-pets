# CI와 릴리즈

## PR 검사

`.github/workflows/ci.yml`은 PR, main push, 수동 실행과 릴리즈의 재사용 호출에 반응한다. 경로 필터를 두지 않아 필수 상태가 영원히 대기하는 상황을 피한다. 기여자 PR에는 저장소 읽기 권한만 주고 checkout 인증정보를 남기지 않는다. `pull_request_target`으로 기여자 코드를 실행하지 않는다. Actions는 검증한 전체 커밋 SHA로 고정하고 Dependabot이 업데이트를 제안한다.

- Secret scan: 체크섬으로 확인한 Gitleaks 고정 버전으로 현재 파일과 Git 전체 이력 검사. 비밀값은 로그에서 마스킹하며 발견·실행 오류 시 실패한다.
- Repository checks: 여섯 버전 선언, 공개 파일 제외 규칙, 배포 고지.
- Go checks: 모듈 검증·vet·race 검사·빌드.
- Frontend checks: lock 기반 설치·TypeScript/Vite·UI 테스트 타입 검사·Vitest·설치된 Chrome의 Playwright. Chrome을 추가 다운로드하지 않는다. 서버는 테스트 전용 루프백 주소와 임시 DB를 사용한다.
- Native: Linux·Windows·macOS 각각의 Rust 단위 검사와 네이티브 빌드. GUI 동작 검증은 별도다.
- CI required: 모든 작업이 성공한 경우에만 성공하는 최종 상태. 취소·실패·건너뜀은 성공으로 바꾸지 않는다.

소스와 워크플로가 커밋·푸시된 뒤 위 이벤트가 발생하면 원격 CI가 실행된다. CI 실행 결과는 GitHub Actions에서 확인한다. 실제 사용자 인증·Slack 토큰·Docker 엔진을 CI에서 사용하지 않는다.

Gitleaks 실패는 `CI required`와 태그 릴리즈의 후속 패키징을 차단한다. 외부 PR에도 별도 토큰·조직용 라이선스 없이 CLI를 실행한다. 다운로드 버전을 올릴 때 공식 배포 파일의 SHA-256도 함께 갱신한다. 로컬 경로·개인 이메일 같은 개인정보는 비밀값 탐지와 별도로 공개 전 검토한다.

## 저장소 설정

main은 PR과 `CI required` 성공·최신 base 반영·대화 해결을 요구한다. 강제 push·삭제를 금지하고 선형 이력을 사용한다. 현재 단독 유지보수자가 자신의 PR을 병합할 수 있도록 필수 타인 승인 수는 0으로 설정한다. 여러 유지보수자가 생기면 승인 수를 올릴 수 있다. squash 병합과 병합 후 브랜치 자동 삭제를 사용한다.

보안 신고는 비공개 취약점 신고 경로를 사용한다. Secret scanning·push protection을 유지하고 취약점 경고·Dependabot 보안 업데이트를 켠다. 주간 Go·npm·Cargo·Actions 업데이트는 `.github/dependabot.yml`을 기본 브랜치에 반영해야 시작한다. 자동 병합은 활성화하지 않는다. 저장소 설정은 관리자 권한이 필요한 운영 설정이며 소스 파일 추가만으로 GitHub에 적용되지 않는다.

## 버전 변경과 태그

1. `desktop/package.json`, `desktop/package-lock.json`의 루트와 `packages[""]`, `desktop/src-tauri/Cargo.toml`, `Cargo.lock`의 앱 항목, `tauri.conf.json` 버전을 함께 올린다.
2. `python3 scripts/check_versions.py`를 실행한다. PR의 CI가 성공한 뒤 main에 병합한다.
3. 해당 main 커밋에 `v0.1.0` 형식의 버전 태그를 만들고 원격으로 push한다. 태그와 소스 버전이 다르거나 main 이력에 없는 커밋이면 릴리즈를 거부한다. 이미 사용한 태그를 덮어쓰지 않는다.
4. 태그의 전체 CI 성공 후 Linux x64 DEB·AppImage, Windows x64 NSIS, macOS universal DMG를 각 OS에서 만든다. 서버는 Linux amd64·arm64, Windows amd64, macOS amd64·arm64 ZIP을 만든다.
5. 모든 대상의 빌드가 성공해야 GitHub **초안 릴리즈**를 만들고 설치 파일·서버 ZIP·고지 ZIP·`SHA256SUMS.txt`를 첨부한다. `v0.1.0-beta.1`처럼 사전 배포 식별자가 있는 태그는 prerelease로 표시한다. 하나라도 실패하면 부분 릴리즈를 만들지 않는다. 재실행은 같은 초안만 갱신하며 이미 게시한 릴리즈는 덮어쓰지 않는다.
6. 초안의 설치 파일·실제 데스크톱 동작·고지를 검토한 뒤 게시한다. 초기 구현은 자동 게시하지 않는다.

릴리즈 작업의 마지막 단계만 `contents: write`를 사용하며 개인 PAT나 외부 자격증명을 요구하지 않는다. 태그는 현재 소스가 Git에 포함된 뒤 사용해야 한다. 로컬의 미추적 파일은 태그에 포함되지 않는다.

## 서명과 검증 범위

Windows 코드 서명과 Apple Developer ID 서명·공증은 아직 구성하지 않았다. 해당 자격증명을 예제나 저장소에 추가하지 않는다. DMG·NSIS 생성은 신뢰된 배포 서명이나 실제 OS 실행 검증과 별개다. 게시 전 [플랫폼별 실행 조건과 확인 항목](platforms.md)에 따라 대상 환경을 확인한다. Linux 네이티브 Wayland 창 제어는 지원하지 않는다.

폰트·캐릭터·GSAP 등은 자체 코드의 Apache-2.0과 별개다. Tauri의 리소스 매핑은 프로젝트·폰트·에셋 고지를 설치 파일에 넣고 동일 고지를 릴리즈 ZIP으로도 제공한다. 패키지의 전체 전이 의존성 라이선스 심사가 완료됐다는 의미는 아니며 새로운 라이브러리는 해당 원문과 재배포 조건을 확인해 고지에 추가해야 한다.
