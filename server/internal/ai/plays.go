package ai

import (
	"encoding/json"
	"net/http"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/stats"
)

// Plays는 운영 통계의 AI 대국 수입니다 (stats.Tracker의 ai.go).
type Plays interface {
	AIPlay(r *http.Request, u identity.User, game string) bool
	AIEnd(r *http.Request, u identity.User, game, result string) bool
}

// ServePlays는 POST /api/ai/{game}/plays 입니다. AI 대국은 브라우저 안에서만 돌아서 서버가 모르므로
// AI 화면(web/ai.js)이 판의 시작과 끝을 알려 주고, 서버는 날마다, 게임마다 판 수만 셉니다. 기보나 랭킹에는 남기지 않습니다.
//
// 본문(JSON만)은 {"event":"play"} (사람이 그 판의 첫 수를 둠) 또는 {"event":"end","result":"win"|"lose"|"draw"} (사람 쪽 결과).
// 셌든 안 셌든(로봇, 하루 상한, 시작하지 않은 판의 끝) 204입니다. 쿠키가 없으면 401, 모델이 없는 게임이면 404, 본문이 틀리면 400.
func (h Handler) ServePlays(w http.ResponseWriter, r *http.Request) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return
	}
	if !h.jsonOnly(w, r) {
		return
	}
	game := r.PathValue("game")
	if !gamePattern.MatchString(game) || h.Store.Model(game) == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	var body struct {
		Event  string `json:"event"`
		Result string `json:"result"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	switch body.Event {
	case "play":
		if h.Plays != nil {
			h.Plays.AIPlay(r, u, game)
		}
	case "end":
		if body.Result != stats.AIWin && body.Result != stats.AILose && body.Result != stats.AIDraw {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad result"})
			return
		}
		if h.Plays != nil {
			h.Plays.AIEnd(r, u, game, body.Result)
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad event"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
