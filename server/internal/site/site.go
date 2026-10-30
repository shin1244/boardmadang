// Package site는 사이트의 화면과 게임 코드를 보여줍니다. 운영에서 Go 서버 하나가 boardmadang.com 전체를 맡게 하려는 것입니다.
//
//	GET /                 /web/ 로 보냅니다
//	GET /web/…, /sdk/…, /games/…   SITE_DIR(레포 루트) 아래의 파일
//	GET /api/games        게임 목록 (games/<id>/, games/private/<id>/)
//	GET /api/locale       접속한 나라로 고른 화면 언어
//
// 개발 서버(sdk/playground/serve.js)와 같은 모양으로 답합니다. 등록 정보 저장(PUT /api/games/<id>/listing)은
// 아직 개발 서버에만 있습니다 (계정과 게임 주인을 확인하는 업로드를 붙일 때 옮깁니다).
package site

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

func init() {
	// 시스템의 mime 표가 없거나 다른 값을 줘도 ES 모듈로 읽히게 합니다.
	mime.AddExtensionType(".js", "text/javascript; charset=utf-8")
	mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
}

// 보여주는 폴더. 이 밖의 파일(server/, docs/, .env 같은 것)은 보이지 않습니다.
var servedDirs = []string{"web", "sdk", "games"}

var gameIDPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// Site는 Root(레포 루트)의 파일로 답합니다.
type Site struct {
	Root string
}

// ServeRoot는 GET / 입니다. 로비로 보냅니다.
func (s Site) ServeRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "/web/", http.StatusFound)
}

// ServeFile은 GET /web/…, /sdk/…, /games/… 입니다.
//   - 점(.)으로 시작하는 이름이 경로에 있으면 404 (.env, .git 같은 것)
//   - 폴더면 그 안의 index.html, 없으면 404 (폴더 목록은 보여주지 않습니다)
//   - 게임 코드를 고치면 바로 보이게 매번 확인하도록(no-cache) 합니다. 바뀌지 않았으면 304로 답합니다.
func (s Site) ServeFile(w http.ResponseWriter, r *http.Request) {
	clean := path.Clean("/" + r.URL.Path)
	parts := strings.Split(strings.TrimPrefix(clean, "/"), "/")
	if !slices.Contains(servedDirs, parts[0]) {
		http.NotFound(w, r)
		return
	}
	for _, p := range parts {
		if strings.HasPrefix(p, ".") {
			http.NotFound(w, r)
			return
		}
	}
	file := filepath.Join(s.Root, filepath.FromSlash(clean))
	info, err := os.Stat(file)
	if err == nil && info.IsDir() {
		file = filepath.Join(file, "index.html")
		info, err = os.Stat(file)
	}
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// ServeContent는 Range와 If-Modified-Since를 처리합니다. 폴더 목록이나 index.html 이동은 하지 않습니다.
	http.ServeContent(w, r, info.Name(), info.ModTime(), f)
}

// Game은 /api/games의 항목 하나입니다.
type Game struct {
	ID           string          `json:"id"`
	Module       string          `json:"module"`
	Version      string          `json:"version"`
	Private      bool            `json:"private"`
	Listing      json.RawMessage `json:"listing"`                // 등록 정보. 등록 전이면 null
	ListingError string          `json:"listingError,omitempty"` // listing.json이 깨졌으면 그 이유
}

// Games는 games/<id>/index.js 와 games/private/<id>/index.js 를 찾아 목록으로 만듭니다.
func (s Site) Games() []Game {
	list := []Game{}
	for _, d := range []struct {
		dir     string
		private bool
	}{{"games", false}, {"games/private", true}} {
		base := filepath.Join(s.Root, filepath.FromSlash(d.dir))
		entries, err := os.ReadDir(base)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !gameIDPattern.MatchString(e.Name()) {
				continue
			}
			folder := filepath.Join(base, e.Name())
			if _, err := os.Stat(filepath.Join(folder, "index.js")); err != nil {
				continue
			}
			g := Game{
				ID:      e.Name(),
				Module:  "/" + d.dir + "/" + e.Name() + "/index.js",
				Version: CodeVersion(folder),
				Private: d.private,
				Listing: json.RawMessage("null"),
			}
			if data, err := os.ReadFile(filepath.Join(folder, "listing.json")); err == nil {
				if json.Valid(data) {
					g.Listing = data
				} else {
					g.ListingError = "listing.json is not valid JSON"
				}
			}
			list = append(list, g)
		}
	}
	return list
}

// CodeVersion은 게임 코드의 버전입니다: 폴더 안 .js, .mjs 파일(테스트와 node_modules 제외)의
// 상대 경로와 내용을 이은 SHA-256 앞 16글자. 개발 서버의 codeVersion()과 같아야 합니다 (같은 버전끼리만 매칭하므로).
func CodeVersion(folder string) string {
	var files []string
	filepath.WalkDir(folder, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" && p != folder {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if (strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".mjs")) &&
			!strings.HasSuffix(name, ".test.js") && !strings.HasSuffix(name, ".test.mjs") {
			rel, _ := filepath.Rel(folder, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	// 개발 서버는 전체 경로를 문자열로 정렬합니다. 같은 폴더 아래라 상대 경로의 정렬과 같습니다.
	slices.Sort(files)
	h := sha256.New()
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(folder, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		h.Write([]byte(rel))
		h.Write([]byte{0})
		h.Write(data)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

// ServeGames는 GET /api/games 입니다. 매번 폴더를 읽으므로 게임을 넣거나 고치면 바로 보입니다.
func (s Site) ServeGames(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Games())
}

// Locale은 /api/locale의 답입니다. Country는 모르면 null입니다.
type Locale struct {
	Country *string `json:"country"`
	Lang    string  `json:"lang"`
}

var countryPattern = regexp.MustCompile(`^[A-Z]{2}$`)
var koPattern = regexp.MustCompile(`(?i)^ko\b`)

// DetectLocale은 접속한 나라로 화면 언어를 고릅니다. 한국이면 ko, 그 밖의 나라는 en.
// 운영에서는 GCP 부하 분산기가 커스텀 요청 헤더 `X-Client-Region: {client_region}`로 나라 코드를 넣어 줍니다.
// 나라를 모르면 브라우저의 Accept-Language를 봅니다.
func DetectLocale(r *http.Request) Locale {
	raw := strings.ToUpper(r.Header.Get("X-Client-Region"))
	if countryPattern.MatchString(raw) {
		lang := "en"
		if raw == "KR" {
			lang = "ko"
		}
		return Locale{Country: &raw, Lang: lang}
	}
	if koPattern.MatchString(r.Header.Get("Accept-Language")) {
		return Locale{Lang: "ko"}
	}
	return Locale{Lang: "en"}
}

// ServeLocale은 GET /api/locale 입니다.
func (s Site) ServeLocale(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, DetectLocale(r))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
