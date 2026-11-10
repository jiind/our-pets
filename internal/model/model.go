package model

import (
	"encoding/json"
	"errors"
)

type Fault struct {
	Status  int
	Message string
}

// Error는 클라이언트에 공개 가능한 오류 설명을 반환한다.
func (f *Fault) Error() string {
	return f.Message
}

// Bad는 입력·권한·충돌 오류를 HTTP 계층에 전달한다.
func Bad(status int, message string) error {
	return &Fault{Status: status, Message: message}
}

// Status는 내부 오류 상세를 숨기고 공개 가능한 응답을 구분한다.
func Status(err error) (int, string) {
	var f *Fault
	if errors.As(err, &f) {
		return f.Status, f.Message
	}
	return 500, "서버 처리 실패"
}

type Principal struct {
	UserID        string `json:"userId"`
	DeviceID      string `json:"deviceId"`
	PetID         string `json:"petId"`
	PetRegistered bool   `json:"petRegistered"`
	ExpiresAt     int64  `json:"expiresAt"`
	SessionHash   string `json:"-"`
}

type FrameAnimation struct {
	Frames []int `json:"frames"`
	FPS    int   `json:"fps"`
}

type Manifest struct {
	SchemaVersion int                       `json:"schemaVersion"`
	DisplaySize   int                       `json:"displaySize"`
	FrameWidth    int                       `json:"frameWidth"`
	FrameHeight   int                       `json:"frameHeight"`
	Animations    map[string]FrameAnimation `json:"animations"`
}

type Design struct {
	ID        string   `json:"id"`
	OwnerID   string   `json:"ownerId"`
	Version   int      `json:"version"`
	Name      string   `json:"name"`
	ImageHash string   `json:"imageHash"`
	Manifest  Manifest `json:"manifest"`
}

type Pet struct {
	BuiltinID  string  `json:"builtinId"`
	ID         string  `json:"id"`
	UserID     string  `json:"userId"`
	OwnerName  string  `json:"ownerName"`
	Name       string  `json:"name"`
	Design     *Design `json:"design"`
	Online     bool    `json:"online"`
	Registered bool    `json:"registered"`
}

type Sender struct {
	BuiltinID string `json:"builtinId,omitempty"`
	UserID    string `json:"userId"`
	UserName  string `json:"userName"`
	PetID     string `json:"petId"`
	PetName   string `json:"petName"`
	DesignID  string `json:"designId,omitempty"`
}

type Notification struct {
	SchemaVersion int             `json:"schemaVersion"`
	EventID       string          `json:"eventId"`
	SourceKind    string          `json:"sourceKind"`
	ConnectionID  string          `json:"connectionId"`
	OccurredAt    int64           `json:"occurredAt"`
	Title         string          `json:"title"`
	Body          string          `json:"body"`
	Resource      string          `json:"resource,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

type Event struct {
	ProposalKind     string        `json:"proposalKind,omitempty"`
	ReplyToMessageID string        `json:"replyToMessageId,omitempty"`
	ID               string        `json:"id"`
	Type             string        `json:"type"`
	Kind             string        `json:"kind"`
	Body             string        `json:"body"`
	Sender           *Sender       `json:"sender,omitempty"`
	Notification     *Notification `json:"notification,omitempty"`
	CreatedAt        int64         `json:"createdAt"`
	ExpiresAt        int64         `json:"expiresAt"`
}

type GatheringMember struct {
	PetID    string `json:"petId"`
	PetName  string `json:"petName"`
	UserName string `json:"userName"`
}

type Gathering struct {
	ID        string            `json:"id"`
	HostPetID string            `json:"hostPetId"`
	Kind      string            `json:"kind"`
	Origin    string            `json:"origin"`
	Host      *Sender           `json:"host,omitempty"`
	Status    string            `json:"status"`
	ExpiresAt int64             `json:"expiresAt"`
	Members   []GatheringMember `json:"members"`
}
