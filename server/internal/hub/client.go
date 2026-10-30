package hub

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

const (
	// 클라이언트가 보내는 메시지 하나의 최대 크기. 가장 큰 메시지(result)도 수백 바이트입니다.
	maxMessageSize = 1024
	// 이 시간 안에 아무것도(퐁 포함) 안 오면 죽은 연결로 봅니다.
	pongWait = 60 * time.Second
	// 핑 간격. pongWait보다 짧아야 합니다.
	pingPeriod = 50 * time.Second
	// 메시지 하나를 쓰는 데 걸릴 수 있는 최대 시간
	writeWait = 10 * time.Second
	// 보낼 대기열 크기. 이만큼 밀리면 느린 클라이언트로 보고 끊습니다.
	sendBuffer = 64
)

// Client는 웹소켓 연결 하나입니다.
//
// gorilla/websocket은 한 연결에 두 고루틴이 동시에 쓰면 안 됩니다.
// 그래서 쓰기는 writePump 하나만 하고, 다른 곳에서는 Send로 send 채널에 넣기만 합니다.
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte   // 보낼 메시지. 가득 차면 느린 클라이언트로 보고 연결을 끊습니다.
	user identity.User // 세션 쿠키로 확인한 신원 (게스트 또는 계정)

	done      chan struct{} // 닫히면 연결을 정리 중입니다. send 채널은 닫지 않습니다 (닫힌 채널에 보내면 패닉).
	closeOnce sync.Once

	// 아래 넷은 hub.mu를 잡고만 읽고 씁니다. 상대의 고루틴이 매칭하면서 바꾸기 때문입니다.
	queued  string // 빠른 매칭 대기열의 키 (게임|타이머). 없으면 ""
	hosting string // 방 목록에 올린 내 방 코드. 없으면 ""
	room    *Room
	player  int // 방 안에서의 번호 (0 = 선공, 1 = 후공)

	// 초당 행동 수 제한. readPump 고루틴만 씁니다.
	windowStart time.Time
	windowCount int
}

func newClient(h *Hub, conn *websocket.Conn, user identity.User) *Client {
	return &Client{
		hub:  h,
		conn: conn,
		send: make(chan []byte, sendBuffer),
		user: user,
		done: make(chan struct{}),
	}
}

// Send는 메시지를 보낼 대기열에 넣습니다. 네트워크에 직접 쓰지 않으므로 락을 잡은 채로 불러도 됩니다.
// 대기열이 가득 차면 연결을 끊습니다. 느린 클라이언트 하나 때문에 상대가 기다리지 않게 하려는 것입니다.
func (c *Client) Send(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Println("메시지를 JSON으로 만들지 못했습니다:", err)
		return
	}
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.send <- data:
	default:
		c.close()
	}
}

// busy는 이미 대기열, 방 목록, 대국 중 하나에 있는지입니다. hub.mu를 잡고 부릅니다.
func (c *Client) busy() bool {
	return c.room != nil || c.queued != "" || c.hosting != ""
}

func (c *Client) sendError(msg string) {
	c.Send(protocol.Error{Type: protocol.TypeError, Message: msg})
}

// close는 연결을 닫습니다. 여러 곳에서 불려도 한 번만 처리합니다.
// 연결이 닫히면 readPump가 끝나고, ServeWS가 hub.leave로 대기열과 방을 정리합니다.
func (c *Client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.conn.Close()
	})
}

// allowAction은 초당 행동 수 제한(MaxActionsPerSecond)을 넘지 않았는지 봅니다.
func (c *Client) allowAction(now time.Time) bool {
	if now.Sub(c.windowStart) >= time.Second {
		c.windowStart = now
		c.windowCount = 0
	}
	c.windowCount++
	return c.windowCount <= MaxActionsPerSecond
}

// readPump는 연결이 끊길 때까지 메시지를 읽어 종류별로 처리합니다.
func (c *Client) readPump() {
	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		c.handle(data)
	}
}

func (c *Client) handle(data []byte) {
	typ, err := protocol.PeekType(data)
	if err != nil {
		c.sendError("bad message")
		return
	}

	switch typ {
	case protocol.TypeJoin:
		var m protocol.Join
		if json.Unmarshal(data, &m) != nil {
			c.sendError("bad message")
			return
		}
		c.hub.join(c, m.Game, m.Minutes)
		return
	case protocol.TypeCreate:
		var m protocol.Create
		if json.Unmarshal(data, &m) != nil {
			c.sendError("bad message")
			return
		}
		c.hub.create(c, m.Game, m.Minutes)
		return
	case protocol.TypeEnter:
		var m protocol.Enter
		if json.Unmarshal(data, &m) != nil {
			c.sendError("bad message")
			return
		}
		c.hub.enter(c, m.Room)
		return
	case protocol.TypeBump:
		c.hub.bump(c)
		return
	}

	room, player := c.hub.seat(c)
	if room == nil {
		c.sendError("not in a room")
		return
	}
	switch typ {
	case protocol.TypeAction:
		var m protocol.ActionMsg
		if json.Unmarshal(data, &m) != nil || !validAction(m.Action) {
			c.sendError("bad action")
			return
		}
		if !c.allowAction(time.Now()) {
			c.sendError("too many actions")
			return
		}
		room.relay(player, m.Action)
	case protocol.TypeHash:
		var m protocol.Hash
		if json.Unmarshal(data, &m) != nil || m.Hash == "" || len(m.Hash) > 64 || (m.Turn != nil && *m.Turn != 0 && *m.Turn != 1) {
			c.sendError("bad hash")
			return
		}
		room.reportHash(player, m.Seq, m.Hash, m.Turn)
	case protocol.TypeResult:
		var m protocol.Result
		if json.Unmarshal(data, &m) != nil || (m.Winner != nil && *m.Winner != 0 && *m.Winner != 1) {
			c.sendError("bad result")
			return
		}
		room.reportResult(player, m)
	case protocol.TypeResign:
		room.resign(player)
	default:
		c.sendError("unknown type")
	}
}

// validAction은 모양만 봅니다. 규칙에 맞는지는 클라이언트의 게임 로직이 판단합니다.
// 좌표는 플랫폼 상한(rows, cols ≤ 32) 안이어야 합니다.
func validAction(a protocol.Action) bool {
	if a.Kind == "" || len(a.Kind) > 32 {
		return false
	}
	if a.Kind == "click" {
		return a.Row >= 0 && a.Row < 32 && a.Col >= 0 && a.Col < 32
	}
	return a.Row == 0 && a.Col == 0
}

// writePump는 send 채널에서 꺼내 웹소켓에 씁니다. 이 연결에 쓰는 유일한 곳입니다.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.close()
	}()

	for {
		select {
		case data := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}
