package server_test

import (
	"testing"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/identity"
)

// 초대 코드는 새 계정에만 쓰고 같은 기기의 재시도와 재접속은 펫 ID를 유지한다.
func TestDeviceJoinAndReconnect(t *testing.T) {
	f := setup(t)
	anonymous := identity.Login{}
	key := database.ID() + database.ID()
	access := identity.DeviceAccess{Key: key, DisplayName: "우리 펫", Invite: "invalid-invite"}
	f.request("POST", "/device/session", anonymous, access, 403, nil)
	access.Invite = invite
	var first, repeated identity.Login
	f.request("POST", "/device/session", anonymous, access, 200, &first)
	f.request("POST", "/device/session", anonymous, access, 200, &repeated)
	f.request("POST", "/me/pet/registration", first, map[string]string{"designId": "default"}, 200, nil)
	f.request("POST", "/logout", first, nil, 200, nil)
	var resumed identity.Login
	f.request("POST", "/device/session", anonymous, identity.DeviceAccess{Key: key}, 200, &resumed)
	for _, login := range []identity.Login{repeated, resumed} {
		if login.Principal.UserID != first.Principal.UserID || login.Principal.PetID != first.Principal.PetID || login.Principal.DeviceID != first.Principal.DeviceID {
			t.Fatal("same device key created a different identity")
		}
	}
	if !resumed.Principal.PetRegistered {
		t.Fatal("registered pet was lost on reconnect")
	}
	var keyHash string
	if err := f.db.QueryRow(`SELECT key_hash FROM device_keys WHERE device_id=?`, first.Principal.DeviceID).Scan(&keyHash); err != nil {
		t.Fatal(err)
	}
	if keyHash != identity.HashToken(key) {
		t.Fatal("device credential was not hashed at rest")
	}
	f.request("POST", "/device/session", anonymous, identity.DeviceAccess{Key: database.ID() + database.ID()}, 401, nil)
}

// 기존 세션은 자기 기기만 연결할 수 있고 삭제할 때 생성한 기기 키도 함께 제거한다.
func TestRememberLegacyDeviceAndDelete(t *testing.T) {
	f := setup(t)
	legacy := f.user("legacy-device")
	key := database.ID() + database.ID()
	f.request("PUT", "/me/device-key", identity.Login{}, map[string]string{"key": key}, 401, nil)
	f.request("PUT", "/me/device-key", legacy, map[string]string{"key": key}, 200, nil)
	f.request("PUT", "/me/device-key", legacy, map[string]string{"key": key}, 200, nil)
	f.request("PUT", "/me/device-key", legacy, map[string]string{"key": database.ID() + database.ID()}, 409, nil)
	var resumed identity.Login
	f.request("POST", "/device/session", identity.Login{}, identity.DeviceAccess{Key: key}, 200, &resumed)
	if resumed.Principal.PetID != legacy.Principal.PetID {
		t.Fatal("legacy account migration lost the pet")
	}
	f.request("DELETE", "/me/account", resumed, map[string]string{"deviceKey": database.ID() + database.ID()}, 403, nil)
	f.request("DELETE", "/me/account", resumed, map[string]string{"deviceKey": key}, 200, nil)
	f.request("POST", "/device/session", identity.Login{}, identity.DeviceAccess{Key: key}, 401, nil)
}
