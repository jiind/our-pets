"""의존성 변경·원문 누락·미검토 조건을 배포 성공으로 간주하지 않는지 검증한다."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import dependency_notices as notices


class DependencyNoticesTests(unittest.TestCase):
    # 현재 고지는 실제 잠금 파일과 원문·MPL 소스 지문을 모두 통과해야 한다.
    def test_current_inventory_is_complete(self) -> None:
        notices.check()

    # 기존 허용 조건에 없는 라이선스는 수동 검토 없이 허용하지 않는다.
    def test_unknown_license_requires_review(self) -> None:
        with self.assertRaisesRegex(SystemExit, '검토되지 않은'):
            notices.validate_expression('AGPL-3.0-only')

    # 고지 내용을 바꾸고 원문 지문을 갱신하지 않으면 검사에 실패한다.
    def test_notice_tampering_fails(self) -> None:
        manifest = json.loads(notices.MANIFEST.read_text())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / 'inventory.json'
            path.write_text(json.dumps(manifest))
            with patch.object(notices, 'OUTPUT', root), patch.object(notices, 'MANIFEST', path):
                with self.assertRaisesRegex(SystemExit, '지문 불일치'):
                    notices.check()

    # 잠금 파일과 비교해 패키지 행을 누락시킨 목록은 원문이 있어도 거부한다.
    def test_missing_package_fails(self) -> None:
        manifest = json.loads(notices.MANIFEST.read_text())
        manifest['packages'] = [p for p in manifest['packages'] if p['name'] != 'tauri']
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'inventory.json'
            path.write_text(json.dumps(manifest))
            with patch.object(notices, 'MANIFEST', path):
                with self.assertRaisesRegex(SystemExit, '전체 의존성'):
                    notices.check()


if __name__ == '__main__':
    unittest.main()
