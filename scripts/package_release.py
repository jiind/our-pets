#!/usr/bin/env python3
"""허용한 서버·설치 파일과 공개 문서만 릴리즈 산출물로 묶는다."""
import argparse
import hashlib
from pathlib import Path
import shutil
import zipfile

from check_versions import ROOT, check_versions
from prepare_notices import prepare

OUTPUT = ROOT / 'release-out'


# 서버 바이너리와 비밀값 없는 운영 예제·고지를 ZIP으로 묶는다.
def package_server(platform: str, binary: Path) -> None:
    # 1. 허용한 대상과 실제 빌드 산출물만 선택한다.
    if platform not in {'linux-amd64', 'linux-arm64', 'windows-amd64', 'darwin-amd64', 'darwin-arm64'}:
        raise SystemExit('지원하지 않는 서버 대상입니다.')
    if not binary.is_file():
        raise SystemExit('서버 실행 파일이 없습니다.')
    version = check_versions()
    OUTPUT.mkdir(exist_ok=True)
    name = 'our-pets.exe' if platform.startswith('windows-') else 'our-pets'

    # 2. 지정한 공개 파일만 압축해 데이터·인증 자료가 섞이지 않게 한다.
    with zipfile.ZipFile(OUTPUT / f'our-pets-server-{version}-{platform}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.write(binary, name)
        for path in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'docs/operations.md', 'docs/platforms.md', 'examples/server.env.example', 'examples/our-pets.service']:
            archive.write(ROOT / path, path)


# 현재 OS에서 만든 설치 파일과 별도 배포 고지를 수집한다.
def package_desktop(platform: str) -> None:
    # 1. 실제 패키지 확장자와 대상별 필수 결과를 확인한다.
    required = {'linux-x64': {'.deb', '.AppImage'}, 'windows-x64': {'.exe'}, 'macos-universal': {'.dmg'}}
    if platform not in required:
        raise SystemExit('지원하지 않는 데스크톱 대상입니다.')
    bundle = ROOT / 'desktop/src-tauri/target'
    bundle = bundle / ('universal-apple-darwin/release/bundle' if platform == 'macos-universal' else 'release/bundle')
    packages = [file for file in bundle.rglob('*') if file.is_file() and file.suffix in required[platform]]
    if {file.suffix for file in packages} != required[platform]:
        raise SystemExit('필수 설치 파일이 모두 생성되지 않았습니다: ' + platform)
    OUTPUT.mkdir(exist_ok=True)

    # 2. 아티팩트 이름 충돌을 피하고 고지를 함께 제공한다.
    for file in packages:
        shutil.copyfile(file, OUTPUT / (platform + '-' + file.name))
    notices = ROOT / 'desktop/src-tauri/target/release-notices'
    prepare(notices)
    with zipfile.ZipFile(OUTPUT / f'our-pets-notices-{check_versions()}-{platform}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(notices.iterdir()):
            archive.write(file, file.name)


# 전체 산출물의 SHA-256과 검증 범위를 포함한 릴리즈 설명을 생성한다.
def release_notes() -> None:
    # 1. 이전 지문 파일을 제외하고 모든 설치 파일·압축 파일을 해시한다.
    files = sorted(file for file in OUTPUT.iterdir() if file.is_file() and file.name != 'SHA256SUMS.txt')
    if not files:
        raise SystemExit('릴리즈 산출물이 없습니다.')
    checksums = []
    for file in files:
        digest = hashlib.sha256()
        with file.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        checksums.append(digest.hexdigest() + '  ' + file.name)
    (OUTPUT / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='utf-8')

    # 2. 자동 빌드와 실제 실행 검증·서명을 명확히 구분한다.
    text = f'''# Our Pets {check_versions()}

PR CI와 태그 버전 검사를 통과한 소스로 생성한 초기 배포 패키지입니다.

- 데스크톱: Linux x64 DEB·AppImage, Windows x64 NSIS, macOS Intel·Apple Silicon 공용 DMG.
- 서버: Linux amd64·arm64, Windows amd64, macOS amd64·arm64 ZIP.
- SHA256SUMS.txt와 각 플랫폼의 고지 ZIP을 함께 확인해 주세요.
- Windows 코드 서명·Apple Developer ID 서명·공증은 구성하지 않았습니다. OS가 경고하거나 설치를 제한할 수 있습니다.
- CI 빌드 성공은 실제 투명 창·클릭 통과·포커스·보행 검증을 뜻하지 않습니다. 플랫폼별 실행 조건과 배포 전 확인 항목은 소스의 docs/platforms.md를 확인해 주세요.
- 런타임 라이브러리·폰트·캐릭터는 별도 고지를 따릅니다. 이 설명은 모든 의존성의 법률적 호환성 심사 완료를 의미하지 않습니다.
- 기본 메시지·알림은 접속 중 받은 것만 표시하며 오프라인 기록을 재생하지 않습니다.

이 릴리즈는 초안입니다. 설치·OS 동작을 검토한 뒤 게시해 주세요.
'''
    (ROOT / 'release-notes.md').write_text(text, encoding='utf-8')


# 릴리즈 작업별로 명시적인 입력만 전달한다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['server', 'desktop', 'notes'])
    parser.add_argument('--platform', default='')
    parser.add_argument('--binary', type=Path)
    args = parser.parse_args()
    if args.kind == 'server':
        if args.binary is None:
            parser.error('서버 빌드에는 --binary가 필요합니다.')
        package_server(args.platform, args.binary)
    elif args.kind == 'desktop':
        package_desktop(args.platform)
    else:
        release_notes()


if __name__ == '__main__':
    main()
