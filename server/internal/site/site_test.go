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

// write는 root 아래에 파일을 만듭니다.
func write(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newMux(root string) *http.ServeMux {
	s := Site{Root: root}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.ServeRoot)
	mux.HandleFunc("GET /web/", s.ServeFile)
	mux.HandleFunc("GET /sdk/", s.ServeFile)
	mux.HandleFunc("GET /games/", s.ServeFile)
	mux.HandleFunc("GET /api/games", s.ServeGames)
	mux.HandleFunc("GET /api/locale", s.ServeLocale)
	return mux
}

func get(mux http.Handler, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
	return rec
}

func TestServeFile(t *testing.T) {
	root := t.TempDir()
	write(t, root, "web/index.html", "<h1>lobby</h1>")
	write(t, root, "web/lobby.js", "export {}")
	write(t, root, "web/.secret", "no")
	write(t, root, "sdk/playground/index.html", "playground")
	write(t, root, "games/tictactoe/index.js", "export default {}")
	write(t, root, "games/private/mine/index.js", "export default {}")
	write(t, root, "games/empty/readme.txt", "x")
	write(t, root, ".env", "SESSION_SECRET=x")
	write(t, root, "server/go.mod", "module x")
	mux := newMux(root)

	for target, want := range map[string]struct {
		code int
		body string
	}{
		"/web/":                        {200, "<h1>lobby</h1>"},
		"/web/index.html":              {200, "<h1>lobby</h1>"},
		"/web/lobby.js":                {200, "export {}"},
		"/sdk/playground/":             {200, "playground"},
		"/games/tictactoe/index.js":    {200, "export default {}"},
		"/games/private/mine/index.js": {200, "export default {}"},
		"/games/empty/":                {404, ""}, // 폴더 목록은 보여주지 않습니다
		"/web/.secret":                 {404, ""},
		"/web/nope.js":                 {404, ""},
	} {
		rec := get(mux, target)
		if rec.Code != want.code || (want.body != "" && rec.Body.String() != want.body) {
			t.Errorf("%s: %d %q, want %d %q", target, rec.Code, rec.Body.String(), want.code, want.body)
		}
	}

	// 폴더 밖으로 나가는 경로는 어떤 모양이든 내용을 보여주지 않습니다 (먹스가 경로를 정리해 다른 곳으로 보내거나 404)
	for _, target := range []string{"/web/../.env", "/web/%2e%2e/.env", "/web/..%2f..%2f.env", "/games/../server/go.mod", "/web/..%2fserver/go.mod"} {
		rec := get(mux, target)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "SESSION_SECRET") || strings.Contains(rec.Body.String(), "module x") {
			t.Errorf("%s leaked: %d %q", target, rec.Code, rec.Body)
		}
		if loc := rec.Header().Get("Location"); loc != "" {
			if rec := get(mux, loc); rec.Code == http.StatusOK {
				t.Errorf("%s → %s: %d", target, loc, rec.Code)
			}
		}
	}
	// 먹스를 거치지 않고 정리되지 않은 경로가 와도 마찬가지입니다
	for _, p := range []string{"/web/../.env", "/web/../../etc/passwd", "/games/../server/go.mod"} {
		r := httptest.NewRequest("GET", "/web/", nil)
		r.URL.Path = p
		rec := httptest.NewRecorder()
		Site{Root: root}.ServeFile(rec, r)
		if rec.Code != http.StatusNotFound {
			t.Errorf("direct %s: %d %q", p, rec.Code, rec.Body)
		}
	}

	rec := get(mux, "/web/lobby.js")
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Errorf("js content type = %q", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-cache" {
		t.Errorf("cache-control = %q", rec.Header().Get("Cache-Control"))
	}
	if rec := get(mux, "/"); rec.Code != http.StatusFound || rec.Header().Get("Location") != "/web/" {
		t.Errorf("/: %d → %q", rec.Code, rec.Header().Get("Location"))
	}
}

// ServeFile을 다른 경로에 잘못 붙여도 세 폴더 밖은 보이지 않습니다.
func TestServeFileOnlyServedDirs(t *testing.T) {
	root := t.TempDir()
	write(t, root, "server/go.mod", "module x")
	s := Site{Root: root}
	rec := httptest.NewRecorder()
	s.ServeFile(rec, httptest.NewRequest("GET", "/server/go.mod", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("server/go.mod: %d", rec.Code)
	}
}

func TestGames(t *testing.T) {
	root := t.TempDir()
	write(t, root, "games/b-game/index.js", "b")
	write(t, root, "games/b-game/listing.json", `{"name":{"ko":"비"}}`)
	write(t, root, "games/a-game/index.js", "a")
	write(t, root, "games/broken/index.js", "x")
	write(t, root, "games/broken/listing.json", `{"name":`)
	write(t, root, "games/no-code/listing.json", `{}`)
	write(t, root, "games/Bad_Name/index.js", "x")
	write(t, root, "games/private/secret/index.js", "s")

	rec := get(newMux(root), "/api/games")
	var list []struct {
		ID           string          `json:"id"`
		Module       string          `json:"module"`
		Version      string          `json:"version"`
		Private      bool            `json:"private"`
		Listing      json.RawMessage `json:"listing"`
		ListingError string          `json:"listingError"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("%v: %s", err, rec.Body)
	}
	var ids []string
	for _, g := range list {
		ids = append(ids, g.ID)
	}
	if strings.Join(ids, ",") != "a-game,b-game,broken,secret" {
		t.Fatalf("ids = %v", ids)
	}
	if list[0].Module != "/games/a-game/index.js" || string(list[0].Listing) != "null" || len(list[0].Version) != 16 {
		t.Errorf("a-game = %+v", list[0])
	}
	if !strings.Contains(string(list[1].Listing), `"비"`) {
		t.Errorf("b-game listing = %s", list[1].Listing)
	}
	if string(list[2].Listing) != "null" || list[2].ListingError == "" {
		t.Errorf("broken = %+v", list[2])
	}
	if !list[3].Private || list[3].Module != "/games/private/secret/index.js" {
		t.Errorf("secret = %+v", list[3])
	}
}

// 개발 서버(sdk/playground/serve.js)의 codeVersion()이 같은 폴더에 낸 값과 같아야 합니다.
// 값은 node로 한 번 계산해 적어 둔 것입니다. 다르면 같은 게임인데 개발 서버와 운영 서버가 서로 매칭되지 않습니다.
func TestCodeVersionMatchesDevServer(t *testing.T) {
	root := t.TempDir()
	write(t, root, "index.js", "export default {};\n")
	write(t, root, "lib/rules.mjs", "export const n = 1;\n")
	write(t, root, "lib/b.js", "// b\n")
	write(t, root, "index.test.js", "test")          // 테스트는 빼고
	write(t, root, "node_modules/x/index.js", "dep") // 의존성도 빼고
	write(t, root, "listing.json", `{"name":"x"}`)   // 등록 정보도 빼고
	write(t, root, "README.md", "# x")
	if got, want := CodeVersion(root), "cd6d5b5752ca2c0d"; got != want {
		t.Errorf("CodeVersion = %s, want %s (node의 codeVersion)", got, want)
	}

}

func TestDetectLocale(t *testing.T) {
	for _, tc := range []struct {
		region, accept string
		country, lang  string
	}{
		{"KR", "", "KR", "ko"},
		{"kr", "en-US", "KR", "ko"},
		{"US", "ko-KR", "US", "en"},
		{"", "ko-KR,ko;q=0.9", "", "ko"},
		{"", "KO", "", "ko"},
		{"", "kok", "", "en"}, // 다른 언어 (콘칸어)
		{"", "en-US", "", "en"},
		{"XYZ", "ko", "", "ko"}, // 나라 코드 모양이 아니면 무시
		{"", "", "", "en"},
	} {
		r := httptest.NewRequest("GET", "/api/locale", nil)
		if tc.region != "" {
			r.Header.Set("X-Client-Region", tc.region)
		}
		if tc.accept != "" {
			r.Header.Set("Accept-Language", tc.accept)
		}
		got := DetectLocale(r)
		country := ""
		if got.Country != nil {
			country = *got.Country
		}
		if country != tc.country || got.Lang != tc.lang {
			t.Errorf("%q/%q = %s/%s, want %s/%s", tc.region, tc.accept, country, got.Lang, tc.country, tc.lang)
		}
	}
	rec := get(newMux(t.TempDir()), "/api/locale")
	if rec.Body.String() != "{\"country\":null,\"lang\":\"en\"}\n" {
		t.Errorf("body = %q", rec.Body)
	}
}
