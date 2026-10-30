package hub

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// shortMinute는 테스트 동안 타이머 1분을 d로 줄입니다.
func shortMinute(t *testing.T, d time.Duration) {
	old := MinuteUnit
	MinuteUnit = d
	t.Cleanup(func() { MinuteUnit = old })
}

func minutes(n int) *int { return &n }

func (p *player) hashTurn(seq int, h string, turn *int) {
	p.send(protocol.Hash{Type: protocol.TypeHash, Seq: seq, Hash: h, Turn: turn})
}

func (p *player) expectClock(running *int) protocol.Clock {
	p.t.Helper()
	var c protocol.Clock
	p.expect(protocol.TypeClock, &c)
	if !samePlayer(c.Running, running) {
		p.t.Fatalf("clock running = %v, want %v (%+v)", ptr(c.Running), ptr(running), c)
	}
	return c
}

// matchTimed는 타이머 m분으로 두 명을 붙입니다. 시작 해시(선공 차례)를 보내고 시계가 선공 쪽으로 가는 것까지 확인합니다.
func matchTimed(t *testing.T, srv *httptest.Server, m int) [2]*player {
	t.Helper()
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(m)})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(m)})
	var ma, mb protocol.Matched
	a.expect(protocol.TypeMatched, &ma)
	b.expect(protocol.TypeMatched, &mb)
	if ma.Minutes == nil || *ma.Minutes != m {
		t.Fatalf("matched minutes = %v, want %d", ptr(ma.Minutes), m)
	}
	a.seat, b.seat = ma.Player, mb.Player
	p := [2]*player{a, b}
	if a.seat == 1 {
		p = [2]*player{b, a}
	}
	p[0].hashTurn(-1, "start", seat(0))
	p[1].hashTurn(-1, "start", seat(0))
	each := int64(m) * MinuteUnit.Milliseconds()
	for _, x := range p {
		c := x.expectClock(seat(0))
		if c.Remaining[0] > each || c.Remaining[1] != each {
			t.Fatalf("bad starting clock: %+v", c)
		}
	}
	return p
}

func TestClockSwitchesOnFirstReport(t *testing.T) {
	shortMinute(t, time.Second)
	p := matchTimed(t, newServer(t), 1)

	time.Sleep(100 * time.Millisecond)
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)

	// 먼저 온 보고로 바로 넘어갑니다. 상대 보고를 기다리지 않습니다.
	p[0].hashTurn(0, "after-0", seat(1))
	for _, x := range p {
		c := x.expectClock(seat(1))
		if c.Remaining[0] >= 950 || c.Remaining[0] < 500 || c.Remaining[1] != 1000 {
			t.Fatalf("clock after first move: %+v", c)
		}
	}
	// 늦게 온 같은 보고는 시계를 다시 건드리지 않습니다.
	p[1].hashTurn(0, "after-0", seat(1))

	p[0].result(seat(0))
	p[1].result(seat(0))
	for _, x := range p {
		x.expectClock(nil) // 끝나면 시계가 멈춥니다
		x.expectEnded(seat(0), protocol.ReasonResult)
	}
}

func TestTimeout(t *testing.T) {
	shortMinute(t, 200*time.Millisecond)
	p := matchTimed(t, newServer(t), 1)
	for _, x := range p {
		c := x.expectClock(nil)
		if c.Remaining[0] != 0 || c.Remaining[1] != 200 {
			t.Fatalf("final clock: %+v", c)
		}
		x.expectEnded(seat(1), protocol.ReasonTimeout)
	}
}

func TestTimeoutWhileAway(t *testing.T) {
	// 끊겨서 기다리는 동안에도 그 사람 차례면 시계는 갑니다.
	shortMinute(t, 200*time.Millisecond)
	shortGrace(t, 5*time.Second)
	p := matchTimed(t, newServer(t), 1)
	p[0].conn.Close()
	p[1].expect(protocol.TypeAway, nil)
	p[1].expectClock(nil)
	p[1].expectEnded(seat(1), protocol.ReasonTimeout)
}

func TestTurnMismatchIsDesync(t *testing.T) {
	shortMinute(t, time.Second)
	p := matchTimed(t, newServer(t), 1)
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)
	p[0].hashTurn(0, "after-0", seat(1))
	p[0].expectClock(seat(1))
	p[1].expectClock(seat(1))
	p[1].hashTurn(0, "after-0", seat(0))
	for _, x := range p {
		x.expect(protocol.TypeDesync, nil)
		x.expectClock(nil)
		x.expectEnded(nil, protocol.ReasonDesync)
	}
}

func TestResumeIncludesClock(t *testing.T) {
	shortMinute(t, 10*time.Second)
	p := matchTimed(t, newServer(t), 1)
	p[1].reconnect()
	var m protocol.Resumed
	p[1].expect(protocol.TypeResumed, &m)
	if m.Minutes == nil || *m.Minutes != 1 || m.Clock == nil || !samePlayer(m.Clock.Running, seat(0)) {
		t.Fatalf("resumed without clock: %+v", m)
	}
}

func TestDifferentTimersDoNotMatch(t *testing.T) {
	srv := newServer(t)
	a, b, c := connect(t, srv), connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(10)})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	b.expect(protocol.TypeWaiting, nil)
	c.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(5)})
	c.expect(protocol.TypeWaiting, nil)
}

func TestRejectsBadMinutes(t *testing.T) {
	a := connect(t, newServer(t))
	for _, m := range []int{0, -1, 181} {
		a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(m)})
		var e protocol.Error
		a.expect(protocol.TypeError, &e)
		if e.Message != "bad minutes" {
			t.Errorf("minutes %d: error = %q", m, e.Message)
		}
	}
	p := match(t, newServer(t))
	p[0].hashTurn(0, "x", seat(2))
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "bad hash" {
		t.Errorf("turn 2: error = %q", e.Message)
	}
}
