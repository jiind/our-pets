#!/usr/bin/env python3
"""프로젝트와 포함 에셋·UI 라이브러리의 고지를 배포용 디렉터리에 모은다."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    'LICENSE': 'Apache-2.0.txt',
    'desktop/public/licenses/PROJECT-ARTWORK.txt': 'PROJECT-ARTWORK.txt',
    'PRIVACY.md': 'PRIVACY.md',
    'docs/server-privacy-template.md': 'server-privacy-template.md',
    'desktop/public/licenses/GSAP-Standard-License.txt': 'GSAP-Standard-License.txt',
    'desktop/public/licenses/dependencies.txt': 'dependencies.txt',
    'desktop/public/licenses/dependency-inventory.json': 'dependency-inventory.json',
    'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
    'desktop/public/fonts/OFL.txt': 'Pretendard-OFL.txt',
    'desktop/public/licenses/vscode-pets-MIT.txt': 'vscode-pets-MIT.txt',
    'desktop/public/licenses/gopher-CC0.txt': 'gopher-CC0.txt',
    'desktop/public/licenses/GSAP-NOTICE.txt': 'GSAP-NOTICE.txt',
    'desktop/public/licenses/x11rb-MIT.txt': 'x11rb-MIT.txt',
    'desktop/public/licenses/x11rb-protocol-MIT.txt': 'x11rb-protocol-MIT.txt',
    'desktop/public/licenses/gethostname-Apache-2.0.txt': 'gethostname-Apache-2.0.txt',
    'desktop/public/licenses/gdkx11-MIT.txt': 'gdkx11-MIT.txt',
    'desktop/public/licenses/glib-MIT.txt': 'glib-MIT.txt',
    'desktop/public/licenses/glib-COPYRIGHT.txt': 'glib-COPYRIGHT.txt',
    'docs/character-assets.md': 'character-assets.md',
}


# 공개 고지의 누락을 확인하고 요청한 경우 원문을 그대로 복사한다.
def prepare(output: Path | None = None) -> None:
    # 1. 잠금 파일과 생성 고지의 일치 여부를 확인한다.
    from dependency_notices import check
    check()

    # 2. 라이선스와 출처 파일을 확인한다.
    for source in FILES:
        if not (ROOT / source).is_file():
            raise SystemExit('배포 고지가 없습니다: ' + source)

    if (ROOT / 'desktop/src/assets/licenses/vscode-pets-MIT.txt').read_bytes() != (ROOT / 'desktop/public/licenses/vscode-pets-MIT.txt').read_bytes():
        raise SystemExit('앱 표시용 MIT 고지와 배포 원문이 일치하지 않습니다.')

    # 3. 배포 고지만 복사하고 로컬 설정이나 인증 파일은 읽지 않는다.
    if output is not None:
        output.mkdir(parents=True, exist_ok=True)
        for source, target in FILES.items():
            shutil.copyfile(ROOT / source, output / target)
        shutil.copytree(ROOT / 'desktop/public/licenses/sources', output / 'sources', dirs_exist_ok=True)


# CI 확인 또는 배포 고지 수집을 실행한다.
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    prepare(None if args.check else args.output)
    print('Verified distribution notices.')


if __name__ == '__main__':
    main()
