#!/usr/bin/env python3
"""실제 AppImage의 네이티브 라이브러리를 추적해 원문 고지와 대응 소스를 함께 배포한다."""
import argparse
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile


# 공개 원문을 HTTPS로 내려받고 요구된 SHA-256을 검증한다.
def download(url: str, target: Path, expected: str | None = None) -> None:
    if not url.startswith('https://'):
        raise SystemExit('소스 다운로드에는 HTTPS가 필요합니다.')
    with urllib.request.urlopen(url, timeout=90) as source, target.open('wb') as output:
        while chunk := source.read(1024 * 1024):
            output.write(chunk)
    if expected and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
        raise SystemExit('공식 소스 지문이 일치하지 않습니다: ' + target.name)


# 링커 패치·strip 이후에도 유지되는 ELF 빌드 ID로 바이너리 출처를 확인한다.
@lru_cache(maxsize=2048)
def build_id(file: Path) -> str:
    result = subprocess.run(['readelf', '-n', str(file)], capture_output=True, text=True, check=True)
    match = re.search(r'Build ID: ([0-9a-f]+)', result.stdout)
    if not match:
        raise SystemExit('출처 대조에 필요한 ELF 빌드 ID가 없습니다: ' + file.name)
    return match.group(1)


# 파일명만 같은 다른 버전을 허용하지 않고 빌드 ID가 일치한 패키지 소유자만 찾는다.
def owners(file: Path) -> list[str]:
    result = subprocess.run(['dpkg-query', '-S', '*/' + file.name], capture_output=True, text=True)
    packages = set()
    expected = build_id(file)
    for line in result.stdout.splitlines():
        if ': /' in line:
            package, original = line.rsplit(': ', 1)
            path = Path(original)
            if path.is_file() and build_id(path.resolve()) == expected:
                packages.update(package.split(', '))
    if not packages:
        raise SystemExit('빌드 ID가 일치하는 원본 패키지를 추적할 수 없습니다: ' + file.name)
    return sorted(packages)


# AppImage와 같은 빌드 환경에서 배포하는 실제 ELF 구성요소의 원본 패키지를 수집한다.
def components(appdir: Path) -> tuple[list[dict], list[str]]:
    entries = []
    packages = set()
    for file in sorted(appdir.rglob('*')):
        if not file.is_file() or file.is_symlink():
            continue
        with file.open('rb') as source:
            if source.read(4) != b'\x7fELF':
                continue
        relative = str(file.relative_to(appdir))
        if relative in {'usr/bin/our-pets-desktop', 'AppRun.wrapped'}:
            continue
        original = owners(file)
        packages.update(original)
        entries.append({'file': relative, 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'binaryPackages': original})
    if not entries:
        raise SystemExit('AppImage 네이티브 라이브러리 목록이 비어 있습니다.')
    return entries, sorted(packages)


# 정적으로 연결된 AppImage 런타임의 정확한 소스·패치·고정된 FUSE 소스를 수집한다.
def runtime_sources(appimage: Path, directory: Path) -> None:
    # 1. 실제 실행 파일에 포함된 런타임 커밋을 사용하며 추정 버전은 허용하지 않는다.
    with appimage.open('rb') as source:
        header = source.read(5_000_000)
    match = re.search(rb'https://github.com/AppImage/type2-runtime/commit/([0-9a-f]{7,40})', header)
    if not match:
        raise SystemExit('AppImage 런타임의 정확한 소스 커밋을 확인할 수 없습니다.')
    commit = match.group(1).decode()
    archive = directory / ('type2-runtime-' + commit + '.tar.gz')
    download('https://codeload.github.com/AppImage/type2-runtime/tar.gz/' + commit, archive)

    # 2. 원본 빌드 스크립트의 고정 URL·검증 해시를 그대로 사용한다.
    with tarfile.open(archive) as source:
        script = next(member for member in source.getmembers() if member.name.endswith('/scripts/common/install-dependencies.sh'))
        content = source.extractfile(script).read().decode()
        license_file = next(member for member in source.getmembers() if member.name.endswith('/LICENSE'))
        (directory / 'AppImage-runtime-LICENSE.txt').write_bytes(source.extractfile(license_file).read())
    urls = re.findall(r'wget\s+["\']?(https://[^\s"\']+)', content)
    hashes = dict((name, digest) for digest, name in re.findall(r'([0-9a-f]{64})\s+([^\s"\']+)\s*["\']?\s*\|\s*sha256sum', content))
    for url in urls:
        name = url.rsplit('/', 1)[-1]
        if name not in hashes:
            raise SystemExit('런타임 의존성 소스의 고정 지문이 없습니다: ' + name)
        download(url, directory / name, hashes[name])
    if not any('fuse-' in url for url in urls):
        raise SystemExit('LGPL 런타임 라이브러리 소스가 누락됐습니다.')
    download('https://raw.githubusercontent.com/AppImage/AppImageKit/13/LICENSE', directory / 'AppRun-MIT.txt')
    notices = {
        'musl-COPYRIGHT.txt': 'https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT?h=v1.2.5',
        'zstd-LICENSE.txt': 'https://raw.githubusercontent.com/facebook/zstd/v1.5.6/LICENSE',
        'zlib-LICENSE.txt': 'https://raw.githubusercontent.com/madler/zlib/v1.3.2/LICENSE',
        'mimalloc-LICENSE.txt': 'https://raw.githubusercontent.com/microsoft/mimalloc/v2.1.7/LICENSE',
    }
    for name, url in notices.items():
        download(url, directory / name)
        if b'<html' in (directory / name).read_bytes().lower():
            raise SystemExit('정적 런타임 라이선스 원문 대신 HTML을 받았습니다: ' + name)


# 대응 소스를 함께 제공할 수 없으면 AppImage 릴리즈 수집을 실패시킨다.
def collect(appimage: Path, output: Path) -> None:
    # 1. 실제 배포 파일만 격리 경로에 추출하고 OS 패키지와 출처를 대조한다.
    with tempfile.TemporaryDirectory(prefix='our-pets-native-sources-') as temporary:
        directory = Path(temporary)
        subprocess.run([str(appimage.resolve()), '--appimage-extract'], cwd=directory, stdout=subprocess.DEVNULL, check=True)
        appdir = directory / 'squashfs-root'
        entries, packages = components(appdir)
        sources = directory / 'sources'
        sources.mkdir()
        copyrights = directory / 'copyrights'
        copyrights.mkdir()
        source_packages = set()
        for package in packages:
            result = subprocess.check_output(['dpkg-query', '-W', '-f=${source:Package}\t${source:Version}', package], text=True).split('\t')
            if len(result) != 2 or not all(result):
                raise SystemExit('네이티브 원본 버전 정보가 없습니다: ' + package)
            source_packages.add(tuple(result))
            path = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
            if not path.is_file():
                raise SystemExit('네이티브 저작권 원문이 없습니다: ' + package)
            (copyrights / (package.replace(':', '-') + '.txt')).write_bytes(path.read_bytes())

        # 2. 라이선스별 서면 제공 약속 대신 정확한 패키지 소스를 실제로 함께 제공한다.
        for name, version in sorted(source_packages):
            subprocess.run(['apt-get', 'source', '--download-only', '--only-source', name + '=' + version], cwd=sources, check=True, stdout=subprocess.DEVNULL)
        runtime_sources(appimage, sources)
        metadata = {'appimageSha256': hashlib.sha256(appimage.read_bytes()).hexdigest(), 'components': entries, 'sourcePackages': [{'name': name, 'version': version} for name, version in sorted(source_packages)]}
        (directory / 'native-components.json').write_text(json.dumps(metadata, indent=2) + '\n')
        (directory / 'README.txt').write_text('Native library sources and notices for the accompanying Linux AppImage. Sources are unmodified Ubuntu source distributions plus the exact AppImage runtime source, its patches and pinned FUSE/squashfuse sources. See each source archive for original terms and build instructions. Our Pets source and build instructions are available from the same GitHub release tag. Dynamic libraries may be replaced in an extracted AppDir; no additional reverse-engineering restrictions are imposed by Our Pets. OS libraries installed independently follow the OS distributor terms.\n')
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(sources.iterdir()):
                if file.is_file():
                    archive.write(file, 'sources/' + file.name)
            for file in sorted(copyrights.iterdir()):
                archive.write(file, 'copyrights/' + file.name)
            for file in sorted(Path('/usr/share/common-licenses').iterdir()):
                if file.is_file():
                    archive.write(file, 'common-licenses/' + file.name)
            archive.write(directory / 'native-components.json', 'native-components.json')
            archive.write(directory / 'README.txt', 'README.txt')
        print(f'네이티브 ELF {len(entries)}개와 원본 소스 {len(source_packages)}개를 함께 수집했습니다.')


# Linux 릴리즈 작업에서만 명시한 AppImage와 출력 ZIP을 처리한다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--appimage', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    collect(args.appimage, args.output)


if __name__ == '__main__':
    main()
