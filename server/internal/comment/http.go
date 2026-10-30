package comment

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// Handler는 의견과 신고 API입니다.
//
//	GET    /api/games/{game}/comments        의견 목록, 최근 것부터 {"comments":[...],"count":N}
//	POST   /api/games/{game}/comments        의견 남기기 {"text":"..."}
//	DELETE /api/games/{game}/comments/{id}   내 의견 지우기
//	POST   /api/reports                      신고 {"game":"...","comment":"...","reason":"spam","detail":"..."}
//
// 남기기, 지우기, 신고는 세션 쿠키가 있어야 합니다 (게스트도 됩니다).
// POST는 JSON 본문만 받습니다. 다른 사이트의 폼은 JSON을 보낼 수 없고, fetch로 보내면 브라우저가 미리 확인(preflight)하는데
// 이 서버가 CORS 허가를 주지 않아서 막힙니다. 쿠키도 SameSite=Lax라 다른 사이트의 POST에는 붙지 않습니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
}

const maxBody = 8 << 10

func (h Handler) ServeList(w http.ResponseWriter, r *http.Request) {
	viewer := ""
	if u, ok := h.IDs.FromRequest(r); ok {
		viewer = u.ID
	}
	list, count, err := h.Store.List(r.PathValue("game"), viewer)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": list, "count": count})
}

func (h Handler) ServePost(w http.ResponseWriter, r *http.Request) {
	u, ok := h.user(w, r)
	if !ok {
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	v, err := h.Store.Post(r.PathValue("game"), u, body.Text)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

func (h Handler) ServeDelete(w http.ResponseWriter, r *http.Request) {
	u, ok := h.user(w, r)
	if !ok {
		return
	}
	if err := h.Store.Delete(r.PathValue("game"), r.PathValue("id"), u); err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h Handler) ServeReport(w http.ResponseWriter, r *http.Request) {
	u, ok := h.user(w, r)
	if !ok {
		return
	}
	var body Report
	if !readJSON(w, r, &body) {
		return
	}
	hidden, err := h.Store.Report(u, Report{Game: body.Game, Comment: body.Comment, Reason: body.Reason, Detail: body.Detail})
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true, "hidden": hidden})
}

func (h Handler) user(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
	}
	return u, ok
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return false
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return false
	}
	return true
}

func (h Handler) fail(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrNotYours):
		status = http.StatusForbidden
	case errors.Is(err, ErrTooSoon), errors.Is(err, ErrTooMany):
		status = http.StatusTooManyRequests
	case errors.Is(err, ErrBadGame), errors.Is(err, ErrEmpty), errors.Is(err, ErrTooLong),
		errors.Is(err, ErrOwn), errors.Is(err, ErrBadReason):
	default:
		log.Printf("의견 저장소 오류: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
