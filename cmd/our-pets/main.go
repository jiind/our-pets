package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jiind/our-pets/internal/database"
	"github.com/jiind/our-pets/internal/server"
)

// main은 설정·저장소·API 서버를 초기화하고 종료 신호를 처리한다.
func main() {
	// 1. 검증한 설정으로 단일 서버와 영속 저장소를 구성한다.
	config, err := server.ConfigFromEnv()
	if err != nil {
		slog.Error("설정 오류", "error", err)
		os.Exit(1)
	}
	db, err := database.Open(config.Directory)
	if err != nil {
		slog.Error("DB 초기화 실패", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	app := server.New(ctx, db, config)
	go app.Maintain(ctx)
	httpServer := &http.Server{Addr: config.Bind, Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}

	// 2. 새 요청을 중단하고 진행 중인 HTTP 요청을 마무리한다.
	go func() {
		<-ctx.Done()
		stop, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = httpServer.Shutdown(stop)
	}()
	slog.Info("로컬망 펫 서버 시작", "bind", config.Bind, "sampleEnabled", config.SampleEnabled)
	if config.TLSCert != "" {
		err = httpServer.ListenAndServeTLS(config.TLSCert, config.TLSKey)
	} else {
		err = httpServer.ListenAndServe()
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("서버 실행 실패", "error", err)
		os.Exit(1)
	}
}
