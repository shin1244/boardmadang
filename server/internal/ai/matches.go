package ai

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"path"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// AI 대국의 기보: AI 화면(web/ai.js)이 두는 동안 판을 통째로 보내면 record.AIStore에 남깁니다 (분석용).
// 사람이 첫 수를 둔 판부터, 진행 알림(LiveBeat)마다 수가 늘었으면, 판이 끝났을 때, 화면을 닫거나 다른 판으로 넘어갈 때 보냅니다.
// 로비의 판 수, 내 대국 목록, 다시보기에는 넣지 않습니다 (record/ai.go).

// maxMatchBody는 받는 본문의 크기입니다. 행동 하나가 60바이트쯤이라 상한(record.MaxAIMoves)까지 들어갑니다.
const maxMatchBody = 512 << 10

// Matches는 AI 대국의 기보를 남기는 곳입니다 (record.AIStore).
type Matches interface {
	Report(u identity.User, country, game, model string, rep record.AIReport) error
}

// ServeMatch는 POST /api/ai/{game}/match 입니다 (JSON만). 본문은 record.AIReport입니다.
// 남겼으면 204입니다. 쿠키가 없으면 401, 모델이 없는 게임이면 404, 본문이 틀리면 400,
// 그 id를 다른 사람이나 다른 판이 쓰고 있으면 403, 이미 끝난 판이면 409, 하루 상한을 넘었으면 429입니다.
// 화면은 실패해도 대국에 상관없이 그냥 넘어갑니다.
func (h Handler) ServeMatch(w http.ResponseWriter, r *http.Request) {
	u, game, ok := h.liveTarget(w, r)
	if !ok || !h.jsonOnly(w, r) {
		return
	}
	var rep record.AIReport
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxMatchBody)).Decode(&rep); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if h.Matches == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	country := ""
	if h.Locate != nil {
		country = h.Locate(r)
	}
	model := ""
	if m := h.Store.Model(game); m != nil {
		model = path.Base(m.Model) // /ai/<게임>/<해시>.onnx → <해시>.onnx
	}
	err := h.Matches.Report(u, country, game, model, rep)
	var bad record.BadReport
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.As(err, &bad):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": bad.Error()})
	case errors.Is(err, record.ErrNotYours):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, record.ErrEnded):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, record.ErrTooMany):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
	default:
		log.Printf("AI 대국 %s를 남기지 못했습니다: %v", rep.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save"})
	}
}
