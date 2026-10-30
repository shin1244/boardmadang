package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/auth"
	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
	"github.com/shin1244/boardmadang/server/internal/identity"
)

func newTestServer() *httptest.Server {
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	login := &auth.Handler{IDs: ids}
	return httptest.NewServer(routes(hub.New(config.Config{Port: "0"}, ids, nil), ids, nil, nil, login))
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
