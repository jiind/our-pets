package database

import (
	"crypto/rand"
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

//go:embed migrations/002_message_replies.sql
var messageReplies string

//go:embed migrations/003_gatherings.sql
var gatherings string

//go:embed migrations/004_coffee_recruitments.sql
var recruitments string

//go:embed migrations/005_social_recruitments.sql
var socialRecruitments string

//go:embed migrations/006_builtin_pets.sql
var builtinPets string

// Open은 단일 서버용 SQLite 연결과 멱등적인 초기 마이그레이션을 준비한다.
func Open(directory string) (*sql.DB, error) {
	// 1. 서버 전용 데이터 디렉터리와 연결을 만든다.
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "our-pets.db"))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	// 2. 무결성과 WAL을 설정하고 스키마를 트랜잭션으로 반영한다.
	if _, err = db.Exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); err == nil {
		var tx *sql.Tx
		tx, err = db.Begin()
		if err == nil {
			_, err = tx.Exec(schema)
			if err == nil {
				var version int
				err = tx.QueryRow(`SELECT MAX(version) FROM schema_versions`).Scan(&version)
				if err == nil && version < 2 {
					_, err = tx.Exec(messageReplies)
				}
			}
			if err == nil {
				_, err = tx.Exec(gatherings)
			}
			if err == nil {
				var version int
				err = tx.QueryRow(`SELECT MAX(version) FROM schema_versions`).Scan(&version)
				if err == nil && version < 4 {
					_, err = tx.Exec(recruitments)
					if err == nil {
						err = checkForeignKeys(tx)
					}
				}
			}
			if err == nil {
				var version int
				err = tx.QueryRow(`SELECT MAX(version) FROM schema_versions`).Scan(&version)
				if err == nil && version < 5 {
					_, err = tx.Exec(socialRecruitments)
					if err == nil {
						err = checkForeignKeys(tx)
					}
				}
			}
			if err == nil {
				var version int
				err = tx.QueryRow(`SELECT MAX(version) FROM schema_versions`).Scan(&version)
				if err == nil && version < 6 {
					_, err = tx.Exec(builtinPets)
				}
			}
			if err == nil {
				err = tx.Commit()
			} else {
				_ = tx.Rollback()
			}
		}
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// checkForeignKeys는 테이블 교체 뒤 외래 키 무결성을 확인하고 위반이 있으면 전체 마이그레이션을 취소한다.
func checkForeignKeys(tx *sql.Tx) error {
	rows, err := tx.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("마이그레이션 뒤 외래 키 무결성이 일치하지 않습니다")
	}
	return rows.Err()
}

// ID는 네트워크나 시각에 의존하지 않는 무작위 식별자를 만든다.
func ID() string {
	return fmt.Sprintf("%x", randBytes(16))
}

// randBytes는 운영체제 난수 생성 실패 시 불완전한 식별자 생성을 중단한다.
func randBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
