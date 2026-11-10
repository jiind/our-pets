package server_test

import (
	"testing"

	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/model"
)

// TestAccountSettings는 아이디 보호·닉네임 동기화·현재 비밀번호 확인과 세션 폐기를 검증한다.
func TestAccountSettings(t *testing.T) {
	// 1. 계정 조회에는 비밀값이 없고 요청 필드로 아이디·수정 대상을 바꿀 수 없다.
	f := setup(t)
	a, b := f.user("account-owner"), f.user("account-friend")
	var account map[string]any
	f.request("GET", "/me/account", identity.Login{}, nil, 401, nil)
	f.request("GET", "/me/account", a, nil, 200, &account)
	if len(account) != 2 || account["username"] != "account-owner" {
		t.Fatalf("공개 계정 응답 오류: %v", account)
	}
	f.request("PUT", "/me/account", a, map[string]string{"displayName": "변경", "username": "other"}, 400, nil)
	f.request("PUT", "/me/account", a, map[string]string{"displayName": "변경", "userId": b.Principal.UserID}, 400, nil)
	f.request("PUT", "/me/account", a, map[string]string{"displayName": " "}, 400, nil)
	f.request("PUT", "/me/account", a, map[string]string{"displayName": "새 닉네임"}, 200, &account)
	var pet model.Pet
	f.request("GET", "/me/pet", a, nil, 200, &pet)
	if account["username"] != "account-owner" || pet.ID != a.Principal.PetID || pet.Name != "새 닉네임" || pet.OwnerName != "새 닉네임" {
		t.Fatal("아이디·펫 ID 또는 닉네임 동기화 오류")
	}
	f.request("GET", "/me/account", b, nil, 200, &account)
	if account["displayName"] == "새 닉네임" {
		t.Fatal("다른 계정의 닉네임이 바뀜")
	}

	// 2. 현재 비밀번호 확인 전에는 저장·세션 폐기를 수행하지 않는다.
	var second identity.Login
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "account-owner", Password: password}, 200, &second)
	f.request("PUT", "/me/password", a, map[string]string{"currentPassword": "wrong-password", "newPassword": "new-password-456"}, 400, nil)
	f.request("GET", "/me/account", second, nil, 200, nil)
	f.request("PUT", "/me/password", a, map[string]string{"currentPassword": password, "newPassword": "short"}, 400, nil)
	f.request("PUT", "/me/password", a, map[string]string{"currentPassword": password, "newPassword": "new-password-456", "userId": b.Principal.UserID}, 400, nil)

	// 3. 변경 이후에는 새 비밀번호와 현재 세션만 유효하고 다른 사용자는 유지된다.
	f.request("PUT", "/me/password", a, map[string]string{"currentPassword": password, "newPassword": "new-password-456"}, 200, nil)
	f.request("GET", "/me/account", a, nil, 200, nil)
	f.request("GET", "/me/account", second, nil, 401, nil)
	f.request("GET", "/me/account", b, nil, 200, nil)
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "account-owner", Password: password}, 401, nil)
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "account-owner", Password: "new-password-456"}, 200, nil)
}
