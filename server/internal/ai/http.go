package ai

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// maxBody는 PUT의 본문입니다. 신경망을 base64로 담으면 4/3배가 됩니다
const maxBody = MaxModel/3*4 + 64<<10

// Handler는 신경망 파일과 운영자의 올리기, 지우기입니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
	// Known은 그 id의 게임이 있는지입니다 (레포 게임이나 올린 게임). 없는 게임에는 모델을 올릴 수 없습니다
	Known func(id string) bool
}

// PutRequest는 PUT /api/admin/ai/{game}의 본문입니다.
type PutRequest struct {
	Meta  Meta   `json:"meta"`  // trainer/train.py --export-onnx가 쓴 model.json
	Model string `json:"model"` // model.onnx의 base64
}

// ServeFile은 신경망 파일을 내보냅니다. 이름이 내용의 해시라 오래 캐시합니다.
func (h Handler) ServeFile(w http.ResponseWriter, r *http.Request) {
	data, err := h.Store.file(r.PathValue("game"), r.PathValue("file"))
	if errors.Is(err, ErrNoModel) || errors.Is(err, os.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		log.Printf("AI 모델 읽기 실패 %s: %v", r.URL.Path, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "application/octet-stream")
	hd.Set("Cache-Control", "public, max-age=31536000, immutable")
	hd.Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
}

func (h Handler) ServePut(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok {
		return
	}
	game := r.PathValue("game")
	if !gamePattern.MatchString(game) || h.Known == nil || !h.Known(game) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return
	}
	var req PutRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&req); err != nil {
		if errors.As(err, new(*http.MaxBytesError)) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "model must be an ONNX file up to 16MB"})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	model, err := base64.StdEncoding.DecodeString(req.Model)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "model must be base64"})
		return
	}
	meta, err := h.Store.Put(u.ID, game, req.Meta, model)
	var bad BadMeta
	switch {
	case errors.As(err, &bad):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": bad.Error()})
	case err != nil:
		log.Printf("AI 모델 저장 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("AI 모델: %s가 %s의 모델을 올림 (%s, %d바이트, 학습한 버전 %v)", u.ID, game, meta.File, meta.Size, deref(meta.Version))
		writeJSON(w, http.StatusOK, map[string]any{"ai": meta.summary()})
	}
}

func (h Handler) ServeDelete(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok {
		return
	}
	game := r.PathValue("game")
	err := h.Store.Delete(game)
	switch {
	case errors.Is(err, ErrNoModel):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("AI 모델 지우기 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("AI 모델: %s가 %s의 모델을 지움", u.ID, game)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// admin은 운영자만 통과시킵니다 (internal/admin과 같은 응답).
func (h Handler) admin(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return identity.User{}, false
	}
	if !u.Admin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
		return identity.User{}, false
	}
	return u, true
}

func deref(s *string) string {
	if s == nil {
		return "모름"
	}
	return *s
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
