package pets

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/jiind/our-pets/internal/model"
)

// TestSpriteValidation는 단일 이미지 대체와 실제 프레임 경계·속도 제한을 검증한다.
func TestSpriteValidation(t *testing.T) {
	// 1. 실제 시트를 디코딩한 크기로 단일 이미지 기본값을 만든다.
	raw := &bytes.Buffer{}
	if err := png.Encode(raw, image.NewNRGBA(image.Rect(0, 0, 128, 64))); err != nil {
		t.Fatal(err)
	}
	simple := model.Manifest{DisplaySize: 160}
	if err := Validate(raw.Bytes(), &simple); err != nil || simple.FrameWidth != 128 || simple.FrameHeight != 64 {
		t.Fatalf("단일 이미지 대체 실패: %+v, %v", simple, err)
	}

	// 2. 프레임 범위 밖·과도한 FPS·실행 명령 이름은 거부한다.
	for _, item := range []struct {
		name      string
		animation string
		frames    []int
		fps       int
		valid     bool
	}{
		{"optional walk", "walk", []int{0, 1}, 8, true},
		{"outside frame", "walk", []int{2}, 8, false},
		{"negative frame", "react", []int{-1}, 8, false},
		{"excess FPS", "idle", []int{0}, 25, false},
		{"unknown action", "execute", []int{0}, 8, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			manifest := model.Manifest{SchemaVersion: 1, DisplaySize: 160, FrameWidth: 64, FrameHeight: 64, Animations: map[string]model.FrameAnimation{item.animation: {Frames: item.frames, FPS: item.fps}}}
			err := Validate(raw.Bytes(), &manifest)
			if (err == nil) != item.valid {
				t.Fatalf("validation=%v want valid=%v", err, item.valid)
			}
		})
	}
}

// TestValidatePNGAndManifestBoundaries는 실제 PNG와 매니페스트의 허용 경계를 검증한다.
func TestValidatePNGAndManifestBoundaries(t *testing.T) {
	// 1. 실제 PNG와 픽셀 손상 및 애니메이션 청크가 포함된 입력을 준비한다.
	encode := func(w, h int) []byte {
		var buf bytes.Buffer
		if err := png.Encode(&buf, image.NewNRGBA(image.Rect(0, 0, w, h))); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}
	sheet := encode(256, 1)
	corrupt := append([]byte(nil), sheet...)
	for pos := 8; pos+12 <= len(corrupt); {
		size := int(binary.BigEndian.Uint32(corrupt[pos:]))
		if string(corrupt[pos+4:pos+8]) == "IDAT" {
			corrupt[pos+8] ^= 0xff
			break
		}
		pos += size + 12
	}
	apng := append([]byte(nil), sheet[:len(sheet)-12]...)
	chunk := []byte{0, 0, 0, 8, 'a', 'c', 'T', 'L', 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(chunk[16:], crc32.ChecksumIEEE(chunk[4:16]))
	apng = append(apng, chunk...)
	apng = append(apng, sheet[len(sheet)-12:]...)
	frames := make([]int, 256)
	for i := range frames {
		frames[i] = i
	}
	base := func() model.Manifest {
		return model.Manifest{SchemaVersion: 1, DisplaySize: 160, FrameWidth: 1, FrameHeight: 1}
	}

	// 2. 파일 크기와 이미지 내용 및 프레임·속도 한계의 양쪽을 확인한다.
	cases := []struct {
		name     string
		data     []byte
		manifest model.Manifest
		valid    bool
	}{
		{"empty", nil, base(), false},
		{"over 8 MiB", make([]byte, MaxUpload+1), base(), false},
		{"width 2049", encode(2049, 1), base(), false},
		{"height 2049", encode(1, 2049), base(), false},
		{"corrupt pixels", corrupt, base(), false},
		{"APNG", apng, base(), false},
		{"256 frames", sheet, model.Manifest{SchemaVersion: 1, DisplaySize: 48, FrameWidth: 1, FrameHeight: 1, Animations: map[string]model.FrameAnimation{"idle": {Frames: frames, FPS: 24}}}, true},
		{"257 frames", encode(257, 1), base(), false},
		{"schema unsupported", sheet, model.Manifest{SchemaVersion: 3, DisplaySize: 160, FrameWidth: 1, FrameHeight: 1}, false},
		{"uneven frame", sheet, model.Manifest{SchemaVersion: 1, DisplaySize: 160, FrameWidth: 3, FrameHeight: 1}, false},
		{"minimum FPS", sheet, model.Manifest{DisplaySize: 200, FrameWidth: 1, FrameHeight: 1, Animations: map[string]model.FrameAnimation{"walk": {Frames: []int{255}, FPS: 1}}}, true},
		{"zero FPS", sheet, model.Manifest{DisplaySize: 160, FrameWidth: 1, FrameHeight: 1, Animations: map[string]model.FrameAnimation{"idle": {Frames: []int{0}, FPS: 0}}}, false},
		{"257 animation frames", sheet, model.Manifest{DisplaySize: 160, FrameWidth: 1, FrameHeight: 1, Animations: map[string]model.FrameAnimation{"idle": {Frames: append(append([]int(nil), frames...), 0), FPS: 1}}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Validate(tc.data, &tc.manifest)
			if tc.name == "APNG" && (err == nil || !strings.Contains(err.Error(), "APNG")) {
				t.Fatalf("APNG 전용 거부 오류가 필요함: %v", err)
			}
			if (err == nil) != tc.valid {
				t.Fatalf("검증 결과: %v, 허용 여부: %v", err, tc.valid)
			}
		})
	}

	// 3. 동작을 생략한 단일 PNG의 기본 프레임과 스키마를 확인한다.
	m := model.Manifest{DisplaySize: 160}
	if err := Validate(encode(7, 9), &m); err != nil || m.SchemaVersion != 1 || m.FrameWidth != 7 || m.FrameHeight != 9 || len(m.Animations) != 0 {
		t.Fatalf("단일 이미지 기본값: %+v, %v", m, err)
	}
}

// TestNamedAnimations는 자유 목록의 이름·역할·개수와 프레임 범위를 검증한다.
func TestNamedAnimations(t *testing.T) {
	// 1. 네 동작을 가진 시트와 대기·이동 역할을 만든다.
	var raw bytes.Buffer
	if err := png.Encode(&raw, image.NewNRGBA(image.Rect(0, 0, 64, 64))); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*model.Manifest)
		valid  bool
	}{
		{"four animations", nil, true},
		{"missing role", func(m *model.Manifest) {
			m.WalkAnimation = "missing"
		}, false},
		{"blank name", func(m *model.Manifest) {
			a := m.Animations["dance"]
			a.Name = " "
			m.Animations["dance"] = a
		}, false},
		{"outside frame", func(m *model.Manifest) {
			a := m.Animations["dance"]
			a.Frames = []int{4}
			m.Animations["dance"] = a
		}, false},
		{"reserved key", func(m *model.Manifest) {
			m.Animations["__proto__"] = m.Animations["dance"]
		}, false},
		{"legacy names only", func(m *model.Manifest) {
			m.SchemaVersion = 1
		}, false},
		{"32 animations", func(m *model.Manifest) {
			for i := 0; i < 28; i++ {
				m.Animations[fmt.Sprintf("extra-%d", i)] = m.Animations["dance"]
			}
		}, true},
		{"33 animations", func(m *model.Manifest) {
			for i := 0; i < 29; i++ {
				m.Animations[fmt.Sprintf("extra-%d", i)] = m.Animations["dance"]
			}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// 2. 각 입력은 독립된 맵으로 검증해 다른 경우를 덮어쓰지 않는다.
			m := model.Manifest{SchemaVersion: 2, DisplaySize: 160, FrameWidth: 32, FrameHeight: 32, IdleAnimation: "rest", WalkAnimation: "stride", Animations: map[string]model.FrameAnimation{}}
			for _, id := range []string{"rest", "stride", "dance", "jump"} {
				m.Animations[id] = model.FrameAnimation{Name: "사용자 동작", Frames: []int{0, 1, 2, 3}, FPS: 8}
			}
			if tc.change != nil {
				tc.change(&m)
			}
			if err := Validate(raw.Bytes(), &m); (err == nil) != tc.valid {
				t.Fatalf("검증 오류: %v, 허용 여부: %v", err, tc.valid)
			}
		})
	}
}
