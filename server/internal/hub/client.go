package hub

import "github.com/gorilla/websocket"

// Client는 웹소켓 연결 하나입니다.
//
// gorilla/websocket은 한 연결에 두 고루틴이 동시에 쓰면 안 됩니다.
// 그래서 쓰기는 writePump 하나만 하고, 다른 곳에서는 Send로 send 채널에 넣기만 합니다.
type Client struct {
	hub  *Hub
	conn *websocket.Conn
	send chan []byte // 보낼 메시지. 가득 차면 느린 클라이언트로 보고 연결을 끊습니다.

	room   *Room
	player int // 방 안에서의 번호 (0 = 선공, 1 = 후공)
}

// Send는 메시지를 보낼 대기열에 넣습니다. 네트워크에 직접 쓰지 않으므로 락을 잡은 채로 불러도 됩니다.
//
// TODO: JSON으로 만들어 send 채널에 넣기 (채널이 가득 차면 연결 종료)
func (c *Client) Send(msg any) {}

// readPump는 연결이 끊길 때까지 메시지를 읽어 종류별로 처리합니다.
//
// TODO:
//   - 메시지 크기 제한 (SetReadLimit), 핑/퐁으로 죽은 연결 감지
//   - protocol.PeekType으로 종류를 보고: join → hub.join, action → room.relay,
//     hash → room.reportHash, result → room.reportResult, resign → room.end
func (c *Client) readPump() {}

// writePump는 send 채널에서 꺼내 웹소켓에 씁니다. 이 연결에 쓰는 유일한 곳입니다.
//
// TODO: 쓰기 타임아웃(SetWriteDeadline), 주기적인 핑
func (c *Client) writePump() {}
