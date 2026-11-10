package server_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jiind/our-pets/internal/connectors"
	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/messaging"
	"github.com/jiind/our-pets/internal/model"
	"github.com/jiind/our-pets/internal/server"
)

const invite = "test-only-invite"
const password = "test-password-123"

type fixture struct {
	t    *testing.T
	app  *server.Server
	db   *sql.DB
	http *httptest.Server
	ctx  context.Context
}

// setup은 실제 SQLite와 HTTP·WebSocket 경로를 사용하는 격리 서버를 만든다.
func setup(t *testing.T) *fixture {
	return setupWithSample(t, true)
}

// setupWithSample은 샘플 활성화 설정을 서버 생성 시점에 주입한 격리 서버를 만든다.
func setupWithSample(t *testing.T, sampleEnabled bool) *fixture {
	// 1. 테스트별 저장소와 내부망 설정을 구성한다.
	t.Helper()
	directory := t.TempDir()
	db, err := database.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	app := server.New(ctx, db, server.Config{Directory: directory, Invite: invite, MessageTTL: 7 * 24 * time.Hour, Retention: 30 * 24 * time.Hour, SampleEnabled: sampleEnabled, AllowedCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}, Origins: []string{"http://127.0.0.1:1420"}})
	httpServer := httptest.NewServer(app.Handler())
	f := &fixture{t: t, db: db, app: app, http: httpServer, ctx: ctx}

	// 2. 연결이 먼저 종료된 뒤 서버와 DB를 정리한다.
	t.Cleanup(func() {
		cancel()
		httpServer.Close()
		db.Close()
	})
	return f
}

// request는 실제 HTTP API에 JSON을 보내 상태와 응답을 검증한다.
func (f *fixture) request(method, path string, login identity.Login, body any, want int, out any) {
	f.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, f.http.URL+"/api/v1"+path, reader)
	if err != nil {
		f.t.Fatal(err)
	}
	if login.Token != "" {
		req.Header.Set("Authorization", "Bearer "+login.Token)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		raw, _ := io.ReadAll(response.Body)
		f.t.Fatalf("%s %s: status=%d want=%d body=%s", method, path, response.StatusCode, want, raw)
	}
	if out != nil {
		if err = json.NewDecoder(response.Body).Decode(out); err != nil {
			f.t.Fatal(err)
		}
	}
}

// user는 계정 생성과 대표 펫 등록을 실제 HTTP 경로로 완료한다.
func (f *fixture) user(name string) identity.Login {
	// 1. 실제 계정을 생성한다.
	f.t.Helper()
	var login identity.Login
	f.request("POST", "/register", identity.Login{}, identity.Credentials{Username: name, Password: password, DisplayName: name, PetName: name + "-pet", Invite: invite}, 201, &login)

	// 2. 별도 펫 등록을 완료한 세션을 테스트에 전달한다.
	f.request("POST", "/me/pet/registration", login, map[string]string{"name": name + "-pet", "designId": "default"}, 200, nil)
	return login
}

// send는 접수된 메시지와 고정 수신 대상을 반환한다.
func (f *fixture) send(from identity.Login, mode, kind, body, key string, to ...identity.Login) messaging.Accepted {
	f.t.Helper()
	ids := []string{}
	for _, user := range to {
		ids = append(ids, user.Principal.PetID)
	}
	var accepted messaging.Accepted
	f.request("POST", "/messages", from, messaging.Send{SenderPetID: from.Principal.PetID, Mode: mode, Kind: kind, Body: body, PetIDs: ids, IdempotencyKey: key}, 201, &accepted)
	return accepted
}

// pending은 현재 기기만 조회할 수 있는 미수신 이벤트를 반환한다.
func (f *fixture) pending(login identity.Login) []model.Event {
	f.t.Helper()
	var result []model.Event
	f.request("GET", "/inbox", login, nil, 200, &result)
	return result
}

// socket은 첫 프레임 토큰 인증을 수행하고 앱 수신 이벤트를 확인 채널에 전달한다.
func (f *fixture) socket(login identity.Login, ack bool) (*websocket.Conn, <-chan model.Event) {
	// 1. 실제 WebSocket 핸드셰이크와 인증 완료 프레임을 확인한다.
	f.t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(f.http.URL, "http", "ws", 1)+"/api/v1/ws", nil)
	if err != nil {
		f.t.Fatal(err)
	}
	auth, _ := json.Marshal(map[string]string{"type": "auth", "token": login.Token})
	if err = conn.Write(ctx, websocket.MessageText, auth); err != nil {
		f.t.Fatal(err)
	}
	if _, _, err = conn.Read(ctx); err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(func() { conn.CloseNow() })
	events := make(chan model.Event, 100)

	// 2. 클라이언트처럼 선택적으로 수신 확인하고 테스트 종료 때 읽기를 마친다.
	go func() {
		defer close(events)
		for {
			_, data, readErr := conn.Read(f.ctx)
			if readErr != nil {
				return
			}
			var event model.Event
			if json.Unmarshal(data, &event) != nil {
				return
			}
			if event.Type != "message" && event.Type != "notification" {
				continue
			}
			if ack {
				raw, _ := json.Marshal(map[string]string{"type": "ack", "id": event.ID})
				if conn.Write(f.ctx, websocket.MessageText, raw) != nil {
					return
				}
			}
			events <- event
		}
	}()
	return conn, events
}

// receive는 수신 ID와 발신자·본문을 실제 소켓에서 검증한다.
func receive(t *testing.T, events <-chan model.Event, id, body string) {
	t.Helper()
	select {
	case event, ok := <-events:
		if !ok || event.ID != id || event.Body != body || event.Sender == nil {
			t.Fatalf("예상 메시지 불일치: %+v", event)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("메시지 수신 시간 초과")
	}
}

// TestFourPetsAndAllDevices는 네 명의 단일·복수·전체 수신과 다중 기기 전달을 검증한다.
func TestFourPetsAndAllDevices(t *testing.T) {
	// 1. 발신자와 선택된 두 수신자·비선택 수신자를 만들고 한 사용자는 두 기기로 연결한다.
	f := setup(t)
	alice, bob, carol, dave := f.user("alice"), f.user("bob"), f.user("carol"), f.user("dave")
	var bobSecond identity.Login
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "bob", Password: password}, 200, &bobSecond)
	if bobSecond.Principal.DeviceID == bob.Principal.DeviceID {
		t.Fatal("다른 기기가 같은 ID를 받음")
	}
	_, b1 := f.socket(bob, true)
	_, b2 := f.socket(bobSecond, true)
	_, c := f.socket(carol, true)
	_, d := f.socket(dave, true)

	// 2. 한 펫에 보내면 해당 펫의 모든 기기가 받고 나머지 펫에는 저장되지 않는다.
	single := f.send(alice, "selected", "text", "커피?", "single-key-001", bob)
	receive(t, b1, single.ID, "커피?")
	receive(t, b2, single.ID, "커피?")
	if len(f.pending(carol)) != 0 || len(f.pending(dave)) != 0 || len(f.pending(alice)) != 0 {
		t.Fatal("선택하지 않은 펫에 전달됨")
	}

	// 3. 기존 복수 ID·이모지 API의 호환 요청도 수신자를 정확히 격리한다.
	multi := f.send(alice, "selected", "emoji", "☕", "multi-key-001", bob, carol)
	receive(t, b1, multi.ID, "☕")
	receive(t, b2, multi.ID, "☕")
	receive(t, c, multi.ID, "☕")
	if len(f.pending(dave)) != 0 || len(multi.PetIDs) != 2 {
		t.Fatal("복수 수신 경계 위반")
	}

	// 4. 전체 대상은 발신자를 제외한 현재 세 펫으로 고정된다.
	all := f.send(alice, "all", "text", "점심?", "all-key-0001")
	receive(t, b1, all.ID, "점심?")
	receive(t, b2, all.ID, "점심?")
	receive(t, c, all.ID, "점심?")
	receive(t, d, all.ID, "점심?")
	late := f.user("later")
	if len(all.PetIDs) != 3 || len(f.pending(late)) != 0 || len(f.pending(alice)) != 0 {
		t.Fatal("전체 대상 스냅샷 경계 위반")
	}
	repeat := f.send(alice, "all", "text", "점심?", "all-key-0001")
	if repeat.ID != all.ID || len(repeat.PetIDs) != 3 {
		t.Fatal("재시도가 새 메시지 또는 새 수신자를 만듦")
	}
	select {
	case event := <-d:
		t.Fatalf("추가 메시지가 도착함: %+v", event)
	case <-time.After(600 * time.Millisecond):
	}
}

// TestRealtimeAuthorizationAndExpiry는 접속 중 전달·오프라인 미재생·권한·기기별 확인을 검증한다.
func TestRealtimeAuthorizationAndExpiry(t *testing.T) {
	// 1. 오프라인 발송을 거부하고 재접속 때 이전 연결의 미확인 메시지를 재생하지 않는다.
	f := setup(t)
	a, b, c, d := f.user("alice"), f.user("bob"), f.user("carol"), f.user("dave")
	f.request("POST", "/messages", a, messaging.Send{SenderPetID: a.Principal.PetID, Mode: "selected", Kind: "text", Body: "offline", IdempotencyKey: "offline-refused-1", PetIDs: []string{b.Principal.PetID}}, 409, nil)
	connection, unconfirmed := f.socket(b, false)
	offline := f.send(a, "selected", "text", "before reconnect", "offline-key1", b)
	receive(t, unconfirmed, offline.ID, "before reconnect")
	if _, err := f.db.Exec(`UPDATE messages SET created_at=? WHERE id=?`, time.Now().Add(-time.Second).UnixMilli(), offline.ID); err != nil {
		t.Fatal(err)
	}
	connection.CloseNow()
	_, first := f.socket(b, true)
	if len(f.pending(b)) != 0 {
		t.Fatal("접속 이전 메시지가 복구됨")
	}

	// 2. 두 기기는 새 메시지를 각각 받고 한 기기의 ACK가 다른 기기를 제거하지 않는다.
	var second identity.Login
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "bob", Password: password}, 200, &second)
	_, secondEvents := f.socket(second, false)
	live := f.send(a, "selected", "text", "live", "live-key-001", b)
	receive(t, first, live.ID, "live")
	receive(t, secondEvents, live.ID, "live")
	deadline := time.Now().Add(3 * time.Second)
	for len(f.pending(b)) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(f.pending(b)) != 0 || len(f.pending(second)) != 1 {
		t.Fatal("기기별 앱 수신 상태가 분리되지 않음")
	}

	// 3. 타인의 발신·조회·수신 확인과 같은 키의 다른 내용을 거부한다.
	f.request("POST", "/messages", b, messaging.Send{SenderPetID: a.Principal.PetID, Mode: "selected", Kind: "text", Body: "spoof", IdempotencyKey: "spoof-key", PetIDs: []string{d.Principal.PetID}}, 403, nil)
	f.request("GET", "/messages/"+offline.ID, d, nil, 404, nil)
	f.request("POST", "/inbox/"+offline.ID+"/ack", d, nil, 404, nil)
	f.request("POST", "/messages", a, messaging.Send{SenderPetID: a.Principal.PetID, Mode: "selected", Kind: "text", Body: "changed", IdempotencyKey: "offline-key1", PetIDs: []string{b.Principal.PetID, c.Principal.PetID}}, 409, nil)
	f.request("GET", "/inbox", identity.Login{}, nil, 401, nil)

	// 4. 미확인 상태여도 만료된 메시지는 현재 연결에서 다시 내보내지 않는다.
	if _, err := f.db.Exec(`UPDATE messages SET expires_at=? WHERE id=?`, time.Now().Add(-time.Minute).UnixMilli(), live.ID); err != nil {
		t.Fatal(err)
	}
	if len(f.pending(second)) != 0 {
		t.Fatal("만료된 메시지가 전달 대기 중임")
	}
}

// upload는 실제 multipart PNG 등록 경로를 검증한다.
func (f *fixture) upload(login identity.Login, data []byte, want int) model.Design {
	f.t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	_ = writer.WriteField("name", "직접 그린 펫")
	_ = writer.WriteField("manifest", `{"schemaVersion":1,"displaySize":160,"animations":{}}`)
	part, _ := writer.CreateFormFile("image", "custom.png")
	_, _ = part.Write(data)
	_ = writer.Close()
	req, _ := http.NewRequest("POST", f.http.URL+"/api/v1/designs", body)
	req.Header.Set("Authorization", "Bearer "+login.Token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != want {
		data, _ := io.ReadAll(response.Body)
		f.t.Fatalf("디자인 상태 %d, want %d: %s", response.StatusCode, want, data)
	}
	var d model.Design
	if want == 201 {
		if err = json.NewDecoder(response.Body).Decode(&d); err != nil {
			f.t.Fatal(err)
		}
	}
	return d
}

// TestDesignIdentityAndInteractions는 공유 외형·새 버전·상호작용의 수신자 독립성을 검증한다.
func TestDesignIdentityAndInteractions(t *testing.T) {
	// 1. 실제 투명 PNG를 올리고 서로 다른 사용자의 펫에 같은 디자인을 적용한다.
	f := setup(t)
	a, b, c := f.user("alice"), f.user("bob"), f.user("carol")
	bitmap := image.NewNRGBA(image.Rect(0, 0, 40, 40))
	bitmap.Set(20, 20, color.NRGBA{R: 200, G: 100, A: 255})
	raw := &bytes.Buffer{}
	_ = png.Encode(raw, bitmap)
	first := f.upload(a, raw.Bytes(), 201)
	f.request("PUT", "/me/pet/design", b, map[string]string{"designId": first.ID}, 200, nil)
	second := f.upload(a, raw.Bytes(), 201)
	var all []model.Pet
	f.request("GET", "/pets", a, nil, 200, &all)
	for _, pet := range all {
		if pet.ID == a.Principal.PetID && (pet.Design.ID != second.ID || pet.Design.Version != 2) {
			t.Fatal("새 버전이 기존 펫 관계를 훼손함")
		}
		if pet.ID == b.Principal.PetID && pet.Design.ID != first.ID {
			t.Fatal("다른 소유자의 디자인이 덮어써짐")
		}
	}

	// 2. 펫 사이 상호작용은 지정한 상대에게만 전달되고 안정적인 발신자 ID를 유지한다.
	_, _ = f.socket(b, false)
	interaction := f.send(a, "selected", "interaction", "highfive", "interact-key1", b)
	events := f.pending(b)
	if len(events) != 1 || events[0].ID != interaction.ID || events[0].Sender.PetID != a.Principal.PetID || len(f.pending(c)) != 0 {
		t.Fatal("펫 상호작용 수신자 불일치")
	}
	f.upload(a, []byte("pretend PNG"), 400)
	f.request("POST", "/messages", a, messaging.Send{SenderPetID: a.Principal.PetID, Mode: "all", Kind: "interaction", Body: "exec", IdempotencyKey: "invalid-interaction"}, 400, nil)
}

// TestConnectorIsolation는 수동 샘플의 소유권·멱등 발송·삭제와 장애 중 내부 메시지를 검증한다.
func TestConnectorIsolation(t *testing.T) {
	// 1. 실제 등록과 접속 후 두 샘플을 추가하되 생성 자체는 알림을 만들지 않는다.
	f := setup(t)
	a, b, c := f.user("alice"), f.user("bob"), f.user("carol")
	for _, login := range []identity.Login{a, b, c} {
		f.request("POST", "/me/pet/registration", login, map[string]any{"name": "pet", "designId": "default"}, 200, nil)
	}
	_, _ = f.socket(b, false)
	_, _ = f.socket(c, false)
	var good, bad connectors.Connection
	f.request("POST", "/connectors", b, map[string]any{"kind": "sample", "config": map[string]any{}}, 201, &good)
	f.request("POST", "/connectors", b, map[string]any{"kind": "sample", "config": map[string]any{"fail": true}}, 201, &bad)
	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM external_notifications`).Scan(&count); err != nil || count != 0 {
		t.Fatal("연결 추가가 알림을 생성함", err)
	}

	// 2. 소유자만 수동 발송하며 동일 요청 재시도는 한 건으로 유지한다.
	request := map[string]any{"idempotencyKey": "manual-sample-key"}
	f.request("POST", "/connectors/"+good.ID+"/test-events", a, request, 404, nil)
	f.request("DELETE", "/connectors/"+good.ID, a, nil, 404, nil)
	f.request("POST", "/connectors/"+good.ID+"/test-events", b, request, 202, nil)
	f.request("POST", "/connectors/"+good.ID+"/test-events", b, request, 202, nil)
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM external_notifications WHERE connection_id=?`, good.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("수동 샘플 중복 저장", err)
	}
	pending := f.pending(b)
	if len(pending) != 1 || pending[0].Type != "notification" || len(f.pending(c)) != 0 {
		t.Fatal("샘플 구독 대상 격리 실패")
	}

	// 3. 삭제는 미전달 목록에서 숨기며 이미 전송 중인 이벤트 ACK는 허용한다.
	f.request("DELETE", "/connectors/"+good.ID, b, nil, 200, nil)
	f.request("DELETE", "/connectors/"+good.ID, b, nil, 200, nil)
	f.request("POST", "/connectors/"+good.ID+"/test-events", b, request, 404, nil)
	if len(f.pending(b)) != 0 {
		t.Fatal("삭제한 연결의 미전달 알림이 남음")
	}
	f.request("POST", "/inbox/"+pending[0].ID+"/ack", b, nil, 200, nil)
	var listed struct {
		Connections []connectors.Connection `json:"connections"`
	}
	f.request("GET", "/connectors", b, nil, 200, &listed)
	if len(listed.Connections) != 1 || listed.Connections[0].ID != bad.ID {
		t.Fatal("삭제한 연결이 목록에 남음")
	}

	// 4. 실패한 샘플을 자동 재시도하지 않고 내부 메시지는 계속 전달한다.
	f.request("POST", "/connectors/"+bad.ID+"/test-events", b, request, 503, nil)
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM external_notifications WHERE connection_id=?`, bad.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("실패한 샘플의 알림 생성", err)
	}
	accepted := f.send(a, "selected", "text", "still works", "connector-key1", c)
	if events := f.pending(c); len(events) != 1 || events[0].ID != accepted.ID {
		t.Fatal("커넥터 장애가 내부 메시지를 중단함")
	}
}

// TestNetworkBoundary는 허용 CIDR과 앱 출처 밖의 요청을 차단한다.
func TestNetworkBoundary(t *testing.T) {
	f := setup(t)
	req := httptest.NewRequest("GET", "http://server/healthz", nil)
	req.RemoteAddr = "203.0.113.20:5000"
	response := httptest.NewRecorder()
	f.app.Handler().ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatal("외부 CIDR 허용")
	}
	req.RemoteAddr = "127.0.0.1:5000"
	req.Header.Set("Origin", "https://untrusted.example")
	response = httptest.NewRecorder()
	f.app.Handler().ServeHTTP(response, req)
	if response.Code != 403 {
		t.Fatal("외부 Origin 허용")
	}
}

// TestReplies는 수신자만 원본 발신 펫에게 답장하고 원본 관계가 배달되는지 검증한다.
func TestReplies(t *testing.T) {
	// 1. 같은 원본을 받은 두 사람 중 한 명이 발신자에게만 답장한다.
	f := setup(t)
	a, b, c, d := f.user("alice"), f.user("bob"), f.user("carol"), f.user("dave")
	for _, login := range []identity.Login{a, b, c} {
		_, _ = f.socket(login, false)
	}
	original := f.send(a, "selected", "text", "커피?", "reply-original", b, c)
	in := messaging.Send{SenderPetID: b.Principal.PetID, Mode: "selected", PetIDs: []string{a.Principal.PetID}, Kind: "text", Body: "좋아요", IdempotencyKey: "reply-valid-1", ReplyToMessageID: original.ID}
	var accepted messaging.Accepted
	f.request("POST", "/messages", b, in, 201, &accepted)
	events := f.pending(a)
	if len(events) != 1 || events[0].ID != accepted.ID || events[0].ReplyToMessageID != original.ID || events[0].Sender.PetID != b.Principal.PetID {
		t.Fatalf("원본 관계가 답장에 배달되지 않음: %+v", events)
	}
	if len(f.pending(c)) != 1 || len(f.pending(d)) != 0 {
		t.Fatal("답장이 원본의 다른 수신자에게 전달됨")
	}

	// 2. 미수신자의 참조·잘못된 답장 대상·전체 답장을 거부한다.
	in.SenderPetID = d.Principal.PetID
	in.IdempotencyKey = "reply-forbidden"
	f.request("POST", "/messages", d, in, 404, nil)
	in.SenderPetID = b.Principal.PetID
	in.PetIDs = []string{c.Principal.PetID}
	f.request("POST", "/messages", b, in, 404, nil)
	in.Mode = "all"
	in.PetIDs = nil
	f.request("POST", "/messages", b, in, 400, nil)
}

// TestDurableReopen는 세션·펫 ID·수신 관계를 보존하되 오프라인 본문을 재생하지 않는지 검증한다.
func TestDurableReopen(t *testing.T) {
	// 1. 메시지를 접수한 뒤 첫 서버와 DB를 닫는다.
	f := setup(t)
	a, b := f.user("alice"), f.user("bob")
	connection, _ := f.socket(b, false)
	accepted := f.send(a, "selected", "text", "after restart", "restart-key1", b)
	connection.CloseNow()
	f.http.Close()
	if err := f.db.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for f.db.Stats().OpenConnections != 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if f.db.Stats().OpenConnections != 0 {
		t.Fatal("이전 서버의 DB 연결이 아직 종료되지 않음")
	}

	// 2. 같은 경로를 다시 열어 기존 토큰과 수신 대상을 복구한다.
	db, err := database.Open(f.app.Config.Directory)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	app := server.New(f.ctx, db, f.app.Config)
	principal, err := app.Identity.Resolve(b.Token)
	if err != nil || principal.PetID != b.Principal.PetID {
		t.Fatalf("기존 세션과 펫 복구 실패: %+v %v", principal, err)
	}
	pending, err := app.Delivery.Pending(principal)
	if err != nil || len(pending) != 0 {
		t.Fatalf("서버 재시작이 과거 본문을 재생함: %+v %v", pending, err)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_recipients WHERE message_id=? AND pet_id=?`, accepted.ID, b.Principal.PetID).Scan(&count); err != nil || count != 1 {
		t.Fatal("기존 메시지의 수신 관계가 사라짐", err)
	}
}

// TestNicknamePetIdentity는 예전 펫 이름과 요청의 이름이 계정 닉네임을 덮지 못하는지 검증한다.
func TestNicknamePetIdentity(t *testing.T) {
	// 1. 별도 이름이 있던 기존 펫도 조회에서는 닉네임과 안정적인 ID를 유지한다.
	f := setup(t)
	a, b := f.user("nickname"), f.user("friend")
	if _, err := f.db.Exec(`UPDATE pets SET name=? WHERE id=?`, "이전 펫 이름", a.Principal.PetID); err != nil {
		t.Fatal(err)
	}
	var current model.Pet
	f.request("GET", "/me/pet", a, nil, 200, &current)
	if current.ID != a.Principal.PetID || current.Name != "nickname" || current.OwnerName != "nickname" {
		t.Fatalf("계정 닉네임과 대표 펫 ID 불일치: %+v", current)
	}

	// 2. 이전 클라이언트가 임의 이름을 보내도 닉네임으로 외형만 적용한다.
	f.request("POST", "/me/pet/registration", a, map[string]string{"name": "요청으로 바꾼 이름", "designId": "builtin:dog"}, 200, &current)
	if current.ID != a.Principal.PetID || current.Name != "nickname" || current.BuiltinID != "dog" {
		t.Fatal("외형 변경이 닉네임 또는 펫 ID를 덮어씀")
	}

	// 3. 새 메시지의 발신 스냅샷에도 같은 닉네임을 전달한다.
	_, _ = f.socket(b, false)
	accepted := f.send(a, "selected", "text", "닉네임 메시지", "nickname-message-1", b)
	events := f.pending(b)
	if len(events) != 1 || events[0].ID != accepted.ID || events[0].Sender.UserName != "nickname" || events[0].Sender.PetName != "nickname" {
		t.Fatal("메시지 발신 이름이 닉네임과 다름")
	}
}
