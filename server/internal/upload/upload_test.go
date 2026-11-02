package upload

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/site"
)

const gameCode = `export default { id: 'dots', board: { places: 'cells', rows: 3, cols: 3 }, pieces: 'xo', maxActions: 9,
  setup: () => ({}), play: (s) => s, result: () => null, view: () => ({ pieces: [] }) };
`

const thumbnailJSON = `{"board":{"places":"cells","rows":3,"cols":3,"extra":1},"pieces":"xo","player":0,
  "view":{"pieces":[{"row":0,"col":1,"piece":"x","note":"drop me"}],"marks":[{"row":1,"col":1,"type":"dot","color":1}]}}`

func validListing() map[string]any {
	return map[string]any{
		"languages":   map[string]any{"ko": "full", "en": "rulebook"},
		"difficulty":  "easy",
		"timer":       map[string]any{"minutes": 10.0, "custom": true},
		"name":        map[string]any{"ko": " 점 잇기 ", "en": "Dots", "ja": "버려질 글"},
		"description": map[string]any{"ko": "소개", "en": "About"},
		"rulebook":    map[string]any{"ko": "규칙", "en": "Rules"},
	}
}

// makeZip은 이름 → 내용으로 zip을 만듭니다. 순서를 지키려고 짝수 칸에 이름, 홀수 칸에 내용을 받습니다.
func makeZip(t *testing.T, pairs ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := 0; i < len(pairs); i += 2 {
		f, err := zw.Create(pairs[i])
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(pairs[i+1]))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func member(id string) identity.User { return identity.Member(id, "") }

func open(t *testing.T, dir string) (*Store, *time.Time) {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	s.Reserved = func(id string) bool { return id == "tictactoe" }
	return s, &now
}

func codes(err error) []string {
	var p Problems
	if !errors.As(err, &p) {
		return nil
	}
	out := []string{}
	for _, x := range p {
		out = append(out, x.Code+":"+x.File)
	}
	return out
}

func TestZipRules(t *testing.T) {
	s, _ := open(t, t.TempDir())
	u := member("m_a")
	cases := []struct {
		name  string
		zip   []byte
		codes []string
	}{
		{"zip가 아님", []byte("hello"), []string{"zip.bad:"}},
		{"index.js 없음", makeZip(t, "game.js", gameCode), []string{"file.noIndex:"}},
		{"모르는 파일", makeZip(t, "index.js", gameCode, "notes.txt", "x", "data.json", "{}", "rules/listing.json", "{}"),
			[]string{"file.badType:notes.txt", "file.badType:data.json", "file.badType:rules/listing.json"}},
		{"테스트 파일", makeZip(t, "index.js", gameCode, "index.test.js", ""), []string{"file.badType:index.test.js"}},
		{"경로", makeZip(t, "index.js", gameCode, "../x.js", "", ".hidden.js", "", "/abs.js", "", "a\\b.js", "", "한글.js", ""),
			[]string{"file.badName:../x.js", "file.badName:.hidden.js", "file.badName:/abs.js", "file.badName:a\\b.js", "file.badName:한글.js"}},
		{"같은 이름", makeZip(t, "index.js", gameCode, "index.js", gameCode), []string{"file.duplicate:index.js"}},
		{"깨진 listing.json", makeZip(t, "index.js", gameCode, "listing.json", "{"), []string{"file.badJson:listing.json"}},
		{"코드가 너무 큼", makeZip(t, "index.js", gameCode, "big.js", strings.Repeat("x", MaxCode)), []string{"code.tooBig:"}},
	}
	for _, c := range cases {
		_, err := s.NewDraft(u, c.zip)
		if got := codes(err); !slices.Equal(got, c.codes) {
			t.Errorf("%s: %v, want %v (%v)", c.name, got, c.codes, err)
		}
	}
	many := []string{"index.js", gameCode}
	for i := range MaxFiles {
		many = append(many, "f"+strings.Repeat("x", i)+".js", "")
	}
	if _, err := s.NewDraft(u, makeZip(t, many...)); !slices.Equal(codes(err), []string{"zip.tooManyFiles:"}) {
		t.Errorf("파일이 너무 많음: %v", err)
	}
	if _, err := s.NewDraft(u, make([]byte, MaxZip+1)); !slices.Equal(codes(err), []string{"zip.tooBig:"}) {
		t.Errorf("큰 zip: %v", err)
	}
}

func TestNewDraft(t *testing.T) {
	dir := t.TempDir()
	s, _ := open(t, dir)
	// 게임 폴더째로 압축한 zip (macOS가 끼워 넣는 파일 포함)
	data := makeZip(t,
		"dots/", "",
		"dots/index.js", gameCode,
		"dots/lib/rules.mjs", "export const n = 3;\n",
		"dots/listing.json", `{"difficulty":"easy"}`,
		"dots/thumbnail.json", thumbnailJSON,
		"__MACOSX/dots/._index.js", "junk",
		"dots/.DS_Store", "junk",
	)
	d, err := s.NewDraft(member("m_a"), data)
	if err != nil {
		t.Fatal(err)
	}
	if d.Module != "/drafts/"+d.ID+"/index.js" || !draftPattern.MatchString(d.ID) {
		t.Fatalf("초안 주소: %+v", d)
	}
	if len(d.Files) != 2 || d.Files[0].Path != "index.js" || d.Files[1].Path != "lib/rules.mjs" {
		t.Fatalf("코드 파일: %+v", d.Files)
	}
	if string(d.Listing) != `{"difficulty":"easy"}` {
		t.Fatalf("listing.json은 그대로 돌려줍니다: %s", d.Listing)
	}
	if strings.Contains(string(d.Thumbnail), "extra") || strings.Contains(string(d.Thumbnail), "drop me") || len(d.ThumbnailProblems) > 0 {
		t.Fatalf("썸네일은 알려진 칸만: %s %v", d.Thumbnail, d.ThumbnailProblems)
	}

	// 버전은 같은 파일을 레포 게임 폴더에 둔 것과 같아야 합니다 (site.CodeVersion, sdk/lib/games.js의 codeVersion)
	repo := t.TempDir()
	writeFiles(filepath.Join(repo, "g"), map[string][]byte{"index.js": []byte(gameCode), "lib/rules.mjs": []byte("export const n = 3;\n")})
	want, _ := site.CodeVersion(os.DirFS(repo), "g")
	if d.Version != want {
		t.Fatalf("버전 %s, want %s", d.Version, want)
	}

	body, err := s.draftFile(d.ID, "lib/rules.mjs")
	if err != nil || string(body) != "export const n = 3;\n" {
		t.Fatalf("초안 파일: %q %v", body, err)
	}
	for _, name := range []string{"../draft.json", "draft.json", "nope.js"} {
		if _, err := s.draftFile(d.ID, name); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}

	// 틀린 썸네일은 문제로 보지 않고 뺍니다
	d, err = s.NewDraft(member("m_a"), makeZip(t, "index.js", gameCode, "thumbnail.json", `{"board":{"places":"cells","rows":99,"cols":3}}`))
	if err != nil || d.Thumbnail != nil || len(d.ThumbnailProblems) == 0 {
		t.Fatalf("틀린 썸네일: %s %v %v", d.Thumbnail, d.ThumbnailProblems, err)
	}
}

func TestDraftLimits(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	u := member("m_a")
	var ids []string
	for range MaxDrafts + 1 {
		d, err := s.NewDraft(u, makeZip(t, "index.js", gameCode))
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, d.ID)
		*now = now.Add(time.Second)
	}
	if _, err := s.draftFile(ids[0], "index.js"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("가장 오래된 초안은 지워야 합니다: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "drafts", ids[0])); !os.IsNotExist(err) {
		t.Fatalf("폴더도 지워야 합니다: %v", err)
	}
	// 다른 사람 초안은 그대로
	other, _ := s.NewDraft(member("m_b"), makeZip(t, "index.js", gameCode))
	if _, err := s.draftFile(ids[1], "index.js"); err != nil {
		t.Fatal(err)
	}

	// 다시 열면 기한이 지난 초안을 지웁니다
	*now = now.Add(DraftTTL)
	again, _ := open(t, dir)
	again.now = s.now
	again.sweep("")
	if len(again.drafts) != 0 {
		t.Fatalf("기한이 지난 초안: %d", len(again.drafts))
	}
	_ = other

	for i := range DraftsPerHour {
		_, err := s.NewDraft(u, []byte("not a zip"))
		if i < DraftsPerHour-MaxDrafts-1 && errors.Is(err, ErrTooMany) {
			t.Fatalf("%d번째에 막힘", i)
		}
	}
	if _, err := s.NewDraft(u, makeZip(t, "index.js", gameCode)); !errors.Is(err, ErrTooMany) {
		t.Fatalf("한 시간에 %d번까지: %v", DraftsPerHour, err)
	}
}

func TestPublish(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	a, b := member("m_a"), member("m_b")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode, "thumbnail.json", thumbnailJSON))

	if _, err := s.Publish(b, d.ID, "dots", validListing(), true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("남의 초안: %v", err)
	}
	if _, err := s.Publish(a, d.ID, "Dots!", validListing(), true); !errors.Is(err, ErrBadID) {
		t.Fatalf("id 모양: %v", err)
	}
	if _, err := s.Publish(a, d.ID, "tictactoe", validListing(), true); !errors.Is(err, ErrTaken) {
		t.Fatalf("레포 게임 id: %v", err)
	}
	bad := validListing()
	delete(bad, "difficulty")
	if _, err := s.Publish(a, d.ID, "dots", bad, true); !slices.Equal(codes(err), []string{"difficulty.invalid:"}) {
		t.Fatalf("등록 정보 문제: %v", err)
	}

	g, err := s.Publish(a, d.ID, "dots", validListing(), true)
	if err != nil {
		t.Fatal(err)
	}
	if g.Module != "/uploads/dots/"+d.Version+"/index.js" || g.Version != d.Version || g.Thumbnail == nil {
		t.Fatalf("등록한 게임: %+v", g)
	}
	var listing Listing
	json.Unmarshal(g.Listing, &listing)
	if listing.Name["ko"] != "점 잇기" || listing.Name["ja"] != "" || len(listing.Languages) != 2 || *listing.Timer.Minutes != 10 {
		t.Fatalf("정리한 등록 정보: %s", g.Listing)
	}
	if _, err := s.draftFile(d.ID, "index.js"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("등록한 초안은 지웁니다: %v", err)
	}
	if _, err := s.gameFile("dots", d.Version, "index.js"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "uploads", "dots", d.Version, "thumbnail.json")); !os.IsNotExist(err) {
		t.Fatal("버전 폴더에는 코드만 둡니다")
	}

	// 다른 계정은 같은 id로 못 올립니다
	db, _ := s.NewDraft(b, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(b, db.ID, "dots", validListing(), false); !errors.Is(err, ErrTaken) {
		t.Fatalf("남의 게임 id: %v", err)
	}

	// 새 버전. 옛 버전 코드는 남깁니다
	*now = now.Add(time.Minute)
	d2, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// v2\n"))
	g2, err := s.Publish(a, d2.ID, "dots", validListing(), false)
	if err != nil || g2.Version == g.Version || g2.Thumbnail != nil {
		t.Fatalf("새 버전: %+v %v", g2, err)
	}
	if _, err := s.gameFile("dots", g.Version, "index.js"); err != nil {
		t.Fatalf("옛 버전: %v", err)
	}

	// 다시 열어도 그대로
	again, _ := open(t, dir)
	games := again.Games()
	if len(games) != 1 || games[0].Version != g2.Version {
		t.Fatalf("다시 연 뒤: %+v", games)
	}
	mine := again.Mine("m_a")
	if len(mine.Games) != 1 || mine.Left != PublishesPerDay-2 {
		t.Fatalf("내 게임: %+v", mine)
	}

	// 하루 등록 횟수
	for range PublishesPerDay - 2 {
		d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
		if _, err := s.Publish(a, d.ID, "dots", validListing(), false); err != nil {
			t.Fatal(err)
		}
	}
	d3, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d3.ID, "dots", validListing(), false); !errors.Is(err, ErrTooMany) {
		t.Fatalf("하루 %d번까지: %v", PublishesPerDay, err)
	}
	*now = now.Add(24 * time.Hour)
	if _, err := s.Publish(a, d3.ID, "dots-two", validListing(), false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("기한이 지난 초안: %v", err)
	}
	d4, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d4.ID, "dots-two", validListing(), false); err != nil {
		t.Fatalf("다음 날: %v", err)
	}

	// 레포에 같은 id가 생기면 목록에서 뺍니다
	s.Reserved = func(id string) bool { return id == "dots" }
	if games := s.Games(); len(games) != 1 || games[0].ID != "dots-two" {
		t.Fatalf("레포와 겹친 게임: %+v", games)
	}
}

func TestCheckListing(t *testing.T) {
	l := validListing()
	l["languages"] = map[string]any{"ko": "rulebook", "en": "everything"}
	l["timer"] = map[string]any{"minutes": 0.5, "custom": true}
	l["name"] = map[string]any{"ko": "  "}
	l["rulebook"] = map[string]any{"ko": strings.Repeat("😀", 10001)} // 자바스크립트 기준 20002자
	_, p := CheckListing(l)
	got := []string{}
	for _, x := range p {
		got = append(got, x.Code+":"+x.Field)
	}
	want := []string{"languages.invalid:", "languages.needFull:", "timer.invalid:", "text.missing:name", "text.tooLong:rulebook"}
	if !slices.Equal(got, want) {
		t.Fatalf("%v, want %v", got, want)
	}
	if _, p := CheckListing("nope"); p[0].Code != "languages.none" {
		t.Fatal(p)
	}
	l = validListing()
	l["timer"] = map[string]any{"minutes": nil, "custom": false}
	l["description"] = map[string]any{"ko": "\uFEFF 소개 \u0085", "en": "About"}
	out, p := CheckListing(l)
	if p != nil || out.Timer.Minutes != nil || out.Description["ko"] != "소개 \u0085" {
		t.Fatalf("%+v %v", out, p)
	}
	l["timer"] = map[string]any{"custom": false} // minutes가 없으면 틀림 (null과 다름)
	if _, p := CheckListing(l); len(p) != 1 || p[0].Code != "timer.invalid" {
		t.Fatal(p)
	}
}

func TestCheckThumbnail(t *testing.T) {
	cases := map[string]string{
		`"x"`: "thumbnail: must be an object",
		`[]`:  "thumbnail.board: must be an object", // 자바스크립트처럼 배열은 칸마다 검사합니다
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":2,"view":{"pieces":[]}}`:                                               "thumbnail.player: must be 0 or 1",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[{"row":3,"col":0,"piece":"x"}]}}`:                  "thumbnail.view.pieces: each needs a place on the board and a piece name",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"marks":null}}`:                                  "thumbnail.view.marks: must be a list if present",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"tint":[{"row":0,"col":0,"color":2}]}}`:          "thumbnail.view.tint: each needs a place on the board and a color",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"text":[{"row":0,"col":0,"text":"123456789"}]}}`: "thumbnail.view.text: each needs a place on the board and up to 8 characters",
	}
	for in, want := range cases {
		if _, p := CheckThumbnail([]byte(in)); len(p) == 0 || p[0] != want {
			t.Errorf("%s: %v, want %q", in, p, want)
		}
	}
	big := `{"board":{"places":"cells","rows":32,"cols":32},"pieces":"xo","player":1,"view":{"pieces":[` +
		strings.TrimSuffix(strings.Repeat(`{"row":1,"col":1,"piece":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},`, 700), ",") + `]}}`
	if _, p := CheckThumbnail([]byte(big)); len(p) != 1 || !strings.Contains(p[0], "larger than 32KB") {
		t.Errorf("큰 썸네일: %v", p)
	}
	out, p := CheckThumbnail([]byte(thumbnailJSON))
	want := `{"board":{"cols":3,"places":"cells","rows":3},"pieces":"xo","player":0,"view":{"marks":[{"col":1,"color":1,"row":1,"type":"dot"}],"pieces":[{"col":1,"piece":"x","row":0}]}}`
	if p != nil || string(out) != want {
		t.Fatalf("%s %v", out, p)
	}
}

// names는 테스트용 계정 저장소입니다.
type names map[string]string

func (n names) Name(id string) (string, bool) {
	name, ok := n[id]
	return name, ok
}

func TestHTTP(t *testing.T) {
	s, _ := open(t, t.TempDir())
	ids := identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	ids.Members = names{"m_a": "maker"}
	h := Handler{Store: s, IDs: ids}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/uploads", h.ServeMine)
	mux.HandleFunc("POST /api/drafts", h.ServeNewDraft)
	mux.HandleFunc("POST /api/drafts/{draft}/publish", h.ServePublish)
	mux.HandleFunc("GET /drafts/{draft}/{path...}", h.ServeDraftFile)
	mux.HandleFunc("GET /uploads/{game}/{version}/{path...}", h.ServeFile)
	guest := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(identity.User{ID: "g_a", Kind: identity.KindGuest, Tag: "1234"})}
	cookie := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(member("m_a"))}

	do := func(method, path, ctype string, body []byte, c *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if c != nil {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	zipped := makeZip(t, "index.js", gameCode)

	if rec := do("POST", "/api/drafts", "application/zip", zipped, nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("쿠키 없이: %d", rec.Code)
	}
	if rec := do("POST", "/api/drafts", "application/zip", zipped, guest); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "member only") {
		t.Fatalf("게스트: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/drafts", "multipart/form-data", zipped, cookie); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("폼 본문: %d", rec.Code)
	}
	if rec := do("POST", "/api/drafts", "application/zip", make([]byte, MaxZip+1), cookie); rec.Code != http.StatusRequestEntityTooLarge || !strings.Contains(rec.Body.String(), "zip.tooBig") {
		t.Fatalf("큰 zip: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/drafts", "application/zip", makeZip(t, "a.js", ""), cookie); rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "file.noIndex") {
		t.Fatalf("규칙 위반: %d %s", rec.Code, rec.Body)
	}
	rec := do("POST", "/api/drafts", "application/zip", zipped, cookie)
	if rec.Code != http.StatusCreated {
		t.Fatalf("초안: %d %s", rec.Code, rec.Body)
	}
	var d Draft
	json.Unmarshal(rec.Body.Bytes(), &d)

	rec = do("GET", d.Module, "", nil, nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "*" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("초안 파일: %d %v", rec.Code, rec.Header())
	}
	for _, p := range []string{"/drafts/" + d.ID + "/draft.json", "/drafts/" + d.ID + "/../draft.json", "/drafts/nope/index.js"} {
		if rec := do("GET", p, "", nil, nil); rec.Code != http.StatusNotFound && rec.Code != http.StatusMovedPermanently {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}

	body, _ := json.Marshal(map[string]any{"id": "dots", "listing": validListing(), "thumbnail": false})
	if rec := do("POST", "/api/drafts/"+d.ID+"/publish", "text/plain", body, cookie); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("JSON이 아닌 본문: %d", rec.Code)
	}
	rec = do("POST", "/api/drafts/"+d.ID+"/publish", "application/json", body, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"module":"/uploads/dots/`+d.Version+`/index.js"`) {
		t.Fatalf("등록: %d %s", rec.Code, rec.Body)
	}
	rec = do("GET", "/uploads/dots/"+d.Version+"/index.js", "", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") || rec.Body.String() != gameCode {
		t.Fatalf("올린 게임 파일: %d %v", rec.Code, rec.Header())
	}
	for _, p := range []string{"/uploads/dots/" + d.Version + "/game.json", "/uploads/dots/latest/index.js", "/uploads/dots/" + d.Version + "/.x.js"} {
		if rec := do("GET", p, "", nil, nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	rec = do("GET", "/api/uploads", "", nil, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"dots"`) || strings.Contains(rec.Body.String(), "m_a") {
		t.Fatalf("내 게임: %d %s", rec.Code, rec.Body)
	}
}
