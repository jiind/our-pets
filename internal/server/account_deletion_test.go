package server_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/messaging"
	"github.com/jiind/our-pets/internal/model"
)

// TestAccountDeletion은 비밀번호 재확인·관련 데이터 삭제·타인 보존·이미지 파일 삭제를 검증한다.
func TestAccountDeletion(t *testing.T) {
	// 1. 두 계정과 공유 외형·메시지·모집·샘플 연결을 실제 API로 준비한다.
	f := setup(t)
	a, b := f.user("delete-owner"), f.user("delete-friend")
	f.socket(a, false)
	f.socket(b, false)
	bitmap := image.NewNRGBA(image.Rect(0, 0, 20, 20))
	bitmap.Set(10, 10, color.NRGBA{R: 150, A: 255})
	var raw bytes.Buffer
	if err := png.Encode(&raw, bitmap); err != nil {
		t.Fatal(err)
	}
	design := f.upload(a, raw.Bytes(), 201)
	f.request("PUT", "/me/pet/design", b, map[string]string{"designId": design.ID}, 200, nil)
	f.request("POST", "/messages", a, messaging.Send{SenderPetID: a.Principal.PetID, Kind: "text", Body: "삭제 대상", Mode: "selected", PetIDs: []string{b.Principal.PetID}, IdempotencyKey: "delete-own-message"}, 201, nil)
	f.request("POST", "/messages", b, messaging.Send{SenderPetID: b.Principal.PetID, Kind: "text", Body: "다른 사람 메시지", Mode: "selected", PetIDs: []string{a.Principal.PetID}, IdempotencyKey: "keep-friend-message"}, 201, nil)
	f.request("POST", "/gatherings", a, map[string]string{"kind": "coffee", "idempotencyKey": uuid.NewString()}, 200, nil)
	f.request("POST", "/connectors", a, map[string]any{"kind": "sample", "config": map[string]any{}}, 201, nil)
	f.request("DELETE", "/me/account", identity.Login{}, map[string]string{"currentPassword": password}, 401, nil)
	f.request("DELETE", "/me/account", a, map[string]string{"currentPassword": "wrong-password"}, 400, nil)
	f.request("DELETE", "/me/account", a, map[string]string{"currentPassword": password, "userId": b.Principal.UserID}, 400, nil)
	f.request("GET", "/me/account", a, nil, 200, nil)

	// 2. 삭제 후 모든 본인 세션과 자료를 제거하고 타인 외형은 고양이로 복구한다.
	var result struct {
		Status  string `json:"status"`
		Pending bool   `json:"pendingFileCleanup"`
	}
	f.request("DELETE", "/me/account", a, map[string]string{"currentPassword": password}, 200, &result)
	if result.Status != "deleted" || result.Pending {
		t.Fatalf("계정 삭제 결과 오류: %+v", result)
	}
	f.request("GET", "/me/account", a, nil, 401, nil)
	f.request("POST", "/login", identity.Login{}, identity.Credentials{Username: "delete-owner", Password: password}, 401, nil)
	f.request("GET", "/me/account", b, nil, 200, nil)
	var friend model.Pet
	f.request("GET", "/me/pet", b, nil, 200, &friend)
	if friend.Design != nil || friend.BuiltinID != "cat" {
		t.Fatal("삭제한 디자인을 사용하는 다른 펫 복구 실패")
	}
	for _, table := range []string{"users", "devices", "sessions", "pets", "designs", "connector_connections"} {
		column := "user_id"
		if table == "users" {
			column = "id"
		}
		if table == "designs" || table == "connector_connections" {
			column = "owner_id"
		}
		var count int
		if err := f.db.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE "+column+"=?", a.Principal.UserID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("삭제 후 데이터 잔류: %s %d %v", table, count, err)
		}
	}
	var count int
	if err := f.db.QueryRow(`SELECT COUNT(*) FROM messages WHERE sender_pet_id=?`, b.Principal.PetID).Scan(&count); err != nil || count != 1 {
		t.Fatal("타인이 보낸 메시지가 손상됨")
	}
	if _, err := os.Stat(filepath.Join(f.app.Pets.Directory, design.ImageHash+".png")); !os.IsNotExist(err) {
		t.Fatal("참조 없는 PNG가 남음")
	}
	rows, err := f.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("계정 삭제로 외래 키가 손상됨")
	}
}
