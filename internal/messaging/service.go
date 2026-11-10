package messaging

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type Service struct {
	DB     *sql.DB
	TTL    time.Duration
	Online func(string) bool
}

type Send struct {
	ProposalKind     string   `json:"proposalKind,omitempty"`
	ReplyToMessageID string   `json:"replyToMessageId,omitempty"`
	SenderPetID      string   `json:"senderPetId"`
	Mode             string   `json:"mode"`
	PetIDs           []string `json:"petIds"`
	Kind             string   `json:"kind"`
	Body             string   `json:"body"`
	IdempotencyKey   string   `json:"idempotencyKey"`
}

type Accepted struct {
	ID     string   `json:"id"`
	PetIDs []string `json:"petIds"`
	Status string   `json:"status"`
}

var Emojis = map[string]bool{"☕": true, "🍚": true, "👋": true, "❤️": true, "👍": true, "🎉": true}

// Send는 발신 권한을 검증하고 전송 시점의 수신자를 메시지와 함께 확정한다.
func (s *Service) Send(p model.Principal, in Send) (Accepted, error) {
	// 1. 발신자와 본문·대상 선택 계약을 검증하고 요청 지문을 계산한다.
	if in.SenderPetID != p.PetID {
		return Accepted{}, model.Bad(403, "자신의 펫으로만 보낼 수 있습니다")
	}
	if in.ProposalKind != "" {
		return Accepted{}, model.Bad(400, "모집은 POST /api/v1/gatherings로 시작하세요")
	}
	if (in.Mode != "selected" && in.Mode != "all") || (in.Kind != "text" && in.Kind != "emoji" && in.Kind != "interaction") || utf8.RuneCountInString(strings.TrimSpace(in.Body)) < 1 || utf8.RuneCountInString(in.Body) > 2000 || len(in.IdempotencyKey) < 8 || len(in.IdempotencyKey) > 128 || len(in.PetIDs) > 1000 {
		return Accepted{}, model.Bad(400, "메시지와 대상 선택을 확인하세요")
	}
	if in.Kind == "emoji" && !Emojis[in.Body] {
		return Accepted{}, model.Bad(400, "지원하지 않는 이모지입니다")
	}
	if in.Kind == "interaction" && (in.Mode != "selected" || len(in.PetIDs) != 1 || (in.Body != "wave" && in.Body != "highfive")) {
		return Accepted{}, model.Bad(400, "펫 사이 상호작용은 특정 친구에게 인사 또는 하이파이브를 보냅니다")
	}

	if in.Mode == "all" && len(in.PetIDs) > 0 {
		return Accepted{}, model.Bad(400, "전체 전송에는 개별 대상을 넣지 마세요")
	}
	sort.Strings(in.PetIDs)
	unique := []string{}
	for _, id := range in.PetIDs {
		if len(unique) == 0 || unique[len(unique)-1] != id {
			unique = append(unique, id)
		}
	}
	in.PetIDs = unique
	raw, _ := json.Marshal(in)
	sum := sha256.Sum256(raw)
	fingerprint := hex.EncodeToString(sum[:])

	// 2. 같은 멱등성 키의 재시도는 기존 접수 결과를 돌려준다.
	tx, err := s.DB.Begin()
	if err != nil {
		return Accepted{}, err
	}
	defer tx.Rollback()
	var registered bool
	if err = tx.QueryRow(`SELECT active FROM pets WHERE id=? AND user_id=?`, p.PetID, p.UserID).Scan(&registered); err != nil {
		if err == sql.ErrNoRows {
			return Accepted{}, model.Bad(403, "등록한 내 펫으로만 보낼 수 있습니다")
		}
		return Accepted{}, err
	}
	if !registered {
		return Accepted{}, model.Bad(403, "펫을 먼저 등록하세요")
	}
	var previousID, previousHash string
	err = tx.QueryRow(`SELECT id,request_hash FROM messages WHERE sender_pet_id=? AND idempotency_key=?`, p.PetID, in.IdempotencyKey).Scan(&previousID, &previousHash)
	if err == nil {
		if previousHash != fingerprint {
			return Accepted{}, model.Bad(409, "같은 전송 키로 내용을 바꿀 수 없습니다")
		}
		ids, readErr := recipientIDs(tx, previousID)
		return Accepted{ID: previousID, PetIDs: ids, Status: "accepted"}, readErr
	}
	if err != sql.ErrNoRows {
		return Accepted{}, err
	}

	// 3. 전체 전송도 현재 등록된 펫 목록으로 고정하고 잘못된 선택은 모두 거절한다.
	targets := in.PetIDs
	if in.Mode == "all" {
		rows, queryErr := tx.Query(`SELECT id FROM pets WHERE active=1 AND id<>? ORDER BY id`, p.PetID)
		if queryErr != nil {
			return Accepted{}, queryErr
		}
		targets = []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return Accepted{}, err
			}
			if s.Online == nil || s.Online(id) {
				targets = append(targets, id)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return Accepted{}, err
		}
	}
	if len(targets) == 0 {
		return Accepted{}, model.Bad(400, "현재 연결된 수신 펫을 선택하세요")
	}

	for _, id := range targets {
		if s.Online != nil && !s.Online(id) {
			return Accepted{}, model.Bad(409, "지금 연결된 친구에게만 보낼 수 있습니다")
		}
		var exists int
		if id == p.PetID || tx.QueryRow(`SELECT 1 FROM pets WHERE id=? AND active=1`, id).Scan(&exists) != nil {
			return Accepted{}, model.Bad(400, "유효하지 않은 수신 펫입니다")
		}
	}
	if in.ReplyToMessageID != "" {
		if in.Mode != "selected" || len(targets) != 1 || in.Kind == "interaction" {
			return Accepted{}, model.Bad(400, "답장은 원본 발신 펫 한 마리에게 보낼 수 있습니다")
		}
		var authorized int
		if tx.QueryRow(`SELECT 1 FROM messages m JOIN message_recipients r ON r.message_id=m.id WHERE m.id=? AND r.pet_id=? AND m.sender_pet_id=?`, in.ReplyToMessageID, p.PetID, targets[0]).Scan(&authorized) != nil {
			return Accepted{}, model.Bad(404, "답장할 수 있는 원본 메시지를 찾을 수 없습니다")
		}
	}

	// 4. 발신자 스냅샷과 개별 수신자를 한 트랜잭션으로 영속화한다.
	sender := model.Sender{}
	if err = tx.QueryRow(`SELECT u.id,u.display_name,p.id,u.display_name,COALESCE(p.design_id,''),p.builtin_id FROM pets p JOIN users u ON u.id=p.user_id WHERE p.id=?`, p.PetID).Scan(&sender.UserID, &sender.UserName, &sender.PetID, &sender.PetName, &sender.DesignID, &sender.BuiltinID); err != nil {
		return Accepted{}, err
	}
	snapshot, _ := json.Marshal(sender)
	id := database.ID()
	now := time.Now()
	var replyTo any
	if in.ReplyToMessageID != "" {
		replyTo = in.ReplyToMessageID
	}
	if _, err = tx.Exec(`INSERT INTO messages(id,sender_pet_id,kind,body,mode,idempotency_key,request_hash,sender_snapshot,created_at,expires_at,reply_to_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, p.PetID, in.Kind, in.Body, in.Mode, in.IdempotencyKey, fingerprint, string(snapshot), now.UnixMilli(), now.Add(s.TTL).UnixMilli(), replyTo); err != nil {
		return Accepted{}, err
	}

	for _, target := range targets {
		if _, err = tx.Exec(`INSERT INTO message_recipients(message_id,pet_id) VALUES(?,?)`, id, target); err != nil {
			return Accepted{}, err
		}
	}
	return Accepted{ID: id, PetIDs: targets, Status: "accepted"}, tx.Commit()
}

// recipientIDs는 이미 접수된 메시지의 변경되지 않는 수신 펫 목록을 조회한다.
func recipientIDs(tx *sql.Tx, id string) ([]string, error) {
	rows, err := tx.Query(`SELECT pet_id FROM message_recipients WHERE message_id=? ORDER BY pet_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var target string
		if err = rows.Scan(&target); err != nil {
			return nil, err
		}
		result = append(result, target)
	}
	return result, rows.Err()
}

// Status는 발신자에게만 서버 접수와 펫·기기별 앱 수신 상태를 제공한다.
func (s *Service) Status(p model.Principal, id string) (map[string]any, error) {
	// 1. 다른 발신자의 메시지는 존재 여부를 숨긴다.
	var own int
	if s.DB.QueryRow(`SELECT 1 FROM messages WHERE id=? AND sender_pet_id=?`, id, p.PetID).Scan(&own) != nil {
		return nil, model.Bad(404, "메시지를 찾을 수 없습니다")
	}

	// 2. 첫 앱 수신과 기기별 수신 건수를 읽음과 구분한다.
	rows, err := s.DB.Query(`SELECT r.pet_id,r.received_at,(SELECT COUNT(*) FROM device_receipts dr JOIN devices d ON d.id=dr.device_id JOIN pets p ON p.user_id=d.user_id WHERE dr.event_id=r.message_id AND p.id=r.pet_id) FROM message_recipients r WHERE r.message_id=?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	recipients := []map[string]any{}
	for rows.Next() {
		var target string
		var received sql.NullInt64
		var devices int
		if err = rows.Scan(&target, &received, &devices); err != nil {
			return nil, err
		}
		var at any
		if received.Valid {
			at = received.Int64
		}
		recipients = append(recipients, map[string]any{"petId": target, "receivedAt": at, "deviceCount": devices})
	}
	return map[string]any{"id": id, "status": "accepted", "recipients": recipients}, rows.Err()
}
