#!/usr/bin/env python3
"""잠긴 의존성의 원문 고지·출처·지문을 수집하고 변경 누락을 CI에서 차단한다."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'desktop/public/licenses'
MANIFEST = OUTPUT / 'dependency-inventory.json'
LICENSE_IDS = {'CC0-1.0', 'MIT', 'MIT-0', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', '0BSD', 'Zlib', 'Unlicense', 'Unicode-3.0', 'MPL-2.0', 'CDLA-Permissive-2.0', 'BSL-1.0', 'LGPL-2.1-or-later', 'LLVM-exception'}


# Cargo가 생성한 잠금 파일의 패키지 식별자와 원문 블록을 Python 3.10에서도 읽는다.
def cargo_packages() -> list[dict]:
    text = (ROOT / 'desktop/src-tauri/Cargo.lock').read_text(encoding='utf-8')
    blocks = re.split(r'(?m)^\[\[package\]\]\s*$', text)[1:]
    packages = []
    for block in blocks:
        fields = {key: json.loads(value) for key, value in re.findall(r'(?m)^(name|version|source|checksum) = ("[^"\n]*")$', block)}
        if not {'name', 'version'} <= fields.keys() or '[[' in block:
            raise SystemExit('지원하지 않는 Cargo 잠금 파일 형식입니다. 파서를 검토하세요.')
        fields['raw'] = block.strip()
        packages.append(fields)
    if not packages:
        raise SystemExit('Cargo 잠금 파일에 패키지가 없습니다.')
    return packages


# 배포 목록 비교에 사용할 공개 설정 지문을 경로·시간 정보 없이 만든다.
def inputs() -> dict:
    cargo = [p['raw'] for p in cargo_packages() if p['name'] != 'our-pets-desktop']
    npm = json.loads((ROOT / 'desktop/package-lock.json').read_text(encoding='utf-8'))
    runtime = {name: value for name, value in npm['packages'].items() if name and not value.get('dev')}
    return {'cargo': digest(json.dumps(cargo, sort_keys=True).encode()), 'npm': digest(json.dumps(runtime, sort_keys=True).encode()), 'go.mod': digest((ROOT / 'go.mod').read_bytes()), 'go.sum': digest((ROOT / 'go.sum').read_bytes())}


# 파일과 공개 설정의 SHA-256을 계산한다.
def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# 도구가 연속 출력한 JSON 객체를 손실 없이 분리한다.
def json_stream(raw: str) -> list:
    values = []
    decoder = json.JSONDecoder()
    while raw.strip():
        value, end = decoder.raw_decode(raw.lstrip())
        values.append(value)
        raw = raw.lstrip()[end:]
    return values


# 원문 라이선스와 저작권·저자 고지를 하위 벤더 코드까지 포함해 고른다.
def license_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.rglob('*') if p.is_file() and not p.is_symlink() and any(word in p.name.lower() for word in ['license', 'licence', 'copying', 'copyright', 'notice', 'authors']) and p.stat().st_size <= 2_000_000)


# 공식 SPDX 식에서 새 조건이 추가되면 자동 허용하지 않고 검토를 요구한다.
def validate_expression(expression: str) -> None:
    identifiers = set(re.findall(r'[A-Za-z0-9][A-Za-z0-9.+-]*', expression)) - {'OR', 'AND', 'WITH'}
    if not identifiers or not identifiers <= LICENSE_IDS:
        raise SystemExit('검토되지 않은 라이선스: ' + expression)


# 현재 잠금 파일의 모든 Rust·Go와 npm 런타임 의존성을 원문과 함께 수집한다.
def generate(cargo_metadata: Path | None, go_metadata: Path | None) -> None:
    # 1. 패키지 소스에서 원문을 읽고 패키지에 빠진 고지만 검증된 고정 커밋 사본으로 보완한다.
    cargo = json.loads(cargo_metadata.read_text(encoding='utf-8') if cargo_metadata else subprocess.check_output(['cargo', 'metadata', '--locked', '--format-version', '1'], cwd=ROOT / 'desktop/src-tauri', text=True))
    go = json_stream(go_metadata.read_text(encoding='utf-8') if go_metadata else subprocess.check_output(['go', 'list', '-m', '-json', 'all'], cwd=ROOT, text=True))
    override_root = ROOT / 'scripts/license-overrides'
    overrides = json.loads((override_root / 'provenance.json').read_text(encoding='utf-8'))
    packages = []
    parts = ['Third-party dependency licenses\n\nThis inventory includes locked Rust/Go dependencies (including build and target-specific dependencies) and npm runtime dependencies. Inclusion is not a claim that every package is linked into every OS binary. Original terms apply. Source URLs and checksums identify exact unmodified upstream sources. The GLib Rust wrapper is patched as documented in THIRD_PARTY_NOTICES.md.\n']
    source_archives = []
    for package in sorted(cargo['packages'], key=lambda p: (p['name'], p['version'])):
        if package['name'] == 'our-pets-desktop':
            continue
        name, version = package['name'], package['version']
        expression = package['license'] or ''
        validate_expression(expression)
        directory = Path(package['manifest_path']).parent
        texts = [(str(p.relative_to(directory)), p.read_bytes()) for p in license_files(directory)]
        if expression == 'MPL-2.0' and not any(b'Mozilla Public License' in raw for _, raw in texts):
            canonical = next(Path(p['manifest_path']).parent for p in cargo['packages'] if p['name'] == 'cssparser' and p['version'] == '0.37.0') / 'LICENSE'
            texts.append(('MPL-2.0 canonical license referenced by source headers', canonical.read_bytes()))
        if not texts:
            for item in overrides.get(name + '@' + version, []):
                path = override_root / item['file']
                if digest(path.read_bytes()) != item['sha256']:
                    raise SystemExit('보완 고지 원문 지문 불일치: ' + item['file'])
                texts.append((item['url'], path.read_bytes()))
        if not texts:
            raise SystemExit('라이선스 원문 누락: ' + name + '@' + version)
        source = f'https://static.crates.io/crates/{name}/{name}-{version}.crate'
        packages.append({'ecosystem': 'cargo', 'name': name, 'version': version, 'license': expression, 'source': source, 'checksum': next((p.get('checksum') for p in cargo_packages() if p['name'] == name and p['version'] == version), None)})
        parts.append(f'\n=== cargo: {name} {version} ===\nLicense expression: {expression}\nSource: {source}\n')
        for label, data in texts:
            parts.append('\n--- ' + label + ' ---\n' + data.decode('utf-8', errors='replace') + '\n')
        if expression == 'MPL-2.0':
            cache = directory.parent.parent.parent / 'cache' / directory.parent.name / f'{name}-{version}.crate'
            if not cache.is_file():
                raise SystemExit('MPL 배포 소스 원문이 없습니다: ' + name)
            source_archives.append((cache, name + '-' + version + '.crate'))
    for module in go:
        if module.get('Main'):
            continue
        directory = Path(module.get('Dir', ''))
        if not module.get('Dir'):
            raise SystemExit('Go 소스 누락: go mod download all을 먼저 실행하세요: ' + module['Path'])
        texts = [(str(p.relative_to(directory)), p.read_bytes()) for p in license_files(directory)]
        if not texts:
            raise SystemExit('Go 라이선스 원문 누락: ' + module['Path'])
        path, version = module['Path'], module['Version']
        source = 'https://proxy.golang.org/' + ''.join('!' + c.lower() if c.isupper() else c for c in path) + '/@v/' + version + '.zip'
        packages.append({'ecosystem': 'go', 'name': path, 'version': version, 'license': 'See original texts', 'source': source, 'checksum': module.get('Sum')})
        parts.append(f'\n=== go: {path} {version} ===\nSource: {source}\n')
        for label, data in texts:
            parts.append('\n--- ' + label + ' ---\n' + data.decode('utf-8', errors='replace') + '\n')
        if any(b'Mozilla Public License' in data for _, data in texts):
            cache = Path(module['GoMod']).with_suffix('.zip')
            if not cache.is_file():
                raise SystemExit('Go MPL 소스 ZIP이 없습니다: ' + path)
            source_archives.append((cache, path.replace('/', '-') + '-' + version + '.zip'))
    npm = json.loads((ROOT / 'desktop/package-lock.json').read_text(encoding='utf-8'))
    for location, package in sorted(npm['packages'].items()):
        if not location or package.get('dev'):
            continue
        directory = ROOT / 'desktop' / location
        metadata = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
        name, version = metadata['name'], metadata['version']
        texts = [(str(p.relative_to(directory)), p.read_bytes()) for p in license_files(directory)]
        if name == 'gsap':
            texts = [('GSAP-NOTICE.txt', (OUTPUT / 'GSAP-NOTICE.txt').read_bytes()), ('GSAP-Standard-License.txt', (OUTPUT / 'GSAP-Standard-License.txt').read_bytes())]
        if not texts:
            raise SystemExit('npm 라이선스 원문 누락: ' + name)
        packages.append({'ecosystem': 'npm', 'name': name, 'version': version, 'license': metadata.get('license'), 'source': package.get('resolved'), 'checksum': package.get('integrity')})
        parts.append(f'\n=== npm: {name} {version} ===\nLicense: {metadata.get("license")}\n')
        for label, data in texts:
            parts.append('\n--- ' + label + ' ---\n' + data.decode('utf-8', errors='replace') + '\n')

    # 2. 생성물은 개인정보 없이 공개 고지·잠금 지문·MPL 원본 소스로만 구성한다.
    text = ''.join(parts).encode()
    (OUTPUT / 'dependencies.txt').write_bytes(text)
    sources = OUTPUT / 'sources'
    sources.mkdir(exist_ok=True)
    files = {'dependencies.txt': digest(text)}
    for source, name in source_archives:
        shutil.copyfile(source, sources / name)
        files['sources/' + name] = digest(source.read_bytes())
    MANIFEST.write_text(json.dumps({'inputs': inputs(), 'packages': packages, 'files': files}, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'Generated notices for {len(packages)} dependencies and {len(source_archives)} source archives.')


# CI에서는 외부 도구·네트워크 없이 잠금 변경과 배포 원문의 변조·누락을 검사한다.
def check() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding='utf-8'))
    if manifest['inputs'] != inputs():
        raise SystemExit('의존성 변경 후 고지를 갱신하세요: python3 scripts/dependency_notices.py --update')
    expected_cargo = {(p['name'], p['version']) for p in cargo_packages() if p['name'] != 'our-pets-desktop'}
    listed_cargo = {(p['name'], p['version']) for p in manifest['packages'] if p['ecosystem'] == 'cargo'}
    if expected_cargo != listed_cargo:
        raise SystemExit('Cargo 잠금 파일의 전체 의존성이 고지 목록에 포함되어야 합니다.')
    for package in manifest['packages']:
        if package['ecosystem'] == 'cargo':
            validate_expression(package['license'])
    for name, expected in manifest['files'].items():
        path = OUTPUT / name
        if path.is_symlink() or not path.resolve().is_relative_to(OUTPUT.resolve()):
            raise SystemExit('고지 파일은 공개 고지 디렉터리 안에 있어야 합니다.')
        if not path.is_file() or digest(path.read_bytes()) != expected:
            raise SystemExit('의존성 배포 원문 지문 불일치: ' + name)
    print(f'Verified notices and original distribution files for {len(manifest["packages"])} dependencies.')


# 고지 재생성과 오프라인 무결성 검사를 명시적으로 구분한다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--cargo-metadata', type=Path)
    parser.add_argument('--go-metadata', type=Path)
    args = parser.parse_args()
    if args.update:
        generate(args.cargo_metadata, args.go_metadata)
    check()


if __name__ == '__main__':
    main()
