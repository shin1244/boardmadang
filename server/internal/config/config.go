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
	// 화면(web/)과 게임 코드(games/)가 있는 폴더, 곧 레포 루트 (internal/site). 비어 있으면 ..(server 폴더에서 켠 기준).
	SiteDir string

	// 브라우저가 보는 사이트 주소 (https://boardmadang.com). 소셜 로그인에서 돌아올 주소를 만듭니다.
	// 비어 있으면 요청의 Host로 만듭니다.
	PublicURL string
	// 소셜 로그인 (internal/auth). ID와 비밀값이 둘 다 있는 곳만 켭니다.
	GoogleClientID, GoogleClientSecret string
	GitHubClientID, GitHubClientSecret string
	// 개발용 로그인 (DEV_LOGIN=1). OAuth 앱 없이 "dev" 계정으로 로그인합니다. 운영에서는 절대 켜지 않습니다.
	DevLogin bool
	// 운영자 계정 id 목록 (ADMIN_IDS=m_…,m_…). 운영자 화면(/web/admin.html)과 운영 API(internal/admin)를 씁니다.
	// 계정 id는 로그인한 뒤 /api/me의 id입니다.
	AdminIDs []string
}

func Load() Config {
	cfg := Config{
		Port:          os.Getenv("PORT"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		DataDir:       os.Getenv("DATA_DIR"),
		SiteDir:       os.Getenv("SITE_DIR"),
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
	if cfg.SiteDir == "" {
		cfg.SiteDir = ".."
	}

	cfg.AllowedOrigins = list(os.Getenv("ALLOWED_ORIGINS"))
	cfg.AdminIDs = list(os.Getenv("ADMIN_IDS"))
	return cfg
}

// list는 쉼표로 나눈 값의 빈칸을 떼고 빈 것은 뺍니다.
func list(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
