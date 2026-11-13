"""배포 파일명과 체크섬이 GitHub 업로드 전후에도 일치하는지 확인한다."""
import hashlib
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import package_release


class DesktopPackageTests(unittest.TestCase):
    # 실제 소스와 분리된 산출물·고지·버전 경계를 준비한다.
    def setUp(self) -> None:
        # 1. 테스트마다 독립적인 임시 저장소를 만든다.
        temporary = tempfile.TemporaryDirectory(prefix='our-pets-package-test-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'release-out'

        # 2. 버전과 고지만 고정하고 실제 파일 복사·체크섬 코드는 사용한다.
        for name, value in [('ROOT', self.root), ('OUTPUT', self.output), ('check_versions', lambda: '1.2.3-beta.1'), ('prepare', self.prepare_notices), ('collect_linux_sources', self.collect_linux_sources)]:
            replacement = patch.object(package_release, name, value)
            replacement.start()
            self.addCleanup(replacement.stop)

    # 임시 패키지에 들어갈 고지 파일 하나를 준비한다.
    def prepare_notices(self, output: Path) -> None:
        output.mkdir(parents=True, exist_ok=True)
        (output / 'NOTICE.txt').write_text('Packaging test notice\n')

    # 네이티브 소스 수집 경계를 고정해 패키징 검사는 네트워크에 의존하지 않는다.
    def collect_linux_sources(self, appimage: Path, output: Path) -> None:
        self.assertEqual(appimage.suffix, '.AppImage')
        output.write_bytes(b'native source fixture')

    # Tauri가 만드는 공백 포함 원본 파일명을 재현한다.
    def create_bundle(self, platform: str, suffix: str, name: str = 'Our Pets') -> None:
        # 1. 대상별 Tauri 번들 디렉터리를 선택한다.
        target = self.root / 'desktop/src-tauri/target'
        bundle = target / ('universal-apple-darwin/release/bundle' if platform == 'macos-universal' else 'release/bundle')
        directory = bundle / platform
        directory.mkdir(parents=True, exist_ok=True)

        # 2. 원본 이름은 유지한 채 식별 가능한 설치 파일을 기록한다.
        (directory / (name + suffix)).write_bytes(b'installer fixture')

    # 세 OS의 설치 파일이 안전한 공개 이름으로 복사되는지 확인한다.
    def test_all_platforms_use_canonical_names(self) -> None:
        for platform, suffixes in [('linux-x64', ['.deb', '.AppImage']), ('windows-x64', ['.exe']), ('macos-universal', ['.dmg'])]:
            with self.subTest(platform=platform):
                # 1. 플랫폼별 원본을 만들고 실제 수집기를 실행한다.
                for suffix in suffixes:
                    self.create_bundle(platform, suffix)
                package_release.package_desktop(platform)

                # 2. 파일명과 내용이 배포 계약에 맞는지 확인한다.
                for suffix in suffixes:
                    file = self.output / f'our-pets-desktop-1.2.3-beta.1-{platform}{suffix}'
                    self.assertEqual(file.read_bytes(), b'installer fixture')

    # 같은 종류의 오래된 번들이 섞이면 배포를 거부하는지 확인한다.
    def test_duplicate_bundle_types_are_rejected(self) -> None:
        # 1. 두 DEB와 AppImage 하나를 만들어 모호한 입력을 구성한다.
        self.create_bundle('linux-x64', '.deb', 'Old Pet')
        self.create_bundle('linux-x64', '.deb', 'New Pet')
        self.create_bundle('linux-x64', '.AppImage')

        # 2. 수집 결과를 생성하기 전에 실패해야 한다.
        with self.assertRaisesRegex(SystemExit, 'exactly one'):
            package_release.package_desktop('linux-x64')
        self.assertFalse(self.output.exists())

    # 체크섬 목록의 이름과 실제 배포 파일이 일대일로 대응하는지 확인한다.
    def test_checksums_reference_exact_public_filenames(self) -> None:
        # 1. 공백 포함 원본에서 배포 파일과 체크섬을 생성한다.
        for suffix in ['.deb', '.AppImage']:
            self.create_bundle('linux-x64', suffix)
        package_release.package_desktop('linux-x64')
        package_release.release_notes()

        # 2. 각 이름이 그대로 업로드 가능하며 내용 지문과 일치해야 한다.
        entries = (self.output / 'SHA256SUMS.txt').read_text().splitlines()
        self.assertEqual(len(entries), 4)
        for entry in entries:
            digest, name = entry.split('  ', 1)
            self.assertIsNotNone(re.fullmatch(r'[A-Za-z0-9._-]+', name))
            self.assertEqual(digest, hashlib.sha256((self.output / name).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
