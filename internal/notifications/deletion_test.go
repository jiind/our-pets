package notifications

import (
	"testing"
	"time"

	"github.com/jiind/our-pets/internal/database"
)

// TestPruneDeleted는 DB에서 삭제한 연결의 실행 작업만 취소하고 유효한 연결은 보존한다.
func TestPruneDeleted(t *testing.T) {
	// 1. 유효한 연결 하나와 이미 지워진 작업 하나를 격리 DB에 준비한다.
	db, err := database.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`INSERT INTO users VALUES('owner','owner','Owner',x'00',x'00',0); INSERT INTO connector_connections(id,kind,schema_version,owner_id,config,state) VALUES('live','sample',1,'owner','{}','ready');`); err != nil {
		t.Fatal(err)
	}
	service := New(db, time.Minute, true)
	deleted, live := false, false
	service.running["deleted"] = func() {
		deleted = true
	}
	service.running["live"] = func() {
		live = true
	}

	// 2. 삭제한 작업만 정리하고 현재 연결에는 취소를 전달하지 않는다.
	if err = service.PruneDeleted(); err != nil {
		t.Fatal(err)
	}
	if !deleted || live || len(service.running) != 1 {
		t.Fatal("연결 소유 범위 또는 실행 작업 정리 오류")
	}
}
