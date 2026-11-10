package server

import (
	"net/http"

	"github.com/jiind/our-pets/internal/model"
	"github.com/jiind/our-pets/internal/pets"
)

// updateDesign은 PNG를 받지 않고 본인 외형의 이름·애니메이션 설정만 새 버전으로 저장한다.
func (s *Server) updateDesign(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 허용되지 않은 이미지·소유자 필드를 포함한 요청을 거부한다.
	var in pets.DesignUpdate
	if err := decode(r, &in); err != nil {
		return err
	}

	// 2. 소유권·원본 프레임 검증과 버전 교체는 펫 서비스에 위임한다.
	design, err := s.Pets.UpdateDesign(p, r.PathValue("id"), in)
	if err != nil {
		return err
	}
	return respond(w, 200, design)
}

// deleteDesign은 인증한 소유자의 등록 외형만 선택 목록에서 제거한다.
func (s *Server) deleteDesign(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	if err := s.Pets.DeleteDesign(p, r.PathValue("id")); err != nil {
		return err
	}
	return respond(w, 200, map[string]string{"status": "deleted"})
}
