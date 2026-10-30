package hub

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// newRecordingServer는 기보를 임시 폴더에 저장하는 서버입니다.
func newRecordingServer(t *testing.T) *httptest.Server {
	t.Helper()
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	store, err := record.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	h := New(config.Config{}, ids, store)
	matches := record.Handler{Store: store, IDs: ids}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /ws", h.ServeWS)
	mux.HandleFunc("GET /api/matches", matches.ServeMine)
	mux.HandleFunc("GET /api/matches/{id}", matches.ServeMatch)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// getJSON은 p의 쿠키로 GET합니다. p가 nil이면 쿠키 없이.
func getJSON(t *testing.T, srv *httptest.Server, p *player, path string, v any) int {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+path, nil)
	if p != nil {
		req.Header = p.header.Clone()
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if v != nil && res.StatusCode == http.StatusOK {
		if err := json.NewDecoder(res.Body).Decode(v); err != nil {
			t.Fatal(err)
		}
	}
	return res.StatusCode
}

func TestEndedMatchIsRecorded(t *testing.T) {
	shortMinute(t, time.Second)
	srv := newRecordingServer(t)
	p := matchTimed(t, srv, 1)
	p[0].action(1, 1)
	p[0].expect(protocol.TypeRelay, nil)
	p[1].expect(protocol.TypeRelay, nil)
	p[1].send(protocol.Resign{Type: protocol.TypeResign})

	var e protocol.Ended
	for _, x := range p {
		x.expectClock(nil)
		x.expect(protocol.TypeEnded, &e)
	}
	if !record.ValidID(e.Record) {
		t.Fatalf("ended without record id: %+v", e)
	}

	var v record.View
	if code := getJSON(t, srv, p[0], "/api/matches/"+e.Record, &v); code != http.StatusOK {
		t.Fatalf("GET match = %d", code)
	}
	if v.Game != "tictactoe" || v.Reason != protocol.ReasonResign || *v.Winner != 0 || *v.Minutes != 1 {
		t.Fatalf("bad record: %+v", v)
	}
	if len(v.Moves) != 1 || v.Moves[0].Player != 0 || v.Moves[0].Action.Row != 1 || v.Count != 1 {
		t.Fatalf("bad moves: %+v", v.Moves)
	}
	if len(v.You) != 1 || v.You[0] != 0 || v.Clock == nil || v.Clock[1] != 1000 {
		t.Fatalf("you/clock: %+v", v)
	}

	// 안 둔 사람도 링크로 볼 수 있지만 자리는 없습니다
	var anon record.View
	getJSON(t, srv, nil, "/api/matches/"+e.Record, &anon)
	if len(anon.You) != 0 || len(anon.Moves) != 1 {
		t.Fatalf("anonymous view: %+v", anon)
	}
}

func TestRecordHidesUserIDs(t *testing.T) {
	srv := newRecordingServer(t)
	p := match(t, srv)
	p[0].send(protocol.Resign{Type: protocol.TypeResign})
	var e protocol.Ended
	p[0].expect(protocol.TypeEnded, &e)

	res, err := http.Get(srv.URL + "/api/matches/" + e.Record)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var raw map[string]any
	json.NewDecoder(res.Body).Decode(&raw)
	data, _ := json.Marshal(raw)
	if strings.Contains(string(data), `"g_`) {
		t.Fatalf("user id leaked: %s", data)
	}
}

func TestMyMatches(t *testing.T) {
	srv := newRecordingServer(t)
	p := match(t, srv)
	p[1].send(protocol.Resign{Type: protocol.TypeResign})
	var e protocol.Ended
	p[1].expect(protocol.TypeEnded, &e)

	var mine []record.View
	getJSON(t, srv, p[1], "/api/matches", &mine)
	if len(mine) != 1 || mine[0].ID != e.Record || len(mine[0].You) != 1 || mine[0].You[0] != 1 || mine[0].Moves != nil {
		t.Fatalf("my matches: %+v", mine)
	}
	// 쿠키가 없으면 빈 목록
	var none []record.View
	if code := getJSON(t, srv, nil, "/api/matches", &none); code != http.StatusOK || len(none) != 0 {
		t.Fatalf("no cookie: %d %+v", code, none)
	}
	if code := getJSON(t, srv, nil, "/api/matches/ZZZZZZZZZZ", nil); code != http.StatusNotFound {
		t.Fatalf("missing record = %d", code)
	}
}
