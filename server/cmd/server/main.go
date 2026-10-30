// boardmadang 서버 진입점입니다.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
)

func main() {
	cfg := config.Load()
	h := hub.New(cfg)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           routes(h),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("서버 시작: http://localhost:%s", cfg.Port)
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
	// TODO: 진행 중인 방에 종료를 알리고, 기록을 저장소에 남기기 (docs/deploy-gcp.md 참고)
}

func routes(h *hub.Hub) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("GET /ws", h.ServeWS)
	return mux
}

// GCP 헬스 체크용입니다.
func healthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte("ok"))
}
