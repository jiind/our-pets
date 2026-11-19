package server_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"

	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/model"
	"github.com/jiind/our-pets/internal/pets"
)

// TestDesignManagement는 소유권·PNG 불변성·버전 교체·삭제 이후의 펫 참조를 검증한다.
func TestDesignManagement(t *testing.T) {
	// 1. 같은 외형을 사용하는 두 사용자를 준비하고 기본 펫과 타인 변경을 차단한다.
	f := setup(t)
	a := f.user("design-owner")
	var b identity.Login
	f.request("POST", "/register", identity.Login{}, identity.Credentials{Username: "design-friend", Password: password, DisplayName: "design-friend", Invite: invite}, 201, &b)
	bitmap := image.NewNRGBA(image.Rect(0, 0, 40, 40))
	bitmap.Set(20, 20, color.NRGBA{R: 200, A: 255})
	raw := &bytes.Buffer{}
	if err := png.Encode(raw, bitmap); err != nil {
		t.Fatal(err)
	}
	first := f.upload(a, raw.Bytes(), 201)
	if _, err := f.db.Exec(`UPDATE designs SET manifest=json_set(manifest,'$.animations',NULL) WHERE id=?`, first.ID); err != nil {
		t.Fatal(err)
	}
	var shared, catalogue []model.Design
	f.request("GET", "/designs", identity.Login{}, nil, 401, nil)
	f.request("GET", "/designs", b, nil, 200, &shared)
	f.request("GET", "/me/designs", b, nil, 200, &catalogue)
	if len(shared) != 1 || shared[0].ID != first.ID || shared[0].OwnerName != "design-owner" || len(catalogue) != 0 {
		t.Fatal("공유 목록과 계정별 목록이 올바르게 구분되지 않음")
	}
	if shared[0].Manifest.Animations == nil || len(shared[0].Manifest.Animations) != 0 {
		t.Fatal("이전에 저장한 정적 PNG의 동작 목록이 빈 객체가 아님")
	}
	f.request("POST", "/me/pet/registration", b, map[string]string{"designId": first.ID}, 200, nil)
	update := pets.DesignUpdate{Name: "이름 수정", Manifest: model.Manifest{SchemaVersion: 1, DisplaySize: 160, FrameWidth: 20, FrameHeight: 20, Animations: map[string]model.FrameAnimation{"walk": {Frames: []int{0, 1, 2, 3}, FPS: 6}}}}
	f.request("PUT", "/designs/"+first.ID, b, update, 403, nil)
	f.request("DELETE", "/designs/"+first.ID, b, nil, 403, nil)
	f.request("DELETE", "/designs/default", a, nil, 403, nil)
	f.request("PUT", "/designs/builtin:dog", a, update, 403, nil)
	f.request("PUT", "/designs/"+first.ID, a, map[string]any{"name": "교체 시도", "manifest": update.Manifest, "imageHash": "replacement"}, 400, nil)
	invalid := update
	invalid.Manifest.FrameWidth = 39
	f.request("PUT", "/designs/"+first.ID, a, invalid, 400, nil)

	// 2. 수정은 새 버전을 만들고 소유자에게만 적용하며 기존 이미지·타인 참조를 보존한다.
	var revised model.Design
	f.request("PUT", "/designs/"+first.ID, a, update, 200, &revised)
	if revised.ID == first.ID || revised.Version != 2 || revised.ImageHash != first.ImageHash || revised.Name != update.Name || revised.Manifest.Animations["walk"].FPS != 6 {
		t.Fatalf("외형 수정 결과 오류: %+v", revised)
	}
	var original model.Design
	f.request("GET", "/designs/"+first.ID, a, nil, 200, &original)
	if original.Name != first.Name || original.Manifest.FrameWidth != 40 {
		t.Fatal("이전 버전을 덮어씀")
	}
	var own, friend model.Pet
	f.request("GET", "/me/pet", a, nil, 200, &own)
	f.request("GET", "/me/pet", b, nil, 200, &friend)
	if own.ID != a.Principal.PetID || own.Design.ID != revised.ID || friend.Design.ID != first.ID {
		t.Fatal("펫 ID 또는 타인의 외형 참조가 바뀜")
	}
	f.request("GET", "/me/designs", a, nil, 200, &catalogue)
	if len(catalogue) != 1 || catalogue[0].ID != revised.ID {
		t.Fatal("교체한 이전 버전이 선택 목록에 남음")
	}
	f.request("GET", "/designs", b, nil, 200, &shared)
	if len(shared) != 1 || shared[0].ID != revised.ID {
		t.Fatal("교체한 이전 버전이 공유 목록에 남음")
	}
	f.request("PUT", "/designs/"+first.ID, a, update, 409, nil)
	f.request("PUT", "/me/pet/design", a, map[string]string{"designId": first.ID}, 404, nil)

	// 3. 사용 중인 외형 삭제는 고양이로 돌아가며 ID·활성 상태·과거 참조를 유지한다.
	f.request("DELETE", "/designs/"+revised.ID, a, nil, 200, nil)
	f.request("GET", "/me/pet", a, nil, 200, &own)
	if own.ID != a.Principal.PetID || !own.Registered || own.Design != nil || own.BuiltinID != "cat" {
		t.Fatalf("삭제 후 대표 펫 복구 오류: %+v", own)
	}
	f.request("GET", "/me/pet", b, nil, 200, &friend)
	if friend.Design.ID != first.ID {
		t.Fatal("삭제가 타인의 기존 참조를 변경함")
	}
	f.request("GET", "/me/designs", a, nil, 200, &catalogue)
	if len(catalogue) != 0 {
		t.Fatal("삭제된 외형이 선택 목록에 남음")
	}
	f.request("GET", "/designs", b, nil, 200, &shared)
	if len(shared) != 0 {
		t.Fatal("삭제된 외형이 공유 목록에 남음")
	}
	f.request("GET", "/designs/"+revised.ID, b, nil, 200, &original)
	f.request("DELETE", "/designs/"+revised.ID, a, nil, 409, nil)
	f.request("POST", "/me/pet/registration", a, map[string]string{"designId": revised.ID}, 409, nil)
}
