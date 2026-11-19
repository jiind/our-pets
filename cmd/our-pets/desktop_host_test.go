package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/server"
)

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

// 공유를 닫으면 접속한 친구의 소켓이 끊기고 개인 서버는 계속 응답한다.
func TestCloseDesktopLANKeepsLocalServer(t *testing.T) {
	directory := t.TempDir()
	db, err := database.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := server.New(t.Context(), db, server.Config{
		Directory:    directory,
		Invite:       "test-only-invite",
		AllowedCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")},
	})
	local := httptest.NewServer(app.Handler())
	defer local.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lan := serveDesktopLAN(listener, app.Handler())
	defer lan.close()
	login, err := desktopSession(app, desktopRequest{DisplayName: "내 펫"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	guest, _, err := websocket.Dial(ctx, "ws://"+listener.Addr().String()+"/api/v1/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer guest.CloseNow()
	auth, err := json.Marshal(map[string]string{"type": "auth", "token": login.Token})
	if err != nil {
		t.Fatal(err)
	}
	if err := guest.Write(ctx, websocket.MessageText, auth); err != nil {
		t.Fatal(err)
	}
	if _, _, err := guest.Read(ctx); err != nil {
		t.Fatal(err)
	}

	lan.close()
	for {
		if _, _, err := guest.Read(ctx); err != nil {
			if ctx.Err() != nil {
				t.Fatal("the LAN WebSocket did not close")
			}
			break
		}
	}
	resp, err := local.Client().Get(local.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("local server responded with %d", resp.StatusCode)
	}
}

// 계정 입력 없이 펫을 시작하고 다음 실행에서 같은 펫과 기기를 되살린다.
func TestDesktopSessionRestoresPet(t *testing.T) {
	for _, key := range []string{"OURPETS_BIND", "OURPETS_DATA", "OURPETS_INVITE", "OURPETS_ALLOWED_CIDRS"} {
		t.Setenv(key, "")
	}
	directory := t.TempDir()
	host, err := desktopConfig(directory)
	if err != nil {
		t.Fatal(err)
	}
	if host.URL != "" || host.Invite != "" {
		t.Fatal("private startup exposed an invitation")
	}
	config, err := server.ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if config.Bind != "127.0.0.1:19378" || len(config.AllowedCIDRs) != 1 || config.AllowedCIDRs[0].String() != "127.0.0.0/8" {
		t.Fatal("private startup did not bind to loopback")
	}
	db, err := database.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := server.New(t.Context(), db, config)

	first, err := desktopSession(app, desktopRequest{DisplayName: "내 펫"})
	if err != nil || !first.Principal.PetRegistered {
		t.Fatalf("local pet was not registered: %v", err)
	}
	again, err := desktopSession(app, desktopRequest{DisplayName: "My pet", DeviceID: first.Principal.DeviceID})
	if err != nil || again.Principal.PetID != first.Principal.PetID || again.Principal.DeviceID != first.Principal.DeviceID {
		t.Fatalf("local pet or device changed: %v", err)
	}
	pet, err := app.Pets.Current(again.Principal)
	if err != nil || pet.Name != "내 펫" || pet.BuiltinID != "cat" {
		t.Fatalf("unexpected restored pet: %+v %v", pet, err)
	}
	secret, err := desktopSecret(directory, "local-account")
	if err != nil || secret == config.Invite {
		t.Fatal("private credential and invitation must be distinct")
	}
}
