"""네이티브 출처를 파일명만으로 추정하지 않고 대응 소스 누락을 차단하는지 검사한다."""
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
import unittest
from unittest.mock import patch

import linux_distribution_sources as native


class NativeSourcesTests(unittest.TestCase):
    # 같은 SONAME이라도 빌드 ID가 다른 라이브러리는 배포 출처로 인정하지 않는다.
    def test_mismatched_binary_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'libtest.so.1'
            file.write_bytes(b'library')
            found = CompletedProcess([], 0, stdout=f'libtest: {file}\n')
            with patch.object(native.subprocess, 'run', return_value=found), patch.object(native, 'build_id', side_effect=['original-build', 'different-build']):
                with self.assertRaisesRegex(SystemExit, '빌드 ID'):
                    native.owners(file)

    # 원본과 빌드 ID가 일치하는 패키지만 소스 수집 대상으로 반환한다.
    def test_matching_binary_identifies_package(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'libtest.so.1'
            file.write_bytes(b'library')
            found = CompletedProcess([], 0, stdout=f'libtest:amd64: {file}\n')
            with patch.object(native.subprocess, 'run', return_value=found), patch.object(native, 'build_id', return_value='same-build'):
                self.assertEqual(native.owners(file), ['libtest:amd64'])

    # 출처를 알 수 없는 AppImage 런타임은 대응 소스 제공을 완료한 것으로 간주하지 않는다.
    def test_unknown_runtime_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'unknown.AppImage'
            file.write_bytes(b'unknown runtime')
            with self.assertRaisesRegex(SystemExit, '정확한 소스 커밋'):
                native.runtime_sources(file, Path(directory))


if __name__ == '__main__':
    unittest.main()
