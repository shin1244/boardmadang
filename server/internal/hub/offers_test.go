package hub

import (
	"testing"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// say는 종류만 있는 메시지(draw, decline, rematch)를 보냅니다.
func (p *player) say(typ string) {
	p.send(map[string]string{"type": typ})
}

func (p *player) expectDraw(by int) {
	p.t.Helper()
	var d protocol.Draw
	p.expect(protocol.TypeDraw, &d)
	if d.Player != by {
		p.t.Fatalf("draw by %d, want %d", d.Player, by)
	}
}

func TestDrawAgreed(t *testing.T) {
	p := match(t, newServer(t))
	p[0].say(protocol.TypeDraw)
	p[0].expectDraw(0)
	p[1].expectDraw(0)

	p[1].say(protocol.TypeDraw) // 상대 제안이 있으면 수락
	p[0].expectEnded(nil, protocol.ReasonAgreed)
	p[1].expectEnded(nil, protocol.ReasonAgreed)
}

func TestDrawOfferGoesAwayOnAction(t *testing.T) {
	p := match(t, newServer(t))
	p[0].say(protocol.TypeDraw)
	p[0].expectDraw(0)
	p[1].expectDraw(0)

	// 행동 하나로 제안이 없어집니다
	p[1].action(0, 0)
	for _, x := range p {
		x.expect(protocol.TypeDrawOff, nil)
		x.expect(protocol.TypeRelay, nil)
	}
	// 이제 수락하려고 보내면 새 제안이 됩니다
	p[1].say(protocol.TypeDraw)
	p[0].expectDraw(1)
	p[1].expectDraw(1)
}

func TestDeclineAndTooSoon(t *testing.T) {
	p := match(t, newServer(t))
	p[0].say(protocol.TypeDraw)
	p[0].expectDraw(0)
	p[1].expectDraw(0)
	p[1].say(protocol.TypeDecline)
	p[0].expect(protocol.TypeDrawOff, nil)
	p[1].expect(protocol.TypeDrawOff, nil)

	// 행동이 오가기 전에는 다시 제안할 수 없습니다
	p[0].say(protocol.TypeDraw)
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "too soon" {
		t.Fatalf("error = %q", e.Message)
	}
	// 상대는 아직 제안하지 않았으므로 할 수 있습니다
	p[1].say(protocol.TypeDraw)
	p[0].expectDraw(1)
	p[1].expectDraw(1)
}

func TestRematchSwapsSeats(t *testing.T) {
	p := match(t, newServer(t))
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	p[0].expectEnded(seat(1), protocol.ReasonResign)
	p[1].expectEnded(seat(1), protocol.ReasonResign)

	p[0].say(protocol.TypeRematch)
	for _, x := range p {
		var r protocol.Rematch
		x.expect(protocol.TypeRematch, &r)
		if r.Player != 0 {
			t.Fatalf("rematch by %d", r.Player)
		}
	}
	p[1].say(protocol.TypeRematch)
	for _, x := range p {
		x.expect(protocol.TypeRematch, nil)
	}
	var m0, m1 protocol.Matched
	p[0].expect(protocol.TypeMatched, &m0)
	p[1].expect(protocol.TypeMatched, &m1)
	if m0.Player != 1 || m1.Player != 0 || m0.Room != m1.Room {
		t.Fatalf("rematch seats: %+v / %+v", m0, m1)
	}
}

func TestRematchOffWhenOpponentLeaves(t *testing.T) {
	p := match(t, newServer(t))
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	p[0].expectEnded(seat(1), protocol.ReasonResign)
	p[1].expectEnded(seat(1), protocol.ReasonResign)

	p[1].conn.Close()
	p[0].expect(protocol.TypeRematchOff, nil)
	p[0].say(protocol.TypeRematch)
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "no rematch" {
		t.Fatalf("error = %q", e.Message)
	}
}

func TestNoRematchDuringGame(t *testing.T) {
	p := match(t, newServer(t))
	p[0].say(protocol.TypeRematch)
	var e protocol.Error
	p[0].expect(protocol.TypeError, &e)
	if e.Message != "no rematch" {
		t.Fatalf("error = %q", e.Message)
	}
}
