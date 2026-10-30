package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/auth"
	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/site"
)

func newTestServer() *httptest.Server {
	return newTestServerWith(nil)
}

func newTestServerWith(pages *site.Site) *httptest.Server {
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	login := &auth.Handler{IDs: ids}
	return httptest.NewServer(routes(hub.New(config.Config{Port: "0"}, ids, nil), ids, nil, nil, login, pages))
}

// 레포의 화면과 게임으로 운영과 같은 길을 확인합니다. 리다이렉트는 따라가지 않고 그대로 봅니다.
func TestSiteRoutes(t *testing.T) {
	pages, err := site.Open("../../..")
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWith(pages)
	defer srv.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	cases := []struct {
		path     string
		status   int
		location string
	}{
		{"/", http.StatusFound, "/web/"},
		{"/web", http.StatusMovedPermanently, "/web/"},
		{"/games/tictactoe?lang=en", http.StatusMovedPermanently, "/games/tictactoe/?lang=en"},
		{"/web/", http.StatusOK, ""},
		{"/web/match.html", http.StatusOK, ""},
		{"/sdk/playground/board.js", http.StatusOK, ""},
		{"/games/tictactoe/index.js", http.StatusOK, ""},
		{"/sdk/playground/serve.js", http.StatusNotFound, ""},
		{"/sdk/playground/", http.StatusNotFound, ""}, // 플레이그라운드는 사이트에 없습니다
		{"/sdk/playground/listing.js", http.StatusOK, ""},
		{"/sdk/playground/platform.js", http.StatusOK, ""},
		{"/server/go.mod", http.StatusNotFound, ""},
		{"/README.md", http.StatusNotFound, ""},
		{"/api/locale", http.StatusOK, ""},
	}
	for _, c := range cases {
		res, err := client.Get(srv.URL + c.path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != c.status || res.Header.Get("Location") != c.location {
			t.Errorf("%s: %d %q, want %d %q", c.path, res.StatusCode, res.Header.Get("Location"), c.status, c.location)
		}
	}

	res, err := client.Get(srv.URL + "/api/games")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var games []site.Game
	if err := json.NewDecoder(res.Body).Decode(&games); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, g := range games {
		found = found || (g.ID == "tictactoe" && g.Module == "/games/tictactoe/index.js" && g.Listing != nil)
	}
	if !found {
		t.Errorf("/api/games = %+v, want tictactoe with listing", games)
	}
}

// 화면 폴더가 없으면 API만 엽니다. /api/locale은 화면과 상관없이 있습니다.
func TestRoutesWithoutSite(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()
	for path, want := range map[string]int{"/": http.StatusNotFound, "/web/": http.StatusNotFound, "/api/games": http.StatusNotFound, "/api/locale": http.StatusOK} {
		res, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s: status = %d, want %d", path, res.StatusCode, want)
		}
	}
}

func TestHealthz(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
}

// 쿠키 없이 웹소켓에 오면 401, /api/me로 받은 쿠키가 있으면 그 다음 단계(아직 501)로 넘어갑니다.
func TestWSNeedsSession(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res, err := http.Get(srv.URL + "/ws")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no cookie: status = %d, want 401", res.StatusCode)
	}

	me, err := http.Get(srv.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	me.Body.Close()
	req, _ := http.NewRequest("GET", srv.URL+"/ws", nil)
	for _, c := range me.Cookies() {
		req.AddCookie(c)
	}
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		t.Fatal("with cookie: still 401")
	}
}
