package server_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/model"
)

// TestAccountRegistrationBoundary는 닉네임과 별개인 가입·펫 등록·세션 폐기 경계를 검증한다.
func TestAccountRegistrationBoundary(t *testing.T) {
	// 1. 잘못된 가입 정보를 거부하고 등록 전 펫은 수신 목록에 노출하지 않는다.
	f := setup(t)
	credentials := identity.Credentials{Username: "new-user", Password: password, DisplayName: "새 닉네임", Invite: "wrong-invite"}
	f.request("POST", "/register", identity.Login{}, credentials, 403, nil)
	credentials.Invite = invite
	credentials.Username = "!bad"
	f.request("POST", "/register", identity.Login{}, credentials, 400, nil)
	credentials.Username = "new-user"
	var login identity.Login
	f.request("POST", "/register", identity.Login{}, credentials, 201, &login)
	if login.Principal.PetRegistered {
		t.Fatal("계정 생성이 펫을 자동 등록함")
	}
	var pets []model.Pet
	f.request("GET", "/pets", login, nil, 200, &pets)
	if len(pets) != 0 {
		t.Fatal("미등록 펫이 수신 대상에 노출됨")
	}
	f.request("POST", "/messages", login, map[string]string{}, 403, nil)

	// 2. 닉네임을 사용하는 같은 ID의 펫만 명시적으로 등록한다.
	var registered model.Pet
	f.request("POST", "/me/pet/registration", login, map[string]string{"designId": "builtin:dog"}, 200, &registered)
	if !registered.Registered || registered.ID != login.Principal.PetID || registered.Name != credentials.DisplayName {
		t.Fatal("명시적 펫 등록이 닉네임 또는 기존 ID를 보존하지 않음")
	}
	var principal model.Principal
	f.request("GET", "/me", login, nil, 200, &principal)
	if !principal.PetRegistered {
		t.Fatal("기존 로그인 세션에서 펫 등록 상태가 갱신되지 않음")
	}

	// 3. 아이디 충돌은 가입 때 처리하고 로그아웃한 토큰은 다시 사용할 수 없다.
	credentials.Username = "NEW-USER"
	f.request("POST", "/register", identity.Login{}, credentials, 409, nil)
	f.request("POST", "/logout", login, nil, 200, nil)
	f.request("GET", "/me", login, nil, 401, nil)
}

// TestSharedNicknamePetIsolation는 같은 닉네임·기본 외형을 사용해도 수신 펫을 혼동하지 않는지 검증한다.
func TestSharedNicknamePetIsolation(t *testing.T) {
	// 1. 같은 닉네임과 고양이 외형을 가진 서로 다른 세 계정을 등록한다.
	f := setup(t)
	logins := make([]identity.Login, 3)
	for index, username := range []string{"same-one", "same-two", "same-three"} {
		f.request("POST", "/register", identity.Login{}, identity.Credentials{Username: username, Password: password, DisplayName: "같은 닉네임", Invite: invite}, 201, &logins[index])
		f.request("POST", "/me/pet/registration", logins[index], map[string]string{"designId": "default"}, 200, nil)
	}
	if logins[0].Principal.PetID == logins[1].Principal.PetID || logins[1].Principal.PetID == logins[2].Principal.PetID {
		t.Fatal("동일 닉네임에 같은 펫 ID를 발급함")
	}
	_, receiver := f.socket(logins[1], false)
	_, _ = f.socket(logins[2], false)

	// 2. 이름 대신 지정한 펫 ID에만 메시지를 전달한다.
	accepted := f.send(logins[0], "selected", "text", "특정 펫에게만", "same-name-single", logins[1])
	receive(t, receiver, accepted.ID, "특정 펫에게만")
	if len(f.pending(logins[2])) != 0 || len(accepted.PetIDs) != 1 || accepted.PetIDs[0] != logins[1].Principal.PetID {
		t.Fatal("같은 닉네임 또는 같은 외형을 수신자 ID로 취급함")
	}
}

// TestGatheringKindsLifecycle는 다섯 모집 종류의 멱등성·참여·권한·완료와 메시지 분리를 검증한다.
func TestGatheringKindsLifecycle(t *testing.T) {
	for _, kind := range []string{"coffee", "smoke", "meal", "chat", "walk"} {
		t.Run(kind, func(t *testing.T) {
			// 1. 접속 중인 모집자가 메시지 없이 현재 종류를 한 번만 모집한다.
			f := setup(t)
			host, peer, outsider := f.user("host"), f.user("peer"), f.user("outsider")
			_, _ = f.socket(host, false)
			_, _ = f.socket(peer, false)
			_, _ = f.socket(outsider, false)
			request := map[string]string{"kind": kind, "idempotencyKey": uuid.NewString()}
			var group, repeated model.Gathering
			f.request("POST", "/gatherings", host, request, 200, &group)
			f.request("POST", "/gatherings", host, request, 200, &repeated)
			if group.ID != repeated.ID || group.Kind != kind || group.HostPetID != host.Principal.PetID || group.Origin != "recruitment" || group.ExpiresAt != 0 {
				t.Fatal("모집의 대상·종류·멱등성 또는 무기한 유지 계약 불일치")
			}
			var messageCount int
			if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messageCount); err != nil || messageCount != 0 {
				t.Fatal("모집 시작을 일반 메시지로 저장함", err)
			}
			var listed []model.Gathering
			f.request("GET", "/gatherings", outsider, nil, 200, &listed)
			if len(listed) != 1 || listed[0].ID != group.ID {
				t.Fatal("접속한 친구가 현재 공개 모집을 볼 수 없음")
			}

			// 2. 참여는 한 번만 기록하고 본인 참여·타인 완료·중복 주최를 거부한다.
			path := "/gatherings/" + group.ID
			f.request("POST", path+"/accept", peer, nil, 200, nil)
			f.request("POST", path+"/accept", peer, nil, 200, nil)
			f.request("POST", path+"/accept", host, nil, 409, nil)
			f.request("POST", path+"/complete", outsider, nil, 403, nil)
			f.request("POST", path+"/leave", host, nil, 409, nil)
			f.request("POST", "/gatherings", peer, map[string]string{"kind": kind, "idempotencyKey": uuid.NewString()}, 409, nil)
			f.request("GET", "/gatherings", host, nil, 200, &listed)
			if len(listed) != 1 || len(listed[0].Members) != 1 || listed[0].Members[0].PetID != peer.Principal.PetID || listed[0].Members[0].PetName != "peer" {
				t.Fatal("참여자가 중복되거나 닉네임/펫 ID가 일치하지 않음")
			}

			// 3. 참여 취소·재참여와 주최자의 명시적 완료 후 해제를 확인한다.
			f.request("POST", path+"/leave", peer, nil, 200, nil)
			f.request("GET", "/gatherings", host, nil, 200, &listed)
			if len(listed) != 1 || len(listed[0].Members) != 0 {
				t.Fatal("참여 취소가 반영되지 않음")
			}
			f.request("POST", path+"/accept", peer, nil, 200, nil)
			f.request("POST", path+"/complete", host, nil, 200, nil)
			f.request("POST", path+"/complete", host, nil, 200, nil)
			f.request("GET", "/gatherings", peer, nil, 200, &listed)
			if len(listed) != 0 {
				t.Fatal("완료된 모집이 현재 모임에 남음")
			}
			f.request("POST", path+"/accept", peer, nil, 404, nil)
		})
	}
}

// TestAuthRateBoundary는 인증 입력 오류가 누적되어도 상태 확인 경로는 차단하지 않는지 검증한다.
func TestAuthRateBoundary(t *testing.T) {
	// 1. 주소별 한도 안에서는 입력 검증 오류를 반환한다.
	f := setup(t)
	for range 30 {
		f.request("POST", "/login", identity.Login{}, map[string]string{"unknownField": "rejected"}, 400, nil)
	}

	// 2. 한도 초과만 인증 경로에서 거부하고 별도 기능 상태는 유지한다.
	f.request("POST", "/login", identity.Login{}, map[string]string{"unknownField": "rejected"}, 429, nil)
	response, err := f.http.Client().Get(f.http.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("인증 시도 제한이 서버 전체를 중단함")
	}
}
