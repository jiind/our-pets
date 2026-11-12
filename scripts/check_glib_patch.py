#!/usr/bin/env python3
"""GLib 보안 백포트의 출처와 정확한 수정 및 전체 의존성 적용을 확인한다."""

import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL_POINTER = '            let p: *mut libc::c_char = std::ptr::null_mut();'
PATCHED_POINTER = ORIGINAL_POINTER.replace('let p:', 'let mut p:')
ORIGINAL_ARGUMENT = '                &p,\n                std::ptr::null::<i8>(),'
PATCHED_ARGUMENT = ORIGINAL_ARGUMENT.replace('&p,', '&mut p,')


# 원본 파일의 해시와 두 줄 보안 백포트를 함께 확인한다.
def check() -> None:
    # 1. 검증된 원본 스냅샷과 정확한 변경 파일만 허용한다.
    vendor = ROOT / 'desktop/src-tauri/vendor/glib-0.18.5'
    manifest_bytes = (vendor / 'UPSTREAM-SHA256.json').read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != 'dd986e4d8a079a69cf655f23fe107118bf835d80f3afa418d7973a15a32290bf':
        raise SystemExit('GLib 원본 파일 목록의 체크섬이 다릅니다.')
    manifest = json.loads(manifest_bytes)
    if manifest['archiveSha256'] != '233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5':
        raise SystemExit('GLib 원본 아카이브 체크섬이 다릅니다.')
    expected_files = set(manifest['files']) | {'PATCH.md', 'UPSTREAM-SHA256.json'}
    actual_files = set()
    for path in vendor.rglob('*'):
        if path.is_symlink():
            raise SystemExit('GLib 스냅샷에 링크가 있습니다.')
        if path.is_file():
            actual_files.add(path.relative_to(vendor).as_posix())
    if actual_files != expected_files:
        raise SystemExit('GLib 스냅샷의 파일이 추가되거나 누락됐습니다.')
    for relative, expected in manifest['files'].items():
        path = vendor / relative
        if path.is_symlink() or not path.is_file():
            raise SystemExit('GLib 원본 파일이 없거나 링크입니다: ' + relative)
        data = path.read_bytes()
        if relative == manifest['patchedFile']:
            source = data.decode()
            if source.count(PATCHED_POINTER) != 1 or source.count(PATCHED_ARGUMENT) != 1:
                raise SystemExit('GLib의 가변 출력 포인터 수정이 없습니다.')
            if hashlib.sha256(data).hexdigest() != manifest['patchedSha256']:
                raise SystemExit('GLib 변경 파일의 체크섬이 다릅니다.')
            data = source.replace(PATCHED_POINTER, ORIGINAL_POINTER).replace(PATCHED_ARGUMENT, ORIGINAL_ARGUMENT).encode()
        if hashlib.sha256(data).hexdigest() != expected:
            raise SystemExit('GLib 원본과 다른 변경이 있습니다: ' + relative)

    # 2. 루트 오버라이드와 잠금 파일이 취약한 레지스트리 복사본을 배제하는지 확인한다.
    cargo = (ROOT / 'desktop/src-tauri/Cargo.toml').read_text()
    if not re.search(r'\[patch\.crates-io\]\s+glib\s*=\s*\{\s*path\s*=\s*"vendor/glib-0\.18\.5"\s*\}', cargo):
        raise SystemExit('GLib 로컬 보안 패치 오버라이드가 없습니다.')
    lock = (ROOT / 'desktop/src-tauri/Cargo.lock').read_text()
    packages = [item for item in lock.split('[[package]]') if re.search(r'^name = "glib"$', item, re.MULTILINE)]
    if len(packages) != 1 or 'version = "0.18.5"' not in packages[0] or re.search(r'^(source|checksum)\s*=', packages[0], re.MULTILINE):
        raise SystemExit('GLib 잠금 파일이 로컬 패치 하나만 사용하지 않습니다.')

    # 3. 설치 패키지의 원문 라이선스와 저작권 고지도 같은 원본인지 확인한다.
    for source, target in [('LICENSE', 'glib-MIT.txt'), ('COPYRIGHT', 'glib-COPYRIGHT.txt')]:
        if (vendor / source).read_bytes() != (ROOT / 'desktop/public/licenses' / target).read_bytes():
            raise SystemExit('GLib 배포 고지가 원본과 다릅니다: ' + source)
    print('GLib 원본·보안 백포트·의존성 오버라이드를 확인했습니다.')


if __name__ == '__main__':
    check()
