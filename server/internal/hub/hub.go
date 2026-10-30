// Package hub는 접속, 매칭 대기열, 방을 관리합니다.
//
// 동시성 규칙
//   - Hub의 맵(queue, rooms)과 Client의 queued, room, player는 h.mu를 잡고만 건드립니다.
//   - Room 안의 값은 r.mu를 잡고만 건드립니다.
//   - 락 순서는 r.mu → h.mu 하나뿐입니다 (방이 끝나면 hub에서 지움). h.mu를 잡은 채로 r.mu를 잡지 않습니다.
//   - 웹소켓에 쓰는 건 각 Client의 writePump 고루틴 하나뿐입니다.
//     다른 곳에서는 Client.Send로 채널에 넣기만 합니다.
//     락을 잡은 채로 네트워크에 쓰면, 느린 클라이언트 하나가 서버 전체를 멈추게 합니다.
package hub

import (
	"crypto/rand"
	"encoding/binary"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 제한값 (docs/abuse-and-limits.md). 테스트에서 줄이려고 변수로 둡니다.
var (
	// 연결당 초당 보낼 수 있는 행동 수. 넘는 행동은 버리고 error를 보냅니다.
	MaxActionsPerSecond = 20
	// 대국당 플레이어당 무시된 행동 상한. 넘으면 상대 승 (spam).
	MaxIgnored = 500
	// 행동 기록 상한. maxActions 상한(2,000) + 양쪽의 무시된 행동 상한.
	// 해시를 보내지 않아 무시된 행동을 셀 수 없을 때도 기록이 끝없이 늘지 않게 합니다.
	MaxLog = 2000 + 2*500
	// 대국 중에 연결이 끊긴 플레이어를 기다리는 시간. 와이파이가 잠깐 끊기거나 휴대폰 화면이 꺼진 정도는 버팁니다.
	// 그 안에 같은 신원으로 다시 join하면 대국을 이어 가고, 못 오면 상대가 이깁니다 (left).
	ReconnectGrace = 15 * time.Second
)

var gameIDPattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

type Hub struct {
	cfg      config.Config
	ids      *identity.Issuer
	upgrader websocket.Upgrader

	mu    sync.Mutex
	queue map[string]*Client // 게임 id별로 상대를 기다리는 한 명
	rooms map[string]*Room   // 방 코드 → 방
	away  map[string]*Room   // 연결이 끊겨 돌아오기를 기다리는 user.ID → 그 방 (끝난 방일 수도 있습니다)
}

func New(cfg config.Config, ids *identity.Issuer) *Hub {
	h := &Hub{
		cfg:   cfg,
		ids:   ids,
		queue: make(map[string]*Client),
		rooms: make(map[string]*Room),
		away:  make(map[string]*Room),
	}
	h.upgrader = websocket.Upgrader{CheckOrigin: h.checkOrigin}
	return h
}

// checkOrigin은 다른 사이트의 페이지가 유저의 쿠키로 웹소켓을 여는 것을 막습니다.
// AllowedOrigins에 있거나 서버와 같은 출처면 통과합니다. Origin이 없으면(브라우저가 아니면) 통과합니다.
func (h *Hub) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if slices.Contains(h.cfg.AllowedOrigins, origin) {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

// ServeWS는 /ws 요청을 웹소켓으로 올리고 Client를 만듭니다.
// 세션 쿠키가 없으면 401입니다. 브라우저는 /api/me를 먼저 불러 쿠키를 받아 둡니다 (docs/identity.md).
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	user, ok := h.ids.FromRequest(r)
	if !ok {
		http.Error(w, "세션이 없습니다. /api/me를 먼저 부르세요", http.StatusUnauthorized)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade가 이미 응답을 보냈습니다. 요청 하나 때문에 서버가 꺼지면 안 되므로 로그만 남깁니다.
		log.Println("웹소켓 연결 실패:", err)
		return
	}
	c := newClient(h, conn, user)
	go c.writePump()
	c.readPump()
	h.leave(c)
}

// seat는 c가 앉아 있는 방과 자리 번호입니다. 방에 없으면 nil.
func (h *Hub) seat(c *Client) (*Room, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return c.room, c.player
}

// join은 c를 게임 대기열에 넣고, 기다리던 상대가 있으면 방을 만듭니다.
// 같은 신원이 끊긴 채로 기다리는 방이 있으면 대기열 대신 그 방으로 돌려보냅니다 (게임 id가 달라도).
//
// 같은 신원끼리도 매칭합니다. 탭 두 개로 혼자 둬볼 수 있어 개발할 때 편합니다.
// TODO: 랭킹이 생기면 같은 user.ID끼리는 매칭하지 않기
// TODO: Go 서버가 게임 목록을 알게 되면 모르는 게임 id를 거절하기 (지금은 모양만 봅니다)
func (h *Hub) join(c *Client, game string) {
	if !gameIDPattern.MatchString(game) {
		c.sendError("unknown game")
		return
	}

	h.mu.Lock()
	if c.room != nil || c.queued != "" {
		h.mu.Unlock()
		c.sendError("already joined")
		return
	}
	if r := h.away[c.user.ID]; r != nil {
		// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서). 그 사이에 유예 시간이 끝났으면 resume이 false입니다.
		h.mu.Unlock()
		if r.resume(c) {
			return
		}
		h.mu.Lock()
		if c.room != nil || c.queued != "" {
			h.mu.Unlock()
			return
		}
	}
	defer h.mu.Unlock()

	other := h.queue[game]
	if other == nil {
		h.queue[game] = c
		c.queued = game
		c.Send(protocol.Waiting{Type: protocol.TypeWaiting, Game: game})
		return
	}
	delete(h.queue, game)
	other.queued = ""

	// 선후공은 랜덤
	players := [2]*Client{other, c}
	if randUint32()%2 == 1 {
		players[0], players[1] = players[1], players[0]
	}
	r := newRoom(h, h.newRoomID(), game, randUint32(), players)
	h.rooms[r.ID] = r
	for i, p := range players {
		p.room = r
		p.player = i
		opp := players[1-i].user
		p.Send(protocol.Matched{
			Type:     protocol.TypeMatched,
			Room:     r.ID,
			Game:     game,
			Player:   i,
			Seed:     r.Seed,
			Opponent: protocol.PlayerInfo{Kind: opp.Kind, Tag: opp.Tag, Name: opp.Name},
		})
	}
}

// leave는 연결이 끊긴 c를 정리합니다. 대기열에 있었으면 바로 빼고,
// 대국 중이었으면 ReconnectGrace만큼 돌아오기를 기다립니다 (Room.playerLeft).
func (h *Hub) leave(c *Client) {
	h.mu.Lock()
	if c.queued != "" && h.queue[c.queued] == c {
		delete(h.queue, c.queued)
	}
	c.queued = ""
	room, player := c.room, c.player
	h.mu.Unlock()

	// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서).
	if room != nil {
		room.playerLeft(player, c)
	}
	c.close()
}

// removeRoom은 끝난 방을 지우고, 두 플레이어가 다시 매칭할 수 있게 합니다. Room.end에서 부릅니다.
func (h *Hub) removeRoom(r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.rooms, r.ID)
	for _, p := range r.Players {
		if p.room == r {
			p.room = nil
		}
	}
}

// seatClient는 돌아온 c를 방 r의 자리에 앉힙니다. 끝난 방이면 앉히지 않습니다 (바로 다시 join할 수 있게).
// stillAway는 같은 신원의 다른 자리가 아직 끊겨 있는지입니다 (탭 두 개로 혼자 둔 경우). Room.resume에서 부릅니다.
func (h *Hub) seatClient(c *Client, r *Room, seat int, ended, stillAway bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !ended {
		c.room = r
		c.player = seat
	}
	if !stillAway && h.away[c.user.ID] == r {
		delete(h.away, c.user.ID)
	}
}

func (h *Hub) markAway(userID string, r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.away[userID] = r
}

func (h *Hub) clearAway(userID string, r *Room) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.away[userID] == r {
		delete(h.away, userID)
	}
}

// 헷갈리는 글자(0과 O, 1과 I)를 뺀 방 코드 글자
const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// newRoomID는 겹치지 않는 여섯 글자 방 코드를 만듭니다. h.mu를 잡고 부릅니다.
func (h *Hub) newRoomID() string {
	for {
		b := make([]byte, 6)
		rand.Read(b)
		for i := range b {
			b[i] = roomAlphabet[int(b[i])%len(roomAlphabet)]
		}
		if id := string(b); h.rooms[id] == nil {
			return id
		}
	}
}

func randUint32() uint32 {
	var b [4]byte
	rand.Read(b[:])
	return binary.BigEndian.Uint32(b[:])
}
