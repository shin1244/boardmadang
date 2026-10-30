package hub

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 관전: 진행 중인 대국(GET /api/live)을 다른 사람이 볼 수 있습니다.
// 관전자는 행동을 보낼 수 없고, 양쪽이 받는 relay, clock, ended와 끊김(away, back), 무승부 제안을 같이 받습니다.
// 처음 붙을 때는 끊겼다 돌아온 플레이어처럼 시드와 지금까지의 기록(watching)을 받아 판을 재생합니다.
//
// 락스텝이라 플레이어의 브라우저에도 이미 판 전체가 있습니다. 관전 때문에 숨겨진 정보가 새로 새지는 않습니다.

// watch는 c를 대국 code의 관전자로 붙입니다.
func (h *Hub) watch(c *Client, code string) {
	if !h.begin(c) {
		return
	}
	r := h.rooms[code]
	if r == nil {
		h.mu.Unlock()
		c.sendError("room not found")
		return
	}
	c.watching = r
	h.mu.Unlock()
	// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서). 그 사이에 끝났으면 addWatcher가 알려 줍니다.
	r.addWatcher(c)
}

func (r *Room) addWatcher(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended || len(r.watchers) >= MaxWatchers {
		r.hub.unwatch(c, r) // 락 순서 r.mu → h.mu
		if r.ended {
			c.sendError("room not found")
		} else {
			c.sendError("too many watchers")
		}
		return
	}
	r.watchers[c] = struct{}{}
	c.Send(protocol.Watching{
		Type:    protocol.TypeWatching,
		Room:    r.ID,
		Game:    r.Game,
		Version: r.Version,
		Seed:    r.Seed,
		Minutes: r.Minutes,
		Players: r.playerInfos(),
		Clock:   r.clockMsg(),
		Draw:    r.drawBy,
		Log:     r.logCopy(),
	})
}

// removeWatcher는 연결이 끊긴 관전자를 뺍니다. Hub.leave에서 부릅니다.
func (r *Room) removeWatcher(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.watchers, c)
}

func (h *Hub) unwatch(c *Client, r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.watching == r {
		c.watching = nil
	}
}

// toWatchers는 관전자에게만 보냅니다. 한쪽 플레이어에게만 가는 알림(away, back)을 관전자도 보게 합니다. r.mu를 잡고 부릅니다.
func (r *Room) toWatchers(msg any) {
	for w := range r.watchers {
		w.Send(msg)
	}
}

// playerInfos는 양쪽의 보여줄 신원입니다. r.mu를 잡고 부릅니다.
func (r *Room) playerInfos() [2]protocol.PlayerInfo {
	var out [2]protocol.PlayerInfo
	for i, p := range r.Players {
		out[i] = protocol.PlayerInfo{Kind: p.user.Kind, Tag: p.user.Tag, Name: p.user.Name}
	}
	return out
}

// live는 진행 중인 대국 목록의 한 줄입니다. 이미 끝났으면 false.
func (r *Room) live(now time.Time) (protocol.LiveRoom, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended {
		return protocol.LiveRoom{}, false
	}
	return protocol.LiveRoom{
		Room:     r.ID,
		Game:     r.Game,
		Version:  r.Version,
		Minutes:  r.Minutes,
		Players:  r.playerInfos(),
		Moves:    len(r.Log),
		Watchers: len(r.watchers),
		Age:      int(now.Sub(r.started) / time.Second),
	}, true
}

// ServeLive는 GET /api/live 입니다. 진행 중인 대국을 최근에 시작한 순서로 돌려줍니다.
func (h *Hub) ServeLive(w http.ResponseWriter, req *http.Request) {
	h.mu.Lock()
	rooms := make([]*Room, 0, len(h.rooms))
	for _, r := range h.rooms {
		rooms = append(rooms, r)
	}
	h.mu.Unlock()

	// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서).
	now := time.Now()
	out := make([]protocol.LiveRoom, 0, len(rooms))
	for _, r := range rooms {
		if v, ok := r.live(now); ok {
			out = append(out, v)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Age < out[j].Age })
	if len(out) > maxListed {
		out = out[:maxListed]
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}
