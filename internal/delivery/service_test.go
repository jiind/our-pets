package delivery

import (
	"encoding/json"
	"testing"

	"github.com/jiind/our-pets/internal/model"
)

// TestGatheringActivityRecipientDevices는 모집 알림의 단계별 대상과 모든 수신 기기를 검증한다.
func TestGatheringActivityRecipientDevices(t *testing.T) {
	// 1. 발신자·두 기기의 참여자·다른 참여자·미참여자의 전달 큐를 분리한다.
	s := New(nil)
	for device, pet := range map[string]string{"host": "a", "peer-one": "b", "peer-two": "b", "other": "c", "outside": "d"} {
		s.devices[device] = peer{petID: pet, activities: make(chan []byte, 4)}
	}
	cases := []struct {
		action  string
		actor   string
		targets []string
		wanted  map[string]bool
	}{
		{"started", "a", nil, map[string]bool{"peer-one": true, "peer-two": true, "other": true, "outside": true}},
		{"joined", "b", []string{"a"}, map[string]bool{"host": true}},
		{"completed", "a", []string{"b", "c"}, map[string]bool{"peer-one": true, "peer-two": true, "other": true}},
	}

	// 2. 모집 시작·참여·완료마다 실제 지정한 기기에만 활동 프레임을 보낸다.
	for _, item := range cases {
		t.Run(item.action, func(t *testing.T) {
			event := model.GatheringActivity{ID: item.action, Type: "gathering_activity", Action: item.action, Actor: model.Sender{PetID: item.actor}}
			s.PublishActivity(event, item.targets)
			for device, peer := range s.devices {
				select {
				case raw := <-peer.activities:
					if !item.wanted[device] {
						t.Fatalf("선택하지 않은 기기 %s에 알림 전달", device)
					}
					var delivered model.GatheringActivity
					if json.Unmarshal(raw, &delivered) != nil || delivered.ID != event.ID {
						t.Fatal("다른 활동 프레임 전달")
					}
				default:
					if item.wanted[device] {
						t.Fatalf("대상 기기 %s가 알림을 받지 못함", device)
					}
				}
			}
		})
	}
}
