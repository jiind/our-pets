# 포함된 폰트

앱 UI에는 무료 오픈소스 Pretendard Variable을 수정 없이 포함한다. 런타임에 외부 폰트 서버나 CDN을 요청하지 않는다.

- 원본: https://github.com/orioncactus/pretendard
- 파일: `desktop/public/fonts/PretendardVariable.woff2`
- 포함 파일 SHA-256: `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4`
- 라이선스: SIL Open Font License 1.1. 저작권 고지와 원문은 `desktop/public/fonts/OFL.txt`에 포함한다.
- 폰트의 개별 판매는 허용되지 않는다. 앱과 함께 배포할 때 원문 고지를 유지한다.

네이티브 타이틀바·트레이 및 이모지 모양은 운영체제가 제공한다. 본문 UI는 번들 폰트를 사용한다. Go·Rust·npm 라이브러리의 의존성 버전은 각 lock/sum 파일을 따른다.

# 포함된 인터랙션 라이브러리

- GSAP 3.15.1: https://gsap.com
- 패키지의 라이선스 표기: Standard 'no charge' license, https://gsap.com/standard-license
- GSAP Skills 문서의 MIT 라이선스와 GSAP 런타임의 라이선스는 별개다.
- 앱에는 npm 패키지에서 사용한 core만 번들로 포함하며 런타임 CDN 요청을 하지 않는다.

# 기본 캐릭터 원화

기본 주황 고양이의 16프레임 원화는 이번 프로젝트용으로 내장 image_gen 도구로 생성했다. 파일은 `desktop/src/assets/ginger-companion-v2.png`이며 생성 프롬프트와 출력 규격은 같은 디렉터리의 `ginger-companion-v2.prompt.txt`에 기록했다. eSheep·Shimeji·VPet·Godot 펫의 이미지나 모델은 포함하지 않는다.

# OS 알림 라이브러리

- tauri-plugin-notification 2.4.0: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/notification · Apache-2.0 OR MIT
- notify-rust 4.18.2: https://github.com/hoodie/notify-rust · MIT OR Apache-2.0
- 실제 포함 버전과 전이 의존성은 desktop/src-tauri/Cargo.lock을 따른다. 런타임에는 OS의 기본 알림 API를 사용한다.

# 추가 기본 펫 에셋

- 강아지: Jason of GDN, Dog Spritesheets, CC0 1.0. https://opengameart.org/content/dog-spritesheets
- 고퍼 픽셀·애니메이션: Egon Elbre, CC0 1.0. https://github.com/egonelbre/gophers
- 고퍼 원안: Renée French, CC BY 4.0. https://go.dev/wiki/Gopher 및 https://creativecommons.org/licenses/by/4.0/
- 페리스 애니메이션: Marc Duiker, vscode-pets, MIT (Copyright © 2022 Anthony Shaw). https://github.com/tonybaloney/vscode-pets
- 페리스 원안: Karen Rustad Tölva, CC0 1.0. https://rustacean.net/

파일·커밋·SHA-256은 `desktop/src/assets/builtin/provenance.json`에 기록한다. GIF는 원본 픽셀을 변경하지 않고 프레임을 PNG 아틀라스로 묶었다. CC0·MIT 원문은 `desktop/public/licenses/`에 포함하며 앱의 펫 선택 아래 캐릭터 출처·라이선스에도 출처·변경 내용·라이선스 URI와 MIT 원문을 표시한다. 다운로드한 다른 프로젝트의 코드·소리·상표·배경 이미지는 포함하지 않는다.

# 2026-11-09 현재 강아지·고퍼 채색 원화

현재 실행에 사용하는 강아지·고퍼의 painted-v2.png는 내장 image_gen.imagegen으로 생성한 16자세 원화다. 고양이는 그림체 참고로 사용했고 새 강아지는 별도로 생성했다. 고퍼는 Renée French의 Go Gopher(CC BY 4.0, https://go.dev/wiki/Gopher, https://creativecommons.org/licenses/by/4.0/)를 새 채색·자세로 각색했다. 원안 출처와 라이선스 및 변경 사실은 앱에서도 고지한다.

이전 Jason of GDN 강아지·Egon Elbre 고퍼의 픽셀 원본과 기존 라이선스는 기록 보존용이며 현재 렌더링에는 사용하지 않는다. 페리스 및 그 출처·라이선스는 유지한다. 원본 PNG를 리사이즈·재편집하지 않았고 저알파 정리만 런타임 메모리에 적용한다. 생성 프롬프트와 파일 지문은 각 에셋 폴더와 provenance.json에 보관한다.

현재 고퍼는 gopher/flat-v3.png의 비픽셀 평면 2D 각색을 사용한다. Renée French의 Go Gopher 원안과 CC BY 4.0 출처·라이선스는 유지하며, 새 변형은 기존 2.5D 원화를 내장 image_gen.imagegen으로 편집한 것이다. 이전 고퍼·강아지·고양이 원본 파일은 보존했다. 프롬프트와 지문은 고퍼 에셋 폴더 및 provenance.json에 기록한다.

# 현재 기본 펫의 평면 2D 원화

현재 기본 고양이·강아지·고퍼·페리스는 각 builtin/<id>/flat-v3.png를 사용한다. 고양이·강아지는 기존 프로젝트 원화를 내장 image_gen.imagegen으로 비픽셀 2D 편집했고, 페리스는 기존 참고 스프라이트에서 정체성을 참고해 같은 16자세 2D 규격으로 생성했다. 고퍼는 그림체 참고로 사용한다. 프롬프트·참고 입력·생성 파일 위치·지문은 각 폴더의 flat-v3.prompt.txt와 provenance.json에 기록한다.

Ferris 원안 Karen Rustad Tölva의 CC0 및 참고 이미지 Marc Duiker/vscode-pets의 MIT 원문·고지는 보존한다. Go Gopher의 Renée French CC BY 4.0 고지도 유지한다. 이전 픽셀·2.5D 파일은 보존하지만 현재 실행 이미지로 참조하지 않는다.

# 현재 원화의 선·명암 개선판

현재 기본 펫은 각 builtin/<id>/cel-v4.png다. 내장 image_gen.imagegen으로 기존 캐릭터의 정체성·16자세를 유지하면서 선을 얇게 하고 절제한 셀 명암을 추가했다. cat/cel-v4-master.png를 먼저 생성해 공통 스타일 기준으로 사용했다. 원본 파일과 정확한 프롬프트·참고 입력·SHA-256은 각 에셋 폴더와 provenance.json에 보존한다. 이전 그림도 보존한다. 고퍼·페리스 원안 및 참고 스프라이트의 기존 출처·라이선스 고지는 유지한다.

# 배포 고지 포함

프로젝트 자체 코드의 Apache-2.0은 위 폰트·캐릭터·라이브러리의 개별 조건을 대체하지 않는다. GSAP의 원본 저작권·약관 링크는 desktop/public/licenses/GSAP-NOTICE.txt에도 기록한다. Tauri 리소스 매핑으로 LICENSE·이 고지·Pretendard OFL·에셋 고지를 설치 패키지에 포함하고 릴리즈에는 같은 고지 ZIP을 첨부한다. 전체 Go·Rust·npm 전이 의존성에 대한 법률적 호환성 심사 완료를 의미하지 않는다.

# Linux X11 버튼 이벤트 관찰

- x11rb·x11rb-protocol 0.13.2: https://github.com/psychon/x11rb · MIT OR Apache-2.0. 배포 고지에 MIT 원문을 포함한다.
- gethostname 1.1.0: https://codeberg.org/swsnr/gethostname.rs · Apache-2.0. 배포 고지에 해당 원문을 포함한다.
- gdkx11 0.18.2: https://github.com/gtk-rs/gtk3-rs · MIT. GTK 3의 X11 사용자 입력 시각 조회에 사용한다. 기존 Linux 의존성을 직접 참조하며 원문을 배포 고지에 포함한다.

버튼 이벤트는 메뉴 닫기와 드래그 놓기를 위해 메모리에서만 처리한다. 키보드 입력이나 포인터 이동을 수집·저장하지 않는다. X11 RECORD 확장이 없으면 기존 상태 조회 방식으로 돌아가며 그 경로에서는 매우 짧은 클릭을 놓칠 수 있다.
