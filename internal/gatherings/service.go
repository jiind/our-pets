package gatherings

import (
	"database/sql"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type Service struct {
	DB         *sql.DB
	Online     func(string) bool
	OnActivity func(model.GatheringActivity, []string)
}

type Create struct {
	Kind           string `json:"kind"`
	IdempotencyKey string `json:"idempotencyKey"`
}

const gatheringSelect = `SELECT g.id,g.host_pet_id,g.kind,g.status,g.expires_at,g.origin,u.id,u.display_name,h.id,u.display_name,COALESCE(h.design_id,''),h.builtin_id FROM gatherings g JOIN pets h ON h.id=g.host_pet_id JOIN users u ON u.id=h.user_id `
const membersSelect = `SELECT m.pet_id,u.display_name,u.display_name FROM gathering_members m JOIN pets p ON p.id=m.pet_id JOIN users u ON u.id=p.user_id WHERE m.gathering_id=? ORDER BY m.accepted_at,m.pet_id`

// publishActivity는 커밋된 모집 변경의 발신자와 당시 대상만 실시간 전달 계층에 넘긴다.
func (s *Service) publishActivity(action string, p model.Principal, group model.Gathering, targets []string) {
	// 1. 실제 저장된 모집자·참여자 이름으로 이벤트의 행동 주체를 구성한다.
	if s.OnActivity == nil {
		return
	}
	actor := model.Sender{UserID: p.UserID, PetID: p.PetID}
	if group.Host != nil && group.HostPetID == p.PetID {
		actor = *group.Host
	} else {
		for _, member := range group.Members {
			if member.PetID == p.PetID {
				actor.UserName, actor.PetName = member.UserName, member.PetName
				break
			}
		}
	}

	// 2. 짧은 만료 시각과 독립 ID를 부여하고 메시지·읽음 상태와 분리한다.
	now := time.Now().UnixMilli()
	s.OnActivity(model.GatheringActivity{ID: database.ID(), Type: "gathering_activity", Action: action, Actor: actor, Gathering: group, CreatedAt: now, ExpiresAt: now + 15000}, targets)
}

// scanGathering은 모임과 현재 모집자 외형을 공개 응답으로 바인딩한다.
func scanGathering(scan func(...any) error) (model.Gathering, error) {
	g := model.Gathering{Host: &model.Sender{}, Members: []model.GatheringMember{}}
	err := scan(&g.ID, &g.HostPetID, &g.Kind, &g.Status, &g.ExpiresAt, &g.Origin, &g.Host.UserID, &g.Host.UserName, &g.Host.PetID, &g.Host.PetName, &g.Host.DesignID, &g.Host.BuiltinID)
	return g, err
}

// readMembers는 참여자 목록을 읽고 다음 조회 전에 DB 연결을 해제한다.
func readMembers(rows *sql.Rows) ([]model.GatheringMember, error) {
	defer rows.Close()
	result := []model.GatheringMember{}
	for rows.Next() {
		var member model.GatheringMember
		if err := rows.Scan(&member.PetID, &member.PetName, &member.UserName); err != nil {
			return nil, err
		}
		result = append(result, member)
	}
	return result, rows.Err()
}

// load는 같은 트랜잭션에서 모집과 참여자 스냅샷을 함께 반환한다.
func load(tx *sql.Tx, id string) (model.Gathering, error) {
	// 1. 모집과 모집자의 현재 공개 정보를 읽는다.
	g, err := scanGathering(tx.QueryRow(gatheringSelect+`WHERE g.id=?`, id).Scan)
	if err != nil {
		return g, err
	}

	// 2. 참여자까지 읽어 생성과 멱등 재시도의 응답 형식을 통일한다.
	rows, err := tx.Query(membersSelect, id)
	if err != nil {
		return g, err
	}
	g.Members, err = readMembers(rows)
	return g, err
}

// Create는 메시지나 수신자 레코드 없이 내 펫의 무기한 모집을 멱등적으로 시작한다.
func (s *Service) Create(p model.Principal, in Create) (model.Gathering, error) {
	// 1. 내 펫과 UUID 형식의 모집 키를 검증한다.
	key, err := uuid.Parse(in.IdempotencyKey)
	if (in.Kind != "coffee" && in.Kind != "smoke" && in.Kind != "meal" && in.Kind != "chat" && in.Kind != "walk") || err != nil || key == uuid.Nil || len(in.IdempotencyKey) != 36 || key.String() != strings.ToLower(in.IdempotencyKey) {
		return model.Gathering{}, model.Bad(400, "모집 종류와 UUID 형식의 idempotencyKey를 확인하세요")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return model.Gathering{}, err
	}
	defer tx.Rollback()
	var own int
	if err = tx.QueryRow(`SELECT 1 FROM pets WHERE id=? AND user_id=? AND active=1`, p.PetID, p.UserID).Scan(&own); err != nil {
		if err == sql.ErrNoRows {
			return model.Gathering{}, model.Bad(403, "현재 계정의 활성 펫으로만 모집할 수 있습니다")
		}
		return model.Gathering{}, err
	}

	// 2. 저장된 재시도 키와 이미 열린 내 모집은 같은 식별자를 반환한다.
	var id, previousKind string
	created := false
	err = tx.QueryRow(`SELECT r.gathering_id,g.kind FROM gathering_requests r JOIN gatherings g ON g.id=r.gathering_id WHERE r.host_pet_id=? AND r.idempotency_key=?`, p.PetID, key.String()).Scan(&id, &previousKind)
	if err != nil && err != sql.ErrNoRows {
		return model.Gathering{}, err
	}
	if err == nil && previousKind != in.Kind {
		return model.Gathering{}, model.Bad(409, "같은 모집 키로 모집 종류를 바꿀 수 없습니다")
	}
	if err == sql.ErrNoRows {
		err = tx.QueryRow(`SELECT id,kind FROM gatherings WHERE host_pet_id=? AND origin='recruitment' AND status='open' ORDER BY created_at LIMIT 1`, p.PetID).Scan(&id, &previousKind)
		if err == nil && previousKind != in.Kind {
			return model.Gathering{}, model.Bad(409, "진행 중인 모집을 완료한 뒤 다른 종류를 모집하세요")
		}
		if err != nil && err != sql.ErrNoRows {
			return model.Gathering{}, err
		}
		if err == sql.ErrNoRows {
			var busy bool
			if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM gatherings g WHERE g.status='open' AND (g.origin='recruitment' OR g.expires_at>?) AND (g.host_pet_id=? OR EXISTS(SELECT 1 FROM gathering_members m WHERE m.gathering_id=g.id AND m.pet_id=?)))`, time.Now().UnixMilli(), p.PetID, p.PetID).Scan(&busy); err != nil {
				return model.Gathering{}, err
			}
			if busy {
				return model.Gathering{}, model.Bad(409, "현재 함께하기를 먼저 끝내거나 나간 뒤 함께할 친구를 모집하세요")
			}
			if s.Online == nil || !s.Online(p.PetID) {
				return model.Gathering{}, model.Bad(409, "펫이 연결된 상태에서 함께할 친구를 모집할 수 있습니다")
			}
			id = database.ID()
			if _, err = tx.Exec(`INSERT INTO gatherings(id,host_pet_id,kind,origin,status,created_at,expires_at) VALUES(?,?,?,'recruitment','open',?,0)`, id, p.PetID, in.Kind, time.Now().UnixMilli()); err != nil {
				return model.Gathering{}, err
			}
			created = true
		}
		if _, err = tx.Exec(`INSERT INTO gathering_requests(host_pet_id,idempotency_key,gathering_id) VALUES(?,?,?)`, p.PetID, key.String(), id); err != nil {
			return model.Gathering{}, err
		}
	}

	// 3. 모집자와 참여자 응답을 확정하고 메시지 경로와 독립적으로 커밋한다.
	g, err := load(tx, id)
	if err != nil {
		return model.Gathering{}, err
	}
	if err = tx.Commit(); err != nil {
		return model.Gathering{}, err
	}
	if created {
		s.publishActivity("started", p, g, nil)
	}
	return g, nil
}

// Live는 모든 현재 모집과 본인이 관여한 기존 메시지 모임의 실시간 스냅샷을 반환한다.
func (s *Service) Live(p model.Principal) ([]model.Gathering, error) {
	// 1. 모집은 같은 서버의 인증 사용자에게 공개하고 메시지 모임의 기존 조회 권한은 유지한다.
	rows, err := s.DB.Query(gatheringSelect+`WHERE g.status='open' AND (g.origin='recruitment' OR (g.expires_at>? AND (g.host_pet_id=? OR EXISTS(SELECT 1 FROM gathering_members m WHERE m.gathering_id=g.id AND m.pet_id=?)))) ORDER BY g.created_at,g.id`, time.Now().UnixMilli(), p.PetID, p.PetID)
	if err != nil {
		return nil, err
	}
	result := []model.Gathering{}
	for rows.Next() {
		g, scanErr := scanGathering(rows.Scan)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		result = append(result, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	// 2. 첫 조회의 연결을 해제한 뒤 각 모임의 현재 참여자 이름을 붙인다.
	for i := range result {
		members, queryErr := s.DB.Query(membersSelect, result[i].ID)
		if queryErr != nil {
			return nil, queryErr
		}
		result[i].Members, err = readMembers(members)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

// Accept는 모집의 공개 참여와 기존 메시지 제안의 수신자 권한을 구분해 한 모임에 참여한다.
func (s *Service) Accept(p model.Principal, id string) error {
	// 1. 현재 연결과 열린 모임을 확인하고 원본 수신자 검사는 메시지 제안에만 적용한다.
	if s.Online == nil || !s.Online(p.PetID) {
		return model.Bad(409, "연결 중일 때 함께하기에 참여할 수 있습니다")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var host, origin string
	var registered bool
	if err = tx.QueryRow(`SELECT active FROM pets WHERE id=? AND user_id=?`, p.PetID, p.UserID).Scan(&registered); err != nil {
		if err == sql.ErrNoRows {
			return model.Bad(403, "등록한 내 펫으로만 참여할 수 있습니다")
		}
		return err
	}
	if !registered {
		return model.Bad(403, "펫을 먼저 등록하세요")
	}
	err = tx.QueryRow(`SELECT host_pet_id,origin FROM gatherings WHERE id=? AND status='open' AND (origin='recruitment' OR expires_at>?)`, id, time.Now().UnixMilli()).Scan(&host, &origin)
	if err == sql.ErrNoRows {
		return model.Bad(404, "참여할 수 있는 함께하기가 없습니다")
	}
	if err != nil {
		return err
	}
	if host == p.PetID {
		return model.Bad(409, "내가 모집한 함께하기에는 참가자로 참여할 수 없습니다")
	}
	if origin == "message" {
		var recipient int
		if err = tx.QueryRow(`SELECT 1 FROM message_recipients WHERE message_id=? AND pet_id=?`, id, p.PetID).Scan(&recipient); err != nil {
			if err == sql.ErrNoRows {
				return model.Bad(404, "수락할 수 있는 제안이 없습니다")
			}
			return err
		}
		if !s.Online(host) {
			return model.Bad(409, "제안한 친구의 연결이 종료되었습니다")
		}
	}

	// 2. 진행 중인 모집의 주최·참여를 자동으로 해제하지 않고 명시적인 완료나 취소를 요구한다.
	var busy bool
	if err = tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM gatherings g WHERE g.origin='recruitment' AND g.status='open' AND (g.host_pet_id=? OR (g.id<>? AND EXISTS(SELECT 1 FROM gathering_members m WHERE m.gathering_id=g.id AND m.pet_id=?))))`, p.PetID, id, p.PetID).Scan(&busy); err != nil {
		return err
	}
	if busy {
		return model.Bad(409, "진행 중인 모집을 완료하거나 참여를 취소한 뒤 다시 참여하세요")
	}
	if _, err = tx.Exec(`UPDATE gatherings SET status='closed' WHERE origin='message' AND host_pet_id=? AND status='open'`, p.PetID); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM gathering_members WHERE pet_id=? AND gathering_id<>? AND gathering_id IN(SELECT id FROM gatherings WHERE origin='message')`, p.PetID, id); err != nil {
		return err
	}
	inserted, err := tx.Exec(`INSERT OR IGNORE INTO gathering_members(gathering_id,pet_id,accepted_at) VALUES(?,?,?)`, id, p.PetID, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	count, err := inserted.RowsAffected()
	if err != nil {
		return err
	}
	group, err := load(tx, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if origin == "recruitment" && count > 0 {
		s.publishActivity("joined", p, group, []string{host})
	}
	return nil
}

// Complete는 모집자만 무기한 모집을 종료하도록 허용한다.
func (s *Service) Complete(p model.Principal, id string) error {
	// 1. 모집 종류와 소유자를 트랜잭션 안에서 확인한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var host, origin, status string
	err = tx.QueryRow(`SELECT host_pet_id,origin,status FROM gatherings WHERE id=?`, id).Scan(&host, &origin, &status)
	if err == sql.ErrNoRows {
		return model.Bad(404, "모집을 찾을 수 없습니다")
	}
	if err != nil {
		return err
	}
	if origin != "recruitment" {
		return model.Bad(400, "메시지 제안은 기존 함께하기 종료 동작을 사용하세요")
	}
	if host != p.PetID {
		return model.Bad(403, "모집자만 모집을 완료할 수 있습니다")
	}

	// 2. 이미 완료한 요청도 같은 종료 상태로 처리한다.
	group, err := load(tx, id)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`UPDATE gatherings SET status='closed' WHERE id=?`, id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if status == "open" {
		targets := []string{}
		for _, member := range group.Members {
			targets = append(targets, member.PetID)
		}
		group.Status = "closed"
		s.publishActivity("completed", p, group, targets)
	}
	return nil
}

// Leave는 참가자 취소를 허용하되 모집자의 완료 동작을 다른 경로로 우회하지 못하게 한다.
func (s *Service) Leave(p model.Principal, id string) error {
	// 1. 모집자는 완료 API로만 종료하고 기존 메시지 제안자의 종료 계약은 유지한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var host, origin string
	err = tx.QueryRow(`SELECT host_pet_id,origin FROM gatherings WHERE id=?`, id).Scan(&host, &origin)
	if err == sql.ErrNoRows {
		return model.Bad(404, "함께하기를 찾을 수 없습니다")
	}
	if err != nil {
		return err
	}
	if host == p.PetID && origin == "recruitment" {
		return model.Bad(409, "모집자는 모집 완료로 함께하기를 끝내세요")
	}

	// 2. 자신의 기존 제안이나 자신의 참가 관계만 변경한다.
	if _, err = tx.Exec(`UPDATE gatherings SET status='closed' WHERE id=? AND origin='message' AND host_pet_id=?`, id, p.PetID); err != nil {
		return err
	}
	if _, err = tx.Exec(`DELETE FROM gathering_members WHERE gathering_id=? AND pet_id=?`, id, p.PetID); err != nil {
		return err
	}
	return tx.Commit()
}

// Disconnect는 기존 메시지 모임만 마지막 기기 단절 시 정리하고 모집은 보존한다.
func (s *Service) Disconnect(p model.Principal) {
	// 1. 다른 기기가 연결되어 있으면 현재 참여를 유지한다.
	if s.Online != nil && s.Online(p.PetID) {
		return
	}

	// 2. 메시지 제안만 종료하고 무기한 모집의 주최·참여 관계는 변경하지 않는다.
	_, _ = s.DB.Exec(`UPDATE gatherings SET status='closed' WHERE origin='message' AND host_pet_id=? AND status='open'`, p.PetID)
	_, _ = s.DB.Exec(`DELETE FROM gathering_members WHERE pet_id=? AND gathering_id IN(SELECT id FROM gatherings WHERE origin='message')`, p.PetID)
}

// Reset은 서버 재시작 때 기존 메시지 모임만 종료하고 현재 모집과 참여자를 보존한다.
func (s *Service) Reset() {
	_, _ = s.DB.Exec(`UPDATE gatherings SET status='closed' WHERE origin='message' AND status='open'`)
}
