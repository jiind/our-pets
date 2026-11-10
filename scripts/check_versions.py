#!/usr/bin/env python3
"""배포 버전과 선택적인 태그를 서로 대조한다."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


# 앱·lock·네이티브 설정의 버전을 확인하고 선택적인 태그와 비교한다.
def check_versions(tag: str | None = None) -> str:
    # 1. 배포에 참여하는 모든 버전 선언을 읽는다.
    package = json.loads((ROOT / 'desktop/package.json').read_text(encoding='utf-8'))
    lock = json.loads((ROOT / 'desktop/package-lock.json').read_text(encoding='utf-8'))
    cargo = (ROOT / 'desktop/src-tauri/Cargo.toml').read_text(encoding='utf-8')
    cargo_lock = (ROOT / 'desktop/src-tauri/Cargo.lock').read_text(encoding='utf-8')
    tauri = json.loads((ROOT / 'desktop/src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    native = next(block for block in cargo_lock.split('[[package]]') if re.search(r'^name = \"our-pets-desktop\"$', block, re.M))
    cargo_version = re.search(r'^version = \"([^\"]+)\"$', cargo, re.M).group(1)
    native_version = re.search(r'^version = \"([^\"]+)\"$', native, re.M).group(1)
    versions = {
        'package.json': package['version'],
        'package-lock.json': lock['version'],
        'package-lock.json root': lock['packages']['']['version'],
        'Cargo.toml': cargo_version,
        'Cargo.lock': native_version,
        'tauri.conf.json': tauri['version'],
    }

    # 2. 안정 버전·사전 배포 버전만 허용하고 불일치 시 배포를 중단한다.
    version = package['version']
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?', version):
        raise SystemExit('지원하지 않는 버전 형식입니다.')
    if len(set(versions.values())) != 1:
        raise SystemExit('버전 불일치: ' + json.dumps(versions, ensure_ascii=False))
    if tag is not None and tag != 'v' + version:
        raise SystemExit('태그가 소스의 v' + version + '과 일치하지 않습니다.')
    return version


# 명령줄에서 현재 버전 또는 릴리즈 태그의 일치 여부를 확인한다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag')
    args = parser.parse_args()
    print(check_versions(args.tag))


if __name__ == '__main__':
    main()
