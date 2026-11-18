package main

import "testing"

// 앱을 다시 열어도 이전 초대 링크의 가입 코드가 유효한지 확인한다.
func TestDesktopInvitePersists(t *testing.T) {
	directory := t.TempDir()
	first, err := desktopInvite(directory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := desktopInvite(directory)
	if err != nil {
		t.Fatal(err)
	}
	other, err := desktopInvite(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 48 || first != second || first == other {
		t.Fatal("expected a persistent, room-specific registration code")
	}
}
