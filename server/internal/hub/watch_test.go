package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

func listLive(t *testing.T, srv *httptest.Server) []protocol.LiveRoom {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/live")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out []protocol.LiveRoom
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestWatch(t *testing.T) {
	srv := newServer(t)
	p := match(t, srv)
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)

	live := listLive(t, srv)
	if len(live) != 1 || live[0].Game != "tictactoe" || live[0].Moves != 1 || len(live[0].Players[0].Tag) != 4 {
		t.Fatalf("live = %+v", live)
	}

	w := connect(t, srv)
	w.send(protocol.Watch{Type: protocol.TypeWatch, Room: live[0].Room})
	var wm protocol.Watching
	w.expect(protocol.TypeWatching, &wm)
	if wm.Room != live[0].Room || len(wm.Log) != 1 || wm.Log[0].Action.Row != 1 {
		t.Fatalf("watching = %+v", wm)
	}
	if got := listLive(t, srv); got[0].Watchers != 1 {
		t.Fatalf("watchers = %d", got[0].Watchers)
	}

	// 관전자는 둘 수 없습니다
	w.action(0, 0)
	var e protocol.Error
	w.expect(protocol.TypeError, &e)
	if e.Message != "not in a room" {
		t.Fatalf("watcher action: %q", e.Message)
	}

	// 대국의 행동과 끝을 같이 받습니다
	p[1].action(0, 0)
	var r protocol.Relay
	w.expect(protocol.TypeRelay, &r)
	if r.Seq != 1 || r.Player != 1 {
		t.Fatalf("watcher relay = %+v", r)
	}
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	w.expectEnded(seat(1), protocol.ReasonResign)
	if got := listLive(t, srv); len(got) != 0 {
		t.Fatalf("ended room still live: %+v", got)
	}

	// 끝난 뒤에는 같은 연결로 다른 대국을 찾을 수 있습니다
	w.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	w.expect(protocol.TypeWaiting, nil)
}

func TestWatchSeesAwayAndDraw(t *testing.T) {
	shortGrace(t, time.Minute)
	srv := newServer(t)
	p := match(t, srv)
	w := connect(t, srv)
	w.send(protocol.Watch{Type: protocol.TypeWatch, Room: listLive(t, srv)[0].Room})
	// 아직 행동이 없어도 기록은 null이 아니라 빈 목록입니다 (브라우저가 그대로 재생합니다)
	var wm protocol.Watching
	w.expect(protocol.TypeWatching, &wm)
	if wm.Log == nil {
		t.Fatal("empty log sent as null")
	}

	p[0].say(protocol.TypeDraw)
	var d protocol.Draw
	w.expect(protocol.TypeDraw, &d)
	p[1].conn.Close()
	var a protocol.Away
	w.expect(protocol.TypeAway, &a)
	if d.Player != 0 || a.Player != 1 {
		t.Fatalf("draw %+v away %+v", d, a)
	}
}

func TestWatchUnknownRoom(t *testing.T) {
	w := connect(t, newServer(t))
	w.send(protocol.Watch{Type: protocol.TypeWatch, Room: "NOPE22"})
	var e protocol.Error
	w.expect(protocol.TypeError, &e)
	if e.Message != "room not found" {
		t.Fatalf("error = %q", e.Message)
	}
}
