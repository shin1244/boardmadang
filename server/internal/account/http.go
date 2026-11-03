package account

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// Handler는 내 계정 API입니다. 계정만 됩니다 (쿠키가 없으면 401, 게스트면 403 {"error":"member only"}).
//
//	GET    /api/account   내 계정 Info
//	PATCH  /api/account   이름 바꾸기 {"name":"..."} → 200 Info. 400 {"error":"name length|name chars|name reserved|name same"},
//	                      RenameEvery가 안 지났으면 429 {"error":"rename too soon","renameAfter":"..."}
//	DELETE /api/account   탈퇴 {"confirm":"<지금 이름>"} → 204. 이름이 다르면 400 {"error":"confirm"}. 세션 쿠키를 지웁니다
//
// PATCH와 DELETE는 JSON 본문만 받습니다. 다른 사이트의 폼은 이런 요청을 보낼 수 없고, fetch는 미리 확인(preflight)에서 막힙니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
	// Forget은 탈퇴한 계정 id로 차례로 부릅니다. 기보(record), 의견(comment), 올린 게임(upload)에서 그 계정을 지웁니다.
	// 계정을 먼저 지운 뒤에 부르므로 그사이에 새 의견이나 업로드가 생기지 않습니다 (토큰이 바로 거절됨).
	// 하나가 실패해도 나머지는 부르고 로그만 남깁니다. 계정은 이미 없어서 다시 시도할 수 없으니 운영자가 로그를 보고 마저 지웁니다.
	Forget []func(id string) error
}

// Info는 내 계정 화면에 보내는 것입니다.
type Info struct {
	Name     string    `json:"name"`
	Provider string    `json:"provider"` // google, github, dev
	Created  time.Time `json:"created"`
	// 이름을 다시 바꿀 수 있는 때. 지금 바꿀 수 있으면 없음
	RenameAfter time.Time `json:"renameAfter,omitzero"`
	Min         int       `json:"min"` // 이름 글자 수
	Max         int       `json:"max"`
}

func (s *Store) info(a Account) Info {
	return Info{Name: a.Name, Provider: a.Provider, Created: a.Created, RenameAfter: a.RenameAfter(s.now()), Min: MinName, Max: MaxName}
}

func (h Handler) ServeGet(w http.ResponseWriter, r *http.Request) {
	a, ok := h.account(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, h.Store.info(a))
}

func (h Handler) ServeRename(w http.ResponseWriter, r *http.Request) {
	a, ok := h.account(w, r)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	next, err := h.Store.Rename(a.ID, body.Name)
	switch {
	case errors.Is(err, ErrNameLength), errors.Is(err, ErrNameChars), errors.Is(err, ErrNameReserved), errors.Is(err, ErrNameSame):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrRenameSoon):
		writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": err.Error(), "renameAfter": a.RenameAfter(h.Store.now())})
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
	case err != nil:
		log.Printf("계정 %s의 이름을 바꾸지 못했습니다: %v", a.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("계정 %s의 이름을 바꿨습니다", a.ID)
		writeJSON(w, http.StatusOK, h.Store.info(next))
	}
}

func (h Handler) ServeDelete(w http.ResponseWriter, r *http.Request) {
	a, ok := h.account(w, r)
	if !ok {
		return
	}
	var body struct {
		Confirm string `json:"confirm"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	// 잘못 눌러 탈퇴하지 않게 지금 이름을 그대로 적어야 합니다
	if strings.TrimSpace(body.Confirm) != a.Name {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "confirm"})
		return
	}
	if err := h.Store.Delete(a.ID); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
			return
		}
		log.Printf("계정 %s를 지우지 못했습니다: %v", a.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	h.IDs.ClearCookie(w, r)
	log.Printf("계정 %s (%s)가 탈퇴했습니다", a.ID, a.Provider)
	for _, forget := range h.Forget {
		if err := forget(a.ID); err != nil {
			log.Printf("탈퇴한 계정 %s의 기록을 다 지우지 못했습니다. 손으로 마저 지워 주세요: %v", a.ID, err)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// account는 요청한 사람의 계정입니다. 쿠키가 없으면 401, 게스트면 403 {"error":"member only"}.
func (h Handler) account(w http.ResponseWriter, r *http.Request) (Account, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return Account{}, false
	}
	if !u.IsMember() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "member only"})
		return Account{}, false
	}
	a, ok := h.Store.Get(u.ID)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return Account{}, false
	}
	return a, true
}

// readJSON은 JSON 본문을 v에 읽습니다. 안 되면 오류를 보내고 false입니다.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return false
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(v) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
