package ai

import (
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
)

func TestServeMatch(t *testing.T) {
	f := setup(t)
	if rec := f.put("tictactoe", onnx, nil); rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	store, err := record.OpenAI(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := Handler{Store: f.store, IDs: f.ids, Matches: store, Locate: func(*http.Request) string { return "KR" }}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/ai/{game}/match", h.ServeMatch)
	guest := identity.User{ID: "g_guest1", Kind: identity.KindGuest, Tag: "4821"}
	other := identity.User{ID: "g_other1", Kind: identity.KindGuest, Tag: "1111"}
	send := func(game, ctype, body string, u *identity.User) int {
		t.Helper()
		req := httptest.NewRequest("POST", "/api/ai/"+game+"/match", strings.NewReader(body))
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

	id := record.NewID()
	moves := `[{"player":0,"action":{"kind":"click","row":1,"col":1},"at":500},{"player":1,"action":{"kind":"click","row":0,"col":0},"at":2500}]`
	body := func(end string) string {
		return `{"id":"` + id + `","version":"8345048c42920d27","seed":42,"seat":1,"level":"easy","sims":1,"moves":` + moves + end + `}`
	}
	const jsonType = "application/json"
	for _, c := range []struct {
		name, game, ctype, body string
		u                       *identity.User
		code                    int
	}{
		{"no cookie", "tictactoe", jsonType, body(""), nil, 401},
		{"form post", "tictactoe", "text/plain", body(""), &guest, 415},
		{"no model", "nakseok", jsonType, body(""), &guest, 404},
		{"bad JSON", "tictactoe", jsonType, `{`, &guest, 400},
		{"bad level", "tictactoe", jsonType, strings.Replace(body(""), `"easy"`, `"god"`, 1), &guest, 400},
		{"good", "tictactoe", jsonType, body(""), &guest, 204},
		{"someone else's id", "tictactoe", jsonType, body(""), &other, 403},
		{"end", "tictactoe", jsonType, body(`,"end":{"winner":1,"reason":"result"}`), &guest, 204},
		{"after end", "tictactoe", jsonType, body(`,"end":{"winner":1,"reason":"result"}`), &guest, 409},
	} {
		if got := send(c.game, c.ctype, c.body, c.u); got != c.code {
			t.Errorf("%s = %d, want %d", c.name, got, c.code)
		}
	}

	m, err := store.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	want := path.Base(f.store.Model("tictactoe").Model)
	if m.AI.Model != want || m.Players[1].Country != "KR" || m.Players[1].ID != guest.ID || *m.Winner != 1 || m.Reason != record.AIReasonResult {
		t.Fatalf("stored = %+v (ai %+v), want model %s", m, m.AI, want)
	}
}
