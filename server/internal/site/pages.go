package site

// 검색 엔진이 읽을 페이지: 게임 페이지, 소개 페이지, sitemap.xml, robots.txt.
//
// 로비(web/index.html)는 스크립트가 게임 목록을 채우는 화면이라 게임마다 주소와 제목이 따로 없고, 룰북도 HTML에 없습니다.
// 그래서 서버가 listing.json의 이름, 소개, 룰북을 HTML에 직접 넣은 페이지를 언어마다 따로 내줍니다.
//
//	/ko/games/<id>, /en/games/<id>   게임 페이지: 룰북, 판 정보, 선공·후공 승률, 두러 가기
//	/ko/make, /en/make               보드게임 만들기 소개
//	/ko/ai, /en/ai                   AI 상대 소개
//	/sitemap.xml, /robots.txt
//
// 모양은 약관 페이지처럼 lobby.css 위에 guide.css를 얹습니다. 로그인, 테마 버튼, 화면 언어 메뉴는 web/guide.js가 로비와 같은 코드로 붙이고,
// 화면 언어 메뉴에서 다른 언어를 고르면 그 언어의 같은 페이지로 갑니다.
// 개발 서버(sdk/playground/serve.js)에는 없습니다. 게임 제작자가 자기 컴퓨터에서 쓸 일이 없는 페이지입니다.

import (
	"bytes"
	"embed"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"html/template"
	"log"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

//go:embed pages/*.html
var pageFiles embed.FS

// pageLangs는 페이지를 내주는 언어입니다 (web/i18n.js의 화면 언어와 같음). 첫 번째 언어가 hreflang의 x-default입니다.
var pageLangs = []string{"en", "ko"}

// guides는 소개 페이지입니다. 본문은 pages/<이름>.<언어>.html에 있습니다.
var guides = []string{"make", "ai"}

// listingLangs는 listing.json의 언어 순서입니다 (sdk/playground/listing.js의 LANGS와 같음).
// 원하는 언어의 글이 없으면 이 순서로 있는 글을 씁니다.
var listingLangs = []string{"ko", "en", "ja", "zh", "es", "fr", "de", "pt", "ru", "ar"}

// pageTemplates는 페이지 이름(game, make.ko, …)마다 layout.html에 본문을 붙인 템플릿입니다.
var pageTemplates = loadPages()

func loadPages() map[string]*template.Template {
	base := template.Must(template.New("layout.html").ParseFS(pageFiles, "pages/layout.html"))
	names := []string{"game"}
	for _, g := range guides {
		for _, l := range pageLangs {
			names = append(names, g+"."+l)
		}
	}
	out := make(map[string]*template.Template, len(names))
	for _, name := range names {
		t := template.Must(base.Clone())
		out[name] = template.Must(t.ParseFS(pageFiles, "pages/"+name+".html"))
	}
	return out
}

// pageText는 페이지의 짧은 글자입니다. 상단 메뉴와 바닥글은 web/i18n.js와 같은 글자를 씁니다
// (스크립트가 돈 뒤에도 바뀌지 않게).
var pageText = map[string]map[string]string{
	"ko": {
		"site": "보드마당", "menu": "메뉴", "games": "게임", "rooms": "방 목록", "ranking": "랭킹", "soon": "준비 중",
		"register": "게임 등록", "login": "로그인", "logout": "로그아웃", "langLabel": "화면 언어: 한국어", "langCode": "KO",
		"footer": "사이트 정보", "legal": "약관과 개인정보", "source": "소스 코드", "discord": "디스코드", "contact": "문의",
		"crumbs": "위치",

		"play": "지금 두기", "playAI": "AI와 두기", "rulebook": "룰북", "info": "게임 정보",
		"cells": "칸", "points": "교차점", "board": "판",
		"timerEach": "각자", "timerCustom": "방을 만들 때 바꿀 수 있음", "timerNone": "타이머 없음", "minutes": "%d분",
		"difficulty": "난이도", "easy": "하", "normal": "중", "hard": "상", "langs": "지원 언어",
		"balance": "선공·후공 승률", "first": "선공 승", "draw": "무승부", "second": "후공 승",
		"balanceLabel": "선공 승 %d%%, 무승부 %d%%, 후공 승 %d%%",
		"balanceNote":  "AI가 학습 마지막 구간에 자기끼리 둔 %s판의 결과입니다.",
		"even":         "선공과 후공이 거의 비슷합니다.", "drawish": "대부분 무승부로 끝납니다.",
		"slight.first": "선공이 조금 유리합니다.", "slight.second": "후공이 조금 유리합니다.",
		"strong.first": "선공이 크게 유리합니다.", "strong.second": "후공이 크게 유리합니다.",
		"oldVersion": "지금과 다른 버전의 코드로 학습할 때 잰 것입니다.",
		"author":     "제작자", "thumb": "%s 판 그림",
		"gameTitle": "%s 룰과 온라인 대전", "gameDesc": "설치 없이 브라우저에서 바로 온라인 대전.", "gameDescAI": "AI와도 둘 수 있습니다.",
		"madeTitle": "이 게임도 누군가 직접 만들었습니다",
		"madeBody":  "보드마당에서는 직접 만든 보드게임의 규칙만 쓰면 판 그리기, 온라인 대전, AI 상대가 따라옵니다.",
		"madeLink":  "온라인 보드게임 만들기",
	},
	"en": {
		"site": "Boardmadang", "menu": "Menu", "games": "Games", "rooms": "Rooms", "ranking": "Ranking", "soon": "Coming soon",
		"register": "Register a game", "login": "Log in", "logout": "Log out", "langLabel": "Site language: English", "langCode": "EN",
		"footer": "Site info", "legal": "Terms & privacy", "source": "Source code", "discord": "Discord", "contact": "Contact",
		"crumbs": "Breadcrumb",

		"play": "Play now", "playAI": "Play the AI", "rulebook": "Rulebook", "info": "About the game",
		"cells": "Cells", "points": "Intersections", "board": "Board",
		"timerEach": "each", "timerCustom": "hosts can change it", "timerNone": "No timer", "minutes": "%d min",
		"difficulty": "Difficulty", "easy": "Easy", "normal": "Normal", "hard": "Hard", "langs": "Language",
		"balance": "First vs. second player", "first": "First wins", "draw": "Draws", "second": "Second wins",
		"balanceLabel": "First player wins %d%%, draws %d%%, second player wins %d%%",
		"balanceNote":  "From %s games the AI played against itself near the end of training.",
		"even":         "Both sides are about even.", "drawish": "Most games end in a draw.",
		"slight.first": "The first player has a slight edge.", "slight.second": "The second player has a slight edge.",
		"strong.first": "The first player has a big edge.", "strong.second": "The second player has a big edge.",
		"oldVersion": "Measured while training on an earlier version of the code.",
		"author":     "Creator", "thumb": "%s board",
		"gameTitle": "%s: rules and online play", "gameDesc": "Play online in your browser, no install.", "gameDescAI": "You can play the AI too.",
		"madeTitle": "Someone made this game themselves",
		"madeBody":  "On Boardmadang you write the rules of your own board game, and the board, online matches, and an AI opponent come with it.",
		"madeLink":  "Make your own board game online",
	},
}

// guideMeta는 소개 페이지의 제목과 설명입니다 (검색 결과와 링크 미리보기에 보이는 글).
var guideMeta = map[string]map[string]struct{ Title, Description string }{
	"make": {
		"ko": {
			"온라인 보드게임 만들기: 규칙만 쓰면 대전과 AI 상대까지",
			"직접 만든 보드게임을 온라인으로. 자바스크립트로 규칙만 쓰면 판 그리기, 온라인 대전, 기보, AI 상대는 보드마당이 맡습니다. 무료이고 설치가 필요 없습니다.",
		},
		"en": {
			"Make your own board game online, with rules enforced and an AI opponent",
			"Turn your own board game into an online game. Write the rules in JavaScript, and Boardmadang handles the board, online matches, replays, and an AI opponent. Free, nothing to install.",
		},
	},
	"ai": {
		"ko": {
			"내가 만든 보드게임을 AI와 두기: 플레이테스트와 선공 승률",
			"직접 만든 보드게임에 AI 상대를 붙입니다. AlphaZero 방식으로 학습한 AI와 혼자서도 플레이테스트하고, AI끼리 둔 판으로 선공과 후공 중 누가 유리한지 봅니다.",
		},
		"en": {
			"Play your own board game against an AI: playtesting and first-player balance",
			"Get an AI opponent for a board game you designed. Playtest alone against an AI trained AlphaZero-style, and see from its self-play games whether the first or second player has the edge.",
		},
	},
}

// pageData는 layout.html과 본문 템플릿이 받는 값입니다.
type pageData struct {
	Lang        string
	Title       string // <title>. 사이트 이름은 layout.html이 붙입니다
	Description string
	Canonical   string // 이 페이지의 절대 주소
	Origin      string // https://boardmadang.com
	Alternates  []alternate
	T           map[string]string
	Game        *gameView  // 게임 페이지만
	Games       []gameView // 소개 페이지의 게임 목록
}

type alternate struct{ Lang, URL string }

// gameView는 페이지에 보일 게임 하나입니다. 글자는 고른 언어로, 그 언어 글이 없으면 listingLangs 순서로 있는 글입니다.
type gameView struct {
	ID              string
	URL             string // 이 언어의 게임 페이지
	Name, NameLang  string
	Desc, DescLang  string
	Rulebook        []string // 문단 (로비처럼 빈 줄로 나눔)
	RulebookLang    string
	Board           string // "8×8". 썸네일이 없으면 판 크기를 몰라서 비어 있습니다
	Points          bool   // 교차점에 놓는 판
	Timer           string
	TimerNote       string
	Difficulty      string // easy, normal, hard. 모르면 비어 있음
	DifficultyLabel string
	Langs           string // 완전 번역 언어 "KO · EN"
	Author          string
	Thumb           string // thumbnail.json 그대로 (guide.js가 보드 렌더러로 그림)
	ThumbLabel      string
	Module          string // 썸네일이 없으면 guide.js가 이 코드를 실행기에 불러 시작 판을 그립니다 (로비와 같음)
	GameLang        string // 그때 게임에 넘길 언어 (sdk/playground/listing.js의 gameLang)
	PlayURL         string
	AIURL           string // AI 모델이 있을 때만
	Balance         *balanceView
	Private         bool // games/private/의 게임 (sitemap에서 뺌)
}

type balanceView struct {
	First, Draw, Second          int // 판 수 (막대의 길이)
	FirstPct, DrawPct, SecondPct int
	Label, Note                  string
}

type listingInfo struct {
	Languages  map[string]string `json:"languages"`
	Difficulty string            `json:"difficulty"`
	Timer      *struct {
		Minutes *int `json:"minutes"`
		Custom  bool `json:"custom"`
	} `json:"timer"`
	Name        map[string]string `json:"name"`
	Description map[string]string `json:"description"`
	Rulebook    map[string]string `json:"rulebook"`
}

// localize는 lang의 글을 고릅니다. 없으면 listingLangs 순서로 있는 글 (sdk/playground/listing.js의 localize와 같음).
func localize(m map[string]string, lang string) (string, string) {
	for _, l := range append([]string{lang}, listingLangs...) {
		if m[l] != "" {
			return m[l], l
		}
	}
	return "", ""
}

var paragraphBreak = regexp.MustCompile(`\n\s*\n`)

// view는 게임 하나를 lang 페이지에 보일 모양으로 바꿉니다. 등록 정보가 없거나 이름이 없으면 false
// (등록 전인 게임은 로비에도 나오지 않습니다).
func view(g Game, lang string) (gameView, bool) {
	var li listingInfo
	if g.Listing == nil || json.Unmarshal(g.Listing, &li) != nil {
		return gameView{}, false
	}
	T := pageText[lang]
	v := gameView{ID: g.ID, URL: "/" + lang + "/games/" + g.ID, Author: g.Author, PlayURL: "/web/?game=" + g.ID, Private: g.Private, Module: g.Module}
	v.Name, v.NameLang = localize(li.Name, lang)
	if v.Name == "" {
		return gameView{}, false
	}
	v.Desc, v.DescLang = localize(li.Description, lang)
	book, bookLang := localize(li.Rulebook, lang)
	v.RulebookLang = bookLang
	for _, p := range paragraphBreak.Split(book, -1) {
		if p = strings.TrimSpace(p); p != "" {
			v.Rulebook = append(v.Rulebook, p)
		}
	}

	// 판 크기는 게임 코드에 있어서 서버는 모릅니다. 썸네일에 판 설정이 들어 있으면 그것으로
	if g.Thumbnail != nil {
		var shot struct {
			Board struct {
				Places     string `json:"places"`
				Rows, Cols int
				Areas      []boardArea `json:"areas"`
			} `json:"board"`
		}
		if json.Unmarshal(g.Thumbnail, &shot) == nil && shot.Board.Rows > 0 && shot.Board.Cols > 0 {
			rows, cols := fieldSize(shot.Board.Rows, shot.Board.Cols, shot.Board.Areas)
			v.Board = fmt.Sprintf("%d×%d", rows, cols)
			v.Points = shot.Board.Places == "points"
			v.Thumb = string(g.Thumbnail)
		}
	}
	v.ThumbLabel = fmt.Sprintf(T["thumb"], v.Name)

	// 타이머: 없으면 타이머 없음 (sdk/playground/listing.js의 timerOf)
	switch {
	case li.Timer == nil || li.Timer.Minutes == nil:
		v.Timer = "—"
		v.TimerNote = T["timerNone"]
	default:
		v.Timer = fmt.Sprintf(T["minutes"], *li.Timer.Minutes)
		v.TimerNote = T["timerEach"]
	}
	if li.Timer != nil && li.Timer.Custom {
		v.TimerNote = T["timerCustom"]
	}
	if slices.Contains([]string{"easy", "normal", "hard"}, li.Difficulty) {
		v.Difficulty = li.Difficulty
		v.DifficultyLabel = T[li.Difficulty]
	}
	var full []string
	for _, l := range listingLangs {
		if li.Languages[l] == "full" {
			full = append(full, strings.ToUpper(l))
		}
	}
	v.Langs = strings.Join(full, " · ")
	// 게임에 넘길 언어: 페이지 언어를 완전 번역하면 그 언어, 아니면 첫 번째 완전 번역 언어
	v.GameLang = lang
	if len(full) > 0 && li.Languages[lang] != "full" {
		v.GameLang = strings.ToLower(full[0])
	}

	if g.AI != nil {
		v.AIURL = "/web/ai.html?game=" + g.ID
		v.Balance = balanceOf(g, lang)
	}
	return v, true
}

// boardArea는 썸네일 판 설정의 판 밖 영역 하나입니다 (sdk/game.d.ts의 Area)
type boardArea struct {
	Side                 string
	Row, Col, Rows, Cols int
}

// fieldSize는 판 밖 영역을 뺀 가운데 판의 크기입니다 (sdk/playground/board.js의 fieldOf).
// 썸네일은 올릴 때 영역이 맞는지 검사해서 맞는 영역만 남기므로 여기서는 다시 검사하지 않습니다.
func fieldSize(rows, cols int, areas []boardArea) (int, int) {
	top, bottom, left, right := 0, rows, 0, cols
	for _, a := range areas {
		switch a.Side {
		case "top":
			top = max(top, a.Row+a.Rows)
		case "bottom":
			bottom = min(bottom, a.Row)
		case "left":
			left = max(left, a.Col+a.Cols)
		case "right":
			right = min(right, a.Col)
		}
	}
	if top >= bottom || left >= right {
		return rows, cols
	}
	return bottom - top, right - left
}

// balanceOf는 선공·후공 승률입니다. 풀이는 로비의 게임 창(web/lobby.js의 fillBalance)과 같습니다.
func balanceOf(g Game, lang string) *balanceView {
	b := g.AI.Balance
	if b == nil || b.Games <= 0 {
		return nil
	}
	T := pageText[lang]
	pct := func(n int) int { return int(math.Round(float64(n) / float64(b.Games) * 100)) }
	v := &balanceView{First: b.Wins[0], Draw: b.Draws, Second: b.Wins[1], FirstPct: pct(b.Wins[0]), DrawPct: pct(b.Draws), SecondPct: pct(b.Wins[1])}
	v.Label = fmt.Sprintf(T["balanceLabel"], v.FirstPct, v.DrawPct, v.SecondPct)
	diff := float64(b.Wins[0]-b.Wins[1]) / float64(b.Games)
	side := "second"
	if diff > 0 {
		side = "first"
	}
	verdict := T["even"]
	switch {
	case b.Draws*2 > b.Games:
		verdict = T["drawish"]
	case math.Abs(diff) < 0.1:
	case math.Abs(diff) < 0.25:
		verdict = T["slight."+side]
	default:
		verdict = T["strong."+side]
	}
	note := []string{fmt.Sprintf(T["balanceNote"], thousands(b.Games)), verdict}
	if g.AI.Version != nil && g.Version != "" && *g.AI.Version != g.Version {
		note = append(note, T["oldVersion"])
	}
	v.Note = strings.Join(note, " ")
	return v
}

// thousands는 1234를 "1,234"로 씁니다 (한국어와 영어 모두 쉼표).
func thousands(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// list는 /api/games와 같은 게임 목록입니다 (레포 게임 뒤에 올린 게임, 판 수, AI 모델, 별).
func (s *Site) list() ([]Game, error) {
	list, err := s.Games()
	if err != nil {
		return nil, err
	}
	if s.Uploaded != nil {
		for _, g := range s.Uploaded.Games() {
			// 올린 뒤에 레포에 같은 id가 생기면 레포 게임만 보입니다
			if !slices.ContainsFunc(list, func(x Game) bool { return x.ID == g.ID }) {
				list = append(list, g)
			}
		}
	}
	for i := range list {
		if s.Played != nil {
			list[i].Plays = s.Played.Plays(list[i].ID)
		}
		if s.Models != nil {
			list[i].AI = s.Models.Model(list[i].ID)
		}
		if s.Starred != nil {
			list[i].Stars = s.Starred.Stars(list[i].ID)
		}
	}
	return list, nil
}

// views는 페이지가 있는 게임들입니다 (등록 정보가 있는 게임).
func (s *Site) views(lang string) ([]gameView, error) {
	list, err := s.list()
	if err != nil {
		return nil, err
	}
	var out []gameView
	for _, g := range list {
		if v, ok := view(g, lang); ok {
			out = append(out, v)
		}
	}
	return out, nil
}

// origin은 절대 주소의 앞부분입니다. PUBLIC_URL이 있으면 그것, 없으면 요청의 Host로 만듭니다 (runnerCSP와 같은 방식).
func (s *Site) origin(r *http.Request) string {
	if s.PublicURL != "" {
		return strings.TrimSuffix(s.PublicURL, "/")
	}
	if !hostPattern.MatchString(r.Host) {
		return ""
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// langOf는 주소의 첫 칸(/ko/…)에서 언어를 읽습니다.
func langOf(r *http.Request) (string, bool) {
	l, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	return l, slices.Contains(pageLangs, l)
}

func (s *Site) newPage(r *http.Request, lang, path string) pageData {
	origin := s.origin(r)
	d := pageData{Lang: lang, Origin: origin, Canonical: origin + "/" + lang + path, T: pageText[lang]}
	for _, l := range pageLangs {
		d.Alternates = append(d.Alternates, alternate{l, origin + "/" + l + path})
	}
	d.Alternates = append(d.Alternates, alternate{"x-default", origin + "/" + pageLangs[0] + path})
	return d
}

// ServeGamePage는 게임 페이지(/ko/games/<id>)입니다. 없는 게임이나 등록 전인 게임은 404입니다.
func (s *Site) ServeGamePage(w http.ResponseWriter, r *http.Request) {
	lang, ok := langOf(r)
	id := r.PathValue("game")
	if !ok || !gameIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	list, err := s.list()
	if err != nil {
		log.Printf("게임 페이지 실패: %v", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	i := slices.IndexFunc(list, func(g Game) bool { return g.ID == id })
	if i < 0 {
		http.NotFound(w, r)
		return
	}
	v, ok := view(list[i], lang)
	if !ok {
		http.NotFound(w, r)
		return
	}
	d := s.newPage(r, lang, "/games/"+id)
	d.Game = &v
	T := pageText[lang]
	d.Title = fmt.Sprintf(T["gameTitle"], v.Name)
	desc := []string{v.Desc, T["gameDesc"]}
	if v.AIURL != "" {
		desc = append(desc, T["gameDescAI"])
	}
	d.Description = strings.TrimSpace(strings.Join(desc, " "))
	s.render(w, "game", d)
}

// ServeGuide는 소개 페이지(/ko/make, /en/ai, …)입니다. 아래쪽에 페이지가 있는 게임 목록을 붙입니다.
func (s *Site) ServeGuide(w http.ResponseWriter, r *http.Request) {
	lang, ok := langOf(r)
	name := strings.TrimPrefix(r.URL.Path, "/"+lang+"/")
	meta, known := guideMeta[name][lang]
	if !ok || !known {
		http.NotFound(w, r)
		return
	}
	games, err := s.views(lang)
	if err != nil {
		log.Printf("소개 페이지 실패: %v", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if name == "ai" {
		// AI 소개에는 AI와 둘 수 있는 게임만
		games = slices.DeleteFunc(games, func(v gameView) bool { return v.AIURL == "" })
	}
	d := s.newPage(r, lang, "/"+name)
	d.Title, d.Description, d.Games = meta.Title, meta.Description, games
	s.render(w, name+"."+lang, d)
}

func (s *Site) render(w http.ResponseWriter, name string, d pageData) {
	var buf bytes.Buffer
	if err := pageTemplates[name].ExecuteTemplate(&buf, "layout.html", d); err != nil {
		log.Printf("페이지 %s 그리기 실패: %v", name, err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	w.Write(buf.Bytes())
}

// ServeSitemap은 검색 엔진에 알려 줄 주소 목록입니다: 로비, 소개 페이지, 게임 페이지. 언어별 주소를 서로 묶어 둡니다.
func (s *Site) ServeSitemap(w http.ResponseWriter, r *http.Request) {
	games, err := s.views(pageLangs[0])
	if err != nil {
		log.Printf("sitemap 실패: %v", err)
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	origin := s.origin(r)
	var b bytes.Buffer
	b.WriteString(xml.Header)
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">` + "\n")
	loc := func(u string) {
		b.WriteString("  <url><loc>")
		xml.EscapeText(&b, []byte(u))
		b.WriteString("</loc></url>\n")
	}
	// 언어마다 한 줄씩, 줄마다 모든 언어의 주소를 xhtml:link로 (구글의 hreflang 규칙. 페이지의 <link rel="alternate">와 같음)
	langs := func(path string) {
		alts := append(slices.Clone(pageLangs), "x-default")
		for _, l := range pageLangs {
			b.WriteString("  <url>\n    <loc>")
			xml.EscapeText(&b, []byte(origin+"/"+l+path))
			b.WriteString("</loc>\n")
			for _, alt := range alts {
				target := alt
				if alt == "x-default" {
					target = pageLangs[0]
				}
				fmt.Fprintf(&b, `    <xhtml:link rel="alternate" hreflang="%s" href="`, alt)
				xml.EscapeText(&b, []byte(origin+"/"+target+path))
				b.WriteString(`"/>` + "\n")
			}
			b.WriteString("  </url>\n")
		}
	}
	loc(origin + "/web/")
	for _, g := range guides {
		langs("/" + g)
	}
	for _, g := range games {
		// games/private/의 게임은 운영 서버에 없고, 있더라도 알릴 게임이 아닙니다
		if !g.Private {
			langs("/games/" + g.ID)
		}
	}
	b.WriteString("</urlset>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(b.Bytes())
}

// ServeRobots는 검색 엔진 로봇에게 주는 안내입니다. 화면이 쓰는 스크립트와 API는 막지 않습니다
// (구글이 로비를 그릴 때 /api/games 같은 것을 불러야 합니다). 로그인, 등록 중인 초안, 운영자 화면만 막고,
// 개인 화면(내 프로필 등)은 그 HTML의 noindex로 뺍니다.
func (s *Site) ServeRobots(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprintf(w, "User-agent: *\nDisallow: /auth/\nDisallow: /drafts/\nDisallow: /web/admin.html\n\nSitemap: %s/sitemap.xml\n", s.origin(r))
}
