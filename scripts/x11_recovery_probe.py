#!/usr/bin/env python3
"""지정한 테스트 펫 창을 화면 밖으로 옮겨 작업영역 복구를 기록한다."""

import argparse
import json
import os
import subprocess
import time

XDO = os.environ.get("OURPETS_XDOTOOL", "xdotool")


# 지정한 테스트 창의 실제 물리 좌표와 크기를 조회한다.
def geometry(window):
    output = subprocess.check_output([XDO, "getwindowgeometry", "--shell", window], text=True)
    return {key: int(value) for key, value in (line.split("=", 1) for line in output.splitlines())}


# 지정한 창만 화면 밖으로 옮긴 뒤 복구 여부를 기록하고 원위치로 돌린다.
def main():
    # 1. 호출자가 준비한 테스트 창과 실제 작업영역만 사용한다.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--window", required=True)
    parser.add_argument("--workarea", nargs=4, type=int, required=True, metavar=("X", "Y", "WIDTH", "HEIGHT"))
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--seconds", type=float, default=4)
    args = parser.parse_args()
    initial = geometry(args.window)
    left, top, width, height = args.workarea
    samples = []

    # 2. 창을 이동하고 실제 위치를 주기적으로 읽되 실패해도 원래 위치로 복원한다.
    try:
        subprocess.run([XDO, "windowmove", args.window, str(left + width + 1000), str(top + height + 1000)], check=True)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            samples.append(geometry(args.window))
            time.sleep(0.25)
    finally:
        subprocess.run([XDO, "windowmove", args.window, str(initial["X"]), str(initial["Y"])], check=True)

    # 3. 수집한 좌표와 작업영역을 저장하고 마지막 창 전체가 영역에 들어왔는지 검증한다.
    with open(args.evidence, "w", encoding="utf-8") as destination:
        json.dump({"label": args.label, "workarea": args.workarea, "initial": initial, "samples": samples}, destination, ensure_ascii=False)
    last = samples[-1]
    inside = left <= last["X"] and top <= last["Y"] and last["X"] + last["WIDTH"] <= left + width and last["Y"] + last["HEIGHT"] <= top + height
    print(json.dumps({"label": args.label, "recovered": inside, "evidence": args.evidence}, ensure_ascii=False))
    if not inside:
        raise SystemExit("테스트 창이 작업영역 안으로 복구되지 않았습니다.")


if __name__ == "__main__":
    main()
