package pets

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

const MaxUpload = 8 << 20

var animationIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

type Service struct {
	DB        *sql.DB
	Directory string
	Online    func(string) bool
}

type Registration struct {
	Name     string `json:"name"`
	DesignID string `json:"designId"`
}

// Current는 미등록 상태를 포함해 인증한 계정의 동일한 대표 펫을 조회한다.
func (s *Service) Current(p model.Principal) (model.Pet, error) {
	// 1. 다른 계정의 펫을 조회하지 않고 등록 상태와 외형 참조를 함께 읽는다.
	var pet model.Pet
	var designID sql.NullString
	err := s.DB.QueryRow(`SELECT p.id,p.user_id,u.display_name,u.display_name,p.active,p.design_id,p.builtin_id FROM pets p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.user_id=?`, p.PetID, p.UserID).Scan(&pet.ID, &pet.UserID, &pet.OwnerName, &pet.Name, &pet.Registered, &designID, &pet.BuiltinID)
	if err == sql.ErrNoRows {
		return pet, model.Bad(404, "내 펫을 찾을 수 없습니다")
	}
	if err != nil {
		return pet, err
	}

	// 2. 등록된 외형과 현재 접속 여부를 붙이되 미등록 펫은 접속 중으로 표시하지 않는다.
	if designID.Valid {
		design, readErr := s.Design(designID.String)
		if readErr != nil {
			return pet, readErr
		}
		pet.Design = &design
	}
	if pet.Registered && s.Online != nil {
		pet.Online = s.Online(pet.ID)
	}
	return pet, nil
}

// OwnDesigns는 등록 전에 올려 둔 디자인도 다시 선택할 수 있도록 본인 버전을 조회한다.
func (s *Service) OwnDesigns(p model.Principal) ([]model.Design, error) {
	// 1. 미적용 디자인을 포함한 본인 버전만 최신순으로 조회한다.
	rows, err := s.DB.Query(`SELECT id,owner_id,version,name,image_hash,manifest FROM designs WHERE owner_id=? AND NOT EXISTS(SELECT 1 FROM design_retirements WHERE design_id=designs.id) ORDER BY version DESC`, p.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// 2. 저장된 선언형 설정을 복원해 등록 화면의 선택 목록으로 반환한다.
	designs := []model.Design{}
	for rows.Next() {
		var design model.Design
		var manifest string
		if err = rows.Scan(&design.ID, &design.OwnerID, &design.Version, &design.Name, &design.ImageHash, &manifest); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(manifest), &design.Manifest); err != nil {
			return nil, err
		}
		designs = append(designs, design)
	}
	return designs, rows.Err()
}

// Register는 대표 펫 ID를 유지하며 계정 닉네임과 선택한 외형을 등록하거나 갱신한다.
func (s *Service) Register(p model.Principal, in Registration) (model.Pet, error) {
	// 1. 외형을 검증하고 표시 이름은 요청값 대신 인증한 계정에서 읽는다.
	if in.DesignID == "" {
		return model.Pet{}, model.Bad(400, "등록할 외형을 선택하세요")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return model.Pet{}, err
	}
	defer tx.Rollback()
	var registered bool
	var previousDesign sql.NullString
	if err = tx.QueryRow(`SELECT p.active,p.design_id,u.display_name FROM pets p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.user_id=?`, p.PetID, p.UserID).Scan(&registered, &previousDesign, &in.Name); err != nil {
		if err == sql.ErrNoRows {
			return model.Pet{}, model.Bad(404, "내 펫을 찾을 수 없습니다")
		}
		return model.Pet{}, err
	}
	var designID any
	builtinID, builtin := builtinSelection(in.DesignID)
	if !builtin {
		builtinID = "cat"
		var owner string
		err = tx.QueryRow(`SELECT owner_id FROM designs WHERE id=?`, in.DesignID).Scan(&owner)
		if err == sql.ErrNoRows {
			return model.Pet{}, model.Bad(404, "등록할 디자인을 찾을 수 없습니다")
		}
		if err != nil {
			return model.Pet{}, err
		}
		if owner != p.UserID && !(registered && previousDesign.Valid && previousDesign.String == in.DesignID) {
			return model.Pet{}, model.Bad(403, "내가 올린 디자인으로만 펫을 등록할 수 있습니다")
		}
		if !previousDesign.Valid || previousDesign.String != in.DesignID {
			var retired int
			if err = tx.QueryRow(`SELECT COUNT(*) FROM design_retirements WHERE design_id=?`, in.DesignID).Scan(&retired); err != nil {
				return model.Pet{}, err
			}
			if retired > 0 {
				return model.Pet{}, model.Bad(409, "목록에서 삭제되거나 수정된 펫입니다. 목록을 새로고침하세요")
			}
		}
		designID = in.DesignID
	}

	// 2. 신규 펫을 만들지 않고 한 계정의 기존 펫을 이름·외형과 함께 활성화한다.
	if _, err = tx.Exec(`UPDATE pets SET name=?,design_id=?,builtin_id=?,active=1 WHERE id=? AND user_id=?`, in.Name, designID, builtinID, p.PetID, p.UserID); err != nil {
		return model.Pet{}, err
	}
	if err = tx.Commit(); err != nil {
		return model.Pet{}, err
	}
	return s.Current(p)
}

// List는 디자인과 소유자를 포함한 유효한 수신 펫 목록을 조회한다.
func (s *Service) List() ([]model.Pet, error) {
	// 1. 디자인 메타데이터를 한 번의 조인으로 가져온다.
	rows, err := s.DB.Query(`SELECT p.id,p.user_id,u.display_name,u.display_name,COALESCE(d.id,''),COALESCE(d.owner_id,''),COALESCE(d.version,0),COALESCE(d.name,''),COALESCE(d.image_hash,''),COALESCE(d.manifest,'{}'),p.builtin_id FROM pets p JOIN users u ON u.id=p.user_id LEFT JOIN designs d ON d.id=p.design_id WHERE p.active=1 ORDER BY u.display_name,p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Pet{}

	// 2. 디자인이 없는 기본 펫과 기기 접속 상태를 구분한다.
	for rows.Next() {
		var p model.Pet
		var d model.Design
		var manifest string
		if err = rows.Scan(&p.ID, &p.UserID, &p.OwnerName, &p.Name, &d.ID, &d.OwnerID, &d.Version, &d.Name, &d.ImageHash, &manifest, &p.BuiltinID); err != nil {
			return nil, err
		}
		if d.ID != "" {
			if err = json.Unmarshal([]byte(manifest), &d.Manifest); err != nil {
				return nil, err
			}
			p.Design = &d
		}
		p.Registered = true
		if s.Online != nil {
			p.Online = s.Online(p.ID)
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

// Design는 등록된 불변 디자인 버전 하나를 조회한다.
func (s *Service) Design(id string) (model.Design, error) {
	var d model.Design
	var raw string
	err := s.DB.QueryRow(`SELECT id,owner_id,version,name,image_hash,manifest FROM designs WHERE id=?`, id).Scan(&d.ID, &d.OwnerID, &d.Version, &d.Name, &d.ImageHash, &raw)
	if err == sql.ErrNoRows {
		return d, model.Bad(404, "디자인을 찾을 수 없습니다")
	}
	if err != nil {
		return d, err
	}
	return d, json.Unmarshal([]byte(raw), &d.Manifest)
}

// Validate는 PNG 디코딩 결과와 선택적인 스프라이트 프레임 규격을 검증한다.
func Validate(data []byte, m *model.Manifest) error {
	// 1. 파일 길이와 실제 PNG 헤더의 픽셀 수를 제한한다.
	if len(data) == 0 || len(data) > MaxUpload {
		return model.Bad(400, "PNG 파일은 8 MiB 이하여야 합니다")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 2048 || cfg.Height > 2048 {
		return model.Bad(400, "최대 2048×2048 PNG 이미지를 사용하세요")
	}
	for offset := 8; offset+12 <= len(data); {
		size := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		if size < 0 || size > len(data)-offset-12 {
			return model.Bad(400, "손상된 PNG입니다")
		}
		if string(data[offset+4:offset+8]) == "acTL" {
			return model.Bad(400, "APNG 대신 PNG 스프라이트 시트를 사용하세요")
		}
		offset += size + 12
	}
	if _, err = png.Decode(bytes.NewReader(data)); err != nil {
		return model.Bad(400, "PNG 픽셀을 디코딩할 수 없습니다")
	}

	// 2. 누락된 애니메이션은 기본 이미지로 대체할 수 있게 정규화한다.
	if m.SchemaVersion == 0 {
		m.SchemaVersion = 1
	}
	if m.FrameWidth == 0 && m.FrameHeight == 0 {
		m.FrameWidth, m.FrameHeight = cfg.Width, cfg.Height
	}
	if (m.SchemaVersion != 1 && m.SchemaVersion != 2) || m.DisplaySize < 48 || m.DisplaySize > 200 || m.FrameWidth < 1 || m.FrameHeight < 1 || cfg.Width%m.FrameWidth != 0 || cfg.Height%m.FrameHeight != 0 {
		return model.Bad(400, "표시 크기 48~200과 PNG를 나누어 떨어지는 프레임 크기를 확인하세요")
	}
	count := (cfg.Width / m.FrameWidth) * (cfg.Height / m.FrameHeight)
	limit := 3
	if m.SchemaVersion == 2 {
		limit = 32
	}
	if count > 256 || len(m.Animations) > limit {
		return model.Bad(400, "프레임은 최대 256개, 애니메이션은 최대 32개까지 등록할 수 있습니다")
	}
	for name, a := range m.Animations {
		validName := name == "idle" || name == "walk" || name == "react"
		if m.SchemaVersion == 2 {
			validName = animationIDPattern.MatchString(name) && name != "__proto__" && name != "constructor" && name != "prototype" && len(strings.TrimSpace(a.Name)) > 0 && len(a.Name) <= 80
		}
		if !validName || a.FPS < 1 || a.FPS > 24 || len(a.Frames) < 1 || len(a.Frames) > 256 {
			return model.Bad(400, "동작 이름과 FPS(1~24)를 확인하세요")
		}
		for _, frame := range a.Frames {
			if frame < 0 || frame >= count {
				return model.Bad(400, "이미지 범위를 벗어난 프레임입니다")
			}
		}
	}
	// 3. 자유 애니메이션의 자동 대기·이동 역할은 실제로 존재하는 항목에만 연결한다.
	if m.SchemaVersion == 2 && len(m.Animations) > 0 {
		for _, id := range []string{m.IdleAnimation, m.WalkAnimation} {
			if _, exists := m.Animations[id]; !exists {
				return model.Bad(400, "대기·걷기에 사용할 애니메이션을 선택하세요")
			}
		}
	}
	return nil
}

// Upload는 기존 호출의 자동 적용을 유지하되 미등록 펫은 외형 저장만 허용한다.
func (s *Service) Upload(p model.Principal, name string, m model.Manifest, r io.Reader) (model.Design, error) {
	return s.upload(p, name, m, r, true)
}

// UploadDraft는 등록 화면의 외형 선택이 완료되기 전에는 기존 펫에도 적용하지 않고 저장한다.
func (s *Service) UploadDraft(p model.Principal, name string, m model.Manifest, r io.Reader) (model.Design, error) {
	return s.upload(p, name, m, r, false)
}

// upload는 검증한 PNG와 불변 버전을 저장하고 등록된 펫에만 선택적으로 적용한다.
func (s *Service) upload(p model.Principal, name string, m model.Manifest, r io.Reader, apply bool) (model.Design, error) {
	// 1. 클라이언트의 파일명이나 MIME을 신뢰하지 않고 실제 바이트를 검증한다.
	data, err := io.ReadAll(io.LimitReader(r, MaxUpload+1))
	if err != nil {
		return model.Design{}, err
	}
	if len(strings.TrimSpace(name)) < 1 || len(name) > 80 {
		return model.Design{}, model.Bad(400, "디자인 이름은 1~80자여야 합니다")
	}
	if err = Validate(data, &m); err != nil {
		return model.Design{}, err
	}
	hash := sha256.Sum256(data)
	d := model.Design{ID: database.ID(), OwnerID: p.UserID, Name: name, ImageHash: hex.EncodeToString(hash[:]), Manifest: m}
	if err = os.MkdirAll(s.Directory, 0700); err != nil {
		return d, err
	}
	path := filepath.Join(s.Directory, d.ImageHash+".png")

	// 2. 같은 내용의 파일은 재사용하고 임시 파일을 원자적으로 반영한다.
	temp, err := os.CreateTemp(s.Directory, "upload-*.png")
	if err != nil {
		return d, err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return d, err
	}
	if err = temp.Close(); err != nil {
		return d, err
	}
	if err = os.Rename(temp.Name(), path); err != nil {
		if _, statErr := os.Stat(path); statErr != nil {
			return d, err
		}
	}

	// 3. 불변 버전을 저장하고 명시적인 등록 전에는 펫 외형이나 활성 상태를 바꾸지 않는다.
	tx, err := s.DB.Begin()
	if err != nil {
		return d, err
	}
	defer tx.Rollback()
	if err = tx.QueryRow(`SELECT COALESCE(MAX(version),0)+1 FROM designs WHERE owner_id=?`, p.UserID).Scan(&d.Version); err != nil {
		return d, err
	}
	raw, _ := json.Marshal(m)
	if _, err = tx.Exec(`INSERT INTO designs VALUES(?,?,?,?,?,?,?)`, d.ID, d.OwnerID, d.Version, d.Name, d.ImageHash, string(raw), time.Now().UnixMilli()); err != nil {
		return d, err
	}
	if apply {
		if _, err = tx.Exec(`UPDATE pets SET design_id=? WHERE id=? AND user_id=? AND active=1`, d.ID, p.PetID, p.UserID); err != nil {
			return d, err
		}
	}
	return d, tx.Commit()
}

// Apply는 공개된 디자인을 자신의 대표 펫에 연결하며 타인의 버전을 수정하지 않는다.
func (s *Service) Apply(p model.Principal, designID string) error {
	// 1. 외형 적용을 이용해 미등록 펫을 활성화하지 못하게 한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var registered bool
	err = tx.QueryRow(`SELECT active FROM pets WHERE id=? AND user_id=?`, p.PetID, p.UserID).Scan(&registered)
	if err != nil {
		if err == sql.ErrNoRows {
			return model.Bad(404, "내 펫을 찾을 수 없습니다")
		}
		return err
	}
	if !registered {
		return model.Bad(403, "펫을 먼저 등록하세요")
	}

	// 2. 기존 공개 디자인 적용과 내장 기본 외형 복귀를 같은 대표 펫에 반영한다.
	var reference any
	builtinID, builtin := builtinSelection(designID)
	if !builtin {
		builtinID = "cat"
		var exists int
		err = tx.QueryRow(`SELECT 1 FROM designs WHERE id=? AND NOT EXISTS(SELECT 1 FROM design_retirements WHERE design_id=designs.id)`, designID).Scan(&exists)
		if err == sql.ErrNoRows {
			return model.Bad(404, "디자인을 찾을 수 없습니다")
		}
		if err != nil {
			return err
		}
		reference = designID
	}
	if _, err = tx.Exec(`UPDATE pets SET design_id=?,builtin_id=? WHERE id=? AND user_id=? AND active=1`, reference, builtinID, p.PetID, p.UserID); err != nil {
		return err
	}
	return tx.Commit()
}
