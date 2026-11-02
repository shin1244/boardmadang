package upload

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// Handler는 게임 올리기 API와 올린 게임의 파일입니다.
//
//	GET  /api/uploads                         내가 올린 게임과 오늘 남은 등록 횟수 {"games":[...],"left":N}
//	POST /api/drafts                          zip 본문(Content-Type: application/zip) → 201 Draft
//	POST /api/drafts/{draft}/publish          {"id":"...","listing":{...},"thumbnail":true} → 200 {"game":{...}}
//	GET  /drafts/{draft}/{path...}            초안의 파일 (실행기가 불러옴)
//	GET  /uploads/{game}/{version}/{path...}  올린 게임의 코드
//
// API는 계정만 됩니다 (쿠키가 없으면 401, 게스트면 403 {"error":"member only"}).
// 규칙에 맞지 않으면 422 {"error":"problems","problems":[{code, file?, field?, lang?, max?}]}입니다.
// POST는 zip이나 JSON 본문만 받습니다. 다른 사이트의 폼은 이런 본문을 보낼 수 없고, fetch는 미리 확인(preflight)에서 막힙니다.
//
// 파일은 쿠키 없이 누구나 받습니다. 실행기의 Worker는 출처가 없어서 쿠키를 붙이지 못하기 때문입니다.
// 초안 주소는 짐작할 수 없는 id라서 올린 사람만 압니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
}

// maxPublishBody: 등록 정보는 10개 언어로 룰북을 다 채우면 1MB 가까이 됩니다
const maxPublishBody = MaxListingFile + 8<<10

func (h Handler) ServeMine(w http.ResponseWriter, r *http.Request) {
	u, ok := h.member(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, h.Store.Mine(u.ID))
}

func (h Handler) ServeNewDraft(w http.ResponseWriter, r *http.Request) {
	u, ok := h.member(w, r)
	if !ok {
		return
	}
	if r.Header.Get("Content-Type") != "application/zip" {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "zip only"})
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxZip))
	if err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "problems", "problems": Problems{{Code: "zip.tooBig", Max: MaxZip}}})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	d, err := h.Store.NewDraft(u, data)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (h Handler) ServePublish(w http.ResponseWriter, r *http.Request) {
	u, ok := h.member(w, r)
	if !ok {
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return
	}
	var body struct {
		ID        string `json:"id"`
		Listing   any    `json:"listing"`
		Thumbnail bool   `json:"thumbnail"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPublishBody)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	g, err := h.Store.Publish(u, r.PathValue("draft"), body.ID, body.Listing, body.Thumbnail)
	if err != nil {
		h.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"game": g})
}

// ServeDraftFile은 초안의 파일입니다. 고쳐서 다시 올리면 새 초안이 되지만, 혹시 몰라 캐시하지 않습니다.
func (h Handler) ServeDraftFile(w http.ResponseWriter, r *http.Request) {
	if !draftPattern.MatchString(r.PathValue("draft")) {
		http.NotFound(w, r)
		return
	}
	data, err := h.Store.draftFile(r.PathValue("draft"), r.PathValue("path"))
	serveFile(w, r, data, err, "no-store")
}

// ServeFile은 올린 게임의 코드입니다. 주소의 버전이 곧 내용의 해시라서 바뀌지 않으므로 오래 캐시합니다.
func (h Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	data, err := h.Store.gameFile(r.PathValue("game"), r.PathValue("version"), r.PathValue("path"))
	serveFile(w, r, data, err, "public, max-age=31536000, immutable")
}

// types는 내보내는 파일의 종류입니다 (site의 types 가운데 게임 폴더에 있을 수 있는 것).
var types = map[string]string{
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
}

func serveFile(w http.ResponseWriter, r *http.Request, data []byte, err error, cache string) {
	name := r.PathValue("path")
	ctype, ok := types[path.Ext(name)]
	if errors.Is(err, ErrNotFound) || !ok {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("올린 게임 파일 읽기 실패 %s: %v", r.URL.Path, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", ctype)
	hd.Set("Cache-Control", cache)
	hd.Set("X-Content-Type-Options", "nosniff")
	// 실행기의 Worker는 출처가 없어서 모듈을 CORS로만 불러올 수 있습니다 (site.ServeFile과 같은 이유)
	hd.Set("Access-Control-Allow-Origin", "*")
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

// member는 계정만 통과시킵니다. 쿠키가 없으면 401, 게스트면 403 {"error":"member only"}.
func (h Handler) member(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return identity.User{}, false
	}
	if !u.IsMember() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "member only"})
		return identity.User{}, false
	}
	return u, true
}

func (h Handler) fail(w http.ResponseWriter, err error) {
	var problems Problems
	switch {
	case errors.As(err, &problems):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "problems", "problems": problems})
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrBadID):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrTooMany):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
	default:
		log.Printf("게임 올리기 오류: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
