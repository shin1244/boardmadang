package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// waitLive는 h.Live()가 바라는 값이 될 때까지 잠깐 기다립니다 (연결과 끊김은 서버가 뒤에서 알아챕니다).
func waitLive(t *testing.T, h *Hub, online, playing int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		o, p := h.Live()
		if o == online && p == playing {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Live() = %d, %d, want %d, %d", o, p, online, playing)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestLive(t *testing.T) {
	ids := identity.NewIssuer(testSecret)
	ids.Members = anyMember{}
	h := New(config.Config{}, ids, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /ws", h.ServeWS)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	waitLive(t, h, 0, 0)
	a, b := connect(t, srv), connect(t, srv)
	// 같은 사람이 탭을 하나 더 열어도 한 명입니다
	second := &player{t: t, srv: srv, header: a.header}
	second.dial()
	waitLive(t, h, 2, 0)

	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeMatched, nil)
	b.expect(protocol.TypeMatched, nil)
	waitLive(t, h, 2, 1)

	second.conn.Close()
	waitLive(t, h, 2, 1) // a의 첫 탭은 아직 열려 있습니다
	b.send(protocol.Resign{Type: protocol.TypeResign})
	waitLive(t, h, 2, 0) // 끝난 방은 진행 중으로 세지 않습니다
	b.conn.Close()
	waitLive(t, h, 1, 0)
}
