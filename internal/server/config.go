package server

import (
	"fmt"
	"net/netip"
	"os"
	"strings"
	"time"
)

type Config struct {
	Bind          string
	Directory     string
	Invite        string
	AllowedCIDRs  []netip.Prefix
	Origins       []string
	MessageTTL    time.Duration
	Retention     time.Duration
	SampleEnabled bool
	TLSCert       string
	TLSKey        string
}

// ConfigFromEnv는 외부 클라우드 없이 실행할 내부망 설정을 읽고 검증한다.
func ConfigFromEnv() (Config, error) {
	// 1. 루프백만 허용하는 기본값과 비밀값 참조를 읽는다.
	c := Config{Bind: env("OURPETS_BIND", "127.0.0.1:9377"), Directory: env("OURPETS_DATA", "./data"), Invite: os.Getenv("OURPETS_INVITE"), MessageTTL: time.Minute, Retention: time.Hour, SampleEnabled: os.Getenv("OURPETS_SAMPLE_ENABLED") == "true", TLSCert: os.Getenv("OURPETS_TLS_CERT"), TLSKey: os.Getenv("OURPETS_TLS_KEY")}
	if len(c.Invite) < 12 {
		return c, fmt.Errorf("OURPETS_INVITE에 12자 이상의 서버 가입 코드를 설정하세요")
	}
	for _, value := range strings.Split(env("OURPETS_ALLOWED_CIDRS", "127.0.0.0/8,::1/128"), ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			return c, fmt.Errorf("허용 CIDR 설정 오류: %w", err)
		}
		c.AllowedCIDRs = append(c.AllowedCIDRs, prefix)
	}
	c.Origins = strings.Split(env("OURPETS_ORIGINS", "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://127.0.0.1:1420"), ",")

	// 2. 만료와 보관 정책 및 TLS 키 쌍을 검증한다.
	for key, target := range map[string]*time.Duration{"OURPETS_MESSAGE_TTL": &c.MessageTTL, "OURPETS_RETENTION": &c.Retention} {
		if raw := os.Getenv(key); raw != "" {
			value, err := time.ParseDuration(raw)
			if err != nil || value < time.Minute {
				return c, fmt.Errorf("%s는 1분 이상 기간이어야 합니다", key)
			}
			*target = value
		}
	}
	if c.Retention < c.MessageTTL || (c.TLSCert == "") != (c.TLSKey == "") {
		return c, fmt.Errorf("보관 기간은 알림 만료 이상이어야 하며 TLS 인증서와 키는 함께 설정하세요")
	}
	return c, nil
}

// env는 비어 있지 않은 환경 변수 또는 명시적인 기본값을 반환한다.
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
