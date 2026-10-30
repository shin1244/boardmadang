package site

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTree는 dir 아래에 files(슬래시 경로 → 내용)를 씁니다.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func openSite(t *testing.T, files map[string]string) *Site {
	t.Helper()
	dir := t.TempDir()
	writeTree(t, dir, files)
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// 같은 폴더를 serve.js의 codeVersion으로 구한 값과 같아야 합니다.
// lib0.js와 lib/rules.mjs는 /로 정렬할 때와 \로 정렬할 때 순서가 바뀝니다.
func TestCodeVersionMatchesServeJS(t *testing.T) {
	s := openSite(t, map[string]string{
		"web/index.html":                        "",
		"games/fixture/index.js":                "export default {};\n",
		"games/fixture/lib.js":                  "export const a = 1;\n",
		"games/fixture/lib/rules.mjs":           "export const b = 2;\n",
		"games/fixture/lib0.js":                 "export const c = 3;\n",
		"games/fixture/index.test.js":           "excluded\n",
		"games/fixture/node_modules/x/index.js": "excluded\n",
		"games/fixture/listing.json":            "{}\n",
	})
	got, err := codeVersion(s.fsys, "games/fixture")
	if err != nil {
		t.Fatal(err)
	}
	if want := "27440701b9ad088b"; got != want {
		t.Errorf("version = %s, want %s (serve.js)", got, want)
	}
}

// 점으로 시작하는 파일과 폴더는 내보내지 않으므로 버전에도 넣지 않습니다 (sdk/lib/games.js와 같음).
func TestCodeVersionSkipsHidden(t *testing.T) {
	plain := openSite(t, map[string]string{"web/index.html": "", "games/x/index.js": "x"})
	hidden := openSite(t, map[string]string{
		"web/index.html":          "",
		"games/x/index.js":        "x",
		"games/x/.draft.js":       "draft",
		"games/x/.cache/index.js": "cache",
	})
	a, err := codeVersion(plain.fsys, "games/x")
	if err != nil {
		t.Fatal(err)
	}
	b, err := codeVersion(hidden.fsys, "games/x")
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Errorf("version with hidden files = %s, want %s", b, a)
	}
}

func TestGames(t *testing.T) {
	s := openSite(t, map[string]string{
		"web/index.html":             "",
		"games/b/index.js":           "b",
		"games/b/listing.json":       `{"name": {"ko": "비"}}`,
		"games/a/index.js":           "a",
		"games/a/listing.json":       "{broken",
		"games/a/thumbnail.json":     "{broken",
		"games/b/thumbnail.json":     `{"player": 0}`,
		"games/no-code/listing.json": "{}",
		"games/Bad/index.js":         "x",
		"games/README.md":            "",
		"games/private/p/index.js":   "p",
	})
	list, err := s.Games()
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, g := range list {
		got = append(got, g.ID)
	}
	if strings.Join(got, ",") != "a,b,p" {
		t.Fatalf("ids = %v, want [a b p]", got)
	}

	a, b, p := list[0], list[1], list[2]
	if a.Listing != nil || a.ListingError == "" {
		t.Errorf("broken listing: listing = %s, error = %q", a.Listing, a.ListingError)
	}
	if b.Module != "/games/b/index.js" || b.Private || len(b.Version) != 16 {
		t.Errorf("b = %+v", b)
	}
	if p.Module != "/games/private/p/index.js" || !p.Private {
		t.Errorf("p = %+v", p)
	}

	// 브라우저가 받는 모양: 등록 전이면 listing은 null, 오류가 없으면 listingError는 없음
	raw, _ := json.Marshal(list)
	var back []map[string]any
	json.Unmarshal(raw, &back)
	if v, ok := back[2]["listing"]; !ok || v != nil {
		t.Errorf("p listing = %v (present %v), want null", v, ok)
	}
	if _, ok := back[1]["listingError"]; ok {
		t.Error("b has listingError")
	}
	// 썸네일: 깨졌거나 없으면 null, 있으면 그대로
	if v, ok := back[0]["thumbnail"]; !ok || v != nil {
		t.Errorf("a thumbnail = %v (present %v), want null", v, ok)
	}
	if v, ok := back[2]["thumbnail"]; !ok || v != nil {
		t.Errorf("p thumbnail = %v (present %v), want null", v, ok)
	}
	if th, _ := back[1]["thumbnail"].(map[string]any); th["player"] != 0.0 {
		t.Errorf("b thumbnail = %v", back[1]["thumbnail"])
	}
	if name := back[1]["listing"].(map[string]any)["name"].(map[string]any)["ko"]; name != "비" {
		t.Errorf("b name = %v", name)
	}
}

func TestOpenNeedsWeb(t *testing.T) {
	if _, err := Open(t.TempDir()); err == nil {
		t.Fatal("Open without web/index.html: no error")
	}
}

func TestServeFile(t *testing.T) {
	s := openSite(t, map[string]string{
		"web/index.html":               "<h1>lobby</h1>",
		"web/lobby.js":                 "lobby",
		"web/lobby.css":                "css",
		"web/.secret.js":               "x",
		"web/notes.txt":                "x",
		"sdk/playground/index.html":    "playground",
		"sdk/playground/playground.js": "playground",
		"sdk/playground/board.js":      "board",
		"sdk/playground/serve.js":      "dev server",
		"sdk/playground/a.test.js":     "test",
		"sdk/README.md":                "x",
		"games/tictactoe/index.js":     "game",
		"games/tictactoe/sub/x.mjs":    "mjs",
		"games/tictactoe/listing.json": "{}",
		"server/go.mod":                "x",
		".env":                         "SECRET",
	})
	cases := []struct {
		path   string
		status int
		ctype  string
		body   string
	}{
		{"/web/", 200, "text/html; charset=utf-8", "<h1>lobby</h1>"},
		{"/web/lobby.js", 200, "text/javascript; charset=utf-8", "lobby"},
		{"/web/lobby.css", 200, "text/css; charset=utf-8", "css"},
		{"/sdk/playground/board.js", 200, "text/javascript; charset=utf-8", "board"},
		{"/games/tictactoe/index.js", 200, "text/javascript; charset=utf-8", "game"},
		{"/games/tictactoe/sub/x.mjs", 200, "text/javascript; charset=utf-8", "mjs"},
		{"/games/tictactoe/listing.json", 200, "application/json; charset=utf-8", "{}"},
		{"/games/tictactoe", 301, "", ""},  // 폴더는 /로 끝나는 주소로
		{"/games/tictactoe/", 404, "", ""}, // index.html이 없는 폴더는 목록을 보여주지 않습니다
		{"/web/lobby.js/", 404, "", ""},
		{"/web/missing.js", 404, "", ""},
		{"/web/.secret.js", 404, "", ""},
		{"/web/notes.txt", 404, "", ""},   // types에 없는 종류
		{"/sdk/playground/", 404, "", ""}, // 플레이그라운드 화면은 내보내지 않습니다
		{"/sdk/playground/playground.js", 404, "", ""},
		{"/sdk/playground/board.js/", 404, "", ""},
		{"/sdk/playground/serve.js", 404, "", ""},
		{"/sdk/playground/a.test.js", 404, "", ""},
		{"/sdk/README.md", 404, "", ""},
		{"/server/go.mod", 404, "", ""},
		{"/.env", 404, "", ""},
		{"/web/../.env", 404, "", ""},
		{"/web//lobby.js", 404, "", ""},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/", nil)
		req.URL.Path = c.path // 그대로 넣어 ..와 //가 손대지 않고 핸들러까지 오게 합니다
		rec := httptest.NewRecorder()
		s.ServeFile(rec, req)
		if rec.Code != c.status {
			t.Errorf("%s: status = %d, want %d", c.path, rec.Code, c.status)
			continue
		}
		if c.status != 200 {
			continue
		}
		if got := rec.Header().Get("Content-Type"); got != c.ctype {
			t.Errorf("%s: Content-Type = %q, want %q", c.path, got, c.ctype)
		}
		if got := rec.Body.String(); got != c.body {
			t.Errorf("%s: body = %q, want %q", c.path, got, c.body)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache", c.path, got)
		}
		if rec.Header().Get("Last-Modified") == "" {
			t.Errorf("%s: no Last-Modified", c.path)
		}
	}
}

// 폴더로 보낼 때 쿼리(?game=)를 지키지 않으면 플레이그라운드가 어떤 게임인지 잃습니다.
func TestServeFileRedirectKeepsQuery(t *testing.T) {
	s := openSite(t, map[string]string{"web/index.html": "", "games/x/index.js": ""})
	rec := httptest.NewRecorder()
	s.ServeFile(rec, httptest.NewRequest("GET", "/games/x?lang=en", nil))
	if got := rec.Header().Get("Location"); got != "/games/x/?lang=en" {
		t.Errorf("Location = %q, want /games/x/?lang=en", got)
	}
}

func TestLocale(t *testing.T) {
	cases := []struct {
		headers map[string]string
		country string // ""면 null
		lang    string
	}{
		{map[string]string{"X-Client-Region": "KR"}, "KR", "ko"},
		{map[string]string{"X-Client-Region": "us", "Accept-Language": "ko-KR"}, "US", "en"},
		{map[string]string{"CF-IPCountry": "KR"}, "KR", "ko"},
		{map[string]string{"X-Client-Region": "JP", "CF-IPCountry": "KR"}, "JP", "en"},
		{map[string]string{"CF-IPCountry": "XX", "Accept-Language": "ko-KR,ko;q=0.9"}, "", "ko"}, // Cloudflare가 모르는 나라
		{map[string]string{"CF-IPCountry": "T1", "Accept-Language": "en-US"}, "", "en"},          // Tor
		{map[string]string{"X-Client-Region": "Korea", "Accept-Language": "KO"}, "", "ko"},
		{map[string]string{"Accept-Language": "kok-IN"}, "", "en"}, // 콘칸어는 ko가 아님
		{map[string]string{}, "", "en"},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/api/locale", nil)
		for k, v := range c.headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		ServeLocale(rec, req)
		var got struct {
			Country *string `json:"country"`
			Lang    string  `json:"lang"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		country := ""
		if got.Country != nil {
			country = *got.Country
		}
		if country != c.country || got.Lang != c.lang {
			t.Errorf("%v: country = %q, lang = %q; want %q, %q", c.headers, country, got.Lang, c.country, c.lang)
		}
	}
}

func TestServeGamesJSON(t *testing.T) {
	s := openSite(t, map[string]string{"web/index.html": ""})
	rec := httptest.NewRecorder()
	s.ServeGames(rec, httptest.NewRequest("GET", "/api/games", nil))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Errorf("no games: %d %q, want 200 []", rec.Code, rec.Body.String())
	}
}
