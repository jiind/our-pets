package delivery

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jiind/our-pets/internal/model"
)

type peer struct {
	petID      string
	conn       *websocket.Conn
	activities chan []byte
	since      int64
}

// PublishActivity는 현재 연결된 대상 기기에만 모집 이벤트를 보내고 재접속용 기록은 남기지 않는다.
func (s *Service) PublishActivity(event model.GatheringActivity, petIDs []string) {
	// 1. nil 대상은 모집자 외 전체, 명시적 목록은 해당 펫들로 한정한다.
	raw, err := json.Marshal(event)
	if err != nil {
		return
	}
	targets := map[string]bool{}
	for _, id := range petIDs {
		targets[id] = true
	}

	// 2. 한 기기의 알림 지연이 다른 기기와 필수 메시지 전송을 막지 않게 한다.
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, current := range s.devices {
		if current.petID == event.Actor.PetID || (petIDs != nil && !targets[current.petID]) || current.activities == nil {
			continue
		}
		select {
		case current.activities <- raw:
		default:
		}
	}
}

type Service struct {
	LiveState    func(model.Principal) ([]model.Gathering, error)
	OnDisconnect func(model.Principal)
	DB           *sql.DB
	mu           sync.Mutex
	devices      map[string]peer
}

// New는 펫과 별개인 기기 연결 관리자를 생성한다.
func New(db *sql.DB) *Service {
	return &Service{DB: db, devices: map[string]peer{}}
}

// Online은 대표 펫에 연결된 기기가 하나라도 있는지 확인한다.
func (s *Service) Online(petID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.devices {
		if p.petID == petID {
			return true
		}
	}
	return false
}

// Pending은 현재 기기 연결 이후 생성된 이벤트만 조회하며 과거 내용을 복구하지 않는다.
func (s *Service) Pending(p model.Principal) ([]model.Event, error) {
	// 1. 접속 이전 이벤트는 오프라인 기록으로 간주해 재생하지 않는다.
	s.mu.Lock()
	active, connected := s.devices[p.DeviceID]
	s.mu.Unlock()
	if !connected || active.petID != p.PetID {
		return []model.Event{}, nil
	}
	rows, err := s.DB.Query(`SELECT m.id,'message',m.kind,m.body,m.sender_snapshot,'',m.created_at,m.expires_at,COALESCE(m.reply_to_message_id,''),COALESCE((SELECT g.kind FROM gatherings g WHERE g.id=m.id AND g.status='open'),'') FROM messages m JOIN message_recipients r ON r.message_id=m.id WHERE r.pet_id=? AND m.created_at>=? AND m.expires_at>? AND NOT EXISTS(SELECT 1 FROM device_receipts d WHERE d.event_id=m.id AND d.device_id=?)
 UNION ALL SELECT n.id,'notification','external','', '',n.payload,n.created_at,n.expires_at,'','' FROM external_notifications n JOIN notification_recipients r ON r.notification_id=n.id JOIN connector_connections c ON c.id=n.connection_id WHERE r.pet_id=? AND c.state!='deleted' AND n.created_at>=? AND n.expires_at>? AND NOT EXISTS(SELECT 1 FROM device_receipts d WHERE d.event_id=n.id AND d.device_id=?) ORDER BY 7,1 LIMIT 100`, p.PetID, active.since, time.Now().UnixMilli(), p.DeviceID, p.PetID, active.since, time.Now().UnixMilli(), p.DeviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []model.Event{}

	// 2. 공급자 원본 대신 내부 공통 이벤트만 복원한다.
	for rows.Next() {
		var e model.Event
		var sender, notification string
		if err = rows.Scan(&e.ID, &e.Type, &e.Kind, &e.Body, &sender, &notification, &e.CreatedAt, &e.ExpiresAt, &e.ReplyToMessageID, &e.ProposalKind); err != nil {
			return nil, err
		}
		if sender != "" {
			if err = json.Unmarshal([]byte(sender), &e.Sender); err != nil {
				return nil, err
			}
		}
		if notification != "" {
			if err = json.Unmarshal([]byte(notification), &e.Notification); err != nil {
				return nil, err
			}
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// Ack는 수신 권한을 확인하고 기기별 앱 수신과 펫 첫 수신을 함께 기록한다.
func (s *Service) Ack(p model.Principal, id string) error {
	// 1. 다른 펫의 이벤트는 ID를 알아도 확인할 수 없다.
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var kind string
	err = tx.QueryRow(`SELECT 'message' FROM message_recipients WHERE message_id=? AND pet_id=? UNION ALL SELECT 'notification' FROM notification_recipients WHERE notification_id=? AND pet_id=?`, id, p.PetID, id, p.PetID).Scan(&kind)
	if err == sql.ErrNoRows {
		return model.Bad(404, "수신 이벤트를 찾을 수 없습니다")
	}
	if err != nil {
		return err
	}

	// 2. 다른 기기의 대기 목록에는 영향을 주지 않도록 기기 영수증을 따로 저장한다.
	now := time.Now().UnixMilli()
	if _, err = tx.Exec(`INSERT OR IGNORE INTO device_receipts VALUES(?,?,?)`, id, p.DeviceID, now); err != nil {
		return err
	}
	query := `UPDATE message_recipients SET received_at=COALESCE(received_at,?) WHERE message_id=? AND pet_id=?`
	if kind == "notification" {
		query = `UPDATE notification_recipients SET received_at=COALESCE(received_at,?) WHERE notification_id=? AND pet_id=?`
	}
	if _, err = tx.Exec(query, now, id, p.PetID); err != nil {
		return err
	}
	return tx.Commit()
}

// Serve는 한 기기당 최신 연결 하나를 유지하며 모든 기기에 독립적으로 전달한다.
func (s *Service) Serve(ctx context.Context, c *websocket.Conn, p model.Principal) {
	// 1. 미등록 계정의 세션이 유효해도 수신 채널이나 접속 중인 펫 목록에는 등록하지 않는다.
	var registered bool
	if err := s.DB.QueryRow(`SELECT active FROM pets WHERE id=? AND user_id=?`, p.PetID, p.UserID).Scan(&registered); err != nil || !registered {
		_ = c.Close(websocket.StatusPolicyViolation, "pet registration required")
		return
	}

	// 2. 같은 기기의 이전 연결만 교체하고 다른 기기는 계속 연결한다.
	s.mu.Lock()
	old := s.devices[p.DeviceID]
	activities := make(chan []byte, 128)
	s.devices[p.DeviceID] = peer{petID: p.PetID, conn: c, since: time.Now().UnixMilli(), activities: activities}
	s.mu.Unlock()
	if old.conn != nil {
		_ = old.conn.Close(websocket.StatusPolicyViolation, "device connection replaced")
	}
	defer func() {
		s.mu.Lock()
		if s.devices[p.DeviceID].conn == c {
			delete(s.devices, p.DeviceID)
		}
		s.mu.Unlock()
		if s.OnDisconnect != nil {
			s.OnDisconnect(p)
		}
	}()
	ready, _ := json.Marshal(map[string]any{"type": "ready", "deviceId": p.DeviceID})
	writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
	err := c.Write(writeCtx, websocket.MessageText, ready)
	done()
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.SetReadLimit(4096)

	// 3. 확인 프레임은 전송 루프와 독립적으로 처리하고 읽음으로 해석하지 않는다.
	go func() {
		defer cancel()
		for {
			_, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			var ack struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			}
			if json.Unmarshal(data, &ack) != nil || ack.Type != "ack" || s.Ack(p, ack.ID) != nil {
				_ = c.Close(websocket.StatusPolicyViolation, "invalid acknowledgement")
				return
			}
		}
	}()

	// 4. 미확인 이벤트를 제한된 묶음으로 재전송하며 만료·로그아웃을 확인한다.
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	sent := map[string]int64{}
	lastState := ""
	for {
		select {
		case <-ctx.Done():
			return
		case raw := <-activities:
			writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
			err := c.Write(writeCtx, websocket.MessageText, raw)
			done()
			if err != nil {
				return
			}
		case <-ping.C:
			probe, done := context.WithTimeout(ctx, 5*time.Second)
			err := c.Ping(probe)
			done()
			if err != nil {
				return
			}
		case <-ticker.C:
			var valid int
			if s.DB.QueryRow(`SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?`, p.SessionHash, time.Now().UnixMilli()).Scan(&valid) != nil || time.Now().UnixMilli() > p.ExpiresAt {
				return
			}
			if s.LiveState != nil {
				groups, stateErr := s.LiveState(p)
				if stateErr != nil {
					return
				}
				raw, _ := json.Marshal(map[string]any{"type": "gatherings", "gatherings": groups})
				if string(raw) != lastState {
					writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
					stateErr = c.Write(writeCtx, websocket.MessageText, raw)
					done()
					if stateErr != nil {
						return
					}
					lastState = string(raw)
				}
			}
			events, err := s.Pending(p)
			if err != nil {
				return
			}
			for _, event := range events {
				now := time.Now().UnixMilli()
				if now-sent[event.ID] < 5000 {
					continue
				}
				data, _ := json.Marshal(event)
				writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
				err = c.Write(writeCtx, websocket.MessageText, data)
				done()
				if err != nil {
					return
				}
				sent[event.ID] = now
			}
			if len(sent) > 10000 {
				sent = map[string]int64{}
			}
		}
	}
}
