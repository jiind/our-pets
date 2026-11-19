package identity

import (
	"database/sql"
	"encoding/hex"
	"strings"
	"time"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type DeviceAccess struct {
	Key         string `json:"key"`
	DisplayName string `json:"displayName"`
	Invite      string `json:"invite"`
	DeviceName  string `json:"deviceName"`
}

// deviceKeyHash는 256비트 기기 키의 지문만 서버에서 사용하도록 검증한다.
func deviceKeyHash(key string) (string, error) {
	if len(key) == 64 {
		if _, err := hex.DecodeString(key); err == nil {
			return HashToken(key), nil
		}
	}
	return "", model.Bad(400, "기기 인증 정보를 확인하세요")
}

// AccessDevice는 기존 키로 재접속하거나 초대 코드와 닉네임으로 같은 기기에 새 계정을 만든다.
func (s *Service) AccessDevice(in DeviceAccess) (Login, error) {
	hash, err := deviceKeyHash(in.Key)
	if err != nil {
		return Login{}, err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return Login{}, err
	}
	defer tx.Rollback()

	// 첫 응답을 받지 못한 요청도 같은 키로 재시도하면 기존 계정으로 연결한다.
	var uid, pid string
	c := Credentials{DeviceName: in.DeviceName}
	err = tx.QueryRow(`SELECT d.user_id,p.id,d.id FROM device_keys k
		JOIN devices d ON d.id=k.device_id JOIN pets p ON p.user_id=d.user_id
		WHERE k.key_hash=?`, hash).Scan(&uid, &pid, &c.DeviceID)
	if err == nil {
		login, err := issueSession(tx, uid, pid, c)
		if err != nil {
			return Login{}, err
		}
		return login, tx.Commit()
	}
	if err != sql.ErrNoRows {
		return Login{}, err
	}

	// 아직 등록되지 않은 키는 닉네임과 초대 코드가 모두 있을 때만 새 계정으로 연결한다.
	if in.DisplayName == "" && in.Invite == "" {
		return Login{}, model.Bad(401, "저장한 기기 인증 정보를 사용할 수 없습니다")
	}
	c.DisplayName = strings.TrimSpace(in.DisplayName)
	if len(c.DisplayName) == 0 || len(c.DisplayName) > 80 {
		return Login{}, model.Bad(400, "닉네임은 1~80바이트로 입력하세요")
	}
	if !s.validInvite(in.Invite) {
		return Login{}, model.Bad(403, "가입 코드가 올바르지 않습니다")
	}
	c.Username = "device-" + database.ID()[:24]
	c.Password = database.ID() + database.ID()
	uid, pid, err = createAccount(tx, c)
	if err != nil {
		return Login{}, err
	}
	login, err := issueSession(tx, uid, pid, c)
	if err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(`INSERT INTO device_keys(device_id,key_hash) VALUES(?,?)`, login.Principal.DeviceID, hash); err != nil {
		return Login{}, err
	}
	return login, tx.Commit()
}

// RememberDevice는 유효한 기존 로그인에 처음으로 영속 기기 키를 연결한다.
func (s *Service) RememberDevice(p model.Principal, key string) error {
	hash, err := deviceKeyHash(key)
	if err != nil {
		return err
	}
	result, err := s.DB.Exec(`INSERT INTO device_keys(device_id,key_hash)
		SELECT device_id,? FROM sessions WHERE token_hash=? AND device_id=? AND user_id=? AND expires_at>?
		ON CONFLICT(device_id) DO UPDATE SET key_hash=excluded.key_hash
		WHERE device_keys.key_hash=excluded.key_hash`,
		hash, p.SessionHash, p.DeviceID, p.UserID, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return model.Bad(409, "이 기기에 저장된 인증 정보를 확인하지 못했습니다")
	}
	return err
}
