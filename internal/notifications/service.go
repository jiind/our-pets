package notifications

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"time"

	"github.com/jiind/our-pets/internal/connectors"
	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type Service struct {
	DB       *sql.DB
	TTL      time.Duration
	Enabled  bool
	Registry map[string]connectors.Connector
	mu       sync.Mutex
	running  map[string]context.CancelFunc
}

// New는 선택적으로 활성화되는 알림 수집 경계를 구성한다.
func New(db *sql.DB, ttl time.Duration, enabled bool) *Service {
	return &Service{DB: db, TTL: ttl, Enabled: enabled, Registry: map[string]connectors.Connector{"sample": connectors.Sample{}}, running: map[string]context.CancelFunc{}}
}

// Create는 자신의 펫에 대한 구독과 별개의 샘플 연결을 등록한다.
func (s *Service) Create(ctx context.Context, p model.Principal, kind string, config json.RawMessage) (connectors.Connection, error) {
	// 1. 공급자 계약과 소유 범위를 검증한다.
	c, ok := s.Registry[kind]
	if !ok || !s.Enabled {
		return connectors.Connection{}, model.Bad(400, "활성화되지 않은 커넥터입니다")
	}
	if err := c.Validate(config); err != nil {
		return connectors.Connection{}, err
	}
	connection := connectors.Connection{ID: database.ID(), Kind: kind, OwnerID: p.UserID, Config: config, State: "connecting"}
	if kind == "sample" {
		connection.State = "ready"
	}

	// 2. 연결과 수신 구독을 함께 저장하고 독립적인 작업을 시작한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return connection, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO connector_connections(id,kind,schema_version,owner_id,config,state) VALUES(?,?,?,?,?,?)`, connection.ID, kind, c.Descriptor().SchemaVersion, p.UserID, string(config), connection.State); err != nil {
		return connection, err
	}
	if _, err = tx.Exec(`INSERT INTO notification_subscriptions VALUES(?,?)`, connection.ID, p.PetID); err != nil {
		return connection, err
	}
	if err = tx.Commit(); err != nil {
		return connection, err
	}
	s.start(ctx, connection)
	return connection, nil
}

// List는 인증된 소유자의 연결 상태만 반환하고 자격증명 참조를 숨긴다.
func (s *Service) List(userID string) ([]connectors.Connection, error) {
	// 1. SQLite TEXT를 일반 문자열로 읽어 드라이버의 JSON 별칭 변환에 의존하지 않는다.
	rows, err := s.DB.Query(`SELECT id,kind,owner_id,config,state,last_error FROM connector_connections WHERE owner_id=? AND state!='deleted' ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []connectors.Connection{}

	// 2. 연결마다 JSON 데이터로 변환한 뒤 소유자 목록을 구성한다.
	for rows.Next() {
		var c connectors.Connection
		var config string
		if err = rows.Scan(&c.ID, &c.Kind, &c.OwnerID, &config, &c.State, &c.LastError); err != nil {
			return nil, err
		}
		c.Config = json.RawMessage(config)
		result = append(result, c)
	}
	return result, rows.Err()
}

// Restore는 서버 재시작 후 저장된 연결을 다시 실행한다.
func (s *Service) Restore(ctx context.Context) error {
	// 1. 조회 연결을 닫은 뒤 수집 작업을 시작해 단일 DB 연결 잠금을 피한다.
	rows, err := s.DB.Query(`SELECT id,kind,owner_id,config,state FROM connector_connections WHERE state!='deleted'`)
	if err != nil {
		return err
	}
	all := []connectors.Connection{}
	for rows.Next() {
		var c connectors.Connection
		var config string
		if err = rows.Scan(&c.ID, &c.Kind, &c.OwnerID, &config, &c.State); err != nil {
			rows.Close()
			return err
		}
		c.Config = json.RawMessage(config)
		all = append(all, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}

	// 2. 비활성 서버는 이전 연결 상태를 명시적으로 정지시킨다.
	for _, c := range all {
		if s.Enabled {
			s.start(ctx, c)
		} else {
			s.report(c.ID, connectors.Report{State: "disabled"})
		}
	}
	return nil
}

// start는 커넥터 오류를 내부 메시지 처리와 격리하고 지수 간격으로 재접속한다.
func (s *Service) start(parent context.Context, c connectors.Connection) {
	// 1. 같은 연결의 중복 실행을 방지한다.
	connector, ok := s.Registry[c.Kind]
	if !ok {
		s.report(c.ID, connectors.Report{State: "unsupported", Error: "알 수 없는 커넥터 종류"})
		return
	}
	s.mu.Lock()
	var exists int
	if s.DB.QueryRow(`SELECT 1 FROM connector_connections WHERE id=? AND state!='deleted'`, c.ID).Scan(&exists) != nil {
		s.mu.Unlock()
		return
	}
	if _, exists := s.running[c.ID]; exists {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(parent)
	s.running[c.ID] = cancel
	s.mu.Unlock()

	// 2. 커넥터별 고루틴 안에서 재접속하고 종료 시 상태를 정리한다.
	go func() {
		defer func() {
			s.report(c.ID, connectors.Report{State: "stopped"})
			s.mu.Lock()
			delete(s.running, c.ID)
			s.mu.Unlock()
		}()
		delay := time.Second
		for ctx.Err() == nil {
			err := connector.Run(ctx, c, s.Publish, func(r connectors.Report) { s.report(c.ID, r) })
			if ctx.Err() != nil {
				return
			}
			description := "커넥터 연결 종료"
			if err != nil {
				description = "알림 수집 실패; 자동 재접속 중"
			}
			s.report(c.ID, connectors.Report{State: "reconnecting", Error: description})
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if delay < 30*time.Second {
				delay *= 2
			}
		}
	}()
}

// report는 민감한 공급자 오류 대신 정제된 연결 상태를 보관한다.
func (s *Service) report(id string, r connectors.Report) {
	_, _ = s.DB.Exec(`UPDATE connector_connections SET state=?,last_error=? WHERE id=? AND state!='deleted'`, r.State, r.Error, id)
}

// SendSample은 연결 소유자의 명시적 요청 한 번만 공통 알림 전달 경계로 보낸다.
func (s *Service) SendSample(ctx context.Context, p model.Principal, id, key string) error {
	// 1. 다른 사용자의 연결을 숨기고 샘플 기능·요청 키·등록 상태를 확인한다.
	var connection connectors.Connection
	var config string
	err := s.DB.QueryRow(`SELECT id,kind,owner_id,config FROM connector_connections WHERE id=? AND owner_id=? AND kind='sample' AND state!='deleted'`, id, p.UserID).Scan(&connection.ID, &connection.Kind, &connection.OwnerID, &config)
	if err == sql.ErrNoRows {
		return model.Bad(404, "샘플 연결을 찾을 수 없습니다")
	}
	if err != nil {
		return err
	}
	if !s.Enabled || !p.PetRegistered {
		return model.Bad(403, "샘플 알림 사용 설정과 펫 등록 상태를 확인하세요")
	}
	if len(key) < 8 || len(key) > 128 {
		return model.Bad(400, "샘플 알림 요청 키는 8~128바이트입니다")
	}
	connection.Config = json.RawMessage(config)

	// 2. 발송 결과만 기록하고 실패한 샘플을 자동으로 재발송하지 않는다.
	if err = (connectors.Sample{}).Emit(ctx, connection, "manual-"+key, s.Publish); err != nil {
		s.report(id, connectors.Report{State: "error", Error: "샘플 알림 발송 실패; 다시 시도하거나 연결을 삭제하세요"})
		return err
	}
	s.report(id, connectors.Report{State: "ready"})
	return nil
}

// Delete는 소유한 샘플 설정·구독을 제거하고 전송 중인 이벤트의 ACK 관계만 만료까지 보존한다.
func (s *Service) Delete(ctx context.Context, p model.Principal, id string) error {
	// 1. 조회 권한과 삭제를 같은 트랜잭션에서 확인하고 삭제 재요청도 성공으로 처리한다.
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var state string
	err = tx.QueryRow(`SELECT state FROM connector_connections WHERE id=? AND owner_id=? AND kind='sample'`, id, p.UserID).Scan(&state)
	if err == sql.ErrNoRows {
		return model.Bad(404, "샘플 연결을 찾을 수 없습니다")
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE connector_connections SET state='deleted',config='{}',credential_ref=NULL,last_error='' WHERE id=?`, id); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM notification_subscriptions WHERE connection_id=?`, id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}

	// 2. 수집 작업은 종료하고 늦은 상태 보고가 삭제된 연결을 복구하지 못하게 한다.
	s.mu.Lock()
	if cancel := s.running[id]; cancel != nil {
		cancel()
	}
	s.mu.Unlock()
	return nil
}

// Publish는 공급자 이벤트를 중복 제거하고 명시된 구독 대상에게만 저장한다.
func (s *Service) Publish(ctx context.Context, n model.Notification) error {
	// 1. 공통 알림 규격과 등록된 연결 종류를 검증한다.
	if n.SchemaVersion != 1 || n.EventID == "" || len(n.EventID) > 256 || len(n.Title) > 200 || len(n.Body) > 8000 || len(n.Data) > 16000 || n.OccurredAt <= 0 {
		return model.Bad(400, "올바르지 않은 공통 알림입니다")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var kind string
	if err = tx.QueryRow(`SELECT kind FROM connector_connections WHERE id=? AND state!='deleted'`, n.ConnectionID).Scan(&kind); err != nil || kind != n.SourceKind {
		return model.Bad(400, "연결과 출처가 일치하지 않습니다")
	}

	// 2. 연결별 이벤트 키와 대상 스냅샷을 같은 트랜잭션으로 저장한다.
	payload, _ := json.Marshal(n)
	id := database.ID()
	now := time.Now()
	result, err := tx.Exec(`INSERT OR IGNORE INTO external_notifications VALUES(?,?,?,?,?,?)`, id, n.ConnectionID, n.EventID, string(payload), now.UnixMilli(), now.Add(s.TTL).UnixMilli())
	if err != nil {
		return err
	}
	count, _ := result.RowsAffected()
	if count == 0 {
		return nil
	}
	if _, err = tx.Exec(`INSERT INTO notification_recipients(notification_id,pet_id) SELECT ?,s.pet_id FROM notification_subscriptions s JOIN pets p ON p.id=s.pet_id WHERE s.connection_id=? AND p.active=1`, id, n.ConnectionID); err != nil {
		return err
	}
	return tx.Commit()
}

// PruneDeleted는 계정 삭제로 DB에서 사라진 연결의 수집 작업도 정지한다.
func (s *Service) PruneDeleted() error {
	// 1. 시작과 같은 잠금 순서로 현재 작업과 DB 연결의 존재를 대조한다.
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, cancel := range s.running {
		var exists int
		err := s.DB.QueryRow(`SELECT 1 FROM connector_connections WHERE id=? AND state!='deleted'`, id).Scan(&exists)
		if err != nil && err != sql.ErrNoRows {
			return err
		}

		// 2. 다른 계정의 유효한 연결은 유지하고 삭제한 연결만 취소한다.
		if err == sql.ErrNoRows {
			cancel()
			delete(s.running, id)
		}
	}
	return nil
}
