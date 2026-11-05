// Package site는 화면(web/), 게임 코드(games/), 화면과 실행기가 import하는 모듈(sdk/, trainer/의 몇 파일)을 내보내고,
// 게임 목록(/api/games)과 화면 언어(/api/locale)를 알려 줍니다.
//
// 개발 서버(sdk/playground/serve.js)가 하던 일을 운영에서는 Go 서버가 맡습니다. 두 곳의 응답 모양은 같아야 합니다.
// 특히 게임 코드 버전(codeVersion)은 매칭 키와 기보에 들어가므로 계산법이 serve.js와 한 글자도 달라선 안 됩니다.
//
// SITE_DIR(레포 루트) 아래에서 이것만 내보냅니다.
//
//	web/              화면. node_modules는 vendorFiles만 (브라우저 AI의 onnxruntime-web)
//	sdk/              화면과 실행기가 import하는 모듈만 (modules). 플레이그라운드 화면과 개발 서버는
//	                  게임 제작자가 자기 컴퓨터에서 쓰는 도구라 사이트에서는 내보내지 않습니다
//	trainer/          브라우저 AI가 실행기 안에서 쓰는 게임 어댑터와 탐색만 (modules)
//	games/            게임 코드. games/private/가 있으면 같이 (운영 이미지에는 넣지 않습니다)
//
// 테스트 파일(*.test.js)과 점으로 시작하는 파일, types에 없는 종류는 내보내지 않습니다.
// 회원이 올린 게임은 internal/upload가 DATA_DIR에서 내보내고, 목록만 Uploaded로 받아 /api/games에 붙입니다.
package site

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"
)

// types는 내보낼 파일의 종류입니다 (serve.js의 TYPES와 같음). 여기에 없는 확장자는 404입니다.
// 운영체제의 MIME 표를 쓰지 않습니다. 윈도우에서는 .js가 text/plain으로 나와 모듈을 못 불러올 수 있습니다.
var types = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",        // 링크 미리보기 그림(og.png)과 아이콘
	".wasm": "application/wasm", // 브라우저 AI의 onnxruntime-web (vendorFiles)
}

// roots는 내보내는 폴더입니다 (SITE_DIR 기준).
var roots = []string{"web/", "games/"}

// modules는 sdk/와 trainer/에서 내보내는 파일입니다. 화면(web/)과 실행기가 import하는 것만 둡니다.
// check.js는 등록창이 올린 게임을 실행기 안에서 검사할 때 씁니다 (web/runner/host.js의 check).
// trainer/의 두 파일은 브라우저 AI가 실행기 안에서 학습할 때와 같은 관측과 탐색을 쓰려고 불러옵니다 (web/runner/host.js의 ai).
var modules = []string{
	"sdk/check.js", "sdk/playground/board.js", "sdk/playground/listing.js", "sdk/playground/platform.js",
	"trainer/env.js", "trainer/mcts.js",
}

// vendorFiles는 web/ 아래 node_modules에서 내보내는 파일입니다 (web/vendor/package.json으로 받는 onnxruntime-web의 WebAssembly판).
// 브라우저 AI의 신경망을 사이트 쪽 Worker(web/ai-net.js)에서 돌립니다. 그 밖의 node_modules는 내보내지 않습니다.
var vendorFiles = []string{
	"web/vendor/node_modules/onnxruntime-web/dist/ort.wasm.min.mjs",
	"web/vendor/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs",
	"web/vendor/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
}

var gameIDPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

type Site struct {
	fsys fs.FS
	// Uploaded는 회원이 올린 게임입니다 (internal/upload). 있으면 /api/games에서 레포 게임 뒤에 붙입니다.
	Uploaded interface{ Games() []Game }
	// Played는 게임마다 둔 판 수입니다 (internal/record). 있으면 /api/games의 plays에 넣습니다.
	Played interface{ Plays(game string) int }
	// Models는 게임마다 AI 모델입니다 (internal/ai). 있으면 /api/games의 ai에 넣습니다.
	Models interface{ Model(game string) *AIModel }
	// Starred는 게임마다 별(즐겨찾기) 수입니다 (internal/star). 있으면 /api/games의 stars에 넣습니다.
	Starred interface{ Stars(game string) int }
}

// AIModel은 브라우저에서 AI와 둘 때 쓰는 학습한 신경망입니다 (internal/ai, trainer/train.py --export-onnx).
// 화면은 관측과 행동의 모양(Rows, Cols, ChannelNames, Specials)이 지금 게임 코드와 같을 때만 씁니다.
type AIModel struct {
	Model        string    `json:"model"`   // 신경망 파일 주소 /ai/<게임>/<해시>.onnx
	Version      *string   `json:"version"` // 학습한 게임 코드 버전. 지금 버전과 달라도 모양이 같으면 씁니다. 모르면 null
	Lang         string    `json:"lang"`    // 학습할 때 view()와 result()에 넘긴 언어. 관측을 같게 만들려고 그대로 씁니다
	Rows         int       `json:"rows"`
	Cols         int       `json:"cols"`
	ChannelNames []string  `json:"channelNames"`
	Specials     []string  `json:"specials"`
	NActions     int       `json:"nActions"`
	Sims         int       `json:"sims"` // 한 수마다 탐색 횟수
	Updated      time.Time `json:"updated"`
	// Balance는 학습 마지막 구간의 자기대국 결과입니다. 게임 창이 선공·후공 승률로 보여 줍니다. 이 기능 전에 내보낸 모델이면 없습니다
	Balance *AIBalance `json:"balance,omitempty"`
}

// AIBalance는 학습의 마지막 5분의 1(반복 수 기준)에서 AI끼리 둔 자기대국의 합계입니다 (trainer/train.py의 balance_from_log).
// 처음 몇 수를 뽑아 두는 학습용 대국이라 사람끼리 둘 때와 같지는 않지만, 한쪽이 크게 유리한 게임은 드러납니다.
type AIBalance struct {
	Games int    `json:"games"`
	Wins  [2]int `json:"wins"`  // 선공, 후공이 이긴 판
	Draws int    `json:"draws"` // Cut도 들어 있습니다
	Cut   int    `json:"cut"`   // 학습용 무승부 규칙(같은 판 반복, --max-moves)으로 끊은 판
	From  int    `json:"from"`  // 합친 반복의 처음과 끝
	To    int    `json:"to"`
}

// Open은 dir(레포 루트)을 엽니다. dir/web/index.html이 없으면 에러입니다.
func Open(dir string) (*Site, error) {
	fsys := os.DirFS(dir)
	if _, err := fs.Stat(fsys, "web/index.html"); err != nil {
		return nil, err
	}
	return &Site{fsys: fsys}, nil
}

// ServeHome은 첫 화면(로비)으로 보냅니다.
func ServeHome(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/web/", http.StatusFound)
}

// ServeFile은 web/, games/ 아래의 파일과 modules, vendorFiles를 내보냅니다.
// 폴더면 그 안의 index.html입니다. 폴더 목록은 보여주지 않습니다.
//
// 브라우저가 매번 바뀌었는지 묻게 합니다 (no-cache + Last-Modified).
// 옛 게임 코드가 캐시에 남으면 상대와 버전이 달라 매칭되지 않습니다.
func (s *Site) ServeFile(w http.ResponseWriter, r *http.Request) {
	name, wantDir := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if !public(name + "/") {
		http.NotFound(w, r)
		return
	}
	info, err := fs.Stat(s.fsys, name)
	if err == nil && info.IsDir() {
		if !wantDir {
			// 화면이 상대 경로(lobby.css)로 부르므로 폴더 주소는 /로 끝나야 합니다
			u := *r.URL
			u.Path += "/"
			http.Redirect(w, r, u.String(), http.StatusMovedPermanently)
			return
		}
		name = path.Join(name, "index.html")
		info, err = fs.Stat(s.fsys, name)
	} else if wantDir {
		err = fs.ErrNotExist
	}
	ctype, ok := types[path.Ext(name)]
	if err != nil || info.IsDir() || !ok {
		http.NotFound(w, r)
		return
	}
	data, err := fs.ReadFile(s.fsys, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(ctype, "text/javascript") || strings.HasPrefix(ctype, "application/json") {
		// 게임 실행기의 Worker는 출처가 없어서(opaque origin) 모듈을 CORS로만 불러올 수 있습니다.
		// 모두 공개된 코드라 누구에게나 열어도 됩니다.
		h.Set("Access-Control-Allow-Origin", "*")
	}
	if name == runnerFrame {
		h.Set("Content-Security-Policy", runnerCSP(r))
	}
	http.ServeContent(w, r, name, info.ModTime(), bytes.NewReader(data))
}

// runnerFrame은 게임 코드를 가두는 실행기 문서입니다 (web/engine.js, web/runner/).
const runnerFrame = "web/runner/frame.html"

var hostPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+(:[0-9]+)?$`)

// runnerCSP는 실행기 문서의 보안 정책입니다. 화면이 sandbox iframe으로 띄우지만, 이 주소를 직접 열어도 갇히도록 헤더로도 겁니다.
//   - sandbox allow-scripts: 출처가 없어서 사이트의 쿠키, 저장소, 부모 화면에 손댈 수 없습니다
//   - connect-src 'none': fetch, 웹소켓 같은 네트워크를 못 씁니다 (data: Worker도 이 정책을 물려받습니다)
//   - script-src: 이 사이트의 스크립트만 (게임 코드, SDK 모듈). 다른 곳의 코드나 eval은 막습니다
//   - worker-src: frame.js가 data: 주소로 Worker를 만들고, 그 Worker가 이 사이트의 worker.js를 불러옵니다
//     (Chromium은 Worker가 처음 불러오는 모듈도 worker-src로 봅니다)
//
// 'self'는 출처가 없는 문서에서 브라우저마다 다르게 풀릴 수 있어 이 사이트의 주소도 같이 적습니다.
func runnerCSP(r *http.Request) string {
	self := "'self'"
	if hostPattern.MatchString(r.Host) {
		scheme := "http"
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			scheme = "https"
		}
		self += " " + scheme + "://" + r.Host
	}
	return "sandbox allow-scripts; default-src 'none'; script-src " + self +
		"; worker-src data: " + self + "; connect-src 'none'; base-uri 'none'; form-action 'none'"
}

// public은 내보내도 되는 경로인지 봅니다. name은 앞의 /를 뗀 URL 경로입니다.
func public(name string) bool {
	if slices.Contains(modules, strings.TrimSuffix(name, "/")) || slices.Contains(vendorFiles, strings.TrimSuffix(name, "/")) {
		return true
	}
	if !slices.ContainsFunc(roots, func(root string) bool { return strings.HasPrefix(name, root) }) {
		return false
	}
	name = strings.TrimSuffix(name, "/")
	for _, part := range strings.Split(name, "/") {
		if part == "" || strings.HasPrefix(part, ".") || part == "node_modules" { // .., 숨김 파일, 빈 칸(//), 받아 둔 패키지
			return false
		}
	}
	return !isTest(path.Base(name))
}

func isTest(name string) bool {
	return strings.HasSuffix(name, ".test.js") || strings.HasSuffix(name, ".test.mjs")
}

// isCode는 게임 코드 버전에 들어가는 파일인지입니다.
func isCode(name string) bool {
	return (strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".mjs")) && !isTest(name)
}

// Game은 /api/games의 게임 하나입니다.
type Game struct {
	ID           string          `json:"id"`
	Module       string          `json:"module"`
	Version      string          `json:"version"`
	Private      bool            `json:"private"`
	Listing      json.RawMessage `json:"listing"`                // listing.json. 등록 전이거나 깨졌으면 null
	ListingError string          `json:"listingError,omitempty"` // listing.json이 깨졌으면 그 이유
	// thumbnail.json. 혼자 두던 판을 그대로 찍은 데이터(판 설정, 기물 세트, 화면)로, 이미지가 아닙니다.
	// 화면이 보드 렌더러로 다시 그립니다. 없거나 깨졌으면 null이고, 화면은 시작 판을 그립니다.
	// 모양 검사는 찍을 때와 업로드할 때 합니다 (sdk/check.js의 validateThumbnail).
	Thumbnail json.RawMessage `json:"thumbnail"`
	// 제작자 클리어 기보가 있는지 (올린 게임만, GET /api/games/<id>/clear). 레포 게임은 클리어 체크를 하지 않습니다
	Clear bool `json:"clear,omitempty"`
	// 제작자의 지금 계정 이름 (올린 게임의 /api/games에만). 로비 게임 창의 '제작자'에 씁니다. 레포 게임이나 이름을 모르면 없습니다
	Author string `json:"author,omitempty"`
	// 둔 판 수 (/api/games에만). 로비의 인기순에 씁니다. 0이거나 개발 서버면 없습니다
	Plays int `json:"plays,omitempty"`
	// 별(즐겨찾기)을 단 계정 수 (/api/games에만, internal/star). 0이거나 개발 서버면 없습니다
	Stars int `json:"stars,omitempty"`
	// 브라우저에서 AI와 둘 때 쓰는 학습한 신경망 (/api/games에만, internal/ai). 없으면 안 나옵니다
	AI *AIModel `json:"ai,omitempty"`
	// 처음 등록한 때 (올린 게임만). 로비의 출시일순에 씁니다. 레포 게임은 없어서 출시일순에서 맨 뒤로 갑니다
	Released time.Time `json:"released,omitzero"`
}

// Has는 레포에 그 id의 게임 폴더가 있는지입니다. 회원은 이 id로 게임을 올릴 수 없습니다.
func (s *Site) Has(id string) bool {
	if !gameIDPattern.MatchString(id) {
		return false
	}
	for _, dir := range []string{"games/", "games/private/"} {
		if info, err := fs.Stat(s.fsys, dir+id); err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

// Games는 games/<id>/index.js 와 games/private/<id>/index.js 를 찾아 목록으로 만듭니다.
// 부를 때마다 새로 읽습니다. 게임 코드는 작고, 매번 읽어야 코드를 고친 게 버전에 바로 반영됩니다.
func (s *Site) Games() ([]Game, error) {
	list := []Game{}
	for _, base := range []struct {
		dir     string
		private bool
	}{{"games", false}, {"games/private", true}} {
		entries, err := fs.ReadDir(s.fsys, base.dir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, d := range entries {
			if !d.IsDir() || !gameIDPattern.MatchString(d.Name()) {
				continue
			}
			folder := base.dir + "/" + d.Name()
			if _, err := fs.Stat(s.fsys, folder+"/index.js"); err != nil {
				continue
			}
			version, err := CodeVersion(s.fsys, folder)
			if err != nil {
				return nil, err
			}
			g := Game{ID: d.Name(), Module: "/" + folder + "/index.js", Version: version, Private: base.private}
			g.Listing, g.ListingError = readListing(s.fsys, folder)
			if data, err := fs.ReadFile(s.fsys, folder+"/thumbnail.json"); err == nil && json.Valid(data) {
				g.Thumbnail = data
			}
			list = append(list, g)
		}
	}
	return list, nil
}

// CodeVersion은 게임 코드의 버전입니다. 폴더 안 .js, .mjs 파일(테스트, node_modules, 점으로 시작하는 이름 제외)을
// /로 구분한 상대 경로 순으로 "경로\0내용\0"씩 이어 SHA-256을 구한 앞 16글자.
// 등록 정보와 썸네일은 판에 영향이 없어 넣지 않습니다. sdk/lib/games.js의 codeVersion과 같아야 합니다.
func CodeVersion(fsys fs.FS, folder string) (string, error) {
	var files []string
	err := fs.WalkDir(fsys, folder, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// 점으로 시작하는 이름은 내보내지 않으므로 버전에도 넣지 않습니다
		hidden := p != folder && strings.HasPrefix(d.Name(), ".")
		if d.IsDir() {
			if d.Name() == "node_modules" || hidden {
				return fs.SkipDir
			}
			return nil
		}
		if isCode(d.Name()) && !hidden {
			files = append(files, strings.TrimPrefix(p, folder+"/"))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	slices.Sort(files)
	hash := sha256.New()
	for _, f := range files {
		data, err := fs.ReadFile(fsys, folder+"/"+f)
		if err != nil {
			return "", err
		}
		hash.Write([]byte(f))
		hash.Write([]byte{0})
		hash.Write(data)
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))[:16], nil
}

// readListing은 listing.json을 읽습니다. 없으면 null (등록 전), 깨졌으면 null과 그 이유.
func readListing(fsys fs.FS, folder string) (json.RawMessage, string) {
	data, err := fs.ReadFile(fsys, folder+"/listing.json")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ""
	}
	if err != nil {
		return nil, err.Error()
	}
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, err.Error()
	}
	return data, ""
}

func (s *Site) ServeGames(w http.ResponseWriter, r *http.Request) {
	list, err := s.Games()
	if err != nil {
		log.Printf("게임 목록 실패: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
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
	writeJSON(w, http.StatusOK, list)
}

// Locale은 /api/locale의 응답입니다.
type Locale struct {
	Country *string `json:"country"` // 나라 코드 (KR). 모르면 null
	Lang    string  `json:"lang"`
}

var (
	countryPattern = regexp.MustCompile(`^[A-Z]{2}$`)
	koPattern      = regexp.MustCompile(`(?i)^ko\b`)
)

// ServeLocale은 접속한 나라로 화면 언어를 고릅니다. 한국이면 ko, 그 밖의 나라는 en.
// 나라는 앞에 선 프록시가 넣어 주는 헤더로 압니다. GCP 부하 분산기면 커스텀 요청 헤더
// X-Client-Region: {client_region}, Cloudflare면 CF-IPCountry입니다. 나라를 모르면 브라우저의 Accept-Language를 봅니다.
// 화면 언어 고르기에만 쓰므로 헤더를 위조해도 문제 없습니다.
func ServeLocale(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, localeOf(r))
}

func localeOf(r *http.Request) Locale {
	for _, h := range []string{"X-Client-Region", "CF-IPCountry"} {
		c := strings.ToUpper(r.Header.Get(h))
		// Cloudflare는 나라를 모르면 XX를 보냅니다
		if countryPattern.MatchString(c) && c != "XX" {
			lang := "en"
			if c == "KR" {
				lang = "ko"
			}
			return Locale{Country: &c, Lang: lang}
		}
	}
	if koPattern.MatchString(r.Header.Get("Accept-Language")) {
		return Locale{Lang: "ko"}
	}
	return Locale{Lang: "en"}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
