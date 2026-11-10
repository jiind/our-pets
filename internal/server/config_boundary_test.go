package server_test

import (
	"net/http"
	"testing"

	"github.com/jiind/our-pets/internal/connectors"
	"github.com/jiind/our-pets/internal/messaging"
)

// TestSampleOptInHTTPBoundary는 기본 비활성 서버와 명시 활성 서버의 샘플 경계를 검증한다.
func TestSampleOptInHTTPBoundary(t *testing.T) {
	// 1. 샘플 비활성 서버에서도 일반 상태 확인, 인증, 메시지 경로가 동작하는지 확인한다.
	f := setupWithSample(t, false)
	response, err := http.Get(f.http.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status=%d", response.StatusCode)
	}
	a, b := f.user("optin-a"), f.user("optin-b")
	_, _ = f.socket(b, false)
	accepted := f.send(a, "selected", "text", "sample stays opt-in", "optin-msg-key", b)
	if events := f.pending(b); len(events) != 1 || events[0].ID != accepted.ID {
		t.Fatal("비활성 샘플이 일반 메시지 전달에 영향을 줌")
	}
	var listed struct {
		Enabled     bool                    `json:"enabled"`
		Connections []connectors.Connection `json:"connections"`
	}
	f.request("GET", "/connectors", a, nil, 200, &listed)
	if listed.Enabled || len(listed.Connections) != 0 {
		t.Fatal("기본 비활성 상태가 API에 반영되지 않음")
	}
	f.request("POST", "/connectors", a, map[string]any{"kind": "sample", "config": map[string]any{}}, 400, nil)
}

// TestSampleExplicitActivation은 명시 활성화 후 소유자 구독과 수동 전송만 허용하는지 확인한다.
func TestSampleExplicitActivation(t *testing.T) {
	// 1. 격리 fixture의 실제 서버 경로에서 활성화와 펫별 수신을 확인한다.
	f := setupWithSample(t, true)
	a, b := f.user("active-a"), f.user("active-b")
	_, _ = f.socket(b, false)
	var conn connectors.Connection
	f.request("POST", "/connectors", b, map[string]any{"kind": "sample", "config": map[string]any{}}, 201, &conn)
	f.request("POST", "/connectors/"+conn.ID+"/test-events", b, map[string]string{"idempotencyKey": "explicit-key-1"}, 202, nil)
	pending := f.pending(b)
	if len(pending) != 1 || pending[0].Type != "notification" {
		t.Fatal("명시 요청 샘플이 연결 소유 펫에 전달되지 않음")
	}
	var listed struct {
		Enabled     bool                    `json:"enabled"`
		Connections []connectors.Connection `json:"connections"`
	}
	f.request("GET", "/connectors", a, nil, 200, &listed)
	if !listed.Enabled || len(listed.Connections) != 0 {
		t.Fatal("다른 사용자의 샘플 구독이 노출됨")
	}
	f.request("POST", "/messages", a, messaging.Send{SenderPetID: a.Principal.PetID, Mode: "selected", Kind: "text", Body: "normal", PetIDs: []string{b.Principal.PetID}, IdempotencyKey: "active-msg-key"}, 201, nil)
	if events := f.pending(a); len(events) != 0 {
		for _, event := range events {
			if event.Type == "notification" {
				t.Fatal("샘플 구독이 소유자 외 펫으로 확장됨")
			}
		}
	}
}
