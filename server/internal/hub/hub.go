// Package hub는 접속, 매칭 대기열, 방을 관리합니다.
//
// 동시성 규칙
//   - Hub의 맵(queue, rooms)은 h.mu를 잡고만 건드립니다.
//   - 웹소켓에 쓰는 건 각 Client의 writePump 고루틴 하나뿐입니다.
//     다른 곳에서는 Client.Send로 채널에 넣기만 합니다.
//     락을 잡은 채로 네트워크에 쓰면, 느린 클라이언트 하나가 서버 전체를 멈추게 합니다.
package hub

import (
	"net/http"
	"sync"

	"github.com/gorilla/websocket"

	"github.com/shin1244/boardmadang/server/internal/config"
)

type Hub struct {
	cfg      config.Config
	upgrader websocket.Upgrader

	mu    sync.Mutex
	queue map[string]*Client // 게임 id별로 상대를 기다리는 한 명
	rooms map[string]*Room   // 방 코드 → 방
}

func New(cfg config.Config) *Hub {
	return &Hub{
		cfg:   cfg,
		queue: make(map[string]*Client),
		rooms: make(map[string]*Room),
	}
}

// ServeWS는 /ws 요청을 웹소켓으로 올리고 Client를 만듭니다.
//
// TODO:
//  1. upgrader.CheckOrigin을 cfg.AllowedOrigins로 설정 (비어 있으면 같은 출처만)
//  2. Upgrade 실패 시 로그만 남기고 return (log.Fatal 금지 — 요청 하나로 서버가 꺼집니다)
//  3. Client를 만들고 writePump는 고루틴으로, readPump는 이 고루틴에서 실행
//  4. readPump가 끝나면 h.leave(c)
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "웹소켓은 아직 구현되지 않았습니다", http.StatusNotImplemented)
}

// join은 c를 게임 대기열에 넣고, 기다리던 상대가 있으면 방을 만듭니다.
//
// TODO:
//   - 알 수 없는 게임 id면 Error 응답
//   - 이미 방에 있거나 대기 중이면 무시
//   - 기다리던 사람이 있으면 newRoom → 양쪽에 Matched (선후공은 랜덤)
//   - 없으면 queue[game] = c
func (h *Hub) join(c *Client, game string) {}

// leave는 연결이 끊긴 c를 정리합니다.
//
// TODO:
//   - 대기열에 있었다면 빼기
//   - 방에 있었다면 room.End(상대 승, ReasonLeft) 후 rooms에서 제거
func (h *Hub) leave(c *Client) {}
