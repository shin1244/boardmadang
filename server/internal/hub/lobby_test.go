package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

func listRooms(t *testing.T, srv *httptest.Server) []protocol.OpenRoom {
	t.Helper()
	res, err := http.Get(srv.URL + "/api/rooms")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out []protocol.OpenRoom
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func (p *player) create(m *int) protocol.Created {
	p.t.Helper()
	p.send(protocol.Create{Type: protocol.TypeCreate, Game: "tictactoe", Minutes: m})
	var c protocol.Created
	p.expect(protocol.TypeCreated, &c)
	return c
}

func shortBump(t *testing.T, d time.Duration) {
	old := BumpEvery
	BumpEvery = d
	t.Cleanup(func() { BumpEvery = old })
}

func TestCreateAndEnter(t *testing.T) {
	srv := newServer(t)
	host, guest := connectMember(t, srv, "host"), connect(t, srv)
	c := host.create(minutes(7))
	if c.Room == "" || c.Minutes == nil || *c.Minutes != 7 || c.BumpEvery != 60 {
		t.Fatalf("created = %+v", c)
	}

	rooms := listRooms(t, srv)
	if len(rooms) != 1 || rooms[0].Room != c.Room || rooms[0].Game != "tictactoe" || *rooms[0].Minutes != 7 || len(rooms[0].Host.Tag) != 4 {
		t.Fatalf("rooms = %+v", rooms)
	}

	guest.send(protocol.Enter{Type: protocol.TypeEnter, Room: c.Room})
	var mh, mg protocol.Matched
	host.expect(protocol.TypeMatched, &mh)
	guest.expect(protocol.TypeMatched, &mg)
	if mh.Room != c.Room || mg.Room != c.Room || mh.Player == mg.Player || *mg.Minutes != 7 {
		t.Fatalf("matched = %+v / %+v", mh, mg)
	}
	if rooms := listRooms(t, srv); len(rooms) != 0 {
		t.Fatalf("room still listed after start: %+v", rooms)
	}

	// 이미 시작한 방에는 못 들어갑니다
	late := connect(t, srv)
	late.send(protocol.Enter{Type: protocol.TypeEnter, Room: c.Room})
	var e protocol.Error
	late.expect(protocol.TypeError, &e)
	if e.Message != "room not found" {
		t.Fatalf("late enter: error = %q", e.Message)
	}
}

func TestGuestCannotCreate(t *testing.T) {
	srv := newServer(t)
	guest := connect(t, srv)
	guest.send(protocol.Create{Type: protocol.TypeCreate, Game: "tictactoe"})
	var e protocol.Error
	guest.expect(protocol.TypeError, &e)
	if e.Message != "member only" {
		t.Fatalf("error = %q, want member only", e.Message)
	}
	if rooms := listRooms(t, srv); len(rooms) != 0 {
		t.Fatalf("guest room listed: %+v", rooms)
	}
	// 거절당한 뒤에도 빠른 매칭은 됩니다
	other := connect(t, srv)
	guest.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	guest.expect(protocol.TypeWaiting, nil)
	other.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	var m protocol.Matched
	other.expect(protocol.TypeMatched, &m)
}

// 정지된 계정은 방을 만들 수 없고, 빠른 매칭으로 두는 것은 됩니다
func TestSuspendedCannotCreate(t *testing.T) {
	srv := newServer(t)
	bad := connectMember(t, srv, "suspended")
	bad.send(protocol.Create{Type: protocol.TypeCreate, Game: "tictactoe"})
	var e protocol.Error
	bad.expect(protocol.TypeError, &e)
	if e.Message != "suspended" {
		t.Fatalf("error = %q, want suspended", e.Message)
	}
	if rooms := listRooms(t, srv); len(rooms) != 0 {
		t.Fatalf("suspended room listed: %+v", rooms)
	}
	other := connect(t, srv)
	bad.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	bad.expect(protocol.TypeWaiting, nil)
	other.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"})
	other.expect(protocol.TypeMatched, nil)
}

func TestRoomWithoutTimer(t *testing.T) {
	srv := newServer(t)
	host, guest := connectMember(t, srv, "host"), connect(t, srv)
	c := host.create(nil)
	if c.Minutes != nil || listRooms(t, srv)[0].Minutes != nil {
		t.Fatalf("timer-less room has minutes: %+v", c)
	}
	guest.send(protocol.Enter{Type: protocol.TypeEnter, Room: c.Room})
	var m protocol.Matched
	guest.expect(protocol.TypeMatched, &m)
	if m.Minutes != nil {
		t.Fatalf("matched minutes = %v", *m.Minutes)
	}
}

func TestHostLeavingRemovesRoom(t *testing.T) {
	srv := newServer(t)
	host := connectMember(t, srv, "host")
	host.create(nil)
	host.conn.Close()
	time.Sleep(50 * time.Millisecond)
	if rooms := listRooms(t, srv); len(rooms) != 0 {
		t.Fatalf("room listed after host left: %+v", rooms)
	}
}

func TestHostCannotJoinOrCreateTwice(t *testing.T) {
	srv := newServer(t)
	host := connectMember(t, srv, "host")
	host.create(nil)
	for _, msg := range []any{
		protocol.Create{Type: protocol.TypeCreate, Game: "tictactoe"},
		protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe"},
	} {
		host.send(msg)
		var e protocol.Error
		host.expect(protocol.TypeError, &e)
		if e.Message != "already joined" {
			t.Fatalf("%+v: error = %q", msg, e.Message)
		}
	}
}

func TestBump(t *testing.T) {
	shortBump(t, 150*time.Millisecond)
	srv := newServer(t)
	a, b := connectMember(t, srv, "a"), connectMember(t, srv, "b")
	ca := a.create(nil)
	time.Sleep(10 * time.Millisecond)
	cb := b.create(nil)
	if rooms := listRooms(t, srv); rooms[0].Room != cb.Room || rooms[1].Room != ca.Room {
		t.Fatalf("newest room should be first: %+v", rooms)
	}

	a.send(protocol.Bump{Type: protocol.TypeBump})
	var e protocol.Error
	a.expect(protocol.TypeError, &e)
	if e.Message != "too soon" {
		t.Fatalf("early bump: error = %q", e.Message)
	}

	time.Sleep(160 * time.Millisecond)
	a.send(protocol.Bump{Type: protocol.TypeBump})
	a.expect(protocol.TypeBumped, nil)
	if rooms := listRooms(t, srv); rooms[0].Room != ca.Room {
		t.Fatalf("bumped room should be first: %+v", rooms)
	}

	notHost := connect(t, srv)
	notHost.send(protocol.Bump{Type: protocol.TypeBump})
	notHost.expect(protocol.TypeError, &e)
	if e.Message != "not hosting" {
		t.Fatalf("bump without room: error = %q", e.Message)
	}
}

// listWaiting은 header의 쿠키로 GET /api/waiting을 부릅니다. header가 nil이면 쿠키 없이 부릅니다.
func listWaiting(t *testing.T, srv *httptest.Server, header http.Header) []protocol.Seeker {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/waiting", nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q", cc)
	}
	var out []protocol.Seeker
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// waitWaiting은 GET /api/waiting의 길이가 n이 될 때까지 잠깐 기다립니다 (끊김은 서버가 뒤에서 알아챕니다).
func waitWaiting(t *testing.T, srv *httptest.Server, n int) []protocol.Seeker {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		got := listWaiting(t, srv, nil)
		if len(got) == n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("waiting = %+v, want %d", got, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWaitingList(t *testing.T) {
	srv := newServer(t)
	a, b := connect(t, srv), connect(t, srv)
	if got := listWaiting(t, srv, nil); got == nil || len(got) != 0 {
		t.Fatalf("empty queue = %#v, want []", got)
	}

	// 빠른 매칭에 들어간 사람은 게임, 버전, 타이머로만 보입니다
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(10), Version: "abc"})
	a.expect(protocol.TypeWaiting, nil)
	got := listWaiting(t, srv, b.header)
	if len(got) != 1 || got[0].Game != "tictactoe" || got[0].Version != "abc" || got[0].Minutes == nil || *got[0].Minutes != 10 {
		t.Fatalf("waiting = %+v", got)
	}
	// 기다리는 본인에게는 (다른 탭에서 봐도) 자기가 보이지 않습니다
	if got := listWaiting(t, srv, a.header); len(got) != 0 {
		t.Fatalf("own waiting = %+v, want none", got)
	}

	// 같은 게임·버전·타이머로 join하면 바로 만나고 목록에서 빠집니다
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Minutes: minutes(10), Version: "abc"})
	a.expect(protocol.TypeMatched, nil)
	b.expect(protocol.TypeMatched, nil)
	waitWaiting(t, srv, 0)

	// 기다리다 나가면 빠집니다. 방 만들기로 연 방은 빠른 매칭 대기가 아니라 보이지 않습니다
	c, host := connect(t, srv), connectMember(t, srv, "host")
	host.create(nil)
	c.send(protocol.Join{Type: protocol.TypeJoin, Game: "other-game"})
	c.expect(protocol.TypeWaiting, nil)
	got = waitWaiting(t, srv, 1)
	if got[0].Game != "other-game" || got[0].Minutes != nil || got[0].Version != "" {
		t.Fatalf("waiting = %+v", got)
	}
	c.conn.Close()
	waitWaiting(t, srv, 0)
}
