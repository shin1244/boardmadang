package star

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func TestSetAndReopen(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		game, user string
		on         bool
		want       int
	}{
		{"tictactoe", "m_a", true, 1},
		{"tictactoe", "m_a", true, 1}, // 두 번 달아도 하나
		{"tictactoe", "m_b", true, 2},
		{"splat-chess", "m_a", true, 1},
		{"tictactoe", "m_b", false, 1},
		{"tictactoe", "m_b", false, 1}, // 안 단 별을 떼도 그대로
		{"cellmoku", "m_a", false, 0},
	} {
		n, err := s.Set(c.game, c.user, c.on)
		if err != nil || n != c.want {
			t.Fatalf("Set(%s, %s, %v) = %d, %v, want %d", c.game, c.user, c.on, n, err, c.want)
		}
	}
	if _, err := s.Set("../x", "m_a", true); err != ErrBadGame {
		t.Fatalf("잘못된 id: %v", err)
	}

	// 다시 열어도 같습니다
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Stars("tictactoe"); got != 1 {
		t.Fatalf("tictactoe 별 = %d", got)
	}
	if got := s.Mine("m_a"); !slices.Equal(got, []string{"splat-chess", "tictactoe"}) {
		t.Fatalf("m_a 별 = %v", got)
	}
	if got := s.Mine("m_b"); len(got) != 0 {
		t.Fatalf("m_b 별 = %v", got)
	}

	if err := s.Forget("m_a"); err != nil {
		t.Fatal(err)
	}
	s, _ = Open(dir)
	if s.Stars("tictactoe") != 0 || s.Stars("splat-chess") != 0 || len(s.Mine("m_a")) != 0 {
		t.Fatalf("탈퇴한 계정의 별이 남음: %v", s.stars)
	}
}

type members map[string]time.Time // 계정 id → 정지 기한 (0이면 정지 아님)

func (m members) Name(id string) (string, bool) {
	_, ok := m[id]
	return id, ok
}

func (m members) Suspension(id string) (time.Time, bool) {
	until := m[id]
	return until, !until.IsZero()
}

func TestHTTP(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ids := identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	ids.Members = members{"m_web": {}, "m_bad": time.Now().Add(time.Hour)}
	h := Handler{Store: s, IDs: ids, Known: func(game string) bool { return game == "tictactoe" || game == "splat-chess" }}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/stars", h.ServeMine)
	mux.HandleFunc("PUT /api/games/{game}/star", h.ServeStar)
	mux.HandleFunc("DELETE /api/games/{game}/star", h.ServeUnstar)

	cookie := func(u identity.User) *http.Cookie {
		return &http.Cookie{Name: identity.CookieName, Value: ids.Sign(u)}
	}
	member := cookie(identity.Member("m_web", ""))
	suspended := cookie(identity.Member("m_bad", ""))
	guest := cookie(identity.User{ID: "g_web", Kind: identity.KindGuest})
	do := func(method, path string, c *http.Cookie) (int, string) {
		req := httptest.NewRequest(method, path, nil)
		if c != nil {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code, strings.TrimSpace(rec.Body.String())
	}
	expect := func(method, path string, c *http.Cookie, status int, body string) {
		t.Helper()
		if got, b := do(method, path, c); got != status || !strings.Contains(b, body) {
			t.Fatalf("%s %s: %d %s, want %d %s", method, path, got, b, status, body)
		}
	}

	expect("PUT", "/api/games/tictactoe/star", nil, http.StatusUnauthorized, "no session")
	expect("PUT", "/api/games/tictactoe/star", guest, http.StatusForbidden, "member only")
	expect("DELETE", "/api/games/tictactoe/star", guest, http.StatusForbidden, "member only")
	expect("PUT", "/api/games/nope/star", member, http.StatusNotFound, "not found")
	expect("PUT", "/api/games/tictactoe/star", member, http.StatusOK, `{"starred":true,"stars":1}`)
	expect("PUT", "/api/games/splat-chess/star", member, http.StatusOK, `{"starred":true,"stars":1}`)
	expect("GET", "/api/stars", member, http.StatusOK, `{"games":["splat-chess","tictactoe"]}`)
	expect("GET", "/api/stars", guest, http.StatusOK, `{"games":[]}`)
	expect("GET", "/api/stars", nil, http.StatusOK, `{"games":[]}`)
	expect("DELETE", "/api/games/tictactoe/star", member, http.StatusOK, `{"starred":false,"stars":0}`)
	expect("GET", "/api/stars", member, http.StatusOK, `{"games":["splat-chess"]}`)

	// 정지된 계정은 달 수 없고 뗄 수는 있습니다
	s.Set("tictactoe", "m_bad", true)
	expect("PUT", "/api/games/splat-chess/star", suspended, http.StatusForbidden, "suspended")
	expect("DELETE", "/api/games/tictactoe/star", suspended, http.StatusOK, `{"starred":false,"stars":0}`)
	// 목록에서 내려간 게임의 별도 뗄 수 있습니다
	s.Set("gone-game", "m_web", true)
	expect("DELETE", "/api/games/gone-game/star", member, http.StatusOK, `"starred":false`)
}
