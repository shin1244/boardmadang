package ai

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func liveAt(start time.Time) (*Live, *time.Time) {
	now := start
	l := NewLive()
	l.now = func() time.Time { return now }
	return l, &now
}

// summary는 목록을 "게임 태그 난이도 수 나이"로 줄입니다.
func summary(list []LiveGame) string {
	out := make([]string, len(list))
	for i, g := range list {
		out[i] = fmt.Sprintf("%s %s %s %d %d", g.Game, g.Player.Tag, g.Level, g.Moves, g.Age)
	}
	return strings.Join(out, "|")
}

func TestLiveBeatAndExpire(t *testing.T) {
	l, now := liveAt(at)
	a := identity.User{ID: "g_a", Kind: identity.KindGuest, Tag: "0001"}
	b := identity.User{ID: "m_b", Kind: identity.KindMember, Tag: "0002", Name: "bee"}

	l.Beat(a, "tictactoe", "normal", 1)
	*now = now.Add(20 * time.Second)
	l.Beat(b, "omok", "hard", 2)
	l.Beat(a, "tictactoe", "normal", 3)
	// 최근에 시작한 판이 먼저. 다시 알려도 시작한 때는 그대로입니다
	if got, want := summary(l.List()), "omok 0002 hard 2 0|tictactoe 0001 normal 3 20"; got != want {
		t.Fatalf("list = %q, want %q", got, want)
	}
	if got := l.List()[0].Player; got.Name != "bee" || got.Kind != identity.KindMember {
		t.Fatalf("player = %+v", got)
	}

	// a만 계속 알리면 b는 liveTTL 뒤에 빠집니다
	*now = now.Add(liveTTL)
	l.Beat(a, "tictactoe", "normal", 4)
	*now = now.Add(time.Second)
	if got, want := summary(l.List()), "tictactoe 0001 normal 4 111"; got != want {
		t.Fatalf("after TTL = %q, want %q", got, want)
	}

	// 끝났다고 알리면 바로 빠집니다. 다른 게임의 끝은 상관없습니다
	l.End(a, "omok")
	if len(l.List()) != 1 {
		t.Fatal("ending another game removed the entry")
	}
	l.End(a, "tictactoe")
	if got := l.List(); len(got) != 0 {
		t.Fatalf("after end = %q", summary(got))
	}
}

func TestLiveOnePerPerson(t *testing.T) {
	l, now := liveAt(at)
	a := identity.User{ID: "g_a", Kind: identity.KindGuest, Tag: "0001"}
	l.Beat(a, "tictactoe", "easy", 5)
	*now = now.Add(30 * time.Second)
	// 다른 게임을 두기 시작하면 앞의 판을 바꿉니다
	l.Beat(a, "omok", "hard", 1)
	if got, want := summary(l.List()), "omok 0001 hard 1 0"; got != want {
		t.Fatalf("other game = %q, want %q", got, want)
	}
	*now = now.Add(30 * time.Second)
	l.Beat(a, "omok", "hard", 9)
	*now = now.Add(30 * time.Second)
	// 수가 줄었으면 새 판입니다 (끝났다는 알림이 안 온 경우)
	l.Beat(a, "omok", "hard", 1)
	if got, want := summary(l.List()), "omok 0001 hard 1 0"; got != want {
		t.Fatalf("new game = %q, want %q", got, want)
	}
}

func TestLiveIdle(t *testing.T) {
	l, now := liveAt(at)
	a := identity.User{ID: "g_a", Kind: identity.KindGuest, Tag: "0001"}
	l.Beat(a, "tictactoe", "normal", 3)
	// 알림은 계속 오는데 수가 늘지 않으면 liveIdle 뒤에 보여주지 않습니다
	for d := time.Duration(0); d <= liveIdle; d += LiveBeat {
		*now = now.Add(LiveBeat)
		l.Beat(a, "tictactoe", "normal", 3)
	}
	if got := l.List(); len(got) != 0 {
		t.Fatalf("idle game listed: %q", summary(got))
	}
	// 다시 두면 돌아옵니다
	l.Beat(a, "tictactoe", "normal", 4)
	if got := l.List(); len(got) != 1 || got[0].Moves != 4 {
		t.Fatalf("after a move = %q", summary(got))
	}
}

func TestLiveFull(t *testing.T) {
	l, now := liveAt(at)
	user := func(i int) identity.User {
		return identity.User{ID: fmt.Sprintf("g_%d", i), Kind: identity.KindGuest, Tag: fmt.Sprintf("%04d", i)}
	}
	for i := range maxLive {
		if !l.Beat(user(i), "tictactoe", "normal", 1) {
			t.Fatalf("beat %d refused", i)
		}
	}
	if l.Beat(user(maxLive), "tictactoe", "normal", 1) {
		t.Fatal("accepted a game over maxLive")
	}
	// 이미 올린 사람은 꽉 차 있어도 계속 알릴 수 있습니다
	if !l.Beat(user(0), "tictactoe", "normal", 2) {
		t.Fatal("refused a listed game")
	}
	if got := len(l.List()); got != maxLive {
		t.Fatalf("listed %d, want %d", got, maxLive)
	}
	// 나머지가 끊겨 자리가 나면 받습니다
	*now = now.Add(liveTTL + time.Second)
	if !l.Beat(user(maxLive), "tictactoe", "normal", 1) {
		t.Fatal("refused after the others expired")
	}
	if got := len(l.List()); got != 1 {
		t.Fatalf("listed %d, want 1", got)
	}
}

func TestServeLive(t *testing.T) {
	f := setup(t)
	if rec := f.put("tictactoe", onnx, nil); rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	h := Handler{Store: f.store, IDs: f.ids, Live: NewLive()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ai/live", h.ServeLive)
	mux.HandleFunc("POST /api/ai/{game}/live", h.ServeLiveBeat)
	mux.HandleFunc("DELETE /api/ai/{game}/live", h.ServeLiveEnd)
	guest := identity.User{ID: "g_guest1", Kind: identity.KindGuest, Tag: "4821"}
	member := identity.User{ID: f.member.ID, Kind: identity.KindMember}
	send := func(method, game, ctype, body string, u *identity.User) int {
		t.Helper()
		req := httptest.NewRequest(method, "/api/ai/"+game+"/live", strings.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if u != nil {
			req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: f.ids.Sign(*u)})
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	list := func() []LiveGame {
		t.Helper()
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/ai/live", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("list = %d", rec.Code)
		}
		var out []LiveGame
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out == nil {
			t.Fatalf("list body %q: %v", rec.Body, err)
		}
		return out
	}

	if got := list(); len(got) != 0 {
		t.Fatalf("empty list = %+v", got)
	}
	const good = `{"moves":3,"level":"normal"}`
	for _, c := range []struct {
		name, method, game, ctype, body string
		u                               *identity.User
		code                            int
	}{
		{"no cookie", "POST", "tictactoe", "application/json", good, nil, 401},
		{"form post", "POST", "tictactoe", "text/plain", good, &guest, 415},
		{"no model", "POST", "nakseok", "application/json", good, &guest, 404},
		{"bad game id", "POST", "Bad_ID", "application/json", good, &guest, 404},
		{"bad level", "POST", "tictactoe", "application/json", `{"moves":3,"level":"<b>"}`, &guest, 400},
		{"no level", "POST", "tictactoe", "application/json", `{"moves":3}`, &guest, 400},
		{"negative moves", "POST", "tictactoe", "application/json", `{"moves":-1,"level":"easy"}`, &guest, 400},
		{"too many moves", "POST", "tictactoe", "application/json", `{"moves":100001,"level":"easy"}`, &guest, 400},
		{"bad JSON", "POST", "tictactoe", "application/json", `{`, &guest, 400},
		{"end without cookie", "DELETE", "tictactoe", "", "", nil, 401},
		{"end without a game", "DELETE", "tictactoe", "", "", &guest, 204},
	} {
		if got := send(c.method, c.game, c.ctype, c.body, c.u); got != c.code {
			t.Errorf("%s = %d, want %d", c.name, got, c.code)
		}
	}
	if got := list(); len(got) != 0 {
		t.Fatalf("refused requests were listed: %+v", got)
	}

	if got := send("POST", "tictactoe", "application/json", good, &guest); got != 204 {
		t.Fatalf("guest beat = %d", got)
	}
	if got := send("POST", "tictactoe", "application/json", `{"moves":0,"level":"hard"}`, &member); got != 204 {
		t.Fatalf("member beat = %d", got)
	}
	got := list()
	if len(got) != 2 {
		t.Fatalf("list = %+v", got)
	}
	byKind := map[string]LiveGame{}
	for _, g := range got {
		byKind[g.Player.Kind] = g
	}
	// 게스트는 쿠키의 id에서 나온 태그로, 계정은 계정 이름으로 보입니다. 내부 id는 나가지 않습니다
	if g := byKind[identity.KindGuest]; g.Game != "tictactoe" || g.Level != "normal" || g.Moves != 3 || g.Player.Name != "" || len(g.Player.Tag) != 4 {
		t.Errorf("guest row = %+v", g)
	}
	if g := byKind[identity.KindMember]; g.Level != "hard" || g.Player.Name != "someone" {
		t.Errorf("member row = %+v", g)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/ai/live", nil))
	if strings.Contains(rec.Body.String(), "g_guest1") || strings.Contains(rec.Body.String(), f.member.ID) {
		t.Errorf("list leaks ids: %s", rec.Body)
	}

	if got := send("DELETE", "tictactoe", "", "", &guest); got != 204 {
		t.Fatalf("end = %d", got)
	}
	if got := list(); len(got) != 1 || got[0].Player.Kind != identity.KindMember {
		t.Fatalf("after end = %+v", got)
	}

	// Live가 없는 서버는 받기만 하고 목록은 비어 있습니다
	off := Handler{Store: f.store, IDs: f.ids}
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/ai/tictactoe/live", strings.NewReader(good))
	req.SetPathValue("game", "tictactoe")
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: f.ids.Sign(guest)})
	off.ServeLiveBeat(rec, req)
	if rec.Code != 204 {
		t.Fatalf("beat without Live = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	off.ServeLiveEnd(rec, req)
	off.ServeLive(rec, httptest.NewRequest("GET", "/api/ai/live", nil))
	if strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("list without Live = %q", rec.Body)
	}
}
