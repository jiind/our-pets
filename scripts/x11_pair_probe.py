#!/usr/bin/env python3
"""별도로 상호작용을 발생시키는 동안 수신 펫 고정과 발신 펫 접근·복귀 좌표를 기록한다."""

import argparse
import json
import os
import subprocess
import time

XDO = os.environ.get("OURPETS_XDOTOOL", "xdotool")


# 지정한 창의 물리 좌표와 크기를 조회한다.
def geometry(window):
    output = subprocess.check_output([XDO, "getwindowgeometry", "--shell", window], text=True)
    return {key: int(value) for key, value in (line.split("=", 1) for line in output.splitlines())}


# 명시한 두 테스트 창의 인사·하이파이브 접근과 복귀를 실제 좌표로 검증한다.
def main():
    # 1. 실행 중인 실제 사용자 창을 임의로 고르지 않고 전용 창과 동작을 입력받는다.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence")
    parser.add_argument("--anchor-window", required=True)
    parser.add_argument("--guest-window", required=True)
    parser.add_argument("--action", choices=["wave", "highfive"], required=True)
    parser.add_argument("--trigger-file", required=True)
    args = parser.parse_args()
    windows = [args.anchor_window, args.guest_window]
    with open(args.trigger_file, encoding="utf-8") as source:
        command = json.load(source)
    if not isinstance(command, list) or not command or not all(isinstance(value, str) for value in command):
        parser.error("트리거 파일은 별도 테스트 UI 조작 명령의 문자열 배열이어야 합니다.")
    initial = [geometry(window) for window in windows]
    trigger = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    # 2. 고정된 화면 중앙 좌표 대신 실제 시작 위치와 창 사이 거리 변화를 기록한다.
    start = time.monotonic()
    samples = []
    while time.monotonic() - start < 5:
        samples.append({"ms": round((time.monotonic() - start) * 1000), "windows": [geometry(window) for window in windows]})
        time.sleep(0.04)
    output, _ = trigger.communicate(timeout=10)
    if trigger.returncode:
        raise AssertionError("상호작용 UI 트리거 실패: " + output)
    with open(args.evidence, "w", encoding="utf-8") as destination:
        json.dump({"action": args.action, "initial": initial, "samples": samples}, destination, ensure_ascii=False)

    # 3. 두 동작 모두 수신 펫은 고정되고 발신 펫만 접근·복귀해야 한다.
    distances = [max(abs(sample["windows"][index]["X"] - initial[index]["X"]) for sample in samples) for index in range(2)]
    initial_gap = abs(initial[0]["X"] - initial[1]["X"])
    minimum_gap = min(abs(sample["windows"][0]["X"] - sample["windows"][1]["X"]) for sample in samples)
    assert minimum_gap < initial_gap - 10, "두 펫이 가까워지지 않았습니다"
    assert distances[0] <= 6 and distances[1] > 10, "수신 펫 고정·발신 펫 접근 계약이 맞지 않습니다"
    returned = any(sample["ms"] >= 2900 and all(abs(sample["windows"][index]["X"] - initial[index]["X"]) <= 6 for index in range(2)) for sample in samples)
    assert returned, "접근 후 시작 위치로 복귀하지 않았습니다"
    print(json.dumps({"action": args.action, "anchorMovement": distances[0], "guestMovement": distances[1], "returned": True, "evidence": args.evidence}))


if __name__ == "__main__":
    main()
