// Package upload는 회원이 올린 게임을 받아 저장하고 내보냅니다 (docs/roadmap.md 1-1).
//
// 올리기는 두 단계입니다.
//  1. 초안: npx boardmadang pack이 만든 zip을 받아 파일 규칙을 검사하고 DATA_DIR/drafts/에 풉니다.
//     등록창은 /drafts/<초안>/index.js를 게임 실행기(web/engine.js)의 샌드박스에 불러와 자동 검사(sdk/check.js)를 돌립니다.
//  2. 등록: 등록 정보, 썸네일, 제작자 클리어 기보(clear.go)를 받아 검사하고 초안의 코드를 DATA_DIR/uploads/<게임>/<버전>/으로 옮깁니다.
//     그때부터 /api/games에 나오고 /uploads/<게임>/<버전>/에서 내보냅니다.
//
// DATA_DIR 아래 모양:
//
//	drafts/<초안>/draft.json     주인, 올린 때, 버전
//	drafts/<초안>/files/...      zip에서 푼 코드, listing.json, thumbnail.json
//	uploads/<게임>/game.json      주인, 지금 버전, 등록 정보, 썸네일, 클리어 기보, 등록한 때, 내렸는지
//	uploads/<게임>/<버전>/...      코드만. 옛 버전은 다시보기를 위해 지우지 않습니다
//
// 등록한 뒤에는 주인이 등록 정보만 고치거나 게임을 내릴 수 있습니다 (Edit). 내린 게임도 코드는 지우지 않습니다.
// 주인이 탈퇴하면 그 사람의 게임을 모두 내립니다 (Forget). 운영자도 게임을 내릴 수 있고, 그러면 주인이 다시 올릴 수 없습니다 (Block).
//
// 서버는 게임 코드를 돌리지 않습니다. 자동 검사는 올린 사람의 브라우저에서 돌기 때문에 서버는 그 결과를 믿지 않습니다.
// 남의 게임 코드가 보는 사람을 해칠 수 없는 건 실행기의 샌드박스 덕분이고, 서버는 파일 모양과 크기, 횟수만 지킵니다.
package upload

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/site"
)

// 제한값. 이유는 docs/abuse-and-limits.md에 있습니다.
const (
	MaxZip           = 300 << 10 // 올리는 zip
	MaxCode          = 256 << 10 // .js, .mjs를 합친 크기 (sdk/check.js의 GAME_LIMITS.codeBytes)
	MaxListingFile   = 1 << 20   // listing.json. 10개 언어로 룰북을 다 채워도 들어가게
	MaxThumbnailFile = 64 << 10  // thumbnail.json. 정리한 뒤에는 ThumbnailBytes
	MaxFiles         = 64
	MaxPath          = 200 // 파일 경로 글자 수
	MaxDepth         = 8   // 폴더 깊이

	MaxDrafts       = 3 // 계정마다 남겨 두는 초안. 넘으면 오래된 것부터 지웁니다
	DraftTTL        = 24 * time.Hour
	DraftsPerHour   = 30
	PublishesPerDay = 5  // 계정마다. 같은 zip을 다시 올려 등록해도 셉니다
	EditsPerHour    = 30 // 계정마다. 등록 정보만 고치기, 내리기, 다시 올리기 (Edit)
)

var (
	ErrNotFound = errors.New("not found")
	ErrBadID    = errors.New("bad id")
	ErrTaken    = errors.New("id taken") // 레포 게임이거나 다른 계정이 올린 게임
	ErrTooMany  = errors.New("too many")
	ErrNoChange = errors.New("nothing to change") // Edit에 바꿀 것이 없음
)

var (
	// IDPattern은 올릴 수 있는 게임 id입니다. 대전 서버(internal/hub)가 받는 모양과 같습니다.
	IDPattern      = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	draftPattern   = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
	versionPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
	// 경로의 한 칸. 주소에 그대로 쓸 수 있는 글자만, 점으로 시작하는 이름(.., 숨김 파일)은 안 됩니다.
	partPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*$`)
)

type Store struct {
	dir string
	now func() time.Time
	// Reserved는 레포에 있는 게임 id인지입니다 (site.Site.Has). 그 id로는 올릴 수 없습니다.
	Reserved func(id string) bool

	mu     sync.Mutex
	games  map[string]*gameMeta
	drafts map[string]*draftMeta
	recent map[string][]time.Time // 계정 → 최근 한 시간 안에 올린 초안 (메모리에만)
	edits  map[string][]time.Time // 계정 → 최근 한 시간 안에 고친 때 (메모리에만)
}

type draftMeta struct {
	ID      string    `json:"id"`
	Owner   string    `json:"owner"`
	Created time.Time `json:"created"`
	Version string    `json:"version"`
}

type gameMeta struct {
	ID        string          `json:"id"`
	Owner     string          `json:"owner"`
	Version   string          `json:"version"`
	Listing   Listing         `json:"listing"`
	Thumbnail json.RawMessage `json:"thumbnail"`       // 없으면 null
	Clear     *Clear          `json:"clear,omitempty"` // 제작자 클리어 기보. 클리어 체크 전에 올린 게임이면 없음
	Created   time.Time       `json:"created"`
	// 등록할 때마다 하나씩 (같은 버전을 다시 등록해도). 하루 횟수를 세고, 어느 버전이 언제 나왔는지 남깁니다.
	Published []published `json:"published"`
	// 주인이 내린 게임. 로비(/api/games)와 클리어 기보에서 빠집니다. 코드는 기보를 다시보려고 그대로 내보냅니다
	Hidden bool `json:"hidden,omitempty"`
	// 운영자가 내린 게임 (Block). Hidden처럼 로비에서 빠지고, 주인이 다시 올릴 수 없습니다. 운영자만 되살립니다
	Blocked bool `json:"blocked,omitempty"`
}

// listed는 로비(/api/games)와 클리어 기보에 나오는 게임인지입니다.
func (g *gameMeta) listed() bool { return !g.Hidden && !g.Blocked }

type published struct {
	Version string    `json:"version"`
	At      time.Time `json:"at"`
}

// Draft는 POST /api/drafts의 응답입니다.
type Draft struct {
	ID      string `json:"id"`
	Module  string `json:"module"` // 실행기가 불러올 주소
	Version string `json:"version"`
	Files   []File `json:"files"`
	// zip의 listing.json. 등록창이 처음 채울 값으로만 쓰고, 등록할 때 다시 받아 검사합니다. 없으면 null
	Listing json.RawMessage `json:"listing"`
	// 검사를 통과한 thumbnail.json. 없거나 틀리면 null이고, 틀렸으면 그 이유가 ThumbnailProblems에
	Thumbnail         json.RawMessage `json:"thumbnail"`
	ThumbnailProblems []string        `json:"thumbnailProblems,omitempty"`
}

type File struct {
	Path  string `json:"path"`
	Bytes int    `json:"bytes"`
}

// Open은 DATA_DIR 아래의 drafts/, uploads/를 엽니다. 기한이 지난 초안은 지웁니다.
func Open(dataDir string) (*Store, error) {
	s := &Store{
		dir:    dataDir,
		now:    time.Now,
		games:  map[string]*gameMeta{},
		drafts: map[string]*draftMeta{},
		recent: map[string][]time.Time{},
		edits:  map[string][]time.Time{},
	}
	for _, d := range []string{"drafts", "uploads"} {
		if err := os.MkdirAll(filepath.Join(dataDir, d), 0o755); err != nil {
			return nil, err
		}
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "uploads"))
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() || !IDPattern.MatchString(e.Name()) {
			continue
		}
		var g gameMeta
		err := readJSONFile(filepath.Join(dataDir, "uploads", e.Name(), "game.json"), &g)
		if errors.Is(err, fs.ErrNotExist) {
			continue // 처음 등록하다 멈춰서 코드 폴더만 남은 게임
		}
		if err != nil || g.ID != e.Name() || len(g.Published) == 0 {
			return nil, fmt.Errorf("uploads/%s/game.json이 깨졌습니다: %v", e.Name(), err)
		}
		s.games[g.ID] = &g
		// 등록하다 멈춘 임시 폴더
		tmp, _ := filepath.Glob(filepath.Join(dataDir, "uploads", e.Name(), ".tmp-*"))
		for _, t := range tmp {
			os.RemoveAll(t)
		}
	}
	entries, err = os.ReadDir(filepath.Join(dataDir, "drafts"))
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		var d draftMeta
		err := readJSONFile(filepath.Join(dataDir, "drafts", e.Name(), "draft.json"), &d)
		if err != nil || d.ID != e.Name() {
			os.RemoveAll(filepath.Join(dataDir, "drafts", e.Name())) // 쓰다 멈춘 초안
			continue
		}
		s.drafts[d.ID] = &d
	}
	s.sweep("")
	return s, nil
}

// ---- 초안 ----

// NewDraft는 zip을 검사해서 초안으로 풉니다. zip이 규칙에 맞지 않으면 Problems입니다.
func (s *Store) NewDraft(u identity.User, data []byte) (Draft, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if !s.hit(s.recent, u.ID, DraftsPerHour) { // 규칙에 맞지 않은 zip도 셉니다
		return Draft{}, ErrTooMany
	}
	files, problems := readZip(data)
	if len(problems) > 0 {
		return Draft{}, problems
	}

	d := &draftMeta{ID: randomID(), Owner: u.ID, Created: now}
	dir := s.draftDir(d.ID)
	if err := writeFiles(filepath.Join(dir, "files"), files); err != nil {
		os.RemoveAll(dir)
		return Draft{}, err
	}
	version, err := site.CodeVersion(os.DirFS(dir), "files")
	if err != nil {
		os.RemoveAll(dir)
		return Draft{}, err
	}
	d.Version = version
	if err := writeJSONFile(filepath.Join(dir, "draft.json"), d); err != nil {
		os.RemoveAll(dir)
		return Draft{}, err
	}
	s.drafts[d.ID] = d
	s.sweep(u.ID)

	out := Draft{ID: d.ID, Module: "/drafts/" + d.ID + "/index.js", Version: version, Files: []File{}}
	for name, body := range files {
		if isCode(name) {
			out.Files = append(out.Files, File{Path: name, Bytes: len(body)})
		}
	}
	slices.SortFunc(out.Files, func(a, b File) int { return strings.Compare(a.Path, b.Path) })
	if body, ok := files["listing.json"]; ok {
		out.Listing = body
	}
	if body, ok := files["thumbnail.json"]; ok {
		out.Thumbnail, out.ThumbnailProblems = CheckThumbnail(body)
	}
	return out, nil
}

// hit은 계정의 최근 한 시간 기록 m[owner]에 지금을 더합니다. 이미 limit번이면 더하지 않고 false입니다. s.mu를 잡고 부릅니다.
func (s *Store) hit(m map[string][]time.Time, owner string, limit int) bool {
	now := s.now()
	recent := slices.DeleteFunc(m[owner], func(t time.Time) bool { return now.Sub(t) >= time.Hour })
	m[owner] = recent
	if len(recent) >= limit {
		return false
	}
	m[owner] = append(recent, now)
	return true
}

// sweep은 기한이 지난 초안과, owner의 초안 가운데 MaxDrafts개를 넘는 오래된 것을 지웁니다. s.mu를 잡고 부릅니다.
func (s *Store) sweep(owner string) {
	now := s.now()
	var mine []*draftMeta
	for id, d := range s.drafts {
		if now.Sub(d.Created) >= DraftTTL {
			s.dropDraft(id)
		} else if d.Owner == owner {
			mine = append(mine, d)
		}
	}
	slices.SortFunc(mine, func(a, b *draftMeta) int { return b.Created.Compare(a.Created) })
	for _, d := range mine[min(len(mine), MaxDrafts):] {
		s.dropDraft(d.ID)
	}
}

// liveDraft는 기한이 지나지 않은 초안입니다. 없으면 nil. s.mu를 잡고 부릅니다.
func (s *Store) liveDraft(id string) *draftMeta {
	d := s.drafts[id]
	if d == nil || s.now().Sub(d.Created) >= DraftTTL {
		return nil
	}
	return d
}

func (s *Store) dropDraft(id string) {
	delete(s.drafts, id)
	os.RemoveAll(s.draftDir(id))
}

func (s *Store) draftDir(id string) string { return filepath.Join(s.dir, "drafts", id) }

// ---- 등록 ----

// PublishRequest는 POST /api/drafts/{draft}/publish의 본문입니다.
type PublishRequest struct {
	ID      string `json:"id"`
	Listing any    `json:"listing"` // JSON을 풀어 둔 등록 정보
	// 썸네일. 등록창이 zip의 thumbnail.json이나 직접 찍은 판을 게임 코드와 맞는지 본 뒤에 보냅니다. 없거나 null이면 썸네일 없이
	Thumbnail json.RawMessage `json:"thumbnail"`
	// 제작자 클리어 기보. 없거나 null이면 같은 버전을 다시 등록할 때만 됩니다 (등록 정보만 고칠 때 전에 깬 판을 그대로 씁니다)
	Clear json.RawMessage `json:"clear"`
}

// Publish는 초안을 id로 등록합니다. 처음이면 새 게임이고, 내가 올린 게임이면 새 버전입니다 (같은 버전이면 등록 정보만 바뀝니다).
// 내린 게임을 다시 등록하면 다시 로비에 나옵니다.
func (s *Store) Publish(u identity.User, draftID string, req PublishRequest) (site.Game, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.liveDraft(draftID)
	if d == nil || d.Owner != u.ID {
		return site.Game{}, ErrNotFound
	}
	id := req.ID
	if !IDPattern.MatchString(id) {
		return site.Game{}, ErrBadID
	}
	g := s.games[id]
	if (s.Reserved != nil && s.Reserved(id)) || (g != nil && g.Owner != u.ID) {
		return site.Game{}, ErrTaken
	}
	if s.publishedToday(u.ID) >= PublishesPerDay {
		return site.Game{}, ErrTooMany
	}
	clean, problems := CheckListing(req.Listing)
	var thumbnail json.RawMessage
	if !isNull(req.Thumbnail) {
		var bad []string
		if thumbnail, bad = CheckThumbnail(req.Thumbnail); len(bad) > 0 {
			problems = append(problems, Problem{Code: "thumbnail.invalid"})
		}
	}
	var clear *Clear
	switch {
	case !isNull(req.Clear):
		var p Problems
		clear, p = CheckClear(req.Clear, d.Version)
		problems = append(problems, p...)
	case g != nil && g.Clear != nil && g.Clear.Version == d.Version:
		clear = g.Clear
	default:
		problems = append(problems, Problem{Code: "clear.missing"})
	}
	if len(problems) > 0 {
		return site.Game{}, problems
	}

	if err := s.copyVersion(d, id); err != nil {
		return site.Game{}, err
	}
	now := s.now()
	if g == nil || clear != g.Clear {
		clear.At = now
	}
	next := gameMeta{ID: id, Owner: u.ID, Created: now}
	if g != nil {
		next = *g
		next.Published = slices.Clone(g.Published)
	}
	next.Version = d.Version
	next.Listing = clean
	next.Thumbnail = thumbnail
	next.Clear = clear
	next.Hidden = false
	next.Published = append(next.Published, published{Version: d.Version, At: now})
	if err := writeJSONFile(filepath.Join(s.dir, "uploads", id, "game.json"), &next); err != nil {
		return site.Game{}, err
	}
	s.games[id] = &next
	s.dropDraft(d.ID)
	return next.entry(), nil
}

// copyVersion은 초안의 코드 파일을 uploads/<id>/<버전>/으로 옮깁니다. 그 버전이 이미 있으면 그대로 둡니다 (버전이 곧 내용의 해시).
// 임시 폴더에 다 쓴 뒤 이름을 바꿔서, 도중에 멈춰도 반쯤 쓴 버전 폴더가 남지 않습니다.
func (s *Store) copyVersion(d *draftMeta, id string) error {
	base := filepath.Join(s.dir, "uploads", id)
	dst := filepath.Join(base, d.Version)
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if err := os.MkdirAll(base, 0o755); err != nil {
		return err
	}
	files := map[string][]byte{}
	src := filepath.Join(s.draftDir(d.ID), "files")
	err := filepath.WalkDir(src, func(p string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() || !isCode(e.Name()) {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)], err = os.ReadFile(p)
		return err
	})
	if err != nil {
		return err
	}
	tmp := filepath.Join(base, ".tmp-"+randomID())
	if err := writeFiles(tmp, files); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// publishedToday는 owner가 최근 24시간 안에 등록한 횟수입니다. s.mu를 잡고 부릅니다.
func (s *Store) publishedToday(owner string) int {
	n := 0
	now := s.now()
	for _, g := range s.games {
		if g.Owner != owner {
			continue
		}
		for _, p := range g.Published {
			if now.Sub(p.At) < 24*time.Hour {
				n++
			}
		}
	}
	return n
}

// ---- 목록 ----

// Games는 올린 게임을 /api/games 모양으로 돌려줍니다. 처음 등록한 순서입니다. 내린 게임과 레포에 같은 id가 생긴 게임은 뺍니다.
func (s *Store) Games() []site.Game {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := make([]*gameMeta, 0, len(s.games))
	for _, g := range s.games {
		if g.listed() && (s.Reserved == nil || !s.Reserved(g.ID)) {
			list = append(list, g)
		}
	}
	slices.SortFunc(list, func(a, b *gameMeta) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	out := make([]site.Game, len(list))
	for i, g := range list {
		out[i] = g.entry()
	}
	return out
}

func (g *gameMeta) entry() site.Game {
	listing, _ := json.Marshal(g.Listing)
	return site.Game{
		ID:        g.ID,
		Module:    "/uploads/" + g.ID + "/" + g.Version + "/index.js",
		Version:   g.Version,
		Listing:   listing,
		Thumbnail: g.Thumbnail,
		Clear:     g.cleared(),
		Released:  g.Created,
	}
}

// Mine은 GET /api/uploads의 응답입니다.
type Mine struct {
	Games []MyGame `json:"games"`
	Left  int      `json:"left"` // 오늘 더 등록할 수 있는 횟수
}

// MyGame은 내가 올린 게임 하나입니다. 로비 항목(site.Game)에 마지막으로 등록한 때와 내렸는지를 더합니다.
// 등록창이 내린 게임의 등록 정보도 고칠 수 있게 로비 항목을 통째로 줍니다.
type MyGame struct {
	site.Game
	Published time.Time `json:"published"`         // 마지막으로 등록한 때
	Hidden    bool      `json:"hidden,omitempty"`  // 내린 게임
	Blocked   bool      `json:"blocked,omitempty"` // 운영자가 내린 게임
}

func (g *gameMeta) mine() MyGame {
	return MyGame{Game: g.entry(), Published: g.Published[len(g.Published)-1].At, Hidden: g.Hidden, Blocked: g.Blocked}
}

// Mine은 owner가 올린 게임과 오늘 남은 등록 횟수입니다.
func (s *Store) Mine(owner string) Mine {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Mine{Games: []MyGame{}, Left: max(0, PublishesPerDay-s.publishedToday(owner))}
	for _, g := range s.games {
		if g.Owner == owner {
			out.Games = append(out.Games, g.mine())
		}
	}
	slices.SortFunc(out.Games, func(a, b MyGame) int { return b.Published.Compare(a.Published) })
	return out
}

// ---- 고치기 ----

// EditRequest는 PATCH /api/uploads/{game}의 본문입니다. 있는 것만 바꿉니다.
type EditRequest struct {
	Listing any   `json:"listing"` // 등록 정보. 코드, 썸네일, 클리어 기보는 그대로입니다
	Hidden  *bool `json:"hidden"`  // true면 내리고 false면 다시 올립니다
}

// Edit은 내가 올린 게임의 등록 정보만 고치거나, 게임을 내리거나 다시 올립니다.
// 코드를 새로 올리지 않으므로 하루 등록 횟수에 세지 않고, 한 시간에 EditsPerHour번까지 됩니다.
//
// 내린 게임은 로비(/api/games)와 클리어 기보에서 빠지지만 코드 파일은 그대로 내보냅니다.
// 그 게임으로 둔 대국의 기보를 다시볼 수 있어야 하기 때문입니다. id도 그대로 주인의 것입니다.
func (s *Store) Edit(u identity.User, id string, req EditRequest) (MyGame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || g.Owner != u.ID || (s.Reserved != nil && s.Reserved(id)) {
		return MyGame{}, ErrNotFound
	}
	if req.Listing == nil && req.Hidden == nil {
		return MyGame{}, ErrNoChange
	}
	if !s.hit(s.edits, u.ID, EditsPerHour) {
		return MyGame{}, ErrTooMany
	}
	next := *g
	if req.Listing != nil {
		clean, problems := CheckListing(req.Listing)
		if len(problems) > 0 {
			return MyGame{}, problems
		}
		next.Listing = clean
	}
	if req.Hidden != nil {
		next.Hidden = *req.Hidden
	}
	if err := writeJSONFile(filepath.Join(s.dir, "uploads", id, "game.json"), &next); err != nil {
		return MyGame{}, err
	}
	s.games[id] = &next
	return next.mine(), nil
}

// ---- 운영자 (internal/admin) ----

// Block은 운영자가 게임을 내리거나(blocked = true) 되살립니다. 내린 게임은 주인이 다시 올려도 로비에 나오지 않고,
// 주인의 내리기(Hidden)는 그대로 둡니다. 코드는 기보를 다시보려고 그대로 내보냅니다. 레포 게임은 ErrNotFound입니다.
func (s *Store) Block(id string, blocked bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || (s.Reserved != nil && s.Reserved(id)) {
		return ErrNotFound
	}
	next := *g
	next.Blocked = blocked
	if err := writeJSONFile(filepath.Join(s.dir, "uploads", id, "game.json"), &next); err != nil {
		return err
	}
	s.games[id] = &next
	return nil
}

// AdminGame은 운영자 화면에 보이는 올린 게임입니다. 주인의 계정 id까지 있습니다.
type AdminGame struct {
	MyGame
	Owner string `json:"owner"`
}

// Admin은 올린 게임 하나를 운영자에게 보여줄 모양으로 돌려줍니다. 레포 게임이거나 없으면 false.
func (s *Store) Admin(id string) (AdminGame, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || (s.Reserved != nil && s.Reserved(id)) {
		return AdminGame{}, false
	}
	return AdminGame{MyGame: g.mine(), Owner: g.Owner}, true
}

// Forget은 탈퇴한 계정 owner가 올린 게임을 모두 내리고 초안을 지웁니다.
// 내린 게임처럼 코드는 남겨 이미 둔 대국의 기보를 다시볼 수 있게 하고, 게임 id는 다른 사람이 쓰지 못하게 그대로 둡니다
// (주인 id만 남고, 그 계정으로는 다시 로그인할 수 없습니다).
func (s *Store) Forget(owner string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.drafts {
		if d.Owner == owner {
			s.dropDraft(d.ID)
		}
	}
	for id, g := range s.games {
		if g.Owner != owner || g.Hidden {
			continue
		}
		next := *g
		next.Hidden = true
		if err := writeJSONFile(filepath.Join(s.dir, "uploads", id, "game.json"), &next); err != nil {
			return err
		}
		s.games[id] = &next
	}
	delete(s.recent, owner)
	delete(s.edits, owner)
	return nil
}

// ---- 파일 ----

// draftFile은 초안의 파일입니다. 기한이 지났거나 없으면 ErrNotFound.
func (s *Store) draftFile(draftID, name string) ([]byte, error) {
	s.mu.Lock()
	d := s.liveDraft(draftID)
	s.mu.Unlock()
	if d == nil || !validPath(name) {
		return nil, ErrNotFound
	}
	return readFile(filepath.Join(s.draftDir(draftID), "files"), name)
}

// gameFile은 올린 게임의 한 버전의 코드 파일입니다.
func (s *Store) gameFile(id, version, name string) ([]byte, error) {
	if !IDPattern.MatchString(id) || !versionPattern.MatchString(version) || !validPath(name) || !isCode(name) {
		return nil, ErrNotFound
	}
	return readFile(filepath.Join(s.dir, "uploads", id, version), name)
}

// CodeZip은 올린 게임 한 버전의 코드와 지금 등록 정보(listing.json)를 zip으로 묶습니다.
// 운영자가 받아 자기 컴퓨터에서 AI를 학습합니다 (internal/ai). zip 안은 <게임>/ 폴더 하나라서 풀면 그대로
// trainer/train.py에 넘길 게임 폴더가 됩니다 (listing.json은 학습할 때 view()에 줄 언어를 고르는 데 씁니다).
// 내린 게임도 코드는 그대로라 받을 수 있습니다. 레포 게임이거나 그 버전이 없으면 ErrNotFound입니다.
func (s *Store) CodeZip(id, version string) ([]byte, error) {
	if !IDPattern.MatchString(id) || !versionPattern.MatchString(version) {
		return nil, ErrNotFound
	}
	s.mu.Lock()
	g := s.games[id]
	var listing Listing
	var at time.Time // zip 안 파일의 시각: 그 버전을 등록한 때
	if g != nil {
		listing = g.Listing
		at = g.Created
		for _, p := range g.Published {
			if p.Version == version {
				at = p.At
			}
		}
	}
	s.mu.Unlock()
	if g == nil || (s.Reserved != nil && s.Reserved(id)) {
		return nil, ErrNotFound
	}
	root := filepath.Join(s.dir, "uploads", id, version)
	var names []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		if name := filepath.ToSlash(rel); validPath(name) && isCode(name) {
			names = append(names, name)
		}
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) || (err == nil && len(names) == 0) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	slices.Sort(names)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: id + "/" + name, Method: zip.Deflate, Modified: at})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	for _, name := range names {
		data, err := readFile(root, name)
		if err == nil {
			err = add(name, data)
		}
		if err != nil {
			return nil, err
		}
	}
	data, err := json.MarshalIndent(listing, "", "  ")
	if err == nil {
		err = add("listing.json", append(data, '\n'))
	}
	if err == nil {
		err = zw.Close()
	}
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func readFile(dir, name string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	return data, err
}

// ---- zip ----

// readZip은 zip을 풀어 경로 → 내용으로 돌려줍니다. 규칙:
//   - .js, .mjs 코드 파일(합쳐서 MaxCode까지)과 맨 위의 listing.json, thumbnail.json만. 테스트 파일도 안 됩니다
//   - 맨 위에 index.js가 있어야 합니다. 모든 파일이 폴더 하나에 들어 있으면 그 폴더를 맨 위로 봅니다
//   - 경로는 영문자, 숫자, _, -, . 만. 점으로 시작하는 이름(.., 숨김 파일)과 절대 경로는 안 됩니다
//
// 다른 JSON 파일을 받지 않는 건, 게임 코드 버전(site.CodeVersion)이 .js, .mjs만 보기 때문입니다.
// 버전이 같은데 데이터가 다르면 두 플레이어의 판이 어긋납니다.
func readZip(data []byte) (map[string][]byte, Problems) {
	if len(data) > MaxZip {
		return nil, Problems{{Code: "zip.tooBig", Max: MaxZip}}
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, Problems{{Code: "zip.bad"}}
	}
	var entries []*zip.File
	for _, f := range zr.File {
		// 폴더 항목과, macOS가 압축할 때 끼워 넣는 파일은 건너뜁니다
		if strings.HasSuffix(f.Name, "/") || strings.HasPrefix(f.Name, "__MACOSX/") || path.Base(f.Name) == ".DS_Store" {
			continue
		}
		entries = append(entries, f)
	}
	if len(entries) > MaxFiles {
		return nil, Problems{{Code: "zip.tooManyFiles", Max: MaxFiles}}
	}
	prefix := commonFolder(entries)

	var problems Problems
	files := map[string][]byte{}
	code := 0
	for _, f := range entries {
		name := strings.TrimPrefix(f.Name, prefix)
		if !validPath(name) {
			problems = append(problems, Problem{Code: "file.badName", File: f.Name})
			continue
		}
		limit := 0
		switch {
		case name == "listing.json":
			limit = MaxListingFile
		case name == "thumbnail.json":
			limit = MaxThumbnailFile
		case isCode(name) && f.Mode().IsRegular():
			limit = MaxCode - code
		default:
			problems = append(problems, Problem{Code: "file.badType", File: name})
			continue
		}
		if _, dup := files[name]; dup {
			problems = append(problems, Problem{Code: "file.duplicate", File: name})
			continue
		}
		body, err := readEntry(f, limit)
		if errors.Is(err, errTooBig) {
			if isCode(name) {
				return nil, append(problems, Problem{Code: "code.tooBig", Max: MaxCode})
			}
			problems = append(problems, Problem{Code: "file.tooBig", File: name, Max: limit})
			continue
		}
		if err != nil {
			return nil, Problems{{Code: "zip.bad"}}
		}
		if isCode(name) {
			code += len(body)
		}
		// 깨진 thumbnail.json은 문제로 보지 않고 썸네일만 뺍니다 (NewDraft의 ThumbnailProblems)
		if name == "listing.json" && !json.Valid(body) {
			problems = append(problems, Problem{Code: "file.badJson", File: name})
			continue
		}
		files[name] = body
	}
	if _, ok := files["index.js"]; !ok && len(problems) == 0 {
		problems = append(problems, Problem{Code: "file.noIndex"})
	}
	return files, problems
}

var errTooBig = errors.New("too big")

// readEntry는 압축을 풀되 limit 바이트까지만 읽습니다. zip 머리말의 크기는 믿지 않습니다 (압축 폭탄).
func readEntry(f *zip.File, limit int) ([]byte, error) {
	if f.UncompressedSize64 > uint64(limit) {
		return nil, errTooBig
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	body, err := io.ReadAll(io.LimitReader(rc, int64(limit)+1))
	if err != nil {
		return nil, err
	}
	if len(body) > limit {
		return nil, errTooBig
	}
	return body, nil
}

// commonFolder는 모든 파일이 폴더 하나(예: mygame/)에 들어 있고 그 안에 index.js가 있으면 그 폴더 이름("mygame/")입니다.
// 게임 폴더째로 압축한 zip도 받으려는 것입니다.
func commonFolder(entries []*zip.File) string {
	if len(entries) == 0 {
		return ""
	}
	first, _, ok := strings.Cut(entries[0].Name, "/")
	if !ok {
		return ""
	}
	prefix := first + "/"
	hasIndex := false
	for _, f := range entries {
		if !strings.HasPrefix(f.Name, prefix) {
			return ""
		}
		hasIndex = hasIndex || f.Name == prefix+"index.js"
	}
	if !hasIndex {
		return ""
	}
	return prefix
}

// validPath는 초안과 올린 게임에 둘 수 있는 상대 경로인지입니다 (zip의 항목 이름, 주소의 경로 모두).
func validPath(name string) bool {
	if name == "" || len(name) > MaxPath {
		return false
	}
	parts := strings.Split(name, "/")
	if len(parts) > MaxDepth {
		return false
	}
	for _, p := range parts {
		if !partPattern.MatchString(p) {
			return false
		}
	}
	return true
}

// isCode는 게임 코드 파일인지입니다 (site의 isCode, sdk/lib/games.js의 isCodeFile과 같음).
func isCode(name string) bool {
	return (strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".mjs")) &&
		!strings.HasSuffix(name, ".test.js") && !strings.HasSuffix(name, ".test.mjs")
}

// ---- 디스크 ----

func writeFiles(dir string, files map[string][]byte) error {
	for name, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func readJSONFile(p string, v any) error {
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// writeJSONFile은 임시 파일에 쓴 뒤 이름을 바꿉니다. 도중에 멈춰도 반쯤 쓴 파일이 남지 않습니다.
func writeJSONFile(p string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func randomID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
