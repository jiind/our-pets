package pets

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/model"
)

type DesignUpdate struct {
	Name     string         `json:"name"`
	Manifest model.Manifest `json:"manifest"`
}

// editableDesign은 기본 펫과 타인·삭제된 외형의 수정을 막고 현재 소유 버전을 반환한다.
func (s *Service) editableDesign(p model.Principal, id string) (model.Design, error) {
	// 1. 기본 펫은 계정의 업로드 외형이 아니므로 변경하지 못하게 한다.
	if _, builtin := builtinSelection(id); builtin {
		return model.Design{}, model.Bad(403, "기본 펫은 수정하거나 삭제할 수 없습니다")
	}
	design, err := s.Design(id)
	if err != nil {
		return design, err
	}
	if design.OwnerID != p.UserID {
		return design, model.Bad(403, "직접 등록한 펫만 수정하거나 삭제할 수 있습니다")
	}

	// 2. 이미 교체·삭제된 버전에 새 변경이 덮어써지지 않게 한다.
	var retired int
	err = s.DB.QueryRow(`SELECT COUNT(*) FROM design_retirements WHERE design_id=?`, id).Scan(&retired)
	if err == nil && retired > 0 {
		err = model.Bad(409, "이미 수정하거나 삭제한 펫입니다. 목록을 새로고침하세요")
	}
	return design, err
}

// UpdateDesign은 PNG를 교체하지 않고 검증된 설정을 새 불변 버전으로 저장한다.
func (s *Service) UpdateDesign(p model.Principal, id string, in DesignUpdate) (model.Design, error) {
	// 1. 소유권과 원본 PNG에 대한 프레임 설정을 검증한다.
	previous, err := s.editableDesign(p, id)
	if err != nil {
		return model.Design{}, err
	}
	in.Name = strings.TrimSpace(in.Name)
	if len(in.Name) == 0 || len(in.Name) > 80 {
		return model.Design{}, model.Bad(400, "디자인 이름은 1~80바이트여야 합니다")
	}
	image, err := os.ReadFile(filepath.Join(s.Directory, previous.ImageHash+".png"))
	if err != nil {
		return model.Design{}, err
	}
	if err = Validate(image, &in.Manifest); err != nil {
		return model.Design{}, err
	}

	// 2. 이전 버전을 목록에서 제거하고 같은 PNG를 참조하는 새 버전을 추가한다.
	tx, err := s.DB.Begin()
	if err != nil {
		return model.Design{}, err
	}
	defer tx.Rollback()
	if err = retireDesign(tx, id); err != nil {
		return model.Design{}, err
	}
	design := model.Design{ID: database.ID(), OwnerID: p.UserID, Name: in.Name, ImageHash: previous.ImageHash, Manifest: in.Manifest}
	if err = tx.QueryRow(`SELECT COALESCE(MAX(version),0)+1 FROM designs WHERE owner_id=?`, p.UserID).Scan(&design.Version); err != nil {
		return model.Design{}, err
	}
	raw, err := json.Marshal(in.Manifest)
	if err != nil {
		return model.Design{}, err
	}
	if _, err = tx.Exec(`INSERT INTO designs VALUES(?,?,?,?,?,?,?)`, design.ID, design.OwnerID, design.Version, design.Name, design.ImageHash, string(raw), time.Now().UnixMilli()); err != nil {
		return model.Design{}, err
	}

	// 3. 소유자가 사용 중인 외형만 교체하고 다른 사용자의 기존 참조는 보존한다.
	if _, err = tx.Exec(`UPDATE pets SET design_id=? WHERE user_id=? AND design_id=?`, design.ID, p.UserID, id); err != nil {
		return model.Design{}, err
	}
	return design, tx.Commit()
}

// DeleteDesign은 선택 목록에서 외형을 제거하고 소유자가 사용 중이면 고양이로 되돌린다.
func (s *Service) DeleteDesign(p model.Principal, id string) error {
	// 1. 직접 등록한 현재 외형에만 삭제를 허용한다.
	if _, err := s.editableDesign(p, id); err != nil {
		return err
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = retireDesign(tx, id); err != nil {
		return err
	}

	// 2. 펫 ID·메시지 관계·공유 PNG를 유지한 채 본인의 외형 참조만 해제한다.
	if _, err = tx.Exec(`UPDATE pets SET design_id=NULL,builtin_id='cat' WHERE user_id=? AND design_id=?`, p.UserID, id); err != nil {
		return err
	}
	return tx.Commit()
}

// retireDesign은 중복·동시 변경을 충돌로 처리하며 기존 불변 외형을 목록에서만 제거한다.
func retireDesign(tx *sql.Tx, id string) error {
	result, err := tx.Exec(`INSERT OR IGNORE INTO design_retirements VALUES(?,?)`, id, time.Now().UnixMilli())
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err == nil && changed == 0 {
		return model.Bad(409, "이미 수정하거나 삭제한 펫입니다. 목록을 새로고침하세요")
	}
	return err
}

// RemoveUnusedImages는 삭제한 디자인의 PNG 중 다른 디자인이 참조하지 않는 파일만 제거한다.
func (s *Service) RemoveUnusedImages(hashes []string) error {
	s.imagesMu.Lock()
	defer s.imagesMu.Unlock()
	// 1. 파일 경로는 서버가 생성한 SHA-256 형식으로 제한한다.
	for _, hash := range hashes {
		if len(hash) != 64 || strings.Trim(hash, "0123456789abcdef") != "" {
			continue
		}
		var references int
		if err := s.DB.QueryRow(`SELECT COUNT(*) FROM designs WHERE image_hash=?`, hash).Scan(&references); err != nil {
			return err
		}

		// 2. 공유 중인 이미지와 사용자 업로드 이외의 파일은 보존한다.
		if references == 0 {
			if err := os.Remove(filepath.Join(s.Directory, hash+".png")); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
	}
	return nil
}

// CleanupUnusedImages는 삭제 실패나 중단된 업로드로 남은 오래된 PNG만 다시 정리한다.
func (s *Service) CleanupUnusedImages() error {
	// 1. 진행 중인 업로드와 겹치지 않도록 한 시간 이상 지난 완성 PNG만 고른다.
	entries, err := os.ReadDir(s.Directory)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	hashes := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".png") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if time.Since(info.ModTime()) > time.Hour {
			hashes = append(hashes, strings.TrimSuffix(entry.Name(), ".png"))
		}
	}

	// 2. 실제 DB 참조는 삭제 직전에 잠금 안에서 다시 확인한다.
	return s.RemoveUnusedImages(hashes)
}
