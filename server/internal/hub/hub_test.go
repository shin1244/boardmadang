package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// ---- 도구 ----

func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	h := New(config.Config{}, ids, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.HandleFunc("GET /api/rooms", h.ServeRooms)
	mux.HandleFunc("GET /api/live", h.ServeLive)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type player struct {
	t      *testing.T
	srv    *httptest.Server
	header http.Header // 세션 쿠키. 같은 신원으로 다시 붙을 때 씁니다
	conn   *websocket.Conn
	seat   int // matched에서 받은 자리 번호
}

// connect는 /api/me로 게스트 쿠키를 받아 웹소켓에 붙습니다. 브라우저와 같은 순서입니다.
func connect(t *testing.T, srv *httptest.Server) *player {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	header := http.Header{}
	for _, c := range res.Cookies() {
		header.Add("Cookie", c.String())
	}
	p := &player{t: t, srv: srv, header: header}
	p.dial()
	return p
}

func (p *player) dial() {
	p.t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(p.srv.URL, "http")+"/ws", p.header)
	if err != nil {
		p.t.Fatal(err)
	}
	p.t.Cleanup(func() { conn.Close() })
	p.conn = conn
}

// reconnect는 연결을 끊었다가 같은 쿠키로 다시 붙고 join을 보냅니다. 새로고침과 같습니다.
func (p *player) reconnect() {
	p.t.Helper()
	p.conn.Close()
	time.Sleep(50 * time.Millisecond) // 서버가 끊김을 알아챌 시간
	p.dial()
	p.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
}

// shortGrace는 테스트 동안 유예 시간을 줄입니다.
func shortGrace(t *testing.T, d time.Duration) {
	old := ReconnectGrace
	ReconnectGrace = d
	t.Cleanup(func() { ReconnectGrace = old })
}

func (p *player) send(msg any) {
	p.t.Helper()
	if err := p.conn.WriteJSON(msg); err != nil {
		p.t.Fatal(err)
	}
}

// expect는 다음 메시지를 읽어 종류를 확인하고 v에 담습니다.
func (p *player) expect(typ string, v any) {
	p.t.Helper()
	p.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := p.conn.ReadMessage()
	if err != nil {
		p.t.Fatalf("waiting for %s: %v", typ, err)
	}
	got, _ := protocol.PeekType(data)
	if got != typ {
		p.t.Fatalf("got %s, want %s: %s", got, typ, data)
	}
	if v != nil {
		if err := json.Unmarshal(data, v); err != nil {
			p.t.Fatal(err)
		}
	}
}

func (p *player) action(row, col int) {
	p.send(protocol.ActionMsg{Type: protocol.TypeAction, Action: protocol.Action{Kind: "click", Row: row, Col: col}})
}

func (p *player) hash(seq int, h string) {
	p.send(protocol.Hash{Type: protocol.TypeHash, Seq: seq, Hash: h})
}

func (p *player) result(winner *int) {
	p.send(protocol.Result{Type: protocol.TypeResult, Winner: winner})
}

func (p *player) expectEnded(winner *int, reason string) {
	p.t.Helper()
	var e protocol.Ended
	p.expect(protocol.TypeEnded, &e)
	if e.Reason != reason || !samePlayer(e.Winner, winner) {
		p.t.Fatalf("ended = winner %v reason %q, want winner %v reason %q", ptr(e.Winner), e.Reason, ptr(winner), reason)
	}
}

func ptr(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}

func seat(n int) *int { return &n }

// match는 두 명을 붙이고 [선공, 후공] 순서로 돌려줍니다. 시작 해시까지 보냅니다.
func match(t *testing.T, srv *httptest.Server) [2]*player {
	t.Helper()
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})

	var ma, mb protocol.Matched
	a.expect(protocol.TypeMatched, &ma)
	b.expect(protocol.TypeMatched, &mb)
	if ma.Room != mb.Room || ma.Seed != mb.Seed || ma.Player == mb.Player {
		t.Fatalf("matched messages disagree: %+v / %+v", ma, mb)
	}
	if ma.Opponent.Kind != identity.KindGuest || len(ma.Opponent.Tag) != 4 {
		t.Fatalf("bad opponent info: %+v", ma.Opponent)
	}
	a.seat, b.seat = ma.Player, mb.Player
	ps := [2]*player{a, b}
	if a.seat == 1 {
		ps = [2]*player{b, a}
	}
	ps[0].hash(-1, "start")
	ps[1].hash(-1, "start")
	return ps
}

// ---- 테스트 ----

func TestPlayToResult(t *testing.T) {
	p := match(t, newServer(t))

	p[0].action(1, 1)
	for _, x := range p {
		var r protocol.Relay
		x.expect(protocol.TypeRelay, &r)
		if r.Seq != 0 || r.Player != 0 || r.Action.Row != 1 || r.Action.Col != 1 {
			t.Fatalf("bad relay: %+v", r)
		}
	}
	p[0].hash(0, "after-0")
	p[1].hash(0, "after-0")

	p[0].result(seat(0))
	p[1].result(seat(0))
	p[0].expectEnded(seat(0), protocol.ReasonResult)
	p[1].expectEnded(seat(0), protocol.ReasonResult)
}

func TestBothPlayersCanJoinAgainAfterEnd(t *testing.T) {
	srv := newServer(t)
	p := match(t, srv)
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	p[0].expectEnded(seat(1), protocol.ReasonResign)
	p[1].expectEnded(seat(1), protocol.ReasonResign)

	// 같은 연결로 다시 대기열에 들어갈 수 있어야 합니다
	p[0].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	p[0].expect(protocol.TypeWaiting, nil)
	p[1].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	p[0].expect(protocol.TypeMatched, nil)
	p[1].expect(protocol.TypeRematchOff, nil) // 상대가 새 대전을 찾기 시작해서 재대결은 못 합니다
	p[1].expect(protocol.TypeMatched, nil)
}

// 끊긴 뒤 유예 시간 안에 안 돌아오면 상대가 이긴다
func TestLeaveGivesOpponentTheWinAfterGrace(t *testing.T) {
	shortGrace(t, 100*time.Millisecond)
	p := match(t, newServer(t))
	p[1].conn.Close()
	var a protocol.Away
	p[0].expect(protocol.TypeAway, &a)
	if a.Player != 1 {
		t.Fatalf("away player = %d, want 1", a.Player)
	}
	p[0].expectEnded(seat(0), protocol.ReasonLeft)
}

// 유예 시간 안에 같은 신원으로 돌아오면 기록을 받아 이어서 둔다
func TestReconnectWithinGrace(t *testing.T) {
	shortGrace(t, 2*time.Second)
	p := match(t, newServer(t))
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)
	p[0].hash(0, "after-0")
	// 후공은 해시를 보내기 전에 끊김

	p[1].reconnect()
	p[0].expect(protocol.TypeAway, nil)
	var r protocol.Resumed
	p[1].expect(protocol.TypeResumed, &r)
	if r.Player != 1 || len(r.Log) != 1 || r.Log[0].Action.Row != 1 || r.Opponent.Kind != identity.KindGuest {
		t.Fatalf("bad resumed: %+v", r)
	}
	var b protocol.Back
	p[0].expect(protocol.TypeBack, &b)
	if b.Player != 1 {
		t.Fatalf("back player = %d, want 1", b.Player)
	}

	// 재생하면서 다시 보내는 해시: -1은 이미 확인됐으니 무시되고, 0은 이제 모입니다
	p[1].hash(-1, "start")
	p[1].hash(0, "after-0")
	p[1].action(0, 0)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)
	p[0].result(seat(1))
	p[1].result(seat(1))
	p[0].expectEnded(seat(1), protocol.ReasonResult)
	p[1].expectEnded(seat(1), protocol.ReasonResult)
}

// 돌아온 뒤에는 원래 유예 타이머가 울려도 지지 않는다
func TestReconnectCancelsTimer(t *testing.T) {
	shortGrace(t, 300*time.Millisecond)
	p := match(t, newServer(t))
	p[1].reconnect()
	p[0].expect(protocol.TypeAway, nil)
	p[1].expect(protocol.TypeResumed, nil)
	p[0].expect(protocol.TypeBack, nil)
	time.Sleep(500 * time.Millisecond)
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	p[0].expectEnded(seat(1), protocol.ReasonResign) // left로 끝났다면 이 메시지가 먼저 왔을 것
}

// 끊겨 있는 동안 대국이 끝났으면, 돌아왔을 때 기록과 결과를 같이 받는다
func TestEndedWhileAway(t *testing.T) {
	shortGrace(t, 2*time.Second)
	p := match(t, newServer(t))
	p[1].conn.Close()
	p[0].expect(protocol.TypeAway, nil)
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	p[0].expectEnded(seat(1), protocol.ReasonResign)

	p[1].dial()
	p[1].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	p[1].expect(protocol.TypeResumed, nil)
	p[1].expectEnded(seat(1), protocol.ReasonResign)

	// 결과를 받은 뒤에는 새로 대기열에 들어갈 수 있다
	p[1].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	p[1].expect(protocol.TypeWaiting, nil)
}

// 유예 시간이 지난 뒤에 돌아오면 평범하게 새 대기열에 들어간다
func TestRejoinAfterGraceQueues(t *testing.T) {
	shortGrace(t, 100*time.Millisecond)
	p := match(t, newServer(t))
	p[1].conn.Close()
	p[0].expect(protocol.TypeAway, nil)
	p[0].expectEnded(seat(0), protocol.ReasonLeft)

	p[1].dial()
	p[1].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	p[1].expect(protocol.TypeWaiting, nil)
}

func TestLeavingQueueFreesIt(t *testing.T) {
	srv := newServer(t)
	a := connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	a.conn.Close()
	time.Sleep(50 * time.Millisecond) // 서버가 끊긴 연결을 정리할 시간

	// 떠난 사람과 매칭되지 않고 새로 기다려야 합니다
	b := connect(t, srv)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	b.expect(protocol.TypeWaiting, nil)
}

func TestDifferentGamesDoNotMatch(t *testing.T) {
	srv := newServer(t)
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "go"})
	b.expect(protocol.TypeWaiting, nil)
}

func TestDesync(t *testing.T) {
	srv := newServer(t)
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeMatched, nil)
	b.expect(protocol.TypeMatched, nil)

	a.hash(-1, "one")
	b.hash(-1, "two")
	for _, x := range []*player{a, b} {
		var d protocol.Desync
		x.expect(protocol.TypeDesync, &d)
		if d.Seq != -1 {
			t.Fatalf("desync seq = %d, want -1", d.Seq)
		}
		x.expectEnded(nil, protocol.ReasonDesync)
	}
}

func TestDisagree(t *testing.T) {
	p := match(t, newServer(t))
	p[0].result(seat(0))
	p[1].result(seat(1))
	p[0].expectEnded(nil, protocol.ReasonDisagree)
}

func TestDrawResult(t *testing.T) {
	p := match(t, newServer(t))
	p[0].result(nil)
	p[1].result(nil)
	p[0].expectEnded(nil, protocol.ReasonResult)
}

// 무시된 행동(해시가 직전과 같음)을 너무 많이 보내면 진다
func TestSpam(t *testing.T) {
	old := MaxIgnored
	MaxIgnored = 2
	t.Cleanup(func() { MaxIgnored = old })

	p := match(t, newServer(t))
	for seq := 0; seq <= 2; seq++ {
		p[1].action(0, 0) // 후공이 선공 차례에 클릭 → 양쪽 로직이 무시
		p[0].expect(protocol.TypeRelay, nil)
		p[1].expect(protocol.TypeRelay, nil)
		p[0].hash(seq, "start")
		p[1].hash(seq, "start")
	}
	p[0].expectEnded(seat(0), protocol.ReasonSpam)
}

// 상태가 바뀐 행동은 무시된 행동으로 세지 않는다
func TestChangedActionsAreNotSpam(t *testing.T) {
	old := MaxIgnored
	MaxIgnored = 1
	t.Cleanup(func() { MaxIgnored = old })

	p := match(t, newServer(t))
	for seq := 0; seq < 4; seq++ {
		p[seq%2].action(seq, 0)
		p[0].expect(protocol.TypeRelay, nil)
		p[1].expect(protocol.TypeRelay, nil)
		h := string(rune('a' + seq))
		p[0].hash(seq, h)
		p[1].hash(seq, h)
	}
	p[0].result(nil)
	p[1].result(nil)
	p[0].expectEnded(nil, protocol.ReasonResult)
}

func TestRateLimit(t *testing.T) {
	old := MaxActionsPerSecond
	MaxActionsPerSecond = 2
	t.Cleanup(func() { MaxActionsPerSecond = old })

	p := match(t, newServer(t))
	for i := 0; i < 3; i++ {
		p[0].action(0, i)
	}
	p[0].expect(protocol.TypeRelay, nil)
	p[0].expect(protocol.TypeRelay, nil)
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "too many actions" {
		t.Fatalf("error = %q", e.Message)
	}
}

func TestLogLimit(t *testing.T) {
	old := MaxLog
	MaxLog = 3
	t.Cleanup(func() { MaxLog = old })

	p := match(t, newServer(t))
	for i := 0; i < 3; i++ {
		p[0].action(0, i)
		p[0].expect(protocol.TypeRelay, nil)
	}
	p[0].expectEnded(nil, protocol.ReasonLimit)
}

func TestRejectsBadMessages(t *testing.T) {
	srv := newServer(t)
	a := connect(t, srv)
	for _, tc := range []struct {
		msg  any
		want string
	}{
		{protocol.Join{Type: protocol.TypeJoin, Game: "../etc"}, "unknown game"},
		{protocol.ActionMsg{Type: protocol.TypeAction}, "not in a room"},
		{map[string]string{"type": "fly"}, "not in a room"},
	} {
		a.send(tc.msg)
		var e protocol.Error
		a.expect(protocol.TypeError, &e)
		if e.Message != tc.want {
			t.Errorf("%+v: error = %q, want %q", tc.msg, e.Message, tc.want)
		}
	}

	p := match(t, srv)
	p[0].send(protocol.ActionMsg{Type: protocol.TypeAction, Action: protocol.Action{Kind: "click", Row: 32}})
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "bad action" {
		t.Errorf("off-board click: error = %q", e.Message)
	}
}

func TestRejectsOtherOrigin(t *testing.T) {
	srv := newServer(t)
	res, _ := http.Get(srv.URL + "/api/me")
	res.Body.Close()
	header := http.Header{"Origin": {"https://evil.example"}}
	for _, c := range res.Cookies() {
		header.Add("Cookie", c.String())
	}
	_, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", header)
	if err == nil {
		t.Fatal("connection from another origin was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %v, want 403", resp)
	}
}
