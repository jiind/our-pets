package identity

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"regexp"
	"strings"
	"time"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type Service struct {
	DB     *sql.DB
	Invite string
}

type Credentials struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	PetName     string `json:"petName"`
	Invite      string `json:"invite"`
	DeviceID    string `json:"deviceId"`
	DeviceName  string `json:"deviceName"`
}

type Login struct {
	Token     string          `json:"token"`
	Principal model.Principal `json:"principal"`
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{2,31}$`)

// HashToken은 원본 세션 토큰 대신 저장할 단방향 지문을 계산한다.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// passwordHash는 무작위 소금과 반복 해시로 비밀번호를 검증 가능한 값으로 변환한다.
func passwordHash(password string, salt []byte) []byte {
	hash, _ := pbkdf2.Key(sha256.New, password, salt, 210000, 32)
	return hash
}

// Register는 계정을 만들고 별도 등록에 사용할 미등록 대표 펫 ID만 발급한다.
func (s *Service) Register(c Credentials) (Login, error) {
	// 1. 식별 정보와 LAN 가입 코드를 검증한다.
	c.Username = strings.ToLower(strings.TrimSpace(c.Username))
	c.DisplayName = strings.TrimSpace(c.DisplayName)
	if !usernamePattern.MatchString(c.Username) || len(c.Password) < 10 || len(c.Password) > 256 || len(strings.TrimSpace(c.DisplayName)) < 1 || len(c.DisplayName) > 80 || len(c.PetName) > 80 {
		return Login{}, model.Bad(400, "아이디 3~32자, 비밀번호 10~256자와 가입 정보를 확인하세요")
	}
	if s.Invite == "" || subtle.ConstantTimeCompare([]byte(s.Invite), []byte(c.Invite)) != 1 {
		return Login{}, model.Bad(403, "가입 코드가 올바르지 않습니다")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return Login{}, err
	}
	uid, pid := database.ID(), database.ID()
	petName := c.DisplayName

	// 2. 기존 펫 등록과 분리한 비활성 펫을 저장하고 안정적인 ID는 유지한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return Login{}, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`INSERT INTO users VALUES(?,?,?,?,?,?)`, uid, c.Username, c.DisplayName, passwordHash(c.Password, salt), salt, time.Now().UnixMilli()); err != nil {
		return Login{}, model.Bad(409, "사용할 수 없는 아이디입니다")
	}
	if _, err = tx.Exec(`INSERT INTO pets(id,user_id,name,active) VALUES(?,?,?,0)`, pid, uid, petName); err != nil {
		return Login{}, err
	}
	if err = tx.Commit(); err != nil {
		return Login{}, err
	}
	return s.newSession(uid, pid, c)
}

// Authenticate는 로컬 계정 비밀번호를 검증하고 기기 세션을 발급한다.
func (s *Service) Authenticate(c Credentials) (Login, error) {
	// 1. 존재하지 않는 계정도 같은 비밀번호 해시 경로를 거친다.
	var uid, pid string
	var hash, salt []byte
	err := s.DB.QueryRow(`SELECT u.id,p.id,u.password_hash,u.salt FROM users u JOIN pets p ON p.user_id=u.id WHERE u.username=?`, strings.ToLower(strings.TrimSpace(c.Username))).Scan(&uid, &pid, &hash, &salt)
	if len(c.Password) > 256 {
		return Login{}, model.Bad(401, "로그인 정보를 확인하세요")
	}
	if err != nil {
		salt = make([]byte, 16)
	}
	candidate := passwordHash(c.Password, salt)
	if err != nil || subtle.ConstantTimeCompare(candidate, hash) != 1 {
		return Login{}, model.Bad(401, "로그인 정보를 확인하세요")
	}

	// 2. 기기 소유권을 유지하면서 새 세션을 발급한다.
	return s.newSession(uid, pid, c)
}

// newSession은 기기를 소유자에 연결하고 만료되는 난수 토큰을 저장한다.
func (s *Service) newSession(uid, pid string, c Credentials) (Login, error) {
	// 1. 알 수 없는 기기 ID는 서버가 새로 생성한다.
	var owner string
	if c.DeviceID != "" {
		_ = s.DB.QueryRow(`SELECT user_id FROM devices WHERE id=?`, c.DeviceID).Scan(&owner)
	}
	if owner != uid {
		c.DeviceID = database.ID()
	}
	if len(c.DeviceName) > 80 {
		c.DeviceName = "desktop"
	}
	token := database.ID() + database.ID()
	p := model.Principal{UserID: uid, PetID: pid, DeviceID: c.DeviceID, ExpiresAt: time.Now().Add(30 * 24 * time.Hour).UnixMilli()}

	// 2. 토큰 원문은 응답에만 넣고 데이터베이스에는 지문을 남긴다.
	tx, err := s.DB.Begin()
	if err != nil {
		return Login{}, err
	}
	defer tx.Rollback()
	if err = tx.QueryRow(`SELECT active FROM pets WHERE id=? AND user_id=?`, pid, uid).Scan(&p.PetRegistered); err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(`INSERT INTO devices(id,user_id,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`, c.DeviceID, uid, c.DeviceName); err != nil {
		return Login{}, err
	}
	if _, err = tx.Exec(`INSERT INTO sessions VALUES(?,?,?,?)`, HashToken(token), uid, c.DeviceID, p.ExpiresAt); err != nil {
		return Login{}, err
	}
	return Login{Token: token, Principal: p}, tx.Commit()
}

// Resolve는 펫 등록 전에도 유효한 계정을 인증하고 현재 펫 등록 상태를 함께 반환한다.
func (s *Service) Resolve(token string) (model.Principal, error) {
	var p model.Principal
	err := s.DB.QueryRow(`SELECT s.user_id,s.device_id,p.id,s.expires_at,p.active FROM sessions s JOIN pets p ON p.user_id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`, HashToken(token), time.Now().UnixMilli()).Scan(&p.UserID, &p.DeviceID, &p.PetID, &p.ExpiresAt, &p.PetRegistered)
	if err != nil {
		return p, model.Bad(401, "로그인이 필요합니다")
	}
	p.SessionHash = HashToken(token)
	return p, nil
}

// Logout은 현재 기기에서 사용한 세션 토큰을 폐기한다.
func (s *Service) Logout(token string) error {
	_, err := s.DB.Exec(`DELETE FROM sessions WHERE token_hash=?`, HashToken(token))
	return err
}
