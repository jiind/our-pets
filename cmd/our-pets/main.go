package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
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
	var host desktopHost
	var listener net.Listener
	managed := len(os.Args) == 3 && (os.Args[1] == "--desktop-local" || os.Args[1] == "--desktop-host")
	if managed {
		var err error
		host, err = desktopConfig(os.Args[2])
		if err != nil {
			slog.Error("데스크톱 호스트 설정 오류", "error", err)
			os.Exit(1)
		}
		listener, err = net.Listen("tcp4", os.Getenv("OURPETS_BIND"))
		if err != nil {
			slog.Error("데스크톱 호스트 포트 오류", "error", err)
			os.Exit(1)
		}
		defer listener.Close()
	}
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
	httpServer := newHTTPServer(config.Bind, app.Handler())
	if listener != nil {
		initial := host
		var lan *desktopLAN
		if os.Args[1] == "--desktop-host" {
			initial, lan, err = openDesktopLAN(app, host)
			if err != nil {
				slog.Error("데스크톱 LAN 시작 실패", "error", err)
				os.Exit(1)
			}
		}
		if err := initial.ready(); err != nil {
			slog.Error("데스크톱 호스트 시작 알림 실패", "error", err)
			os.Exit(1)
		}
		go controlDesktop(app, host, initial, lan, cancel)
	}

	// 2. 새 요청을 중단하고 진행 중인 HTTP 요청을 마무리한다.
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-ctx.Done()
		stop, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = httpServer.Shutdown(stop)
	}()
	slog.Info("로컬망 펫 서버 시작", "bind", config.Bind, "sampleEnabled", config.SampleEnabled)
	if listener != nil {
		err = httpServer.Serve(listener)
	} else if config.TLSCert != "" {
		err = httpServer.ListenAndServeTLS(config.TLSCert, config.TLSKey)
	} else {
		err = httpServer.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		<-stopped
	} else if err != nil {
		slog.Error("서버 실행 실패", "error", err)
		os.Exit(1)
	}
}

// 개인 및 공유 리스너에 같은 HTTP 제한을 적용한다.
func newHTTPServer(address string, handler http.Handler) *http.Server {
	return &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
}
