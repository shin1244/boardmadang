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
