package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/comment"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

var base = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

// fixture는 운영자 하나, 의견을 쓴 사람, 신고한 두 사람, 올린 게임 dots가 있는 운영자 API입니다.
type fixture struct {
	h                    *Handler
	mux                  *http.ServeMux
	dir                  string
	clock                *time.Time
	boss, author, r1, r2 identity.User
	comment              string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	dir := t.TempDir()
	accounts, err := account.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	comments, err := comment.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	comments.Names = accounts
	// 올린 게임은 등록 절차 대신 game.json을 바로 씁니다
	meta := `{"id":"dots","owner":"%s","version":"0123456789abcdef","listing":{},"thumbnail":null,"created":"2026-11-01T00:00:00Z","published":[{"version":"0123456789abcdef","at":"2026-11-01T00:00:00Z"}]}`
	f := &fixture{dir: dir}
	f.boss, _, _ = accounts.Create("google", "1", "boss")
	f.author, _, _ = accounts.Create("google", "2", "author")
	f.r1, _, _ = accounts.Create("google", "3", "report1")
	f.r2, _, _ = accounts.Create("google", "4", "report2")
	os.MkdirAll(filepath.Join(dir, "uploads", "dots"), 0o755)
	os.WriteFile(filepath.Join(dir, "uploads", "dots", "game.json"), []byte(strings.Replace(meta, "%s", f.author.ID, 1)), 0o644)
	uploads, err := upload.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := comments.Post("tictactoe", f.author, "광고 글")
	if err != nil {
		t.Fatal(err)
	}
	f.comment = c.ID

	ids := identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	ids.Members = accounts
	ids.Admins = map[string]bool{f.boss.ID: true}
	f.h, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	f.h.IDs, f.h.Comments, f.h.Uploads, f.h.Accounts = ids, comments, uploads, accounts
	clock := base.Add(10 * time.Minute)
	f.clock = &clock
	f.h.now = func() time.Time { return *f.clock }
	f.mux = http.NewServeMux()
	f.mux.HandleFunc("GET /api/admin", f.h.ServeState)
	f.mux.HandleFunc("POST /api/admin/actions", f.h.ServeAction)

	// 신고는 시간을 정하려고 reports.jsonl에 바로 씁니다
	f.report(comment.Report{At: base, Game: "tictactoe", Comment: f.comment, By: f.r1.ID, Reason: "spam"})
	f.report(comment.Report{At: base.Add(time.Minute), Game: "tictactoe", Comment: f.comment, By: f.r2.ID, Reason: "abuse"})
	f.report(comment.Report{At: base.Add(2 * time.Minute), Game: "dots", By: f.r1.ID, Reason: "broken"})
	f.report(comment.Report{At: base.Add(3 * time.Minute), Game: "tictactoe", By: f.r2.ID, Reason: "copyright", Detail: "베낀 게임"})
	return f
}

func (f *fixture) report(r comment.Report) {
	data, _ := json.Marshal(r)
	file, _ := os.OpenFile(filepath.Join(f.dir, "reports.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	file.Write(append(data, '\n'))
	file.Close()
}

func (f *fixture) do(method, ctype, body string, u *identity.User) *httptest.ResponseRecorder {
	path := "/api/admin"
	if method == "POST" {
		path += "/actions"
	}
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if u != nil {
		req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: f.h.IDs.Sign(*u)})
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	return rec
}

// act는 운영자로 조치를 보내고 상태 코드와 오류를 돌려줍니다.
func (f *fixture) act(a Action) (int, string) {
	body, _ := json.Marshal(a)
	rec := f.do("POST", "application/json", string(body), &f.boss)
	var out struct{ Error string }
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out.Error
}

func (f *fixture) state(t *testing.T) State {
	t.Helper()
	rec := f.do("GET", "", "", &f.boss)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/admin = %d %s", rec.Code, rec.Body)
	}
	var st State
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// order는 대상을 "게임/의견:open" 모양으로 늘어놓습니다.
func order(st State) []string {
	var out []string
	for _, t := range st.Targets {
		s := t.Game + "/" + t.Comment
		if t.Open {
			s += ":open"
		}
		out = append(out, s)
	}
	return out
}

func TestOnlyAdmins(t *testing.T) {
	f := setup(t)
	guest, _ := f.h.IDs.NewGuest()
	if rec := f.do("GET", "", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", rec.Code)
	}
	for _, u := range []identity.User{guest, f.author} {
		for _, method := range []string{"GET", "POST"} {
			rec := f.do(method, "application/json", `{"action":"dismiss","game":"dots"}`, &u)
			if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "admin only") {
				t.Fatalf("%s by %s: %d %s", method, u.ID, rec.Code, rec.Body)
			}
		}
	}
	if rec := f.do("POST", "text/plain", `{"action":"dismiss","game":"dots"}`, &f.boss); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form body: %d", rec.Code)
	}
	if rec := f.do("GET", "", "", &f.boss); rec.Code != http.StatusOK {
		t.Fatalf("admin: %d", rec.Code)
	}
}

func TestReportQueue(t *testing.T) {
	f := setup(t)
	cm := "tictactoe/" + f.comment

	// 아무 조치도 없을 때도 목록은 null이 아니라 []입니다 (화면이 그대로 씁니다)
	if rec := f.do("GET", "", "", &f.boss); !strings.Contains(rec.Body.String(), `"log":[]`) || !strings.Contains(rec.Body.String(), `"suspended":[]`) {
		t.Fatalf("빈 목록: %s", rec.Body)
	}
	st := f.state(t)
	if got, want := strings.Join(order(st), " "), "tictactoe/:open dots/:open "+cm+":open"; got != want {
		t.Fatalf("targets = %s, want %s", got, want)
	}
	c := st.Targets[2]
	if c.CommentInfo == nil || c.CommentInfo.Text != "광고 글" || c.CommentInfo.Author.ID != f.author.ID || c.GameInfo != nil {
		t.Fatalf("comment target = %+v", c)
	}
	if len(c.Reports) != 2 || c.Reports[0].By != f.r2.ID || !c.Latest.Equal(base.Add(time.Minute)) {
		t.Fatalf("최근 신고부터: %+v", c.Reports)
	}
	if g := st.Targets[1].GameInfo; g == nil || g.Owner != f.author.ID {
		t.Fatalf("올린 게임은 주인이 보입니다: %+v", st.Targets[1])
	}
	if st.Targets[0].GameInfo != nil || st.Targets[0].Reports[0].Detail != "베낀 게임" {
		t.Fatalf("레포 게임: %+v", st.Targets[0])
	}
	for _, u := range []identity.User{f.author, f.r1, f.r2} {
		if got := st.Users[u.ID]; got.Name != u.Name || got.Tag == "" {
			t.Fatalf("Users[%s] = %+v", u.ID, got)
		}
	}

	// 가리면 그 의견의 신고는 처리한 것으로 칩니다
	if code, err := f.act(Action{Action: CommentHide, Game: "tictactoe", Comment: f.comment, Note: " 광고 "}); code != 200 {
		t.Fatalf("hide: %d %s", code, err)
	}
	if info, _ := f.h.Comments.Info("tictactoe", f.comment); !info.Hidden || info.Mod != comment.ModHidden {
		t.Fatalf("숨기지 않았습니다: %+v", info)
	}
	st = f.state(t)
	if got, want := strings.Join(order(st), " "), "tictactoe/:open dots/:open "+cm; got != want {
		t.Fatalf("after hide = %s", got)
	}
	if a := st.Targets[2].LastAction; a == nil || a.Action != CommentHide || a.By != f.boss.ID || a.Note != "광고" || !a.At.Equal(*f.clock) {
		t.Fatalf("LastAction = %+v", a)
	}

	// 조치한 뒤에 새 신고가 오면 다시 새 신고입니다
	f.report(comment.Report{At: base.Add(20 * time.Minute), Game: "tictactoe", Comment: f.comment, By: f.author.ID, Reason: "other"})
	if got := order(f.state(t)); got[0] != cm+":open" {
		t.Fatalf("after new report = %v", got)
	}

	// 바꿀 것이 없으면 dismiss로 처리합니다
	*f.clock = base.Add(30 * time.Minute)
	for _, a := range []Action{{Action: Dismiss, Game: "tictactoe"}, {Action: Dismiss, Game: "tictactoe", Comment: f.comment}} {
		if code, err := f.act(a); code != 200 {
			t.Fatalf("dismiss %+v: %d %s", a, code, err)
		}
	}
	if got, want := strings.Join(order(f.state(t)), " "), "dots/:open "+cm+" tictactoe/"; got != want {
		t.Fatalf("after dismiss = %s", got)
	}

	// 의견을 다시 보이게
	if code, _ := f.act(Action{Action: CommentShow, Game: "tictactoe", Comment: f.comment}); code != 200 {
		t.Fatal(code)
	}
	if info, _ := f.h.Comments.Info("tictactoe", f.comment); info.Hidden || info.Mod != comment.ModShown {
		t.Fatalf("보이지 않습니다: %+v", info)
	}

	// 잘못된 조치
	for _, c := range []struct {
		a    Action
		code int
	}{
		{Action{Action: "nope", Game: "dots"}, 400},
		{Action{Action: CommentHide, Game: "dots"}, 400},                           // 의견 없음
		{Action{Action: CommentHide, Game: "tictactoe", Comment: "AAAAAAAA"}, 404}, // 없는 의견
		{Action{Action: CommentHide, Comment: f.comment}, 400},                     // 게임 없음
		{Action{Action: Dismiss, Game: "../x"}, 400},
		{Action{Action: Dismiss}, 400},
		{Action{Action: Dismiss, Game: "dots", Note: strings.Repeat("가", MaxNote+1)}, 400},
	} {
		if code, err := f.act(c.a); code != c.code {
			t.Errorf("%+v = %d %s, want %d", c.a, code, err, c.code)
		}
	}
}

func TestBlockGame(t *testing.T) {
	f := setup(t)
	if code, _ := f.act(Action{Action: GameBlock, Game: "dots"}); code != 200 {
		t.Fatal(code)
	}
	if g, _ := f.h.Uploads.Admin("dots"); !g.Blocked {
		t.Fatalf("not blocked: %+v", g)
	}
	if len(f.h.Uploads.Games()) != 0 {
		t.Fatal("내린 게임이 로비에 있습니다")
	}
	if got := order(f.state(t)); got[len(got)-1] != "dots/" {
		t.Fatalf("내린 게임의 신고는 처리한 것: %v", got)
	}
	if code, _ := f.act(Action{Action: GameBlock, Game: "tictactoe"}); code != 404 {
		t.Fatalf("레포 게임: %d", code)
	}
	if code, _ := f.act(Action{Action: GameBlock, Game: "tictactoe", Comment: f.comment}); code != 400 {
		t.Fatalf("의견으로 게임 내리기: %d", code)
	}
	if code, _ := f.act(Action{Action: GameUnblock, Game: "dots"}); code != 200 {
		t.Fatal(code)
	}
	if len(f.h.Uploads.Games()) != 1 {
		t.Fatal("되살린 게임이 로비에 없습니다")
	}
}

func TestSuspendUser(t *testing.T) {
	f := setup(t)
	for _, c := range []struct {
		a    Action
		code int
		err  string
	}{
		{Action{Action: UserSuspend, User: f.author.ID, Days: 3}, 400, "bad action"},
		{Action{Action: UserSuspend, User: f.boss.ID, Days: 1}, 400, "cannot suspend an admin"},
		{Action{Action: UserSuspend, User: "m_nobody", Days: 1}, 404, "not found"},
		{Action{Action: UserUnsuspend, User: "m_nobody"}, 404, "not found"},
	} {
		if code, err := f.act(c.a); code != c.code || err != c.err {
			t.Errorf("%+v = %d %s", c.a, code, err)
		}
	}

	// 의견을 보고 쓴 사람을 7일 정지하면 그 의견의 신고도 처리한 것으로 칩니다
	if code, err := f.act(Action{Action: UserSuspend, User: f.author.ID, Days: 7, Game: "tictactoe", Comment: f.comment}); code != 200 {
		t.Fatalf("suspend: %d %s", code, err)
	}
	until := f.clock.Add(7 * 24 * time.Hour)
	if got, ok := f.h.Accounts.Suspension(f.author.ID); !ok || !got.Equal(until) {
		t.Fatalf("Suspension = %v, %v", got, ok)
	}
	// 영구 정지
	if code, _ := f.act(Action{Action: UserSuspend, User: f.r1.ID, Days: 0}); code != 200 {
		t.Fatal(code)
	}
	st := f.state(t)
	if len(st.Suspended) != 2 || st.Suspended[0] != f.author.ID || st.Suspended[1] != f.r1.ID {
		t.Fatalf("Suspended = %v", st.Suspended)
	}
	if u := st.Users[f.author.ID]; !u.Suspended || !u.SuspendedUntil.Equal(until) {
		t.Fatalf("Users[author] = %+v", u)
	}
	if u := st.Users[f.r1.ID]; !u.Suspended || !u.SuspendedUntil.IsZero() {
		t.Fatalf("Users[r1] = %+v", u)
	}
	if got := order(st); got[len(got)-1] != "tictactoe/"+f.comment {
		t.Fatalf("targets = %v", got)
	}
	if st.Log[0].Action != UserSuspend || st.Log[0].User != f.r1.ID || !st.Log[1].Until.Equal(until) {
		t.Fatalf("Log = %+v", st.Log)
	}

	// 정지된 사람은 쓰기가 막힙니다
	if u, _ := f.h.IDs.Refresh(f.author); !u.Suspended {
		t.Fatalf("Refresh = %+v", u)
	}
	if code, _ := f.act(Action{Action: UserUnsuspend, User: f.author.ID}); code != 200 {
		t.Fatal(code)
	}
	if u, _ := f.h.IDs.Refresh(f.author); u.Suspended {
		t.Fatalf("after unsuspend = %+v", u)
	}

	// 운영 기록은 다시 켜도 남습니다
	again, err := Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(again.actions) != 3 || again.actions[0].By != f.boss.ID || again.actions[2].Action != UserUnsuspend {
		t.Fatalf("after reopen = %+v", again.actions)
	}
}
