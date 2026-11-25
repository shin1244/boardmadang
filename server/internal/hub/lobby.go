package hub

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 방 목록: 빠른 매칭 대신 방을 만들어 두면 목록에 올라가고, 누가 골라 들어오면 대국이 시작됩니다.
// 방장은 타이머를 정할 수 있고(게임이 허용하면), BumpEvery마다 한 번 방을 목록 맨 위로 다시 올릴 수 있습니다.
// 방장의 연결이 끊기면 방은 바로 사라집니다. 방은 계정만 만들 수 있고(정지된 계정은 안 됨), 들어가는 것은 게스트도 됩니다.

// 방 목록에 한 번에 보여줄 최대 수
const maxListed = 200

type openRoom struct {
	ID      string
	Game    string
	Version string // 방장이 불러온 게임 코드 버전. 들어오는 사람도 같아야 합니다
	Minutes *int
	host    *Client
	bumped  time.Time // 만든 때 또는 마지막으로 올린 때. 목록은 이 순서로 최신이 위입니다
}

// create는 방을 만들어 방 목록에 올립니다. 붙은 뒤에 정지됐을 수 있어 신원을 다시 읽습니다.
func (h *Hub) create(c *Client, game string, minutes *int, version string) {
	u, ok := h.ids.Refresh(c.user)
	if !ok {
		c.sendError("no session")
		return
	}
	if _, reason := identity.WriteDenied(u); reason != "" {
		c.sendError(reason)
		return
	}
	if !gameIDPattern.MatchString(game) {
		c.sendError("unknown game")
		return
	}
	if !validMinutes(minutes) {
		c.sendError("bad minutes")
		return
	}
	if !versionPattern.MatchString(version) {
		c.sendError("bad version")
		return
	}
	if !h.begin(c) {
		return
	}
	defer h.mu.Unlock()

	o := &openRoom{ID: h.newRoomID(), Game: game, Version: version, Minutes: minutes, host: c, bumped: time.Now()}
	h.open[o.ID] = o
	c.hosting = o.ID
	c.Send(protocol.Created{
		Type:      protocol.TypeCreated,
		Room:      o.ID,
		Game:      game,
		Minutes:   minutes,
		BumpEvery: int(BumpEvery / time.Second),
	})
}

// enter는 방 목록의 방에 들어가 대국을 시작합니다. 먼저 들어온 한 명만 됩니다.
// 방장과 게임 코드 버전이 다르면 들어갈 수 없습니다 (한쪽 브라우저가 옛 코드를 들고 있음).
func (h *Hub) enter(c *Client, code, version string) {
	if !h.begin(c) {
		return
	}
	defer h.mu.Unlock()

	o := h.open[code]
	if o == nil {
		c.sendError("room not found")
		return
	}
	if o.Version != version {
		c.sendError("version mismatch")
		return
	}
	delete(h.open, code)
	o.host.hosting = ""
	h.start(o.ID, o.Game, o.Minutes, o.Version, [2]*Client{o.host, c}, true)
}

// bump는 방장의 방을 목록 맨 위로 올립니다. BumpEvery가 지나야 다시 됩니다.
func (h *Hub) bump(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	o := h.open[c.hosting]
	if o == nil {
		c.sendError("not hosting")
		return
	}
	now := time.Now()
	if now.Sub(o.bumped) < BumpEvery {
		c.sendError("too soon")
		return
	}
	o.bumped = now
	c.Send(protocol.Bumped{Type: protocol.TypeBumped})
}

// ServeRooms는 GET /api/rooms 입니다. 상대를 기다리는 방을 최근에 만들거나 올린 순서로 돌려줍니다.
// 게임 이름은 브라우저가 /api/games에서 찾아 붙입니다.
func (h *Hub) ServeRooms(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	list := make([]*openRoom, 0, len(h.open))
	for _, o := range h.open {
		list = append(list, o)
	}
	now := time.Now()
	sort.Slice(list, func(i, j int) bool { return list[i].bumped.After(list[j].bumped) })
	if len(list) > maxListed {
		list = list[:maxListed]
	}
	out := make([]protocol.OpenRoom, len(list))
	for i, o := range list {
		u := o.host.user
		out[i] = protocol.OpenRoom{
			Room:    o.ID,
			Game:    o.Game,
			Version: o.Version,
			Minutes: o.Minutes,
			Host:    protocol.PlayerInfo{Kind: u.Kind, Tag: u.Tag, Name: u.Name},
			Age:     int(now.Sub(o.bumped) / time.Second),
		}
	}
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}

// ServeWaiting은 GET /api/waiting 입니다. 빠른 매칭에서 상대를 기다리는 사람을 게임, 코드 버전, 타이머로만 알려 줍니다 (누구인지는 빼고).
// 로비와 방 목록이 "지금 상대를 찾는 사람이 있다"고 보여 주면, 다음 사람이 대전 찾기를 눌러 바로 만납니다.
// 묻는 사람이 다른 탭에서 기다리는 것은 뺍니다 (자기를 기다리는 사람으로 보지 않게).
func (h *Hub) ServeWaiting(w http.ResponseWriter, r *http.Request) {
	me, _ := h.ids.FromRequest(r)
	h.mu.Lock()
	out := make([]protocol.Seeker, 0, len(h.queue))
	for _, q := range h.queue {
		if me.ID != "" && q.c.user.ID == me.ID {
			continue
		}
		out = append(out, q.info)
	}
	h.mu.Unlock()

	// 대기열은 맵이라 순서가 없습니다. 같은 대기열이면 늘 같은 순서로 보냅니다
	key := func(s protocol.Seeker) string { return queueKey(s.Game, s.Minutes, s.Version) }
	sort.Slice(out, func(i, j int) bool { return key(out[i]) < key(out[j]) })
	if len(out) > maxListed {
		out = out[:maxListed]
	}

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(out)
}
