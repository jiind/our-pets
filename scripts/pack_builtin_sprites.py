"""허가된 원본 GIF 프레임을 그림 변경 없이 로컬 PNG 아틀라스로 묶는다."""

import json
from pathlib import Path
from PIL import Image, ImageSequence


# 원본 GIF의 합성된 전체 프레임을 동일한 셀에 순서대로 보존한다.
def pack_ferris(root: Path) -> None:
    # 1. 각 동작의 모든 프레임을 해독하고 색상·투명도를 유지한다.
    frames = []
    actions = {}
    for action in ("idle", "walk", "swipe"):
        with Image.open(root / f"{action}.gif") as image:
            start = len(frames)
            frames.extend(frame.convert("RGBA").copy() for frame in ImageSequence.Iterator(image))
            actions[action] = list(range(start, len(frames)))
    width, height = frames[0].size
    if any(frame.size != (width, height) for frame in frames):
        raise ValueError("페리스 프레임 크기가 일치하지 않습니다")

    # 2. 픽셀 크기 변경 없이 프레임만 배치하고 대응 정보를 기록한다.
    columns = 8
    sheet = Image.new("RGBA", (columns * width, ((len(frames) + columns - 1) // columns) * height))
    for index, frame in enumerate(frames):
        sheet.paste(frame, ((index % columns) * width, (index // columns) * height))
    sheet.save(root / "sheet.png")
    (root / "frames.json").write_text(json.dumps({"width": width, "height": height, "actions": actions}, indent=2) + "\n")


if __name__ == "__main__":
    pack_ferris(Path(__file__).resolve().parents[1] / "desktop/src/assets/builtin/ferris")
