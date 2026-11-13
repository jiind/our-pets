package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jiind/our-pets/internal/delivery"
	"github.com/jiind/our-pets/internal/gatherings"
	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/messaging"
	"github.com/jiind/our-pets/internal/model"
	"github.com/jiind/our-pets/internal/notifications"
	"github.com/jiind/our-pets/internal/pets"
)

type Server struct {
	Gatherings    *gatherings.Service
	Config        Config
	Identity      *identity.Service
	Pets          *pets.Service
	Messages      *messaging.Service
	Delivery      *delivery.Service
	Notifications *notifications.Service
	DB            *sql.DB
	ctx           context.Context
	rateMu        sync.Mutex
	attempts      map[string]attempt
}

type attempt struct {
	count int
	until time.Time
}

// New는 단일 프로세스 안에 역할별 서비스를 연결한다.
func New(ctx context.Context, db *sql.DB, c Config) *Server {
	d := delivery.New(db)
	g := &gatherings.Service{DB: db, Online: d.Online}
	g.OnActivity = d.PublishActivity
	g.Reset()
	d.LiveState = g.Live
	d.OnDisconnect = g.Disconnect
	return &Server{Gatherings: g, Config: c, DB: db, ctx: ctx, Identity: &identity.Service{DB: db, Invite: c.Invite}, Pets: &pets.Service{DB: db, Directory: filepath.Join(c.Directory, "designs"), Online: d.Online}, Messages: &messaging.Service{DB: db, TTL: c.MessageTTL, Online: d.Online}, Delivery: d, Notifications: notifications.New(db, c.MessageTTL, c.SampleEnabled), attempts: map[string]attempt{}}
}

type endpoint func(http.ResponseWriter, *http.Request) error
type authenticated func(http.ResponseWriter, *http.Request, model.Principal) error

// wrap은 공개 가능한 오류만 JSON 응답으로 반환한다.
func wrap(handler endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := handler(w, r); err != nil {
			status, message := model.Status(err)
			if status == 500 {
				slog.Error("요청 처리 실패", "method", r.Method, "path", r.URL.Path, "error", err)
			}
			_ = respond(w, status, map[string]string{"error": message})
		}
	}
}

// auth는 요청 본문의 사용자 ID 대신 세션 토큰으로 소유권을 확정한다.
func (s *Server) auth(handler authenticated) endpoint {
	return func(w http.ResponseWriter, r *http.Request) error {
		p, err := s.Identity.Resolve(bearer(r))
		if err != nil {
			return err
		}
		return handler(w, r, p)
	}
}

// registeredAuth는 계정 인증과 펫 등록을 구분하고 등록된 펫의 업무 요청만 허용한다.
func (s *Server) registeredAuth(handler authenticated) endpoint {
	return s.auth(func(w http.ResponseWriter, r *http.Request, p model.Principal) error {
		if !p.PetRegistered {
			return model.Bad(403, "펫을 먼저 등록하세요")
		}
		return handler(w, r, p)
	})
}

// Handler는 버전 API와 내부망 접근·출처 제한을 구성한다.
func (s *Server) Handler() http.Handler {
	// 1. 역할별 HTTP API를 등록한다.
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/gatherings", wrap(s.registeredAuth(s.liveGatherings)))
	mux.HandleFunc("POST /api/v1/gatherings", wrap(s.registeredAuth(s.createGathering)))
	mux.HandleFunc("POST /api/v1/gatherings/{id}/complete", wrap(s.registeredAuth(s.completeGathering)))
	mux.HandleFunc("POST /api/v1/gatherings/{id}/accept", wrap(s.registeredAuth(s.acceptGathering)))
	mux.HandleFunc("POST /api/v1/gatherings/{id}/leave", wrap(s.registeredAuth(s.leaveGathering)))
	mux.HandleFunc("GET /healthz", wrap(func(w http.ResponseWriter, r *http.Request) error {
		return respond(w, 200, map[string]string{"status": "ok", "service": "our-pets"})
	}))
	mux.HandleFunc("POST /api/v1/register", wrap(s.register))
	mux.HandleFunc("POST /api/v1/login", wrap(s.login))
	mux.HandleFunc("POST /api/v1/logout", wrap(s.auth(func(w http.ResponseWriter, r *http.Request, p model.Principal) error {
		return s.Identity.Logout(bearer(r))
	})))
	mux.HandleFunc("GET /api/v1/me", wrap(s.auth(func(w http.ResponseWriter, r *http.Request, p model.Principal) error { return respond(w, 200, p) })))
	mux.HandleFunc("GET /api/v1/me/account", wrap(s.auth(s.account)))
	mux.HandleFunc("PUT /api/v1/me/account", wrap(s.auth(s.updateAccount)))
	mux.HandleFunc("DELETE /api/v1/me/account", wrap(s.auth(s.deleteAccount)))
	mux.HandleFunc("PUT /api/v1/me/password", wrap(s.auth(s.changePassword)))
	mux.HandleFunc("GET /api/v1/pets", wrap(s.auth(s.listPets)))
	mux.HandleFunc("GET /api/v1/me/pet", wrap(s.auth(s.currentPet)))
	mux.HandleFunc("POST /api/v1/me/pet/registration", wrap(s.auth(s.registerPet)))
	mux.HandleFunc("GET /api/v1/me/designs", wrap(s.auth(s.ownDesigns)))
	mux.HandleFunc("POST /api/v1/designs", wrap(s.auth(s.upload)))
	mux.HandleFunc("GET /api/v1/designs/{id}", wrap(s.auth(s.design)))
	mux.HandleFunc("PUT /api/v1/designs/{id}", wrap(s.auth(s.updateDesign)))
	mux.HandleFunc("DELETE /api/v1/designs/{id}", wrap(s.auth(s.deleteDesign)))
	mux.HandleFunc("GET /api/v1/designs/{id}/image", wrap(s.auth(s.image)))
	mux.HandleFunc("PUT /api/v1/me/pet/design", wrap(s.registeredAuth(s.applyDesign)))
	mux.HandleFunc("POST /api/v1/messages", wrap(s.registeredAuth(s.send)))
	mux.HandleFunc("GET /api/v1/messages/{id}", wrap(s.registeredAuth(s.status)))
	mux.HandleFunc("GET /api/v1/inbox", wrap(s.registeredAuth(s.inbox)))
	mux.HandleFunc("POST /api/v1/inbox/{id}/ack", wrap(s.registeredAuth(s.ack)))
	mux.HandleFunc("GET /api/v1/connectors", wrap(s.auth(s.listConnections)))
	mux.HandleFunc("POST /api/v1/connectors", wrap(s.registeredAuth(s.createConnection)))
	mux.HandleFunc("POST /api/v1/connectors/{id}/test-events", wrap(s.registeredAuth(s.sendSampleNotification)))
	mux.HandleFunc("DELETE /api/v1/connectors/{id}", wrap(s.auth(s.deleteConnection)))
	mux.HandleFunc("GET /api/v1/ws", s.websocket)

	// 2. 프록시 헤더를 신뢰하지 않고 실제 접속 주소와 정확한 Origin을 검사한다.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		address, parseErr := netip.ParseAddr(host)
		allowed := false
		if err == nil && parseErr == nil {
			for _, prefix := range s.Config.AllowedCIDRs {
				if prefix.Contains(address.Unmap()) {
					allowed = true
				}
			}
		}
		if !allowed {
			_ = respond(w, 403, map[string]string{"error": "허용된 로컬망 주소가 아닙니다"})
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			match := false
			for _, value := range s.Config.Origins {
				if origin == strings.TrimSpace(value) {
					match = true
				}
			}
			if !match {
				_ = respond(w, 403, map[string]string{"error": "허용되지 않은 앱 출처"})
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, pets.MaxUpload+(64<<10))
		mux.ServeHTTP(w, r)
	})
}

// respond는 JSON 형식과 상태 코드를 일관되게 기록한다.
func respond(w http.ResponseWriter, status int, value any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(value)
}

// decode는 알 수 없는 필드·여러 JSON 값·과도한 본문을 거부한다.
func decode(r *http.Request, value any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return model.Bad(400, "JSON 요청을 확인하세요")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return model.Bad(400, "JSON 값은 하나여야 합니다")
	}
	return nil
}

// bearer는 쿠키나 URL에 인증 정보를 넣지 않는 토큰을 추출한다.
func bearer(r *http.Request) string {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// allowLogin은 계정 추측과 비밀번호 해시 자원 소모를 주소별로 제한한다.
func (s *Server) allowLogin(r *http.Request) bool {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	now := time.Now()
	for key, value := range s.attempts {
		if now.After(value.until) {
			delete(s.attempts, key)
		}
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	value := s.attempts[host]
	if value.count >= 30 || len(s.attempts) > 10000 {
		return false
	}
	value.count++
	if value.until.IsZero() {
		value.until = now.Add(time.Minute)
	}
	s.attempts[host] = value
	return true
}

// register는 가입 코드와 로컬 자격증명으로 계정을 만든다.
func (s *Server) register(w http.ResponseWriter, r *http.Request) error {
	if !s.allowLogin(r) {
		return model.Bad(429, "잠시 후 다시 시도하세요")
	}
	var c identity.Credentials
	if err := decode(r, &c); err != nil {
		return err
	}
	result, err := s.Identity.Register(c)
	if err != nil {
		return err
	}
	return respond(w, 201, result)
}

// login은 로컬 비밀번호로 인증된 기기 세션을 발급한다.
func (s *Server) login(w http.ResponseWriter, r *http.Request) error {
	if !s.allowLogin(r) {
		return model.Bad(429, "잠시 후 다시 시도하세요")
	}
	var c identity.Credentials
	if err := decode(r, &c); err != nil {
		return err
	}
	result, err := s.Identity.Authenticate(c)
	if err != nil {
		return err
	}
	return respond(w, 200, result)
}

// listPets는 인증된 로컬망 사용자가 선택할 수 있는 펫 목록을 반환한다.
func (s *Server) listPets(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	result, err := s.Pets.List()
	if err != nil {
		return err
	}
	return respond(w, 200, result)
}

// currentPet은 미등록 계정도 자신의 안정적인 펫 ID와 등록 상태를 조회하게 한다.
func (s *Server) currentPet(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	pet, err := s.Pets.Current(p)
	if err != nil {
		return err
	}
	return respond(w, 200, pet)
}

// ownDesigns는 등록 전에 저장한 디자인을 포함해 본인의 선택 목록을 반환한다.
func (s *Server) ownDesigns(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	designs, err := s.Pets.OwnDesigns(p)
	if err != nil {
		return err
	}
	return respond(w, 200, designs)
}

// registerPet은 이름과 선택한 외형을 검증한 뒤 기존 대표 펫을 실제로 등록한다.
func (s *Server) registerPet(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 가입 폼과 분리한 펫 등록 입력만 받는다.
	var in pets.Registration
	if err := decode(r, &in); err != nil {
		return err
	}

	// 2. 새 식별자를 만들지 않고 등록 또는 등록 정보 수정을 완료한다.
	pet, err := s.Pets.Register(p, in)
	if err != nil {
		return err
	}
	return respond(w, 200, pet)
}

// upload는 UI가 생성한 선언형 설정과 실제 PNG를 등록한다.
func (s *Server) upload(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 크기가 제한된 multipart를 읽고 임시 파일을 정리한다.
	if err := r.ParseMultipartForm(pets.MaxUpload); err != nil {
		return model.Bad(400, "PNG 업로드 요청을 확인하세요")
	}
	defer r.MultipartForm.RemoveAll()
	file, _, err := r.FormFile("image")
	if err != nil {
		return model.Bad(400, "PNG 파일이 필요합니다")
	}
	defer file.Close()
	var manifest model.Manifest
	if err = json.Unmarshal([]byte(r.FormValue("manifest")), &manifest); err != nil {
		return model.Bad(400, "디자인 표시 설정을 확인하세요")
	}

	// 2. 파일 검증과 소유 버전 관리는 펫 서비스에 위임한다.
	var design model.Design
	if draft := r.FormValue("draft"); draft == "true" {
		design, err = s.Pets.UploadDraft(p, r.FormValue("name"), manifest, file)
	} else if draft == "" || draft == "false" {
		design, err = s.Pets.Upload(p, r.FormValue("name"), manifest, file)
	} else {
		return model.Bad(400, "draft는 true 또는 false로 지정하세요")
	}
	if err != nil {
		return err
	}
	return respond(w, 201, design)
}

// design은 인증된 사용자에게 디자인 메타데이터를 반환한다.
func (s *Server) design(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	d, err := s.Pets.Design(r.PathValue("id"))
	if err != nil {
		return err
	}
	return respond(w, 200, d)
}

// image는 서버가 생성한 내용 지문 경로의 PNG만 전송한다.
func (s *Server) image(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	d, err := s.Pets.Design(r.PathValue("id"))
	if err != nil {
		return err
	}
	file, err := os.Open(filepath.Join(s.Pets.Directory, d.ImageHash+".png"))
	if err != nil {
		return err
	}
	defer file.Close()
	w.Header().Set("Content-Type", "image/png")
	_, err = io.Copy(w, file)
	return err
}

// applyDesign은 다른 펫의 ID나 디자인 데이터를 수정하지 않고 자신의 외형만 바꾼다.
func (s *Server) applyDesign(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	var in struct {
		DesignID string `json:"designId"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := s.Pets.Apply(p, in.DesignID); err != nil {
		return err
	}
	return respond(w, 200, map[string]string{"status": "applied"})
}

// send는 발신자 권한·대상 스냅샷·멱등성을 검증한 접수 결과를 반환한다.
func (s *Server) send(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	var in messaging.Send
	if err := decode(r, &in); err != nil {
		return err
	}
	result, err := s.Messages.Send(p, in)
	if err != nil {
		return err
	}
	return respond(w, 201, result)
}

// status는 자신이 보낸 메시지의 앱 수신 상태를 조회한다.
func (s *Server) status(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	result, err := s.Messages.Status(p, r.PathValue("id"))
	if err != nil {
		return err
	}
	return respond(w, 200, result)
}

// inbox는 다른 사용자 ID를 받지 않고 현재 기기의 미수신 목록을 반환한다.
func (s *Server) inbox(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	events, err := s.Delivery.Pending(p)
	if err != nil {
		return err
	}
	return respond(w, 200, events)
}

// ack는 사용자 읽음과 구분되는 현재 기기의 앱 수신을 기록한다.
func (s *Server) ack(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Delivery.Ack(p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]string{"status": "received"})
}

// listConnections는 소유한 연결의 정제된 상태를 제공한다.
func (s *Server) listConnections(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	result, err := s.Notifications.List(p.UserID)
	if err != nil {
		return err
	}
	return respond(w, 200, map[string]any{"enabled": s.Config.SampleEnabled, "connections": result})
}

// createConnection은 자신에게만 구독되는 독립적인 샘플 알림 연결을 만든다.
func (s *Server) createConnection(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	var in struct {
		Kind   string          `json:"kind"`
		Config json.RawMessage `json:"config"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	connection, err := s.Notifications.Create(s.ctx, p, in.Kind, in.Config)
	if err != nil {
		return err
	}
	return respond(w, 201, connection)
}

// sendSampleNotification은 소유한 연결의 수동 테스트 요청만 한 건 접수한다.
func (s *Server) sendSampleNotification(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	var in struct {
		IdempotencyKey string `json:"idempotencyKey"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}
	if err := s.Notifications.SendSample(r.Context(), p, r.PathValue("id"), in.IdempotencyKey); err != nil {
		return err
	}
	return respond(w, 202, map[string]string{"status": "accepted"})
}

// deleteConnection은 다른 사용자의 연결을 노출하지 않고 소유한 샘플만 삭제한다.
func (s *Server) deleteConnection(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Notifications.Delete(r.Context(), p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]bool{"deleted": true})
}

// websocket은 짧은 첫 프레임 인증 후 해당 기기의 미수신 이벤트를 전송한다.
func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	// 1. Origin은 공통 미들웨어에서 정확히 검증했고 인증 토큰은 URL에 받지 않는다.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(4096)
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	_, data, err := c.Read(ctx)
	cancel()
	var frame struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}
	if err != nil || json.Unmarshal(data, &frame) != nil || frame.Type != "auth" {
		_ = c.Close(websocket.StatusPolicyViolation, "authentication required")
		return
	}
	p, err := s.Identity.Resolve(frame.Token)
	if err != nil {
		_ = c.Close(websocket.StatusPolicyViolation, "invalid session")
		return
	}
	if !p.PetRegistered {
		_ = c.Close(websocket.StatusPolicyViolation, "pet registration required")
		return
	}

	// 2. 서버 종료와 함께 연결도 정리하고 앱 수신은 별도 확인 프레임으로 받는다.
	ctx, cancel = context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(s.ctx, cancel)
	defer stop()
	s.Delivery.Serve(ctx, c, p)
}

// Maintain는 만료된 실시간 알림을 재표시하지 않고 설정된 보관 기간 뒤 정리한다.
func (s *Server) Maintain(ctx context.Context) {
	// 1. 재시작 시 연결을 복원하고 주기적인 정리를 시작한다.
	if err := s.Notifications.Restore(ctx); err != nil {
		slog.Error("커넥터 복원 실패", "error", err)
	}
	timer := time.NewTicker(time.Hour)
	defer timer.Stop()

	// 2. 만료된 세션과 오래된 메시지를 삭제하고 연결 없는 영수증을 정리한다.
	for {
		cutoff := time.Now().Add(-s.Config.Retention).UnixMilli()
		_, err := s.DB.Exec(`DELETE FROM sessions WHERE expires_at<?; DELETE FROM messages WHERE created_at<?; DELETE FROM external_notifications WHERE created_at<?; DELETE FROM device_receipts WHERE event_id NOT IN(SELECT id FROM messages UNION ALL SELECT id FROM external_notifications); DELETE FROM connector_connections WHERE state='deleted' AND NOT EXISTS(SELECT 1 FROM external_notifications n WHERE n.connection_id=connector_connections.id);`, time.Now().UnixMilli(), cutoff, cutoff)
		if err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("보관 데이터 정리 실패", "error", err)
		}
		if cleanupErr := s.Notifications.PruneDeleted(); cleanupErr != nil && !errors.Is(cleanupErr, context.Canceled) {
			slog.Error("삭제한 서버 연결 정리 실패")
		}
		if cleanupErr := s.Pets.CleanupUnusedImages(); cleanupErr != nil && !errors.Is(cleanupErr, context.Canceled) {
			slog.Error("미사용 펫 이미지 정리 실패")
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}

// createGathering은 인증한 내 펫으로 메시지 없는 모집을 시작한다.
func (s *Server) createGathering(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 본문이나 수신자 목록 없이 모집 종류와 재시도 키만 허용한다.
	var in gatherings.Create
	if err := decode(r, &in); err != nil {
		return err
	}

	// 2. 같은 활성 모집과 재시도를 동일한 모집 객체로 반환한다.
	result, err := s.Gatherings.Create(p, in)
	if err != nil {
		return err
	}
	return respond(w, 200, result)
}

// completeGathering은 모집자에게만 현재 모집의 완료를 허용한다.
func (s *Server) completeGathering(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Gatherings.Complete(p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]bool{"completed": true})
}

// liveGatherings는 공개 모집과 기존 권한으로 제한한 메시지 모임을 함께 반환한다.
func (s *Server) liveGatherings(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	groups, err := s.Gatherings.Live(p)
	if err != nil {
		return err
	}
	return respond(w, 200, groups)
}

// acceptGathering은 인증한 펫으로 공개 모집에 참여하거나 받은 메시지 제안을 수락한다.
func (s *Server) acceptGathering(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Gatherings.Accept(p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]bool{"accepted": true})
}

// leaveGathering은 자신의 참가 취소와 기존 메시지 제안 종료를 처리한다.
func (s *Server) leaveGathering(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Gatherings.Leave(p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]bool{"left": true})
}
