// boardmadang 서버 진입점입니다.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/admin"
	"github.com/shin1244/boardmadang/server/internal/ai"
	"github.com/shin1244/boardmadang/server/internal/auth"
	"github.com/shin1244/boardmadang/server/internal/comment"
	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
	"github.com/shin1244/boardmadang/server/internal/site"
	"github.com/shin1244/boardmadang/server/internal/stats"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

func main() {
	cfg := config.Load()
	ids := identity.NewIssuer(sessionSecret(cfg))
	records, err := record.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("기보 폴더를 열지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	comments, err := comment.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("의견 폴더를 열지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	uploads, err := upload.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("올린 게임 폴더를 열지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	accounts, err := account.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("계정 기록을 읽지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	ids.Members = accounts
	ids.Admins = make(map[string]bool)
	for _, id := range cfg.AdminIDs {
		ids.Admins[id] = true
	}
	if len(cfg.AdminIDs) > 0 {
		log.Printf("운영자 계정 %d개 (ADMIN_IDS)", len(cfg.AdminIDs))
	}
	comments.Names = accounts
	uploads.Names = accounts
	login := &auth.Handler{Providers: providers(cfg), IDs: ids, Accounts: accounts, Records: records, PublicURL: cfg.PublicURL}
	// 탈퇴하면 계정을 지운 뒤 기보의 자리, 의견, 올린 게임에서 그 계정을 지웁니다
	mine := account.Handler{Store: accounts, IDs: ids, Forget: []func(string) error{records.Forget, comments.Forget, uploads.Forget}}
	ops, err := admin.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("운영 기록을 읽지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	ops.IDs, ops.Comments, ops.Uploads, ops.Accounts = ids, comments, uploads, accounts
	visits, err := stats.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("방문 기록을 읽지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	ids.OnMe = visits.Visit
	var pages *site.Site // 아래에서 엽니다
	models, err := ai.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("AI 모델 폴더를 열지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	// 모델은 있는 게임에만 올립니다 (레포 게임이나 올린 게임). AI 만들기 요청과 코드 받기는 올린 게임만입니다
	bots := &ai.Handler{Store: models, IDs: ids, Games: uploads, Known: func(id string) bool {
		_, ok := uploads.Admin(id)
		return ok || (pages != nil && pages.Has(id))
	}}
	h := hub.New(cfg, ids, records)
	ops.Records, ops.Visits, ops.Live = records, visits, h.Live
	pages, err = site.Open(cfg.SiteDir)
	if err != nil {
		// 개발 서버(serve.js)를 앞에 두고 API만 쓸 때는 화면이 없어도 됩니다
		log.Printf("경고: 화면 폴더를 열지 못해 화면과 게임 목록은 내보내지 않습니다 (SITE_DIR=%s): %v", cfg.SiteDir, err)
	} else {
		pages.Uploaded = uploads
		pages.Played = records
		pages.Models = models
		uploads.Reserved = pages.Has
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           routes(h, ids, records, comments, uploads, login, mine, ops, pages, bots),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("서버 시작: http://localhost:%s (기보: %s)", cfg.Port, cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	// GCP는 VM 재시작이나 인스턴스 교체 전에 SIGTERM을 보냅니다.
	// 새 요청을 막고 처리 중인 요청을 마무리한 뒤 종료합니다.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("종료 중…")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Println("종료 실패:", err)
	}
	records.Close() // 쓰는 중인 기보를 마저 씁니다
	// TODO: 진행 중인 방에 종료를 알리고 기보로 남기기 (docs/deploy-gcp.md 참고)
}

// sessionSecret은 세션 토큰 서명 비밀값입니다. 없으면 임시 값을 만듭니다 (개발용).
// 임시 값이면 서버를 다시 켤 때마다 모든 게스트가 새 게스트가 되고, 서버를 여러 대 띄우면 서로의 토큰을 못 읽습니다.
func sessionSecret(cfg config.Config) []byte {
	if cfg.SessionSecret != "" {
		if len(cfg.SessionSecret) < 32 {
			log.Fatal("SESSION_SECRET은 32자 이상이어야 합니다")
		}
		return []byte(cfg.SessionSecret)
	}
	log.Println("경고: SESSION_SECRET이 없어 임시 비밀값을 씁니다. 운영에서는 반드시 넣으세요.")
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		log.Fatal(err)
	}
	return b
}

// providers는 ID와 비밀값이 둘 다 있는 소셜 로그인만 켭니다. 하나도 없으면 로그인 버튼이 "준비 중"으로 보입니다.
func providers(cfg config.Config) []*auth.Provider {
	var list []*auth.Provider
	if cfg.GoogleClientID != "" && cfg.GoogleClientSecret != "" {
		list = append(list, auth.Google(cfg.GoogleClientID, cfg.GoogleClientSecret))
	}
	if cfg.GitHubClientID != "" && cfg.GitHubClientSecret != "" {
		list = append(list, auth.GitHub(cfg.GitHubClientID, cfg.GitHubClientSecret))
	}
	if cfg.DevLogin {
		log.Println("경고: 개발용 로그인(DEV_LOGIN=1)이 켜져 있습니다. 누구나 dev 계정으로 들어옵니다. 운영에서는 끄세요.")
		list = append(list, auth.Dev())
	}
	if len(list) == 0 {
		log.Println("소셜 로그인이 꺼져 있습니다 (GOOGLE_CLIENT_ID, GITHUB_CLIENT_ID 등이 없음). 게스트로만 들어옵니다.")
	}
	return list
}

// pages가 nil이면 화면과 게임 목록 없이 API만 엽니다. ops가 nil이면 운영자 API를, bots가 nil이면 AI 모델을 열지 않습니다.
func routes(h *hub.Hub, ids *identity.Issuer, records *record.Store, comments *comment.Store, uploads *upload.Store, login *auth.Handler, mine account.Handler, ops *admin.Handler, pages *site.Site, bots *ai.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /api/locale", site.ServeLocale)
	if pages != nil {
		mux.HandleFunc("GET /{$}", site.ServeHome)
		mux.HandleFunc("GET /web/", pages.ServeFile)
		mux.HandleFunc("GET /sdk/playground/", pages.ServeFile)
		mux.HandleFunc("GET /sdk/check.js", pages.ServeFile)
		mux.HandleFunc("GET /trainer/", pages.ServeFile) // 브라우저 AI가 실행기 안에서 쓰는 학습 도구 두 파일만
		mux.HandleFunc("GET /games/", pages.ServeFile)
		mux.HandleFunc("GET /api/games", pages.ServeGames)
	}
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /api/auth/providers", login.ServeProviders)
	mux.HandleFunc("GET /auth/{provider}", login.ServeLogin)
	mux.HandleFunc("GET /auth/{provider}/callback", login.ServeCallback)
	mux.HandleFunc("POST /auth/logout", login.ServeLogout)
	mux.HandleFunc("GET /auth/signup", login.ServeSignupInfo)
	mux.HandleFunc("POST /auth/signup", login.ServeSignup)
	mux.HandleFunc("GET /api/account", mine.ServeGet)
	mux.HandleFunc("PATCH /api/account", mine.ServeRename)
	mux.HandleFunc("DELETE /api/account", mine.ServeDelete)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.HandleFunc("GET /api/rooms", h.ServeRooms)
	mux.HandleFunc("GET /api/live", h.ServeLive)
	matches := record.Handler{Store: records, IDs: ids, Names: ids.Members}
	mux.HandleFunc("GET /api/matches", matches.ServeMine)
	mux.HandleFunc("GET /api/matches/{id}", matches.ServeMatch)
	talk := comment.Handler{Store: comments, IDs: ids}
	mux.HandleFunc("GET /api/games/{game}/comments", talk.ServeList)
	mux.HandleFunc("POST /api/games/{game}/comments", talk.ServePost)
	mux.HandleFunc("DELETE /api/games/{game}/comments/{id}", talk.ServeDelete)
	mux.HandleFunc("POST /api/reports", talk.ServeReport)
	up := upload.Handler{Store: uploads, IDs: ids}
	mux.HandleFunc("GET /api/uploads", up.ServeMine)
	mux.HandleFunc("PATCH /api/uploads/{game}", up.ServeEdit)
	mux.HandleFunc("POST /api/drafts", up.ServeNewDraft)
	mux.HandleFunc("POST /api/drafts/{draft}/publish", up.ServePublish)
	mux.HandleFunc("GET /drafts/{draft}/{path...}", up.ServeDraftFile)
	mux.HandleFunc("GET /uploads/{game}/{version}/{path...}", up.ServeFile)
	mux.HandleFunc("GET /api/games/{game}/clear", up.ServeClear)
	if ops != nil {
		mux.HandleFunc("GET /api/admin", ops.ServeState)
		mux.HandleFunc("POST /api/admin/actions", ops.ServeAction)
		mux.HandleFunc("GET /api/admin/stats", ops.ServeStats)
	}
	if bots != nil {
		mux.HandleFunc("GET /ai/{game}/{file}", bots.ServeFile)
		mux.HandleFunc("GET /api/ai/mine", bots.ServeMine)
		mux.HandleFunc("POST /api/ai/{game}/request", bots.ServeAsk)
		mux.HandleFunc("DELETE /api/ai/{game}/request", bots.ServeCancel)
		mux.HandleFunc("GET /api/ai/{game}/training", bots.ServeTraining)
		mux.HandleFunc("GET /api/admin/ai/requests", bots.ServeRequests)
		mux.HandleFunc("POST /api/admin/ai/{game}/code", bots.ServeCode)
		mux.HandleFunc("POST /api/admin/ai/{game}/decline", bots.ServeDecline)
		mux.HandleFunc("PUT /api/admin/ai/{game}", bots.ServePut)
		mux.HandleFunc("DELETE /api/admin/ai/{game}", bots.ServeDelete)
		mux.HandleFunc("PUT /api/admin/ai/{game}/training", bots.ServePutTraining)
	}
	return mux
}

// GCP 헬스 체크용입니다.
func healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte("ok"))
}
