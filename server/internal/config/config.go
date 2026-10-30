// Package config는 환경변수에서 서버 설정을 읽습니다.
// 비밀값과 환경별 설정은 코드가 아니라 환경변수로만 받습니다 (.env.example 참고).
package config

import (
	"os"
	"strings"
)

type Config struct {
	// 서버가 들을 포트. GCP는 PORT 환경변수로 넘겨줍니다.
	Port string
	// 웹소켓 접속을 허용할 Origin 목록. 비어 있으면 같은 출처만 허용합니다.
	AllowedOrigins []string
}

func Load() Config {
	cfg := Config{
		Port: os.Getenv("PORT"),
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}

	for _, origin := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
		}
	}
	return cfg
}
