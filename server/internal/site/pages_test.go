package site

import (
	"encoding/json"
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// pagesMux는 운영과 같은 길(cmd/server/main.go)로 페이지를 엽니다.
func pagesMux(s *Site) *http.ServeMux {
	mux := http.NewServeMux()
	for _, lang := range []string{"ko", "en"} {
		mux.HandleFunc("GET /"+lang+"/games/{game}", s.ServeGamePage)
		mux.HandleFunc("GET /"+lang+"/make", s.ServeGuide)
		mux.HandleFunc("GET /"+lang+"/ai", s.ServeGuide)
	}
	mux.HandleFunc("GET /sitemap.xml", s.ServeSitemap)
	mux.HandleFunc("GET /robots.txt", s.ServeRobots)
	return mux
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	req.Host = "boardmadang.com"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func pagesSite(t *testing.T) *Site {
	t.Helper()
	s := openSite(t, map[string]string{
		"web/index.html":       "",
		"games/chess/index.js": "x",
		"games/chess/listing.json": `{
			"name": {"ko": "체스 <b>", "en": "Chess"},
			"description": {"ko": "두 사람이 두는 게임", "en": "A two-player game"},
			"rulebook": {"ko": "첫 문단\n\n둘째 <script>alert(1)</script> 문단"},
			"languages": {"ko": "full", "en": "full", "ja": "partial"},
			"difficulty": "hard",
			"timer": {"minutes": 10, "custom": true}
		}`,
		"games/chess/thumbnail.json":        `{"board": {"rows": 8, "cols": 8}, "pieces": {}, "view": {}, "player": 0}`,
		"games/go/index.js":                 "x",
		"games/go/listing.json":             `{"name": {"en": "Go"}}`,
		"games/go/thumbnail.json":           `{"board": {"rows": 9, "cols": 9, "places": "points"}}`,
		"games/draft/index.js":              "x", // 등록 전: 페이지 없음
		"games/noname/index.js":             "x",
		"games/noname/listing.json":         `{"description": {"ko": "이름 없음"}}`,
		"games/private/secret/index.js":     "x",
		"games/private/secret/listing.json": `{"name": {"ko": "비밀"}}`,
	})
	s.Models = models{"chess": {Model: "/ai/chess/x.onnx", Balance: &AIBalance{Games: 1000, Wins: [2]int{600, 300}, Draws: 100}}}
	s.PublicURL = "https://boardmadang.com/"
	return s
}

func TestGamePage(t *testing.T) {
	mux := pagesMux(pagesSite(t))

	rec := get(t, mux, "/ko/games/chess")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("ko chess: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	body := rec.Body.String()
	for _, want := range []string{
		`<html lang="ko">`,
		`<title>체스 &lt;b&gt; 룰과 온라인 대전 · 보드마당</title>`,
		`<meta name="description" content="두 사람이 두는 게임 설치 없이 브라우저에서 바로 온라인 대전. AI와도 둘 수 있습니다.">`,
		`<link rel="canonical" href="https://boardmadang.com/ko/games/chess">`,
		`<link rel="alternate" hreflang="en" href="https://boardmadang.com/en/games/chess">`,
		`<link rel="alternate" hreflang="ko" href="https://boardmadang.com/ko/games/chess">`,
		`<link rel="alternate" hreflang="x-default" href="https://boardmadang.com/en/games/chess">`,
		`<h1 lang="ko">체스 &lt;b&gt;</h1>`,
		`<p>첫 문단</p>`,
		`<p>둘째 &lt;script&gt;alert(1)&lt;/script&gt; 문단</p>`, // 룰북은 글자로만
		`href="/web/?game=chess"`,
		`href="/web/ai.html?game=chess"`,
		`<b>8×8</b><span>칸</span>`,
		`<b>10분</b><span>방을 만들 때 바꿀 수 있음</span>`,
		`<b>상</b>`,
		`<b>KO · EN</b>`,
		`선공 승 60%, 무승부 10%, 후공 승 30%`,
		`1,000판`,
		`선공이 크게 유리합니다.`,
		`data-thumb="{&#34;board&#34;:`,
		`href="/ko/make"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("ko chess: missing %s", want)
		}
	}
	if strings.Contains(body, "<script>alert") || strings.Contains(body, "체스 <b>") {
		t.Error("ko chess: listing text not escaped")
	}

	// 영어 페이지는 영어 글. 룰북은 영어가 없으니 한국어 글을 lang="ko"로
	body = get(t, mux, "/en/games/chess").Body.String()
	for _, want := range []string{`<html lang="en">`, `<title>Chess: rules and online play · Boardmadang</title>`, `<h1 lang="en">Chess</h1>`, `<div class="rulebook-text" lang="ko">`, `<b>10 min</b>`} {
		if !strings.Contains(body, want) {
			t.Errorf("en chess: missing %s", want)
		}
	}

	// 다른 언어의 이름만 있는 게임, 교차점 판, 타이머 없음, AI 없음
	body = get(t, mux, "/ko/games/go").Body.String()
	for _, want := range []string{`<h1 lang="en">Go</h1>`, `<b>9×9</b><span>교차점</span>`, `<b>—</b><span>타이머 없음</span>`} {
		if !strings.Contains(body, want) {
			t.Errorf("ko go: missing %s", want)
		}
	}
	for _, unwanted := range []string{"ai.html", "rulebook-text", "balance-bar"} {
		if strings.Contains(body, unwanted) {
			t.Errorf("ko go: has %s", unwanted)
		}
	}

	for _, path := range []string{"/ko/games/draft", "/ko/games/noname", "/ko/games/missing", "/ko/games/Bad", "/ko/games/a.b", "/ja/games/chess", "/ko/games/"} {
		if rec := get(t, mux, path); rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rec.Code)
		}
	}
}

// 올린 게임도 레포 게임처럼 페이지가 있습니다. 썸네일이 없으면 guide.js가 게임 코드로 시작 판을 그리도록
// 코드 주소와 게임에 넘길 언어(완전 번역한 언어)를 적어 둡니다
func TestGamePageUploaded(t *testing.T) {
	s := openSite(t, map[string]string{"web/index.html": ""})
	s.Uploaded = uploaded{{ID: "up", Author: "maker", Module: "/uploads/up/v1/index.js",
		Listing: json.RawMessage(`{"name": {"en": "Up"}, "languages": {"ko": "full", "en": "partial"}}`)}}
	body := get(t, pagesMux(s), "/en/games/up").Body.String()
	for _, want := range []string{`<h1 lang="en">Up</h1>`, "maker", `<canvas data-module="/uploads/up/v1/index.js" data-lang="ko"`} {
		if !strings.Contains(body, want) {
			t.Errorf("uploaded game page: missing %s", want)
		}
	}
	if body := get(t, pagesMux(s), "/ko/games/up").Body.String(); !strings.Contains(body, `data-lang="ko"`) {
		t.Error("ko page: game lang is not ko")
	}
}

func TestGuides(t *testing.T) {
	mux := pagesMux(pagesSite(t))
	cases := []struct {
		path  string
		want  []string
		avoid []string
	}{
		{"/ko/make", []string{`<html lang="ko">`, "온라인 보드게임 만들기: 규칙만 쓰면 대전과 AI 상대까지", `href="/ko/games/chess"`, `href="/ko/games/go"`, `hreflang="en" href="https://boardmadang.com/en/make"`}, []string{"/ko/games/draft", "/ko/games/noname"}},
		{"/en/make", []string{`<html lang="en">`, "Make your own board game online, with rules enforced", `href="/en/games/chess"`}, nil},
		{"/ko/ai", []string{"내가 만든 보드게임을 AI와 두기", `href="/ko/games/chess"`}, []string{`href="/ko/games/go"`}}, // AI가 있는 게임만
		{"/en/ai", []string{"Play your own board game against an AI", `<link rel="canonical" href="https://boardmadang.com/en/ai">`}, nil},
	}
	for _, c := range cases {
		rec := get(t, mux, c.path)
		if rec.Code != 200 {
			t.Errorf("%s: status %d", c.path, rec.Code)
			continue
		}
		body := rec.Body.String()
		for _, w := range c.want {
			if !strings.Contains(body, w) {
				t.Errorf("%s: missing %s", c.path, w)
			}
		}
		for _, a := range c.avoid {
			if strings.Contains(body, a) {
				t.Errorf("%s: has %s", c.path, a)
			}
		}
	}
	// 게임이 하나도 없어도 페이지는 나옵니다
	empty := pagesMux(openSite(t, map[string]string{"web/index.html": ""}))
	for _, path := range []string{"/ko/make", "/en/ai"} {
		if rec := get(t, empty, path); rec.Code != 200 {
			t.Errorf("%s without games: status %d", path, rec.Code)
		}
	}
}

func TestSitemap(t *testing.T) {
	rec := get(t, pagesMux(pagesSite(t)), "/sitemap.xml")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/xml; charset=utf-8" {
		t.Fatalf("sitemap: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	var doc struct {
		URLs []struct {
			Loc   string `xml:"loc"`
			Links []struct {
				Hreflang string `xml:"hreflang,attr"`
				Href     string `xml:"href,attr"`
			} `xml:"link"`
		} `xml:"url"`
	}
	if err := xml.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("sitemap is not XML: %v\n%s", err, rec.Body)
	}
	var locs []string
	for _, u := range doc.URLs {
		locs = append(locs, u.Loc)
	}
	want := "https://boardmadang.com/web/ " +
		"https://boardmadang.com/en/make https://boardmadang.com/ko/make " +
		"https://boardmadang.com/en/ai https://boardmadang.com/ko/ai " +
		"https://boardmadang.com/en/games/chess https://boardmadang.com/ko/games/chess " +
		"https://boardmadang.com/en/games/go https://boardmadang.com/ko/games/go"
	if got := strings.Join(locs, " "); got != want {
		t.Errorf("sitemap locs:\n got %s\nwant %s", got, want)
	}
	// 언어별 주소는 모든 언어와 x-default를 서로 가리킵니다
	ko := doc.URLs[6]
	var links []string
	for _, l := range ko.Links {
		links = append(links, l.Hreflang+"="+l.Href)
	}
	if got := strings.Join(links, " "); got != "en=https://boardmadang.com/en/games/chess ko=https://boardmadang.com/ko/games/chess x-default=https://boardmadang.com/en/games/chess" {
		t.Errorf("ko chess alternates = %s", got)
	}
}

func TestRobots(t *testing.T) {
	rec := get(t, pagesMux(pagesSite(t)), "/robots.txt")
	body := rec.Body.String()
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("robots: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	for _, want := range []string{"User-agent: *", "Disallow: /auth/", "Disallow: /web/admin.html", "Sitemap: https://boardmadang.com/sitemap.xml"} {
		if !strings.Contains(body, want) {
			t.Errorf("robots: missing %q in %q", want, body)
		}
	}
	// 화면이 쓰는 스크립트와 API는 막지 않습니다 (구글이 로비를 그려 봐야 합니다)
	for _, path := range []string{"/web/", "/api/", "/games/", "/sdk/"} {
		if strings.Contains(body, "Disallow: "+path+"\n") {
			t.Errorf("robots blocks %s", path)
		}
	}
}

// PUBLIC_URL이 없으면 요청의 Host로 절대 주소를 만들고, 이상한 Host는 쓰지 않습니다
func TestPagesOrigin(t *testing.T) {
	s := pagesSite(t)
	s.PublicURL = ""
	mux := pagesMux(s)

	req := httptest.NewRequest("GET", "/robots.txt", nil)
	req.Host = "localhost:8080"
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), "Sitemap: http://localhost:8080/sitemap.xml") {
		t.Errorf("robots with Host: %q", rec.Body)
	}

	req = httptest.NewRequest("GET", "/ko/make", nil)
	req.Host = `evil"><script>`
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "evil") {
		t.Error("bad Host leaked into the page")
	}
}

func TestThousands(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1,000", 123456: "123,456", 1234567: "1,234,567"} {
		if got := thousands(n); got != want {
			t.Errorf("thousands(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestBalanceVerdict(t *testing.T) {
	cases := []struct {
		wins  [2]int
		draws int
		want  string
	}{
		{[2]int{50, 50}, 0, "선공과 후공이 거의 비슷합니다."},
		{[2]int{10, 10}, 80, "대부분 무승부로 끝납니다."},
		{[2]int{60, 40}, 0, "선공이 조금 유리합니다."},
		{[2]int{30, 70}, 0, "후공이 크게 유리합니다."},
	}
	for _, c := range cases {
		g := Game{AI: &AIModel{Balance: &AIBalance{Games: 100, Wins: c.wins, Draws: c.draws}}}
		if b := balanceOf(g, "ko"); b == nil || !strings.HasSuffix(b.Note, c.want) {
			t.Errorf("%v %d: %+v, want %q", c.wins, c.draws, b, c.want)
		}
	}
	if balanceOf(Game{AI: &AIModel{}}, "ko") != nil {
		t.Error("no balance: want nil")
	}
	old, now := "old", "new"
	g := Game{Version: now, AI: &AIModel{Version: &old, Balance: &AIBalance{Games: 10, Wins: [2]int{5, 5}}}}
	if b := balanceOf(g, "en"); !strings.HasSuffix(b.Note, "earlier version of the code.") {
		t.Errorf("old version note = %q", b.Note)
	}
}
