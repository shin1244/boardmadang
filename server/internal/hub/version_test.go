package hub

import (
	"net/http"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// 게임 코드 버전이 다르면 같은 행동으로 다른 판이 되므로 섞지 않습니다.

func TestDifferentVersionsDoNotMatch(t *testing.T) {
	srv := newServer(t)
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Version: "aaaa"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Version: "bbbb"})
	b.expect(protocol.TypeWaiting, nil)
}

func TestEnterNeedsSameVersion(t *testing.T) {
	srv := newServer(t)
	host, guest := connectMember(t, srv, "host"), connect(t, srv)
	host.send(protocol.Create{Type: protocol.TypeCreate, Game: "tictactoe", Version: "aaaa"})
	var c protocol.Created
	host.expect(protocol.TypeCreated, &c)
	if rooms := listRooms(t, srv); rooms[0].Version != "aaaa" {
		t.Fatalf("listed version = %q", rooms[0].Version)
	}

	guest.send(protocol.Enter{Type: protocol.TypeEnter, Room: c.Room, Version: "bbbb"})
	var e protocol.Error
	guest.expect(protocol.TypeError, &e)
	if e.Message != "version mismatch" {
		t.Fatalf("error = %q", e.Message)
	}
	guest.send(protocol.Enter{Type: protocol.TypeEnter, Room: c.Room, Version: "aaaa"})
	guest.expect(protocol.TypeMatched, nil)
	host.expect(protocol.TypeMatched, nil)
}

func TestRejectsBadVersion(t *testing.T) {
	p := connect(t, newServer(t))
	p.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Version: "NOT HEX"})
	var e protocol.Error
	p.expect(protocol.TypeError, &e)
	if e.Message != "bad version" {
		t.Fatalf("error = %q", e.Message)
	}
}

func TestRecordKeepsVersion(t *testing.T) {
	srv := newRecordingServer(t)
	a, b := connect(t, srv), connect(t, srv)
	a.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Version: "0123abcd"})
	a.expect(protocol.TypeWaiting, nil)
	b.send(protocol.Join{Type: protocol.TypeJoin, Game: "tictactoe", Version: "0123abcd"})
	a.expect(protocol.TypeMatched, nil)
	b.expect(protocol.TypeMatched, nil)
	a.send(protocol.Resign{Type: protocol.TypeResign})
	var e protocol.Ended
	a.expect(protocol.TypeEnded, &e)

	var v record.View
	if code := getJSON(t, srv, a, "/api/matches/"+e.Record, &v); code != http.StatusOK {
		t.Fatalf("GET match = %d", code)
	}
	if v.Version != "0123abcd" {
		t.Fatalf("record version = %q", v.Version)
	}
}
