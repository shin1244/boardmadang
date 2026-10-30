package hub

import (
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

func shortEmote(t *testing.T, d time.Duration) {
	old := EmoteEvery
	EmoteEvery = d
	t.Cleanup(func() { EmoteEvery = old })
}

func TestEmote(t *testing.T) {
	shortEmote(t, 100*time.Millisecond)
	srv := newServer(t)
	lone := connect(t, srv)
	lone.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "hello"})
	var e protocol.Error
	lone.expect(protocol.TypeError, &e)
	if e.Message != "not in a room" {
		t.Fatalf("before a game: %q", e.Message)
	}

	ps := match(t, srv)
	a, b := ps[0], ps[1]
	a.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "hello"})
	for _, p := range []*player{a, b} {
		var m protocol.Emote
		p.expect(protocol.TypeEmote, &m)
		if m.Player != a.seat || m.Emote != "hello" {
			t.Fatalf("emote = %+v, want from seat %d", m, a.seat)
		}
	}

	// 너무 빨리 보내면 버립니다. 없는 그림은 거절합니다
	a.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "wow"})
	a.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "<script>"})
	a.expect(protocol.TypeError, &e)
	if e.Message != "bad emote" {
		t.Fatalf("bad emote: %q", e.Message)
	}
	time.Sleep(120 * time.Millisecond)
	b.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "gg"})
	var m protocol.Emote
	a.expect(protocol.TypeEmote, &m) // wow는 버려졌으므로 다음은 b의 gg
	if m.Player != b.seat || m.Emote != "gg" {
		t.Fatalf("emote = %+v, want gg from seat %d", m, b.seat)
	}
	b.expect(protocol.TypeEmote, nil) // 보낸 쪽에도 갑니다

	// 끝난 뒤에도 (재대결을 기다리는 동안) 보낼 수 있습니다
	a.send(protocol.Resign{Type: protocol.TypeResign})
	a.expect(protocol.TypeEnded, nil)
	b.expect(protocol.TypeEnded, nil)
	time.Sleep(120 * time.Millisecond)
	a.send(protocol.Emote{Type: protocol.TypeEmote, Emote: "gg"})
	b.expect(protocol.TypeEmote, &m)
	if m.Emote != "gg" {
		t.Fatalf("after end: %+v", m)
	}
}
