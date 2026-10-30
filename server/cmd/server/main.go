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

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
)

func main() {
	cfg := config.Load()
	ids := identity.NewIssuer(sessionSecret(cfg))
	records, err := record.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("기보 폴더를 열지 못했습니다 (DATA_DIR=%s): %v", cfg.DataDir, err)
	}
	h := hub.New(cfg, ids, records)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           routes(h, ids, records),
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

func routes(h *hub.Hub, ids *identity.Issuer, records *record.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.HandleFunc("GET /api/rooms", h.ServeRooms)
	matches := record.Handler{Store: records, IDs: ids}
	mux.HandleFunc("GET /api/matches", matches.ServeMine)
	mux.HandleFunc("GET /api/matches/{id}", matches.ServeMatch)
	// TODO: 업로드와 등록 정보 저장은 계정만 됩니다. 붙일 때 ids.RequireMember로 감쌉니다.
	//   mux.Handle("PUT /api/games/{id}/listing", ids.RequireMember(...))
	return mux
}

// GCP 헬스 체크용입니다.
func healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte("ok"))
}
