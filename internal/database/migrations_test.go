package database

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestMessageReplyMigration는 기존 데이터 보존·중복 적용·원본 만료 후 답장 보존을 검증한다.
func TestMessageReplyMigration(t *testing.T) {
	// 1. 실제 이전 버전 스키마와 메시지를 만든다.
	directory := t.TempDir()
	legacy, err := sql.Open("sqlite", filepath.Join(directory, "our-pets.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = legacy.Exec(schema); err != nil {
		t.Fatal(err)
	}
	if _, err = legacy.Exec(`INSERT INTO users VALUES('u1','alice','Alice',x'00',x'00',0),('u2','bob','Bob',x'00',x'00',0);
INSERT INTO pets(id,user_id,name) VALUES('p1','u1','first'),('p2','u2','second');
INSERT INTO messages VALUES('old','p1','text','original','selected','key-old','hash','{}',1,1000);
INSERT INTO message_recipients(message_id,pet_id) VALUES('old','p2');`); err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	// 2. 재시작을 반복해도 이전 메시지와 새 컬럼이 올바르게 유지된다.
	for iteration := range 2 {
		db, openErr := Open(directory)
		if openErr != nil {
			t.Fatal(openErr)
		}
		var body string
		var reply sql.NullString
		var version int
		if err = db.QueryRow(`SELECT body,reply_to_message_id FROM messages WHERE id='old'`).Scan(&body, &reply); err != nil || body != "original" || reply.Valid {
			t.Fatalf("이전 메시지 보존 실패: %q, %+v, %v", body, reply, err)
		}
		if err = db.QueryRow(`SELECT MAX(version) FROM schema_versions`).Scan(&version); err != nil || version != 6 {
			t.Fatalf("스키마 버전 오류: %d, %v", version, err)
		}
		var builtin string
		want := "cat"
		if iteration > 0 {
			want = "dog"
		}
		if err = db.QueryRow(`SELECT builtin_id FROM pets WHERE id='p1' AND user_id='u1'`).Scan(&builtin); err != nil || builtin != want {
			t.Fatalf("기본 캐릭터와 기존 펫 관계 보존 실패: %s, %v", builtin, err)
		}
		if _, err = db.Exec(`UPDATE pets SET builtin_id='dog' WHERE id='p1'`); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}

	// 3. 보관 기간이 지난 원본만 삭제하고 새 답장은 남긴다.
	db, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`INSERT INTO messages(id,sender_pet_id,kind,body,mode,idempotency_key,request_hash,sender_snapshot,created_at,expires_at,reply_to_message_id) VALUES('reply','p2','text','response','selected','key-reply','hash','{}',2,2000,'old'); DELETE FROM messages WHERE id='old'`); err != nil {
		t.Fatal(err)
	}
	var reply sql.NullString
	if err = db.QueryRow(`SELECT reply_to_message_id FROM messages WHERE id='reply'`).Scan(&reply); err != nil || reply.Valid {
		t.Fatalf("원본 만료가 답장을 훼손함: %+v, %v", reply, err)
	}
}
