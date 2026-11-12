package ai

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// fakePlays는 받은 알림을 "사람 게임 이벤트 결과"로 남깁니다.
type fakePlays struct{ got []string }

func (p *fakePlays) AIPlay(r *http.Request, u identity.User, game string) bool {
	p.got = append(p.got, u.ID+" "+game+" play")
	return true
}

func (p *fakePlays) AIEnd(r *http.Request, u identity.User, game, result string) bool {
	p.got = append(p.got, u.ID+" "+game+" end "+result)
	return true
}

func TestServePlays(t *testing.T) {
	f := setup(t)
	if rec := f.put("tictactoe", onnx, nil); rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	plays := &fakePlays{}
	h := Handler{Store: f.store, IDs: f.ids, Plays: plays}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/ai/{game}/plays", h.ServePlays)
	guest := identity.User{ID: "g_guest1", Kind: identity.KindGuest}
	post := func(game, ctype, body string, u *identity.User) int {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/ai/"+game+"/plays", strings.NewReader(body))
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

	for _, c := range []struct {
		name, game, ctype, body string
		u                       *identity.User
		code                    int
	}{
		{"play", "tictactoe", "application/json", `{"event":"play"}`, &guest, 204},
		{"end", "tictactoe", "application/json", `{"event":"end","result":"win"}`, &guest, 204},
		{"no cookie", "tictactoe", "application/json", `{"event":"play"}`, nil, 401},
		{"form post", "tictactoe", "text/plain", `{"event":"play"}`, &guest, 415},
		{"no model", "nakseok", "application/json", `{"event":"play"}`, &guest, 404},
		{"bad game id", "Bad_ID", "application/json", `{"event":"play"}`, &guest, 404},
		{"bad event", "tictactoe", "application/json", `{"event":"start"}`, &guest, 400},
		{"bad result", "tictactoe", "application/json", `{"event":"end","result":"lost"}`, &guest, 400},
		{"bad JSON", "tictactoe", "application/json", `{`, &guest, 400},
	} {
		if got := post(c.game, c.ctype, c.body, c.u); got != c.code {
			t.Errorf("%s = %d, want %d", c.name, got, c.code)
		}
	}
	want := []string{"g_guest1 tictactoe play", "g_guest1 tictactoe end win"}
	if strings.Join(plays.got, "|") != strings.Join(want, "|") {
		t.Fatalf("counted %q, want %q", plays.got, want)
	}
}
