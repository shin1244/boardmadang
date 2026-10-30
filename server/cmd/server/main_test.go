package main

import (
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
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	login := &auth.Handler{IDs: ids}
	return httptest.NewServer(routes(hub.New(config.Config{Port: "0"}, ids, nil), ids, nil, nil, login, site.Site{Root: "../../.."}))
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

// 서버 하나가 화면, 게임 코드, 게임 목록까지 답합니다 (레포의 web/, games/를 씁니다).
func TestServesSite(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for path, want := range map[string]int{
		"/web/":                     http.StatusOK,
		"/web/match.js":             http.StatusOK,
		"/games/tictactoe/index.js": http.StatusOK,
		"/sdk/playground/board.js":  http.StatusOK,
		"/api/games":                http.StatusOK,
		"/api/locale":               http.StatusOK,
		"/":                         http.StatusFound,
		"/server/go.mod":            http.StatusNotFound,
		"/.env.example":             http.StatusNotFound,
		"/api/me":                   http.StatusOK, // API는 그대로
	} {
		res, err := noRedirect.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Errorf("%s: %d, want %d", path, res.StatusCode, want)
		}
	}
}
