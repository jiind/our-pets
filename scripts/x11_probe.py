#!/usr/bin/env python3
"""격리 계정의 기본 고양이 창에서 현재 크기의 입력·포커스 경계를 검증한다."""

import argparse
import json
import os
import subprocess
import sys
import time
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk

XDO = os.environ.get("OURPETS_XDOTOOL", "xdotool")


# X11 도구 한 명령을 실행하고 문자열 출력만 반환한다.
def command(*args):
    return subprocess.check_output([XDO, *map(str, args)], text=True).strip()


# GTK 이벤트를 처리하면서 조건이 충족될 때까지 제한적으로 기다린다.
def wait_for(condition, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while Gtk.events_pending():
            Gtk.main_iteration_do(False)
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError("X11 검증 조건 시간 초과")


# 창 위치와 크기를 정수 좌표로 읽는다.
def geometry(window):
    data = command("getwindowgeometry", "--shell", window)
    return {key: int(value) for key, value in (line.split("=", 1) for line in data.splitlines())}


# 펫 주변의 빈 영역과 펫 자체가 서로 다른 창으로 입력되는지 확인한다.
def main():
    # 1. 검증 창을 펫 뒤에 두고 키보드 입력과 빈 영역 클릭을 계수한다.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", nargs="?")
    parser.add_argument("--pet-window", required=True)
    parser.add_argument("--pet-size", type=int, default=160)
    args = parser.parse_args()
    if args.pet_size < 80 or args.pet_size > 240:
        parser.error("펫 크기는 현재 앱과 같은 80~240 범위여야 합니다.")
    pet = args.pet_window
    probe = Gtk.Window(title="Our Pets input probe")
    monitor = Gdk.Display.get_default().get_primary_monitor() or Gdk.Display.get_default().get_monitor(0)
    work = monitor.get_workarea()
    probe.set_decorated(False)
    probe.set_default_size(work.width, work.height)
    probe.move(work.x, work.y)
    fixed = Gtk.Fixed()
    entry = Gtk.Entry()
    entry.set_size_request(500, 60)
    fixed.put(entry, 20, 20)
    button = Gtk.Button(label="Behind transparent pet space")
    button.set_size_request(work.width, work.height - 90)
    fixed.put(button, 0, 90)
    clicked = []
    button.connect("clicked", lambda *_: clicked.append(True))
    probe.add(fixed)
    probe.show_all()
    probe.present()
    wait_for(lambda: probe.get_window() is not None)
    command("mousemove", work.x + 60, work.y + 50)
    command("click", 1)
    entry.grab_focus()

    # 2. 그림 밖의 좌표를 눌러 뒤쪽 버튼에 입력이 도달하는지 검증한다.
    g = geometry(pet)
    command("mousemove", g["X"] + 10, g["Y"] + 100)
    command("click", 1)
    wait_for(lambda: len(clicked) == 1)
    command("mousemove", work.x + 60, work.y + 50)
    command("click", 1)
    focus_before = command("getwindowfocus")

    # 3. 펫 그림을 클릭해도 뒤쪽 버튼에는 전달되지 않고 키보드 포커스는 유지된다.
    g = geometry(pet)
    command("mousemove", g["X"] + g["WIDTH"] // 2, g["Y"] + g["HEIGHT"] - 30 - args.pet_size // 2)
    command("click", 1)
    wait_for(lambda: command("getwindowfocus") == focus_before)
    command("type", "typing-kept")
    wait_for(lambda: entry.get_text() == "typing-kept")
    assert len(clicked) == 1, "펫 클릭이 뒤쪽 프로그램에 전달됨"
    print(json.dumps({"emptyClickThrough": True, "petClickable": True, "keyboardFocusKept": True, "petWindow": pet}))
    if args.evidence:
        root = Gdk.get_default_root_window()
        Gdk.pixbuf_get_from_window(root, 0, 0, root.get_width(), root.get_height()).savev(args.evidence, "png", [], [])
    probe.destroy()


if __name__ == "__main__":
    main()
