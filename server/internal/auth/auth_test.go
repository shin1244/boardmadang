package auth

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// fakeGitHub는 code "good"을 토큰 "tok"으로 바꿔 주고, 그 토큰으로 사용자 42 "octo"를 돌려주는 가짜 GitHub입니다.
func fakeGitHub(t *testing.T) (*httptest.Server, *Provider) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("code") != "good" || r.Form.Get("client_secret") != "secret" {
			json.NewEncoder(w).Encode(map[string]string{"error": "bad_verification_code"})
			return
		}
		if !strings.HasSuffix(r.Form.Get("redirect_uri"), "/auth/github/callback") {
			t.Errorf("redirect_uri = %q", r.Form.Get("redirect_uri"))
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": "tok"})
	})
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"id": 42, "login": "octo"})
	})
	srv := httptest.NewServer(mux)
	p := GitHub("cid", "secret")
	p.AuthURL = srv.URL + "/authorize"
	p.TokenURL = srv.URL + "/token"
	p.ProfileURL = srv.URL + "/user"
	return srv, p
}

type site struct {
	*httptest.Server
	ids      *identity.Issuer
	accounts *account.Store
	records  *record.Store
	browser  *http.Client
}

func newSite(t *testing.T, p *Provider) *site {
	dir := t.TempDir()
	ids := identity.NewIssuer([]byte("test-secret-test-secret-test-secret"))
	accounts, _ := account.Open(dir)
	records, _ := record.Open(dir)
	ids.Members = accounts
	h := &Handler{Providers: []*Provider{p}, IDs: ids, Accounts: accounts, Records: records}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/me", ids.HandleMe)
	mux.HandleFunc("GET /api/auth/providers", h.ServeProviders)
	mux.HandleFunc("GET /auth/{provider}", h.ServeLogin)
	mux.HandleFunc("GET /auth/{provider}/callback", h.ServeCallback)
	mux.HandleFunc("POST /auth/logout", h.ServeLogout)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	browser := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &site{srv, ids, accounts, records, browser}
}

func (s *site) get(t *testing.T, path string) *http.Response {
	t.Helper()
	res, err := s.browser.Get(s.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func (s *site) me(t *testing.T) identity.User {
	t.Helper()
	res, err := s.browser.Get(s.URL + "/api/me")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var u identity.User
	json.NewDecoder(res.Body).Decode(&u)
	return u
}

// login은 로그인을 시작하고, 그곳이 돌려보낸 것처럼 callback을 부릅니다 (code와 state를 고를 수 있습니다).
func (s *site) login(t *testing.T, next, code string, state func(string) string) *http.Response {
	t.Helper()
	res := s.get(t, "/auth/github?next="+url.QueryEscape(next))
	if res.StatusCode != http.StatusFound {
		t.Fatalf("login start: status %d", res.StatusCode)
	}
	to, _ := url.Parse(res.Header.Get("Location"))
	q := to.Query()
	if q.Get("client_id") != "cid" || q.Get("redirect_uri") != s.URL+"/auth/github/callback" {
		t.Fatalf("bad authorize url: %s", to)
	}
	return s.get(t, "/auth/github/callback?code="+code+"&state="+url.QueryEscape(state(q.Get("state"))))
}

func same(s string) string { return s }

func TestLoginAdoptsGuest(t *testing.T) {
	gh, p := fakeGitHub(t)
	defer gh.Close()
	s := newSite(t, p)

	guest := s.me(t)
	if guest.Kind != identity.KindGuest {
		t.Fatalf("first visit = %+v", guest)
	}
	w := 0
	m := &record.Match{ID: record.NewID(), Game: "tictactoe", Winner: &w, Ended: time.Now(),
		Players: [2]record.Player{{ID: guest.ID, Kind: "guest", Tag: guest.Tag}, {ID: "g_other", Kind: "guest", Tag: "0000"}}}
	s.records.Save(m)
	s.records.Close()

	res := s.login(t, "/web/rooms.html?x=1", "good", same)
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/web/rooms.html?x=1" {
		t.Fatalf("callback: %d → %q", res.StatusCode, res.Header.Get("Location"))
	}
	member := s.me(t)
	if member.Kind != identity.KindMember || member.Name != "octo" || !strings.HasPrefix(member.ID, "m_") {
		t.Fatalf("after login = %+v", member)
	}
	list, _ := s.records.ListByUser(member.ID, 10)
	if len(list) != 1 || list[0].Players[0].Name != "octo" {
		t.Fatalf("guest match not adopted: %+v", list)
	}

	// 로그아웃하면 새 게스트, 다시 로그인하면 같은 계정
	req, _ := http.NewRequest("POST", s.URL+"/auth/logout", nil)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if res, err := s.browser.Do(req); err != nil || res.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: %v %v", res, err)
	}
	if u := s.me(t); u.Kind != identity.KindGuest || u.ID == guest.ID {
		t.Fatalf("after logout = %+v, want a new guest", u)
	}
	s.login(t, "/web/", "good", same)
	if u := s.me(t); u != member {
		t.Fatalf("second login = %+v, want %+v", u, member)
	}
}

func TestLoginFailures(t *testing.T) {
	gh, p := fakeGitHub(t)
	defer gh.Close()

	for name, tc := range map[string]struct {
		code  string
		state func(string) string
		want  string
	}{
		"wrong state":   {"good", func(string) string { return "forged" }, "state"},
		"empty state":   {"good", func(string) string { return "" }, "state"},
		"bad code":      {"bad", same, "provider"},
		"user canceled": {"good&error=access_denied", same, "cancelled"},
	} {
		s := newSite(t, p)
		s.me(t)
		res := s.login(t, "/web/history.html", tc.code, tc.state)
		if want := "/web/history.html?login_error=" + tc.want; res.Header.Get("Location") != want {
			t.Errorf("%s: → %q, want %q", name, res.Header.Get("Location"), want)
		}
		if u := s.me(t); u.Kind != identity.KindGuest {
			t.Errorf("%s: logged in as %+v", name, u)
		}
	}

	// 로그인을 시작하지 않은 브라우저 (state 쿠키 없음)
	s := newSite(t, p)
	res := s.get(t, "/auth/github/callback?code=good&state=x")
	if res.Header.Get("Location") != "/web/?login_error=expired" {
		t.Errorf("no cookie: → %q", res.Header.Get("Location"))
	}
	if res := s.get(t, "/auth/nowhere"); res.StatusCode != http.StatusNotFound {
		t.Errorf("unknown provider: %d", res.StatusCode)
	}
}

func TestLogoutRejectsOtherSites(t *testing.T) {
	_, p := fakeGitHub(t)
	s := newSite(t, p)
	req, _ := http.NewRequest("POST", s.URL+"/auth/logout", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	res, err := s.browser.Do(req)
	if err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site logout: %v %v", res, err)
	}
}

func TestProviders(t *testing.T) {
	s := newSite(t, GitHub("a", "b"))
	res, err := s.browser.Get(s.URL + "/api/auth/providers")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body struct{ Providers []string }
	json.NewDecoder(res.Body).Decode(&body)
	if strings.Join(body.Providers, ",") != "github" {
		t.Fatalf("providers = %v", body.Providers)
	}
}

func TestDevLogin(t *testing.T) {
	s := newSite(t, Dev())
	s.me(t)
	res := s.get(t, "/auth/dev?next=/web/rooms.html")
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/web/rooms.html" {
		t.Fatalf("dev login: %d → %q", res.StatusCode, res.Header.Get("Location"))
	}
	if u := s.me(t); u.Kind != identity.KindMember || u.Name != "dev" {
		t.Fatalf("after dev login = %+v", u)
	}
}

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"/web/rooms.html":                 "/web/rooms.html",
		"/web/?game=go&login_error=state": "/web/?game=go",
		"":                                "/web/",
		"https://evil.example/":           "/web/",
		"//evil.example/":                 "/web/",
		"/\\evil.example":                 "/web/",
		"javascript:alert(1)":             "/web/",
	} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}
