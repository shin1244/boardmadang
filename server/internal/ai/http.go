package ai

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/site"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

// maxBody는 PUT의 본문입니다. 신경망을 base64로 담으면 4/3배가 됩니다
const maxBody = MaxModel/3*4 + 64<<10

// Handler는 신경망 파일, 제작자의 AI 만들기 요청, 운영자의 대기열과 올리기, 지우기입니다.
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
	// Known은 그 id의 게임이 있는지입니다 (레포 게임이나 올린 게임). 없는 게임에는 모델을 올릴 수 없습니다
	Known func(id string) bool
	// Games는 올린 게임 쪽입니다 (upload.Store). nil이면 제작자 요청과 코드 받기가 꺼집니다
	Games Games
}

// Games는 올린 게임의 주인과 버전, 코드입니다 (upload.Store).
type Games interface {
	Admin(id string) (upload.AdminGame, bool)
	Mine(owner string) upload.Mine
	CodeZip(id, version string) ([]byte, error)
}

// MyAI는 GET /api/ai/mine의 게임 하나입니다. 없는 칸은 빠집니다.
type MyAI struct {
	Request  *Request      `json:"request,omitempty"`
	Training *TrainingInfo `json:"training,omitempty"`
	AI       *site.AIModel `json:"ai,omitempty"`
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

// ---- 제작자 ----

// ServeMine은 내가 올린 게임마다 AI 만들기 요청, 학습 기록, 모델입니다.
func (h Handler) ServeMine(w http.ResponseWriter, r *http.Request) {
	u, ok := h.member(w, r)
	if !ok {
		return
	}
	out := map[string]MyAI{}
	if h.Games != nil {
		for _, g := range h.Games.Mine(u.ID).Games {
			m := MyAI{AI: h.Store.Model(g.ID)}
			if req, ok := h.Store.RequestOf(g.ID); ok {
				m.Request = &req
			}
			if t, ok := h.Store.TrainingOf(g.ID); ok {
				m.Training = &t
			}
			out[g.ID] = m
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"games": out})
}

// ServeAsk는 내가 올린 게임의 지금 버전으로 AI를 요청합니다. 내린 게임은 안 됩니다.
func (h Handler) ServeAsk(w http.ResponseWriter, r *http.Request) {
	u, ok := h.writer(w, r)
	if !ok || !h.jsonOnly(w, r) {
		return
	}
	game := r.PathValue("game")
	g, ok := h.owned(u, game)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	if g.Hidden || g.Blocked {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "hidden"})
		return
	}
	req, err := h.Store.Ask(u.ID, game, g.Version)
	switch {
	case errors.Is(err, ErrOpen), errors.Is(err, ErrTrained):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrBusy):
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("AI 요청 저장 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("AI 요청: %s가 %s(%s)의 AI를 요청함", u.ID, game, g.Version)
		writeJSON(w, http.StatusOK, map[string]any{"request": req})
	}
}

// ServeCancel은 기다리는 중인 내 요청을 거둡니다.
func (h Handler) ServeCancel(w http.ResponseWriter, r *http.Request) {
	u, ok := h.member(w, r)
	if !ok {
		return
	}
	game := r.PathValue("game")
	err := h.Store.Cancel(u.ID, game)
	switch {
	case errors.Is(err, ErrNotYours):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
	case errors.Is(err, ErrNoAsk):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("AI 요청 거두기 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// ServeTraining은 학습 기록입니다. 게임의 허점이 드러날 수 있어 게임 주인과 운영자만 봅니다 (다른 사람에게는 없는 것처럼 404).
func (h Handler) ServeTraining(w http.ResponseWriter, r *http.Request) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return
	}
	game := r.PathValue("game")
	if _, mine := h.owned(u, game); !mine && !u.Admin {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	data, err := h.Store.trainingFile(game)
	if errors.Is(err, os.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no training"})
		return
	}
	if err != nil {
		log.Printf("학습 기록 읽기 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// ---- 운영자 ----

// ServeRequests는 AI 만들기 요청 목록과 게임마다 학습 기록 요약입니다.
func (h Handler) ServeRequests(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.admin(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": h.Store.Requests(), "trainings": h.Store.Trainings()})
}

// ServeCode는 올린 게임의 코드 zip입니다 (upload.Store.CodeZip). 요청이 있으면 요청한 버전을, 없으면 지금 버전을 줍니다.
// 받아 가면 요청이 학습 중이 됩니다. 상태를 바꾸므로 GET이 아니라 JSON 본문의 POST입니다 (다른 사이트가 못 부름).
func (h Handler) ServeCode(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok || !h.jsonOnly(w, r) {
		return
	}
	game := r.PathValue("game")
	var g upload.AdminGame
	if h.Games != nil {
		g, ok = h.Games.Admin(game)
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	version := g.Version
	if req, ok := h.Store.RequestOf(game); ok && req.open() {
		version = req.Version
	}
	data, err := h.Games.CodeZip(game, version)
	if errors.Is(err, upload.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no code"})
		return
	}
	if err == nil {
		_, _, err = h.Store.Take(game)
	}
	if err != nil {
		log.Printf("게임 코드 묶기 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	log.Printf("AI 요청: %s가 %s(%s)의 코드를 받음", u.ID, game, version)
	hd := w.Header()
	hd.Set("Content-Type", "application/zip")
	hd.Set("Content-Disposition", `attachment; filename="`+game+"-"+version+`.zip"`)
	hd.Set("Cache-Control", "no-store")
	hd.Set("X-Content-Type-Options", "nosniff")
	w.Write(data)
}

// ServeDecline은 요청을 반려합니다. 이유(note)는 제작자에게 보입니다.
func (h Handler) ServeDecline(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok || !h.jsonOnly(w, r) {
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	game := r.PathValue("game")
	req, err := h.Store.Decline(game, body.Note)
	var bad BadMeta
	switch {
	case errors.As(err, &bad):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": bad.Error()})
	case errors.Is(err, ErrNoAsk):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("AI 요청 반려 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("AI 요청: %s가 %s의 요청을 반려함", u.ID, game)
		writeJSON(w, http.StatusOK, map[string]any{"request": req})
	}
}

// ServePutTraining은 학습 기록(trainer/train.py가 쓴 snapshots.json 그대로)을 올립니다.
func (h Handler) ServePutTraining(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok {
		return
	}
	game := r.PathValue("game")
	if !gamePattern.MatchString(game) || h.Known == nil || !h.Known(game) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return
	}
	if !h.jsonOnly(w, r) {
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxTraining))
	if errors.As(err, new(*http.MaxBytesError)) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "snapshots.json must be up to 2MB"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad body"})
		return
	}
	info, err := h.Store.PutTraining(u.ID, game, data)
	var bad BadMeta
	switch {
	case errors.As(err, &bad):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": bad.Error()})
	case err != nil:
		log.Printf("학습 기록 저장 실패 %s: %v", game, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("학습 기록: %s가 %s의 기록을 올림 (스냅샷 %d개)", u.ID, game, info.Snapshots)
		writeJSON(w, http.StatusOK, map[string]any{"training": info})
	}
}

// ---- 공통 ----

// owned는 u가 올린 게임인지입니다.
func (h Handler) owned(u identity.User, game string) (upload.AdminGame, bool) {
	if h.Games == nil || !gamePattern.MatchString(game) {
		return upload.AdminGame{}, false
	}
	g, ok := h.Games.Admin(game)
	return g, ok && g.Owner == u.ID
}

// jsonOnly는 JSON 본문만 받습니다. 다른 사이트의 폼은 JSON을 보낼 수 없고, fetch는 미리 확인(preflight)에서 막힙니다.
func (h Handler) jsonOnly(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return false
	}
	return true
}

// member는 계정만 통과시킵니다 (internal/upload와 같은 응답). 쿠키가 없으면 401, 게스트면 403 {"error":"member only"}.
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

// writer는 member에 더해 정지된 계정이면 403 {"error":"suspended"}.
func (h Handler) writer(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	u, ok := h.member(w, r)
	if ok && u.Suspended {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "suspended"})
		return identity.User{}, false
	}
	return u, ok
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
