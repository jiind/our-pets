#!/usr/bin/env python3
"""격리된 X11 화면에서 실제 창 합성 결과를 PNG로 기록한다."""

import sys
import os
import gi

if len(sys.argv) > 2:
    os.environ["DISPLAY"] = sys.argv[2]

gi.require_version("Gdk", "3.0")
from gi.repository import Gdk


# 지정한 X11 루트 화면의 현재 픽셀을 저장한다.
def main():
    root = Gdk.get_default_root_window()
    if root is None:
        raise SystemExit("DISPLAY에 접근할 수 없습니다")
    pixels = Gdk.pixbuf_get_from_window(root, 0, 0, root.get_width(), root.get_height())
    pixels.savev(sys.argv[1], "png", [], [])


if __name__ == "__main__":
    main()
