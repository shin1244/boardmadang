package record

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 내 대국 목록에 보여줄 최대 수
const mineLimit = 50

// View는 브라우저에 보내는 대국입니다. 플레이어의 내부 id는 빼고, 보는 사람이 앉았던 자리를 붙입니다.
type View struct {
	ID      string                 `json:"id"`
	Game    string                 `json:"game"`
	Version string                 `json:"version,omitempty"`
	Seed    uint32                 `json:"seed"`
	Minutes *int                   `json:"minutes"`
	Players [2]protocol.PlayerInfo `json:"players"`
	You     []int                  `json:"you"` // 보는 사람의 자리. 안 둔 사람이면 [], 혼자 두 자리면 [0, 1]
	Moves   []Move                 `json:"moves,omitempty"`
	Count   int                    `json:"count"` // 행동 수
	Winner  *int                   `json:"winner"`
	Reason  string                 `json:"reason"`
	Clock   *[2]int64              `json:"clock,omitempty"`
	Started time.Time              `json:"started"`
	Ended   time.Time              `json:"ended"`
}

func viewOf(m *Match, viewer string, withMoves bool) View {
	v := View{
		ID: m.ID, Game: m.Game, Version: m.Version, Seed: m.Seed, Minutes: m.Minutes,
		You: []int{}, Count: len(m.Moves),
		Winner: m.Winner, Reason: m.Reason, Clock: m.Clock, Started: m.Started, Ended: m.Ended,
	}
	for i, p := range m.Players {
		v.Players[i] = protocol.PlayerInfo{Kind: p.Kind, Tag: p.Tag, Name: p.Name}
		if viewer != "" && p.ID == viewer {
			v.You = append(v.You, i)
		}
	}
	if withMoves {
		v.Moves = m.Moves
	}
	return v
}

// Handler는 기보 API입니다.
//
//	GET /api/matches/{id}   기보 하나 (행동 기록 포함). id를 아는 사람은 누구나 볼 수 있습니다
//	GET /api/matches        내가 둔 대국 목록, 최근 것부터 (행동 기록 없이)
type Handler struct {
	Store *Store
	IDs   *identity.Issuer
}

func (h Handler) viewer(r *http.Request) string {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		return ""
	}
	return u.ID
}

func (h Handler) ServeMatch(w http.ResponseWriter, r *http.Request) {
	m, err := h.Store.Get(r.PathValue("id"))
	if errors.Is(err, ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err != nil {
		log.Printf("기보 읽기 실패: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, http.StatusOK, viewOf(m, h.viewer(r), true))
}

// ServeMine은 쿠키가 없으면 빈 목록입니다. 게스트를 새로 발급하지는 않습니다.
func (h Handler) ServeMine(w http.ResponseWriter, r *http.Request) {
	out := []View{}
	if me := h.viewer(r); me != "" {
		list, err := h.Store.ListByUser(me, mineLimit)
		if err != nil {
			log.Printf("기보 목록 실패: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
			return
		}
		for _, m := range list {
			out = append(out, viewOf(m, me, false))
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
