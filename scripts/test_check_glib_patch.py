"""GLib 보안 검사기가 실제 소스·명세 변조와 레지스트리 회귀를 거부하는지 확인한다."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import check_glib_patch


class GlibPatchChecks(unittest.TestCase):
    # 실제 스냅샷을 임시 저장소에 복사해 원본 작업 트리와 분리한다.
    def setUp(self):
        # 1. 검사 대상 원본과 라이선스만 테스트 전용 경로에 복사한다.
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for relative in ['desktop/src-tauri/vendor', 'desktop/public/licenses']:
            shutil.copytree(check_glib_patch.ROOT / relative, self.root / relative)
        for relative in ['desktop/src-tauri/Cargo.toml', 'desktop/src-tauri/Cargo.lock']:
            shutil.copyfile(check_glib_patch.ROOT / relative, self.root / relative)

        # 2. 검사기가 임시 복사본에만 접근하도록 루트를 교체한다.
        self.root_patch = patch.object(check_glib_patch, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.vendor = self.root / 'desktop/src-tauri/vendor/glib-0.18.5'

    # 검증된 원본과 공식 백포트 조합은 허용한다.
    def test_verified_snapshot_passes(self):
        with contextlib.redirect_stdout(io.StringIO()):
            check_glib_patch.check()

    # 소스와 파일별 해시를 함께 바꿔도 고정된 원본 명세 검증을 우회하지 못한다.
    def test_modified_source_and_manifest_fail(self):
        # 1. 보안 수정을 되돌리고 명세의 파일별 체크섬도 맞춰 변조한다.
        source = self.vendor / 'src/variant_iter.rs'
        source.write_text(source.read_text().replace('&mut p,', '&p,'))
        manifest_path = self.vendor / 'UPSTREAM-SHA256.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['patchedSha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))

        # 2. 파일 목록 자체의 신뢰 기준이 바뀌면 즉시 거부한다.
        with self.assertRaisesRegex(SystemExit, '원본 파일 목록'):
            check_glib_patch.check()

    # 원본에 없던 빌드 스크립트가 자동 실행 경로로 들어오지 못하게 한다.
    def test_unexpected_build_script_fails(self):
        (self.vendor / 'build.rs').write_text('fn main() {\n}\n')
        with self.assertRaisesRegex(SystemExit, '추가되거나 누락'):
            check_glib_patch.check()

    # 취약한 레지스트리 소스가 잠금 파일에 복귀하면 실패한다.
    def test_registry_dependency_regression_fails(self):
        lock = self.root / 'desktop/src-tauri/Cargo.lock'
        lock.write_text(lock.read_text().replace('name = "glib"\nversion = "0.18.5"', 'name = "glib"\nversion = "0.18.5"\nsource = "registry+https://github.com/rust-lang/crates.io-index"'))
        with self.assertRaisesRegex(SystemExit, '잠금 파일'):
            check_glib_patch.check()


if __name__ == '__main__':
    unittest.main()
