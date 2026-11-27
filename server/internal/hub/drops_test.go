package hub

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// newLocatingServer는 기보를 남기고, 요청의 X-Country 헤더를 접속한 나라로 보는 서버입니다.
func newLocatingServer(t *testing.T) (*httptest.Server, *Hub, *record.Store) {
	t.Helper()
	ids := identity.NewIssuer(testSecret)
	store, err := record.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	h := New(config.Config{}, ids, store)
	h.Locate = func(r *http.Request) string { return r.Header.Get("X-Country") }
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /ws", h.ServeWS)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, h, store
}

// connectFrom은 connect처럼 게스트로 붙되, 그 나라에서 접속한 것으로 합니다 (다시 붙어도 같은 나라).
func connectFrom(t *testing.T, srv *httptest.Server, country string) *player {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	header := http.Header{"X-Country": {country}}
	for _, c := range res.Cookies() {
		header.Add("Cookie", c.String())
	}
	p := &player{t: t, srv: srv, header: header}
	p.dial()
	return p
}

// matchFrom은 match처럼 두 사람을 맞붙입니다. 자리 순서로 돌려주고, 자리마다의 나라도 돌려줍니다.
func matchFrom(t *testing.T, srv *httptest.Server, ca, cb string) ([2]*player, [2]string) {
	t.Helper()
	a, b := connectFrom(t, srv, ca), connectFrom(t, srv, cb)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	var ma, mb protocol.Matched
	a.expect(protocol.TypeMatched, &ma)
	b.expect(protocol.TypeMatched, &mb)
	a.seat, b.seat = ma.Player, mb.Player
	ps, cs := [2]*player{a, b}, [2]string{ca, cb}
	if a.seat == 1 {
		ps, cs = [2]*player{b, a}, [2]string{cb, ca}
	}
	ps[0].hash(-1, "start")
	ps[1].hash(-1, "start")
	ps[0].sync()
	ps[1].sync()
	return ps, cs
}

func TestRecordKeepsCountryAndDrops(t *testing.T) {
	shortGrace(t, 500*time.Millisecond)
	srv, _, store := newLocatingServer(t)
	p, countries := matchFrom(t, srv, "KR", "US")
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)

	// 후공이 끊겼다가 유예 시간 안에 돌아옵니다
	p[1].reconnect()
	p[0].expect(protocol.TypeAway, nil)
	p[1].expect(protocol.TypeResumed, nil)
	p[0].expect(protocol.TypeBack, nil)

	// 선공이 끊기고 돌아오지 않으면 left로 끝납니다
	p[0].conn.Close()
	p[1].expect(protocol.TypeAway, nil)
	var e protocol.Ended
	p[1].expect(protocol.TypeEnded, &e)
	if e.Reason != protocol.ReasonLeft {
		t.Fatalf("ended = %+v", e)
	}
	m, err := store.Get(e.Record)
	if err != nil {
		t.Fatal(err)
	}
	for i, pl := range m.Players {
		if pl.Country != countries[i] {
			t.Errorf("seat %d country = %q, want %q", i, pl.Country, countries[i])
		}
	}
	if len(m.Drops) != 2 {
		t.Fatalf("drops = %+v", m.Drops)
	}
	first, second := m.Drops[0], m.Drops[1]
	if first.Player != 1 || first.Back == nil || *first.Back < first.At {
		t.Errorf("first drop = %+v, want seat 1 back", first)
	}
	if second.Player != 0 || second.Back != nil || second.At < first.At {
		t.Errorf("second drop = %+v, want seat 0 not back", second)
	}
}

func TestShutdownRecordsLiveMatches(t *testing.T) {
	srv, h, store := newLocatingServer(t)
	p, _ := matchFrom(t, srv, "KR", "KR")
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)

	if n := h.Shutdown(); n != 1 {
		t.Fatalf("shutdown ended %d matches, want 1", n)
	}
	var e protocol.Ended
	for _, x := range p {
		x.expect(protocol.TypeEnded, &e)
		if e.Reason != protocol.ReasonShutdown || e.Winner != nil || !record.ValidID(e.Record) {
			t.Fatalf("ended = %+v", e)
		}
	}
	m, err := store.Get(e.Record)
	if err != nil {
		t.Fatal(err)
	}
	if m.Reason != protocol.ReasonShutdown || len(m.Moves) != 1 {
		t.Fatalf("record = %+v", m)
	}
	// 무효라 판 수에 세지 않습니다
	if got := store.Plays("tictactoe"); got != 0 {
		t.Fatalf("plays = %d, want 0", got)
	}
	// 끄는 중에는 새 대국을 받지 않습니다
	p[0].send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	var er protocol.Error
	p[0].expect(protocol.TypeError, &er)
	if er.Message != "server closing" {
		t.Fatalf("error = %q", er.Message)
	}
	if n := h.Shutdown(); n != 0 {
		t.Fatalf("second shutdown ended %d", n)
	}
}
