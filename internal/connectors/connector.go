package connectors

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jiind/our-pets/internal/model"
)

type Descriptor struct {
	Kind          string            `json:"kind"`
	SchemaVersion int               `json:"schemaVersion"`
	Configuration map[string]string `json:"configuration"`
}

type Connection struct {
	ID            string          `json:"id"`
	Kind          string          `json:"kind"`
	OwnerID       string          `json:"ownerId"`
	Config        json.RawMessage `json:"config"`
	CredentialRef string          `json:"-"`
	State         string          `json:"state"`
	LastError     string          `json:"lastError"`
}

type Report struct {
	State string
	Error string
}

type Sink func(context.Context, model.Notification) error
type Reporter func(Report)

// Connector는 수집·변환·상태 보고만 제공하며 외부 제어 명령을 노출하지 않는다.
type Connector interface {
	Descriptor() Descriptor
	Validate(json.RawMessage) error
	Run(context.Context, Connection, Sink, Reporter) error
}

type Sample struct{}

type SampleConfig struct {
	// 이전 설정을 읽기 위한 값이며 자동 발송 간격으로 사용하지 않는다.
	IntervalSeconds int  `json:"intervalSeconds"`
	Fail            bool `json:"fail"`
}

// Descriptor는 샘플 소스의 종류·버전·설정 계약을 제공한다.
func (Sample) Descriptor() Descriptor {
	return Descriptor{Kind: "sample", SchemaVersion: 1, Configuration: map[string]string{"fail": "수동 발송 장애 검증용 boolean"}}
}

// Validate는 실서비스 자격증명 없이 샘플 연결 설정을 검증한다.
func (Sample) Validate(raw json.RawMessage) error {
	var c SampleConfig
	if json.Unmarshal(raw, &c) != nil || (c.IntervalSeconds != 0 && (c.IntervalSeconds < 5 || c.IntervalSeconds > 3600)) {
		return model.Bad(400, "샘플 알림 간격은 5~3600초입니다")
	}
	return nil
}

// Run은 연결을 대기 상태로 유지하며 사용자의 명시적 발송 없이 이벤트를 생성하지 않는다.
func (sample Sample) Run(ctx context.Context, connection Connection, _ Sink, report Reporter) error {
	// 1. 이전 저장 설정도 검증하되 간격 값으로 타이머를 만들지 않는다.
	if err := sample.Validate(connection.Config); err != nil {
		return err
	}

	// 2. 명시적 발송을 기다리며 연결 종료 시 정상적으로 반환한다.
	report(Report{State: "ready"})
	<-ctx.Done()
	return nil
}

// Emit은 사용자가 요청한 샘플 한 건만 공통 알림으로 변환해 전달한다.
func (Sample) Emit(ctx context.Context, connection Connection, eventID string, sink Sink) error {
	// 1. 저장된 장애 옵션만 해석하고 자동 타이머나 재발송을 만들지 않는다.
	var cfg SampleConfig
	if err := json.Unmarshal(connection.Config, &cfg); err != nil {
		return err
	}
	if cfg.Fail {
		return model.Bad(503, "샘플 알림 생성에 실패했어요")
	}

	// 2. 동일 요청 키를 이벤트 키로 유지해 재시도에서도 한 건만 저장한다.
	n := model.Notification{SchemaVersion: 1, EventID: eventID, SourceKind: "sample", ConnectionID: connection.ID, OccurredAt: time.Now().UnixMilli(), Title: "샘플 알림", Body: "알림 보내기를 눌러 생성한 샘플 알림입니다.", Resource: "sample://manual"}
	return sink(ctx, n)
}
