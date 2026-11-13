#!/usr/bin/env python3
"""허용한 서버·설치 파일과 공개 문서만 릴리즈 산출물로 묶는다."""
import argparse
import hashlib
from pathlib import Path
import shutil
import zipfile

from check_versions import ROOT, check_versions
from prepare_notices import prepare
from linux_distribution_sources import collect as collect_linux_sources

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
        for path in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'SECURITY.md', 'docs/operations.md', 'docs/platforms.md', 'PRIVACY.md', 'docs/server-privacy-template.md', 'examples/server.env.example', 'examples/our-pets.service']:
            archive.write(ROOT / path, path)
        for file in sorted((ROOT / 'desktop/public/licenses').rglob('*')):
            if file.is_file():
                archive.write(file, 'licenses/' + str(file.relative_to(ROOT / 'desktop/public/licenses')))


# 현재 OS에서 만든 설치 파일과 별도 배포 고지를 수집한다.
def package_desktop(platform: str) -> None:
    # 1. 실제 패키지 확장자와 대상별 필수 결과를 확인한다.
    required = {'linux-x64': {'.deb', '.AppImage'}, 'windows-x64': {'.exe'}, 'macos-universal': {'.dmg'}}
    if platform not in required:
        raise SystemExit('지원하지 않는 데스크톱 대상입니다.')
    bundle = ROOT / 'desktop/src-tauri/target'
    bundle = bundle / ('universal-apple-darwin/release/bundle' if platform == 'macos-universal' else 'release/bundle')
    packages = [file for file in bundle.rglob('*') if file.is_file() and file.suffix in required[platform]]
    if len(packages) != len(required[platform]) or {file.suffix for file in packages} != required[platform]:
        raise SystemExit('Expected exactly one installer for each required bundle type: ' + platform)
    version = check_versions()
    OUTPUT.mkdir(exist_ok=True)

    # 2. 아티팩트 이름 충돌을 피하고 고지를 함께 제공한다.
    for file in packages:
        shutil.copyfile(file, OUTPUT / f'our-pets-desktop-{version}-{platform}{file.suffix}')
    if platform == 'linux-x64':
        image = next(file for file in packages if file.suffix == '.AppImage')
        collect_linux_sources(image, OUTPUT / f'our-pets-linux-native-sources-{version}.zip')
    notices = ROOT / 'desktop/src-tauri/target/release-notices'
    prepare(notices)
    with zipfile.ZipFile(OUTPUT / f'our-pets-notices-{check_versions()}-{platform}.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(notices.rglob('*')):
            if file.is_file():
                archive.write(file, str(file.relative_to(notices)))


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

Packages built from source that passed PR CI and tag-version validation.

- Desktop: Linux x64 DEB/AppImage, Windows x64 NSIS, and macOS universal DMG for Intel and Apple Silicon.
- Server: Linux amd64/arm64, Windows amd64, and macOS amd64/arm64 ZIPs.
- Verify SHA256SUMS.txt and the platform notice ZIPs alongside the installers.
- Windows code signing and Apple Developer ID signing/notarization are not configured. The OS may warn or restrict installation.
- Successful CI builds do not verify transparency, click-through, focus, or walking on every OS. See docs/platforms.md for runtime requirements and validation before distribution.
- Linux AppImage redistribution must include the native-source ZIP and platform notices alongside the installer.
- Libraries, fonts, and characters retain their individual terms. This release does not establish a completed legal review of all dependencies.
- Messages and notifications are real-time only; offline history is not replayed.

This release is a draft. Review installation and OS behavior before publishing.
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
