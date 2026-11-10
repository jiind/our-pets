package server

import (
	"net/http"

	"github.com/jiind/our-pets/internal/model"
)

// account는 로그인한 사용자 자신의 공개 계정 설정만 조회한다.
func (s *Server) account(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	account, err := s.Identity.Account(p)
	if err != nil {
		return err
	}
	return respond(w, 200, account)
}

// updateAccount는 아이디·사용자 ID를 받지 않고 세션 소유자의 닉네임만 수정한다.
func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 허용된 닉네임 필드만 해석한다.
	var in struct {
		DisplayName string `json:"displayName"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}

	// 2. 계정과 펫 이름의 원자적 변경을 인증 서비스에 위임한다.
	account, err := s.Identity.UpdateNickname(p, in.DisplayName)
	if err != nil {
		return err
	}
	return respond(w, 200, account)
}

// changePassword는 로그인과 같은 요청 제한 아래 현재 비밀번호를 확인해 변경한다.
func (s *Server) changePassword(w http.ResponseWriter, r *http.Request, p model.Principal) error {
	// 1. 비밀번호 추측 요청을 제한하고 허용된 두 필드만 받는다.
	if !s.allowLogin(r) {
		return model.Bad(429, "잠시 후 다시 시도하세요")
	}
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decode(r, &in); err != nil {
		return err
	}

	// 2. 원문을 응답에 포함하지 않고 변경 성공 여부만 반환한다.
	if err := s.Identity.ChangePassword(p, in.CurrentPassword, in.NewPassword); err != nil {
		return err
	}
	return respond(w, 200, map[string]string{"status": "changed"})
}
