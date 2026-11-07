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

// clearOf는 그 버전의 클리어 기보입니다.
func clearOf(version string) json.RawMessage {
	return json.RawMessage(`{"version":"` + version + `","seed":7,"winner":0,"moves":[
  {"player":0,"action":{"kind":"click","row":1,"col":1}},{"player":1,"action":{"kind":"pass"}}]}`)
}

// publishing은 초안 d를 id로 등록하는 본문입니다. 클리어 기보는 있고 썸네일은 없습니다.
func publishing(id string, d Draft) PublishRequest {
	return PublishRequest{ID: id, Listing: validListing(), Clear: clearOf(d.Version)}
}

func TestPublish(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	a, b := member("m_a"), member("m_b")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode, "thumbnail.json", thumbnailJSON))

	if _, err := s.Publish(b, d.ID, publishing("dots", d)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("남의 초안: %v", err)
	}
	if _, err := s.Publish(a, d.ID, publishing("Dots!", d)); !errors.Is(err, ErrBadID) {
		t.Fatalf("id 모양: %v", err)
	}
	if _, err := s.Publish(a, d.ID, publishing("tictactoe", d)); !errors.Is(err, ErrTaken) {
		t.Fatalf("레포 게임 id: %v", err)
	}
	bad := validListing()
	delete(bad, "difficulty")
	req := publishing("dots", d)
	req.Listing = bad
	req.Thumbnail = json.RawMessage(`{"board":null}`)
	req.Clear = nil
	if _, err := s.Publish(a, d.ID, req); !slices.Equal(codes(err), []string{"difficulty.invalid:", "thumbnail.invalid:", "clear.missing:"}) {
		t.Fatalf("등록 정보, 썸네일, 클리어 문제: %v", codes(err))
	}
	req = publishing("dots", d)
	req.Clear = clearOf("0123456789abcdef")
	if _, err := s.Publish(a, d.ID, req); !slices.Equal(codes(err), []string{"clear.version:"}) {
		t.Fatalf("다른 버전의 클리어: %v", codes(err))
	}

	req = publishing("dots", d)
	req.Thumbnail = json.RawMessage(thumbnailJSON)
	g, err := s.Publish(a, d.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	released := *now
	if g.Module != "/uploads/dots/"+d.Version+"/index.js" || g.Version != d.Version || g.Thumbnail == nil || !g.Clear || !g.Released.Equal(released) {
		t.Fatalf("등록한 게임: %+v", g)
	}
	if strings.Contains(string(g.Thumbnail), "drop me") {
		t.Fatalf("썸네일은 알려진 칸만 남깁니다: %s", g.Thumbnail)
	}
	var listing Listing
	json.Unmarshal(g.Listing, &listing)
	if listing.Name["ko"] != "점 잇기" || listing.Name["ja"] != "" || len(listing.Languages) != 2 || *listing.Timer.Minutes != 10 {
		t.Fatalf("정리한 등록 정보: %s", g.Listing)
	}
	c, err := s.ClearOf("dots")
	if err != nil || c.Game != "dots" || c.Version != d.Version || c.Seed != 7 || len(c.Moves) != 2 || c.Moves[1].Action.Kind != "pass" || !c.At.Equal(*now) {
		t.Fatalf("클리어 기보: %+v %v", c, err)
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
	if _, err := s.Publish(b, db.ID, publishing("dots", db)); !errors.Is(err, ErrTaken) {
		t.Fatalf("남의 게임 id: %v", err)
	}

	// 새 버전은 다시 깨야 합니다. 옛 버전 코드는 남깁니다
	*now = now.Add(time.Minute)
	d2, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// v2\n"))
	req = publishing("dots", d2)
	req.Clear = nil
	if _, err := s.Publish(a, d2.ID, req); !slices.Equal(codes(err), []string{"clear.missing:"}) {
		t.Fatalf("새 버전인데 클리어 없이: %v", codes(err))
	}
	g2, err := s.Publish(a, d2.ID, publishing("dots", d2))
	// 출시일은 처음 등록한 때 그대로입니다
	if err != nil || g2.Version == g.Version || g2.Thumbnail != nil || !g2.Clear || !g2.Released.Equal(released) {
		t.Fatalf("새 버전: %+v %v", g2, err)
	}
	if _, err := s.gameFile("dots", g.Version, "index.js"); err != nil {
		t.Fatalf("옛 버전: %v", err)
	}

	// 같은 버전을 다시 등록하면(등록 정보만 고칠 때) 전에 깬 판을 그대로 씁니다
	*now = now.Add(time.Minute)
	d2b, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// v2\n"))
	req = publishing("dots", d2b)
	req.Clear = nil
	if g, err := s.Publish(a, d2b.ID, req); err != nil || !g.Clear {
		t.Fatalf("같은 버전: %+v %v", g, err)
	}
	if c, _ := s.ClearOf("dots"); c.Version != d2.Version || !c.At.Equal(now.Add(-time.Minute)) {
		t.Fatalf("같은 버전의 클리어 기보는 그대로: %+v", c)
	}

	// 다시 열어도 그대로
	again, _ := open(t, dir)
	games := again.Games()
	if len(games) != 1 || games[0].Version != g2.Version || !games[0].Clear {
		t.Fatalf("다시 연 뒤: %+v", games)
	}
	if c, err := again.ClearOf("dots"); err != nil || len(c.Moves) != 2 {
		t.Fatalf("다시 연 뒤 클리어 기보: %+v %v", c, err)
	}
	mine := again.Mine("m_a")
	if len(mine.Games) != 1 || mine.Left != PublishesPerDay-3 {
		t.Fatalf("내 게임: %+v", mine)
	}

	// 하루 등록 횟수
	for range PublishesPerDay - 3 {
		d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
		if _, err := s.Publish(a, d.ID, publishing("dots", d)); err != nil {
			t.Fatal(err)
		}
	}
	d3, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d3.ID, publishing("dots", d3)); !errors.Is(err, ErrTooMany) {
		t.Fatalf("하루 %d번까지: %v", PublishesPerDay, err)
	}
	*now = now.Add(24 * time.Hour)
	if _, err := s.Publish(a, d3.ID, publishing("dots-two", d3)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("기한이 지난 초안: %v", err)
	}
	d4, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d4.ID, publishing("dots-two", d4)); err != nil {
		t.Fatalf("다음 날: %v", err)
	}

	// 레포에 같은 id가 생기면 목록에서 뺍니다
	s.Reserved = func(id string) bool { return id == "dots" }
	if games := s.Games(); len(games) != 1 || games[0].ID != "dots-two" {
		t.Fatalf("레포와 겹친 게임: %+v", games)
	}
	if _, err := s.ClearOf("dots"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("레포와 겹친 게임의 클리어 기보: %v", err)
	}
}

// 로비 목록에는 제작자의 지금 이름을 넣고, 계정 id는 넣지 않습니다
func TestNewGamesPerDay(t *testing.T) {
	s, now := open(t, t.TempDir())
	a, b := member("m_a"), member("m_b")
	publish := func(u identity.User, id, code string) error {
		d, err := s.NewDraft(u, makeZip(t, "index.js", code))
		if err != nil {
			t.Fatal(err)
		}
		_, err = s.Publish(u, d.ID, publishing(id, d))
		return err
	}
	if err := publish(a, "dots", gameCode); err != nil {
		t.Fatal(err)
	}
	if m := s.Mine("m_a"); m.Left != PublishesPerDay-1 || m.NewLeft != 0 {
		t.Fatalf("새 게임을 올린 뒤: left %d, newLeft %d", m.Left, m.NewLeft)
	}
	*now = now.Add(time.Hour)
	if err := publish(a, "dots-two", gameCode); !errors.Is(err, ErrTooNew) {
		t.Fatalf("하루에 새 게임 둘: %v", err)
	}
	// 내 게임의 새 버전과 다른 계정의 새 게임은 됩니다
	if err := publish(a, "dots", gameCode+"// v2\n"); err != nil {
		t.Fatalf("새 버전: %v", err)
	}
	if err := publish(b, "dots-b", gameCode); err != nil {
		t.Fatalf("다른 계정: %v", err)
	}
	// 처음 올린 때부터 24시간이 지나면 다시 새 게임을 올릴 수 있습니다
	*now = now.Add(23 * time.Hour)
	if m := s.Mine("m_a"); m.NewLeft != NewGamesPerDay {
		t.Fatalf("다음 날 newLeft: %d", m.NewLeft)
	}
	if err := publish(a, "dots-two", gameCode); err != nil {
		t.Fatalf("다음 날: %v", err)
	}
}

func TestAuthor(t *testing.T) {
	s, _ := open(t, t.TempDir())
	a := member("m_a")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d.ID, publishing("dots", d)); err != nil {
		t.Fatal(err)
	}
	if games := s.Games(); len(games) != 1 || games[0].Author != "" {
		t.Fatalf("계정 저장소가 없으면 이름 없이: %+v", games)
	}
	accounts := names{"m_a": "maker"}
	s.Names = accounts
	if games := s.Games(); games[0].Author != "maker" {
		t.Fatalf("제작자 이름: %+v", games[0])
	}
	accounts["m_a"] = "renamed"
	if games := s.Games(); games[0].Author != "renamed" {
		t.Fatalf("이름을 바꾸면 바로: %+v", games[0])
	}
	delete(accounts, "m_a")
	if games := s.Games(); games[0].Author != "" {
		t.Fatalf("모르는 계정이면 이름 없이: %+v", games[0])
	}
	accounts["m_a"] = "maker"
	data, _ := json.Marshal(s.Games())
	if !strings.Contains(string(data), `"author":"maker"`) || strings.Contains(string(data), "m_a") {
		t.Fatalf("/api/games 모양: %s", data)
	}
	if mine := s.Mine("m_a"); mine.Games[0].Author != "" {
		t.Fatalf("내 게임 목록에는 넣지 않습니다: %+v", mine.Games[0])
	}
}

func TestEdit(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	a, b := member("m_a"), member("m_b")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	g, err := s.Publish(a, d.ID, publishing("dots", d))
	if err != nil {
		t.Fatal(err)
	}
	left := s.Mine("m_a").Left
	hide, show := true, false

	if _, err := s.Edit(b, "dots", EditRequest{Hidden: &hide}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("남의 게임: %v", err)
	}
	if _, err := s.Edit(a, "nope", EditRequest{Hidden: &hide}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("없는 게임: %v", err)
	}
	if _, err := s.Edit(a, "dots", EditRequest{}); !errors.Is(err, ErrNoChange) {
		t.Fatalf("바꿀 것이 없음: %v", err)
	}
	bad := validListing()
	delete(bad, "difficulty")
	if _, err := s.Edit(a, "dots", EditRequest{Listing: bad}); !slices.Equal(codes(err), []string{"difficulty.invalid:"}) {
		t.Fatalf("틀린 등록 정보: %v", codes(err))
	}

	// 등록 정보만 고치면 코드 버전과 클리어 기보는 그대로이고, 하루 등록 횟수에 세지 않습니다
	l := validListing()
	l["name"] = map[string]any{"ko": "새 이름", "en": "New"}
	my, err := s.Edit(a, "dots", EditRequest{Listing: l})
	var listing Listing
	json.Unmarshal(my.Listing, &listing)
	if err != nil || my.Version != g.Version || !my.Clear || my.Hidden || listing.Name["ko"] != "새 이름" {
		t.Fatalf("등록 정보 고치기: %+v %v", my, err)
	}
	if s.Mine("m_a").Left != left {
		t.Fatal("등록 정보 고치기는 하루 등록 횟수에 세지 않습니다")
	}
	if games := s.Games(); len(games) != 1 || !strings.Contains(string(games[0].Listing), "새 이름") {
		t.Fatalf("로비에 고친 등록 정보: %+v", games)
	}

	// 내리면 로비와 클리어 기보에서 빠지지만, 기보를 다시보려고 코드는 남깁니다
	if my, err := s.Edit(a, "dots", EditRequest{Hidden: &hide}); err != nil || !my.Hidden {
		t.Fatalf("내리기: %+v %v", my, err)
	}
	if games := s.Games(); len(games) != 0 {
		t.Fatalf("내린 게임이 로비에: %+v", games)
	}
	if _, err := s.ClearOf("dots"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("내린 게임의 클리어 기보: %v", err)
	}
	if _, err := s.gameFile("dots", g.Version, "index.js"); err != nil {
		t.Fatalf("내린 게임의 코드: %v", err)
	}
	if mine := s.Mine("m_a"); len(mine.Games) != 1 || !mine.Games[0].Hidden || !strings.Contains(string(mine.Games[0].Listing), "새 이름") {
		t.Fatalf("내 게임에는 내린 게임도: %+v", mine)
	}
	db, _ := s.NewDraft(b, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(b, db.ID, publishing("dots", db)); !errors.Is(err, ErrTaken) {
		t.Fatalf("내린 게임의 id도 주인의 것: %v", err)
	}
	if again, _ := open(t, dir); len(again.Games()) != 0 || !again.Mine("m_a").Games[0].Hidden {
		t.Fatal("다시 열어도 내린 채로")
	}

	// 다시 올리거나, 새로 등록하면 다시 나옵니다
	if my, err := s.Edit(a, "dots", EditRequest{Hidden: &show}); err != nil || my.Hidden || len(s.Games()) != 1 {
		t.Fatalf("다시 올리기: %+v %v", my, err)
	}
	s.Edit(a, "dots", EditRequest{Hidden: &hide})
	d2, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d2.ID, publishing("dots", d2)); err != nil || len(s.Games()) != 1 {
		t.Fatalf("내린 게임을 다시 등록: %v %+v", err, s.Games())
	}

	// 한 시간에 EditsPerHour번까지
	*now = now.Add(time.Hour)
	for range EditsPerHour {
		if _, err := s.Edit(a, "dots", EditRequest{Hidden: &show}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.Edit(a, "dots", EditRequest{Hidden: &show}); !errors.Is(err, ErrTooMany) {
		t.Fatalf("한 시간에 %d번까지: %v", EditsPerHour, err)
	}
}

func TestCheckClear(t *testing.T) {
	const v = "0123456789abcdef"
	clear := func(rest string) string { return `{"version":"` + v + `",` + rest + `}` }
	move := func(a string) string { return clear(`"seed":1,"winner":1,"moves":[{"player":1,"action":` + a + `}]`) }
	pass := `[{"player":0,"action":{"kind":"pass"}}]`
	cases := map[string]string{
		move(`{"kind":"click","row":31,"col":0}`):                                    "",
		move(`{"kind":"pass"}`):                                                      "",
		move(`{"kind":"click","row":32,"col":0}`):                                    "clear.invalid",
		move(`{"kind":"click","row":-1,"col":0}`):                                    "clear.invalid",
		move(`{"kind":"pass","row":1}`):                                              "clear.invalid",
		move(`{"kind":""}`):                                                          "clear.invalid",
		move(`{"kind":"` + strings.Repeat("k", 33) + `"}`):                           "clear.invalid",
		move(`{"kind":"click","row":1.5,"col":0}`):                                   "clear.invalid",
		clear(`"seed":1,"winner":null,"moves":` + pass):                              "clear.invalid",
		clear(`"seed":1,"winner":2,"moves":` + pass):                                 "clear.invalid",
		clear(`"winner":0,"moves":` + pass):                                          "clear.invalid",
		clear(`"seed":-1,"winner":0,"moves":` + pass):                                "clear.invalid",
		clear(`"seed":4294967296,"winner":0,"moves":` + pass):                        "clear.invalid",
		clear(`"seed":1,"winner":0,"moves":[]`):                                      "clear.invalid",
		clear(`"seed":1,"winner":0,"moves":[{"player":2,"action":{"kind":"pass"}}]`): "clear.invalid",
		`{"version":"ffffffffffffffff","seed":1,"winner":0,"moves":` + pass + `}`:    "clear.version",
		`[1,2]`: "clear.invalid",
		`"x"`:   "clear.invalid",
	}
	for in, want := range cases {
		c, p := CheckClear(json.RawMessage(in), v)
		got := ""
		if len(p) > 0 {
			got = p[0].Code
		}
		if got != want || (want == "") != (c != nil) {
			t.Errorf("%s: %q, want %q", in, got, want)
		}
	}
	many := make([]string, MaxClearMoves+1)
	for i := range many {
		many[i] = `{"player":0,"action":{"kind":"pass"}}`
	}
	if _, p := CheckClear(json.RawMessage(clear(`"seed":1,"winner":0,"moves":[`+strings.Join(many, ",")+`]`)), v); len(p) == 0 {
		t.Errorf("행동 %d개는 너무 많습니다", MaxClearMoves+1)
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
	// 테두리 두께(width)와 선(lines)
	widths := map[string]string{
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"marks":[{"row":0,"col":0,"type":"frame","width":31}]}}`:                    "thumbnail.view.marks: each needs a place on the board and a known mark type",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"marks":[{"row":0,"col":0,"type":"frame","width":"5"}]}}`:                   "thumbnail.view.marks: each needs a place on the board and a known mark type",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"lines":{}}}`:                                                               "thumbnail.view.lines: must be a list if present",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"lines":[{"from":{"row":0,"col":0},"to":{"row":3,"col":0}}]}}`:              "thumbnail.view.lines: each needs from and to on the board, and width from 1 to 50",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"lines":[{"from":{"row":0,"col":0},"to":{"row":1,"col":0},"width":0.5}]}}`:  "thumbnail.view.lines: each needs from and to on the board, and width from 1 to 50",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"lines":[{"from":{"row":0,"col":0},"to":{"row":1,"col":0},"hover":null}]}}`: "thumbnail.view.lines: each needs from and to on the board, and width from 1 to 50",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"lines":[7]}}`:                                                              "thumbnail.view.lines: each needs from and to on the board, and width from 1 to 50",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"tint":[{"row":0,"col":0,"color":0,"hover":{"row":3,"col":0}}]}}`:           "thumbnail.view.tint: each needs a place on the board and a color",
		`{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],"tint":[{"row":0,"col":0,"color":"pink"}]}}`:                                "thumbnail.view.tint: each needs a place on the board and a color",
	}
	for in, want := range widths {
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

	// 테두리 두께와 선: hover가 있는 칠하기와 선은 빼고, 모르는 칸은 버립니다 (sdk/test/check.test.js와 같은 경우)
	lined := `{"board":{"places":"cells","rows":3,"cols":3},"pieces":"xo","player":0,"view":{"pieces":[],
	  "marks":[{"row":0,"col":0,"type":"frame","color":1,"width":4.5,"extra":1}],
	  "tint":[{"row":0,"col":1,"color":0},{"row":2,"col":1,"color":1,"hover":{"row":2,"col":2}}],
	  "lines":[{"from":{"row":0,"col":0},"to":{"row":2,"col":2,"extra":1},"color":"#2563eb","width":12},
	           {"from":{"row":1,"col":1},"to":{"row":0,"col":1},"hover":{"row":1,"col":1}}]}}`
	out, p = CheckThumbnail([]byte(lined))
	want = `{"board":{"cols":3,"places":"cells","rows":3},"pieces":"xo","player":0,"view":{"lines":[{"color":"#2563eb","from":{"col":0,"row":0},"to":{"col":2,"row":2},"width":12}],"marks":[{"col":0,"color":1,"row":0,"type":"frame","width":4.5}],"pieces":[],"tint":[{"col":1,"color":0,"row":0}]}}`
	if p != nil || string(out) != want {
		t.Fatalf("선: %s %v", out, p)
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
	ids.Members = names{"m_a": "maker", "m_b": "other"}
	h := Handler{Store: s, IDs: ids}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/uploads", h.ServeMine)
	mux.HandleFunc("PATCH /api/uploads/{game}", h.ServeEdit)
	mux.HandleFunc("POST /api/drafts", h.ServeNewDraft)
	mux.HandleFunc("POST /api/drafts/{draft}/publish", h.ServePublish)
	mux.HandleFunc("GET /drafts/{draft}/{path...}", h.ServeDraftFile)
	mux.HandleFunc("GET /uploads/{game}/{version}/{path...}", h.ServeFile)
	mux.HandleFunc("GET /api/games/{game}/clear", h.ServeClear)
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

	body, _ := json.Marshal(publishing("dots", d))
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
	if rec := do("GET", "/api/games/nope/clear", "", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("없는 게임의 클리어 기보: %d", rec.Code)
	}
	rec = do("GET", "/api/games/dots/clear", "", nil, nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"game":"dots"`) || !strings.Contains(rec.Body.String(), `"seed":7`) || strings.Contains(rec.Body.String(), "m_a") {
		t.Fatalf("클리어 기보: %d %s", rec.Code, rec.Body)
	}
	rec = do("GET", "/api/uploads", "", nil, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"id":"dots"`) || !strings.Contains(rec.Body.String(), `"listing":{`) || strings.Contains(rec.Body.String(), "m_a") {
		t.Fatalf("내 게임: %d %s", rec.Code, rec.Body)
	}

	// 등록 정보만 고치기와 내리기
	other := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(member("m_b"))}
	hide := []byte(`{"hidden":true}`)
	if rec := do("PATCH", "/api/uploads/dots", "application/json", hide, guest); rec.Code != http.StatusForbidden {
		t.Fatalf("게스트가 고치기: %d", rec.Code)
	}
	if rec := do("PATCH", "/api/uploads/dots", "application/json", hide, other); rec.Code != http.StatusNotFound {
		t.Fatalf("남의 게임 고치기: %d", rec.Code)
	}
	if rec := do("PATCH", "/api/uploads/dots", "text/plain", hide, cookie); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("JSON이 아닌 본문: %d", rec.Code)
	}
	if rec := do("PATCH", "/api/uploads/dots", "application/json", []byte(`{}`), cookie); rec.Code != http.StatusBadRequest {
		t.Fatalf("바꿀 것이 없음: %d", rec.Code)
	}
	if rec := do("PATCH", "/api/uploads/dots", "application/json", []byte(`{"listing":{}}`), cookie); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("틀린 등록 정보: %d %s", rec.Code, rec.Body)
	}
	rec = do("PATCH", "/api/uploads/dots", "application/json", hide, cookie)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"hidden":true`) {
		t.Fatalf("내리기: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/api/games/dots/clear", "", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("내린 게임의 클리어 기보: %d", rec.Code)
	}
	if rec := do("GET", "/uploads/dots/"+d.Version+"/index.js", "", nil, nil); rec.Code != http.StatusOK {
		t.Fatalf("내린 게임의 코드는 기보 다시보기에 씁니다: %d", rec.Code)
	}

	// 정지된 계정은 올리기와 고치기가 안 되고, 내 게임 보기는 됩니다
	ids.Members = suspendedNames{names{"m_a": "maker"}}
	if rec := do("POST", "/api/drafts", "application/zip", zipped, cookie); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"suspended"`) {
		t.Fatalf("정지된 계정 초안: %d %s", rec.Code, rec.Body)
	}
	if rec := do("PATCH", "/api/uploads/dots", "application/json", []byte(`{"hidden":false}`), cookie); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"suspended"`) {
		t.Fatalf("정지된 계정 고치기: %d %s", rec.Code, rec.Body)
	}
	if rec := do("GET", "/api/uploads", "", nil, cookie); rec.Code != http.StatusOK {
		t.Fatalf("정지된 계정 내 게임: %d", rec.Code)
	}
}

// suspendedNames는 정지도 알려 주는 테스트용 계정 저장소입니다. 모든 계정이 영구 정지입니다.
type suspendedNames struct{ names }

func (suspendedNames) Suspension(string) (time.Time, bool) { return time.Time{}, true }

func TestBlock(t *testing.T) {
	dir := t.TempDir()
	s, _ := open(t, dir)
	s.Reserved = func(id string) bool { return id == "tictactoe" }
	a := member("m_a")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(a, d.ID, publishing("dots", d)); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"nope", "tictactoe"} {
		if err := s.Block(id, true); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Block(%s): %v", id, err)
		}
		if _, ok := s.Admin(id); ok {
			t.Fatalf("Admin(%s) found", id)
		}
	}
	if err := s.Block("dots", true); err != nil {
		t.Fatal(err)
	}
	// 주인이 다시 올리거나 새 버전을 등록해도 운영자가 되살릴 때까지 로비에 나오지 않습니다
	show := false
	if _, err := s.Edit(a, "dots", EditRequest{Hidden: &show}); err != nil {
		t.Fatal(err)
	}
	next, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// fix\n"))
	if _, err := s.Publish(a, next.ID, publishing("dots", next)); err != nil {
		t.Fatal(err)
	}
	check := func(s *Store, blocked bool) {
		t.Helper()
		if listed := len(s.Games()) == 1; listed == blocked {
			t.Fatalf("blocked=%v인데 로비 = %+v", blocked, s.Games())
		}
		if mine := s.Mine("m_a").Games; len(mine) != 1 || mine[0].Blocked != blocked || mine[0].Hidden {
			t.Fatalf("Mine = %+v", mine)
		}
		g, ok := s.Admin("dots")
		if !ok || g.Owner != "m_a" || g.Blocked != blocked || g.Version != next.Version {
			t.Fatalf("Admin = %+v, %v", g, ok)
		}
	}
	check(s, true)
	again, _ := open(t, dir)
	again.Reserved = s.Reserved
	check(again, true)
	if err := again.Block("dots", false); err != nil {
		t.Fatal(err)
	}
	check(again, false)
}

func TestCodeZip(t *testing.T) {
	dir := t.TempDir()
	s, _ := open(t, dir)
	a := member("m_a")
	d, _ := s.NewDraft(a, makeZip(t, "dots/index.js", gameCode, "dots/lib/rules.mjs", "export const n = 3;\n", "dots/thumbnail.json", thumbnailJSON))
	if _, err := s.Publish(a, d.ID, publishing("dots", d)); err != nil {
		t.Fatal(err)
	}
	next, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// fix\n"))
	if _, err := s.Publish(a, next.ID, publishing("dots", next)); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ id, version string }{{"nope", d.Version}, {"tictactoe", d.Version}, {"dots", "0123456789abcdef"}, {"dots", "../x"}} {
		if _, err := s.CodeZip(c.id, c.version); !errors.Is(err, ErrNotFound) {
			t.Fatalf("CodeZip(%s, %s): %v", c.id, c.version, err)
		}
	}
	// 예전 버전의 코드도 받습니다. 등록 정보는 지금 것이고, 썸네일은 넣지 않습니다
	unzip := func(version string) map[string]string {
		t.Helper()
		data, err := s.CodeZip("dots", version)
		if err != nil {
			t.Fatal(err)
		}
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		files := map[string]string{}
		for _, f := range zr.File {
			r, _ := f.Open()
			var b bytes.Buffer
			b.ReadFrom(r)
			r.Close()
			files[f.Name] = b.String()
		}
		return files
	}
	files := unzip(d.Version)
	if len(files) != 3 || files["dots/index.js"] != gameCode || files["dots/lib/rules.mjs"] == "" {
		t.Fatalf("files = %v", files)
	}
	var listing Listing
	if err := json.Unmarshal([]byte(files["dots/listing.json"]), &listing); err != nil || listing.Languages["ko"] != "full" {
		t.Fatalf("listing.json = %q, %v", files["dots/listing.json"], err)
	}
	if files := unzip(next.Version); files["dots/index.js"] != gameCode+"// fix\n" {
		t.Fatalf("지금 버전: %v", files)
	}
}

func TestForget(t *testing.T) {
	dir := t.TempDir()
	s, _ := open(t, dir)
	a, b := member("m_a"), member("m_b")
	d, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode))
	g, err := s.Publish(a, d.ID, publishing("dots", d))
	if err != nil {
		t.Fatal(err)
	}
	draft, _ := s.NewDraft(a, makeZip(t, "index.js", gameCode+"// 다음 버전\n"))
	db, _ := s.NewDraft(b, makeZip(t, "index.js", gameCode))
	if _, err := s.Publish(b, db.ID, publishing("lines", db)); err != nil {
		t.Fatal(err)
	}

	if err := s.Forget("m_a"); err != nil {
		t.Fatal(err)
	}
	check := func(s *Store) {
		t.Helper()
		var ids []string
		for _, g := range s.Games() {
			ids = append(ids, g.ID)
		}
		if !slices.Equal(ids, []string{"lines"}) {
			t.Fatalf("로비 = %v", ids)
		}
		if mine := s.Mine("m_a").Games; len(mine) != 1 || !mine[0].Hidden {
			t.Fatalf("Mine = %+v", mine)
		}
		// 코드는 남아 기보를 다시볼 수 있고, id는 다른 사람이 쓰지 못합니다
		if _, err := s.gameFile("dots", g.Version, "index.js"); err != nil {
			t.Fatalf("code: %v", err)
		}
		d, _ := s.NewDraft(b, makeZip(t, "index.js", gameCode))
		if _, err := s.Publish(b, d.ID, publishing("dots", d)); !errors.Is(err, ErrTaken) {
			t.Fatalf("남의 id: %v", err)
		}
	}
	check(s)
	if _, err := s.draftFile(draft.ID, "index.js"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("초안은 지웁니다: %v", err)
	}
	again, _ := open(t, dir)
	check(again)
}
