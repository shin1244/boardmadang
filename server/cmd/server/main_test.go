package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/config"
	"github.com/shin1244/boardmadang/server/internal/hub"
)

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(routes(hub.New(config.Config{Port: "0"})))
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
