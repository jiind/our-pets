package identity

import (
	"crypto/rand"
	"crypto/subtle"
	"strings"

	"github.com/jiind/our-pets/internal/model"
)

type Account struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

// Account는 세션 소유자의 수정 불가 아이디와 현재 닉네임만 반환한다.
func (s *Service) Account(p model.Principal) (Account, error) {
	var account Account
	err := s.DB.QueryRow(`SELECT username,display_name FROM users WHERE id=?`, p.UserID).Scan(&account.Username, &account.DisplayName)
	return account, err
}

// UpdateNickname은 사용자와 대표 펫의 표시 이름을 같은 트랜잭션으로 변경한다.
func (s *Service) UpdateNickname(p model.Principal, name string) (Account, error) {
	// 1. 닉네임은 가입 시와 같은 길이로 제한하고 아이디 변경은 받지 않는다.
	name = strings.TrimSpace(name)
	if len(name) == 0 || len(name) > 80 {
		return Account{}, model.Bad(400, "닉네임은 1~80바이트로 입력하세요")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return Account{}, err
	}
	defer tx.Rollback()

	// 2. 안정적인 사용자·펫 ID를 보존하고 이전 클라이언트용 이름도 함께 갱신한다.
	if _, err = tx.Exec(`UPDATE users SET display_name=? WHERE id=?`, name, p.UserID); err != nil {
		return Account{}, err
	}
	if _, err = tx.Exec(`UPDATE pets SET name=? WHERE user_id=?`, name, p.UserID); err != nil {
		return Account{}, err
	}
	if err = tx.Commit(); err != nil {
		return Account{}, err
	}
	return s.Account(p)
}

// ChangePassword는 현재 비밀번호 확인 후 새 해시를 저장하고 다른 세션을 폐기한다.
func (s *Service) ChangePassword(p model.Principal, current, next string) error {
	// 1. 현재 비밀번호를 확인하고 새 비밀번호를 기존 가입 정책으로 검증한다.
	if len(current) > 256 || len(next) < 10 || len(next) > 256 {
		return model.Bad(400, "새 비밀번호는 10~256바이트로 입력하세요")
	}
	var hash, salt []byte
	if err := s.DB.QueryRow(`SELECT password_hash,salt FROM users WHERE id=?`, p.UserID).Scan(&hash, &salt); err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(passwordHash(current, salt), hash) != 1 {
		return model.Bad(400, "현재 비밀번호가 올바르지 않습니다")
	}
	newSalt := make([]byte, 16)
	if _, err := rand.Read(newSalt); err != nil {
		return err
	}
	newHash := passwordHash(next, newSalt)

	// 2. 동시에 변경한 비밀번호를 덮어쓰지 않고 현재 로그인만 유지한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`UPDATE users SET password_hash=?,salt=? WHERE id=? AND password_hash=?`, newHash, newSalt, p.UserID, hash)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return model.Bad(409, "비밀번호가 이미 변경됐어요. 현재 비밀번호를 다시 확인하세요")
	}
	if _, err = tx.Exec(`DELETE FROM sessions WHERE user_id=? AND token_hash<>?`, p.UserID, p.SessionHash); err != nil {
		return err
	}
	return tx.Commit()
}
