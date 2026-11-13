package identity

import (
	"crypto/subtle"

	"github.com/jiind/our-pets/internal/model"
)

// DeleteAccount는 현재 비밀번호를 확인하고 본인 계정·펫·메시지·연결 데이터를 원자적으로 삭제한다.
func (s *Service) DeleteAccount(p model.Principal, password string) ([]string, error) {
	// 1. 세션의 소유자를 다시 확인하고 현재 비밀번호로 삭제 권한을 검증한다.
	if len(password) > 256 {
		return nil, model.Bad(400, "현재 비밀번호를 확인하세요")
	}
	var hash, salt []byte
	if err := s.DB.QueryRow(`SELECT password_hash,salt FROM users WHERE id=?`, p.UserID).Scan(&hash, &salt); err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(passwordHash(password, salt), hash) != 1 {
		return nil, model.Bad(400, "현재 비밀번호가 올바르지 않습니다")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 2. 공유 파일의 참조를 먼저 정리할 수 있도록 삭제할 이미지 지문을 모은다.
	rows, err := tx.Query(`SELECT DISTINCT image_hash FROM designs WHERE owner_id=?`, p.UserID)
	if err != nil {
		return nil, err
	}
	images := []string{}
	for rows.Next() {
		var image string
		if err = rows.Scan(&image); err != nil {
			rows.Close()
			return nil, err
		}
		images = append(images, image)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}

	// 3. 외래 키 순서에 따라 모임·수신 기록·발신 메시지와 서버 연결을 제거한다.
	statements := []struct {
		query string
		args  []any
	}{
		{`UPDATE pets SET design_id=NULL,builtin_id='cat' WHERE design_id IN(SELECT id FROM designs WHERE owner_id=?)`, []any{p.UserID}},
		{`DELETE FROM gathering_requests WHERE host_pet_id=? OR gathering_id IN(SELECT id FROM gatherings WHERE host_pet_id=?)`, []any{p.PetID, p.PetID}},
		{`DELETE FROM gathering_members WHERE pet_id=?`, []any{p.PetID}},
		{`DELETE FROM gatherings WHERE host_pet_id=?`, []any{p.PetID}},
		{`DELETE FROM notification_recipients WHERE pet_id=?`, []any{p.PetID}},
		{`DELETE FROM notification_subscriptions WHERE pet_id=?`, []any{p.PetID}},
		{`DELETE FROM notification_subscriptions WHERE connection_id IN(SELECT id FROM connector_connections WHERE owner_id=?)`, []any{p.UserID}},
		{`DELETE FROM external_notifications WHERE connection_id IN(SELECT id FROM connector_connections WHERE owner_id=?)`, []any{p.UserID}},
		{`DELETE FROM connector_connections WHERE owner_id=?`, []any{p.UserID}},
		{`DELETE FROM message_recipients WHERE pet_id=?`, []any{p.PetID}},
		{`DELETE FROM messages WHERE sender_pet_id=?`, []any{p.PetID}},
		{`DELETE FROM device_receipts WHERE device_id IN(SELECT id FROM devices WHERE user_id=?)`, []any{p.UserID}},
		{`DELETE FROM sessions WHERE user_id=?`, []any{p.UserID}},
		{`DELETE FROM devices WHERE user_id=?`, []any{p.UserID}},
		{`DELETE FROM pets WHERE user_id=?`, []any{p.UserID}},
		{`DELETE FROM design_retirements WHERE design_id IN(SELECT id FROM designs WHERE owner_id=?)`, []any{p.UserID}},
		{`DELETE FROM designs WHERE owner_id=?`, []any{p.UserID}},
	}
	for _, statement := range statements {
		if _, err = tx.Exec(statement.query, statement.args...); err != nil {
			return nil, err
		}
	}

	// 4. 병행 비밀번호 변경이 있으면 전체 삭제를 취소하고 기존 계정을 보존한다.
	result, err := tx.Exec(`DELETE FROM users WHERE id=? AND password_hash=?`, p.UserID, hash)
	if err != nil {
		return nil, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if count != 1 {
		return nil, model.Bad(409, "계정 정보가 변경됐어요. 현재 비밀번호를 다시 확인하세요")
	}
	return images, tx.Commit()
}
