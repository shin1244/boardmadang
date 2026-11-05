package star

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// Handler는 별 API입니다. 게임마다 별 수는 /api/games의 stars에 있습니다 (internal/site).
//
//	GET    /api/stars              내가 별을 단 게임 {"games":["splat-chess",…]}. 게스트이거나 세션이 없으면 빈 목록
//	PUT    /api/games/{game}/star  별 달기 → {"stars":N,"starred":true}
//	DELETE /api/games/{game}/star  별 떼기 → {"stars":N,"starred":false}
//
// 달기와 떼기는 계정만 됩니다 (세션이 없으면 401, 게스트면 403 {"error":"member only"}).
// 정지된 계정은 달 수 없고(403 {"error":"suspended"}) 뗄 수는 있습니다. 없는 게임에 달면 404 {"error":"not found"}.
// 본문이 없는 PUT, DELETE라 다른 사이트의 폼으로는 보낼 수 없고, fetch로 보내면 브라우저가 미리 확인(preflight)하는데
// 이 서버가 CORS 허가를 주지 않아서 막힙니다. 쿠키도 SameSite=Lax라 다른 사이트의 요청에는 붙지 않습니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
	// Known은 별을 달 수 있는 게임인지입니다 (레포 게임이나 올린 게임). nil이면 모든 게임
	Known func(game string) bool
}

func (h Handler) ServeMine(w http.ResponseWriter, r *http.Request) {
	games := []string{}
	if u, ok := h.IDs.FromRequest(r); ok && u.IsMember() {
		games = h.Store.Mine(u.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"games": games})
}

func (h Handler) ServeStar(w http.ResponseWriter, r *http.Request)   { h.set(w, r, true) }
func (h Handler) ServeUnstar(w http.ResponseWriter, r *http.Request) { h.set(w, r, false) }

func (h Handler) set(w http.ResponseWriter, r *http.Request, on bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return
	}
	if on {
		if status, reason := identity.WriteDenied(u); reason != "" {
			writeJSON(w, status, map[string]string{"error": reason})
			return
		}
	} else if !u.IsMember() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "member only"})
		return
	}
	game := r.PathValue("game")
	if on && h.Known != nil && !h.Known(game) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	n, err := h.Store.Set(game, u.ID, on)
	switch {
	case errors.Is(err, ErrBadGame):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("별 저장 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		writeJSON(w, http.StatusOK, map[string]any{"stars": n, "starred": on})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
