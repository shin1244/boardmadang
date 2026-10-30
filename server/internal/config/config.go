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
	// 세션 토큰 서명 비밀값 (docs/identity.md). 비어 있으면 서버가 시작할 때 임시 값을 만듭니다.
	SessionSecret string
	// 기보를 저장할 폴더 (internal/record). 운영에서는 VM의 영구 디스크에 둡니다.
	DataDir string

	// 브라우저가 보는 사이트 주소 (https://boardmadang.example). 소셜 로그인에서 돌아올 주소를 만듭니다.
	// 비어 있으면 요청의 Host로 만듭니다.
	PublicURL string
	// 소셜 로그인 (internal/auth). ID와 비밀값이 둘 다 있는 곳만 켭니다.
	GoogleClientID, GoogleClientSecret string
	GitHubClientID, GitHubClientSecret string
	// 개발용 로그인 (DEV_LOGIN=1). OAuth 앱 없이 "dev" 계정으로 로그인합니다. 운영에서는 절대 켜지 않습니다.
	DevLogin bool
}

func Load() Config {
	cfg := Config{
		Port:          os.Getenv("PORT"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		DataDir:       os.Getenv("DATA_DIR"),
		PublicURL:     os.Getenv("PUBLIC_URL"),

		GoogleClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		GoogleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		GitHubClientID:     os.Getenv("GITHUB_CLIENT_ID"),
		GitHubClientSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
		DevLogin:           os.Getenv("DEV_LOGIN") == "1",
	}
	if cfg.Port == "" {
		cfg.Port = "8080"
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "data"
	}

	for _, origin := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
		}
	}
	return cfg
}
