package comment

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func guest(id string) identity.User {
	return identity.User{ID: id, Kind: identity.KindGuest, Tag: "1234"}
}

// open은 시계를 마음대로 넘길 수 있는 Store입니다.
func open(t *testing.T, dir string) (*Store, *time.Time) {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	return s, &now
}

func TestPostListDelete(t *testing.T) {
	s, now := open(t, t.TempDir())
	a, b := guest("g_a"), guest("g_b")
	first, err := s.Post("tictactoe", a, "  재밌어요\r\n한 판 더  ")
	if err != nil {
		t.Fatal(err)
	}
	if first.Text != "재밌어요\n한 판 더" || !first.Mine {
		t.Fatalf("다듬은 글이 다릅니다: %+v", first)
	}
	*now = now.Add(time.Second)
	if _, err := s.Post("tictactoe", b, "규칙이 헷갈려요"); err != nil {
		t.Fatal(err)
	}

	list, count, err := s.List("tictactoe", "g_a")
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 || len(list) != 2 || list[0].Text != "규칙이 헷갈려요" || list[0].Mine || !list[1].Mine {
		t.Fatalf("최근 것부터 와야 합니다: %+v", list)
	}

	if err := s.Delete("tictactoe", first.ID, b); !errors.Is(err, ErrNotYours) {
		t.Fatalf("남의 의견은 못 지웁니다: %v", err)
	}
	if err := s.Delete("tictactoe", first.ID, a); err != nil {
		t.Fatal(err)
	}
	if _, count, _ := s.List("tictactoe", ""); count != 1 {
		t.Fatalf("지운 의견은 빠져야 합니다: %d", count)
	}
}

func TestPostLimits(t *testing.T) {
	s, now := open(t, t.TempDir())
	a := guest("g_a")
	if _, err := s.Post("tictactoe", a, " \n\t "); !errors.Is(err, ErrEmpty) {
		t.Fatalf("빈 글: %v", err)
	}
	if _, err := s.Post("tictactoe", a, strings.Repeat("가", MaxText+1)); !errors.Is(err, ErrTooLong) {
		t.Fatalf("긴 글: %v", err)
	}
	if _, err := s.Post("tictactoe", a, strings.Repeat("줄\n", MaxLines)+"끝"); !errors.Is(err, ErrTooLong) {
		t.Fatalf("줄이 많은 글: %v", err)
	}
	if _, err := s.Post("../etc", a, "안녕"); !errors.Is(err, ErrBadGame) {
		t.Fatalf("게임 id 모양: %v", err)
	}
	if _, err := s.Post("tictactoe", a, strings.Repeat("가", MaxText)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Post("othello", a, "다른 게임"); !errors.Is(err, ErrTooSoon) {
		t.Fatalf("바로 또 남기면 안 됩니다: %v", err)
	}
	*now = now.Add(PostEvery)
	if _, err := s.Post("othello", a, "다른 게임"); err != nil {
		t.Fatal(err)
	}
}

func TestReportsHideComment(t *testing.T) {
	dir := t.TempDir()
	s, _ := open(t, dir)
	c, _ := s.Post("tictactoe", guest("g_author"), "광고 글")
	if _, err := s.Report(guest("g_author"), Report{Game: "tictactoe", Comment: c.ID, Reason: "spam"}); !errors.Is(err, ErrOwn) {
		t.Fatalf("내 의견은 신고할 수 없습니다: %v", err)
	}
	if _, err := s.Report(guest("g_1"), Report{Game: "tictactoe", Comment: c.ID, Reason: "nope"}); !errors.Is(err, ErrBadReason) {
		t.Fatalf("사유: %v", err)
	}
	for i, by := range []string{"g_1", "g_1", "g_2", "g_3"} {
		hidden, err := s.Report(guest(by), Report{Game: "tictactoe", Comment: c.ID, Reason: "spam"})
		if err != nil {
			t.Fatal(err)
		}
		// 같은 사람의 두 번째 신고는 세지 않습니다
		if want := i == 3; hidden != want {
			t.Fatalf("%d번째 신고 뒤 가려짐 = %v", i+1, hidden)
		}
	}
	list, _, _ := s.List("tictactoe", "g_1")
	if !list[0].Hidden || list[0].Text != "" || !list[0].Reported {
		t.Fatalf("가린 의견은 글을 보내지 않습니다: %+v", list[0])
	}

	// 다시 열어도 그대로입니다
	again, _ := open(t, dir)
	list, count, _ := again.List("tictactoe", "g_2")
	if count != 1 || !list[0].Hidden || !list[0].Reported {
		t.Fatalf("다시 연 뒤: %+v", list)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "reports.jsonl"))
	if n := strings.Count(string(data), "\n"); n != 3 {
		t.Fatalf("신고 기록은 세 줄이어야 합니다: %d\n%s", n, data)
	}
}

func TestReportGame(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	u := guest("g_1")
	r := Report{Game: "tictactoe", Reason: "broken", Detail: "  시작하자마자\t멈춰요 "}
	for range 2 {
		if _, err := s.Report(u, r); err != nil {
			t.Fatal(err)
		}
	}
	again, _ := open(t, dir)
	if _, err := again.Report(u, r); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "reports.jsonl"))
	if strings.Count(string(data), "\n") != 1 || !strings.Contains(string(data), `"detail":"시작하자마자 멈춰요"`) {
		t.Fatalf("같은 게임 신고는 한 번만 남습니다:\n%s", data)
	}

	// 한 시간에 ReportsPerHour번까지
	games := []string{}
	for i := range ReportsPerHour {
		games = append(games, "game-"+string(rune('a'+i)))
	}
	for i, g := range games {
		_, err := s.Report(u, Report{Game: g, Reason: "other"})
		if want := i+1 >= ReportsPerHour; errors.Is(err, ErrTooMany) != want {
			t.Fatalf("%d번째 신고: %v", i+2, err)
		}
	}
	*now = now.Add(time.Hour)
	if _, err := s.Report(u, Report{Game: "game-z", Reason: "other"}); err != nil {
		t.Fatal(err)
	}
}

func TestModerate(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	s.Names = names{"m_author": "지금 이름"}
	spam, _ := s.Post("tictactoe", identity.Member("m_author", "옛 이름"), "광고 글")
	*now = now.Add(time.Minute)
	rude, _ := s.Post("tictactoe", guest("g_rude"), "막말")

	if err := s.Moderate("tictactoe", "AAAAAAAA", ModHidden, "m_admin"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("없는 의견: %v", err)
	}
	for _, by := range []string{"g_1", "g_2", "g_3"} {
		s.Report(guest(by), Report{Game: "tictactoe", Comment: spam.ID, Reason: "spam"})
	}
	// 운영자가 보이게 하면 신고가 쌓여도 보입니다
	if err := s.Moderate("tictactoe", spam.ID, ModShown, "m_admin"); err != nil {
		t.Fatal(err)
	}
	s.Report(guest("g_4"), Report{Game: "tictactoe", Comment: spam.ID, Reason: "spam"})
	// 신고가 없어도 운영자가 가릴 수 있습니다
	if err := s.Moderate("tictactoe", rude.ID, ModHidden, "m_admin"); err != nil {
		t.Fatal(err)
	}

	again, _ := open(t, dir)
	again.Names = s.Names
	list, _, _ := again.List("tictactoe", "")
	if len(list) != 2 || !list[0].Hidden || list[0].Text != "" || list[1].Hidden || list[1].Text != "광고 글" {
		t.Fatalf("다시 연 뒤: %+v", list)
	}
	info, err := again.Info("tictactoe", spam.ID)
	if err != nil || info.Author.ID != "m_author" || info.Author.Name != "지금 이름" || info.Text != "광고 글" ||
		info.Hidden || info.Mod != ModShown || info.Reporters != 4 {
		t.Fatalf("Info = %+v, %v", info, err)
	}
	// 신고 수로 정하게 되돌리면 다시 가려집니다
	again.Moderate("tictactoe", spam.ID, "", "m_admin")
	if info, _ := again.Info("tictactoe", spam.ID); !info.Hidden || info.Mod != "" {
		t.Fatalf("되돌린 뒤 Info = %+v", info)
	}
	if _, err := again.Info("tictactoe", "AAAAAAAA"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("없는 의견 Info: %v", err)
	}

	reports, err := again.Reports()
	if err != nil || len(reports) != 4 || reports[0].By != "g_1" || reports[3].By != "g_4" || reports[0].Comment != spam.ID {
		t.Fatalf("Reports = %+v, %v", reports, err)
	}
}

// suspendedNames는 정지도 알려 주는 테스트용 계정 저장소입니다. 모든 계정이 영구 정지입니다.
type suspendedNames struct{ names }

func (suspendedNames) Suspension(string) (time.Time, bool) { return time.Time{}, true }

// names는 테스트용 계정 저장소입니다.
type names map[string]string

func (n names) Name(id string) (string, bool) {
	name, ok := n[id]
	return name, ok
}

func TestHTTP(t *testing.T) {
	s, _ := open(t, t.TempDir())
	ids := identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	h := Handler{Store: s, IDs: ids}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/games/{game}/comments", h.ServeList)
	mux.HandleFunc("POST /api/games/{game}/comments", h.ServePost)
	mux.HandleFunc("DELETE /api/games/{game}/comments/{id}", h.ServeDelete)
	mux.HandleFunc("POST /api/reports", h.ServeReport)
	ids.Members = names{"m_web": "web"}
	guestCookie := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(guest("g_web"))}
	cookie := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(identity.Member("m_web", ""))}

	do := func(method, path, ctype, body string, withCookie bool, extra ...*http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if withCookie {
			req.AddCookie(cookie)
		}
		for _, c := range extra {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	if rec := do("POST", "/api/games/tictactoe/comments", "application/json", `{"text":"hi"}`, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("쿠키 없이: %d", rec.Code)
	}
	if rec := do("POST", "/api/games/tictactoe/comments", "application/json", `{"text":"hi"}`, false, guestCookie); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "member only") {
		t.Fatalf("게스트: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/games/tictactoe/comments", "text/plain", `{"text":"hi"}`, true); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("JSON이 아닌 본문: %d", rec.Code)
	}
	rec := do("POST", "/api/games/tictactoe/comments", "application/json", `{"text":"hi"}`, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("남기기: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/games/tictactoe/comments", "application/json", `{"text":"again"}`, true); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("바로 또: %d", rec.Code)
	}
	rec = do("GET", "/api/games/tictactoe/comments", "", "", true)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"mine":true`) || !strings.Contains(rec.Body.String(), `"count":1`) {
		t.Fatalf("목록: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "m_web") {
		t.Fatalf("내부 id를 보내면 안 됩니다: %s", rec.Body)
	}
	if rec := do("POST", "/api/reports", "application/json", `{"game":"tictactoe","reason":"copyright"}`, false, guestCookie); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "member only") {
		t.Fatalf("게스트 신고: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/reports", "application/json", `{"game":"tictactoe","reason":"copyright"}`, true); rec.Code != http.StatusOK {
		t.Fatalf("게임 신고: %d %s", rec.Code, rec.Body)
	}
	if rec := do("DELETE", "/api/games/tictactoe/comments/AAAAAAAA", "", "", true); rec.Code != http.StatusNotFound {
		t.Fatalf("없는 의견 지우기: %d", rec.Code)
	}

	// 정지된 계정은 남기기와 신고가 안 됩니다. 지우기는 됩니다
	ids.Members = suspendedNames{names{"m_web": "web"}}
	if rec := do("POST", "/api/games/tictactoe/comments", "application/json", `{"text":"hi"}`, true); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"suspended"`) {
		t.Fatalf("정지된 계정 남기기: %d %s", rec.Code, rec.Body)
	}
	if rec := do("POST", "/api/reports", "application/json", `{"game":"other","reason":"copyright"}`, true); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"suspended"`) {
		t.Fatalf("정지된 계정 신고: %d %s", rec.Code, rec.Body)
	}
	if rec := do("DELETE", "/api/games/tictactoe/comments/AAAAAAAA", "", "", true); rec.Code != http.StatusNotFound {
		t.Fatalf("정지된 계정 지우기: %d", rec.Code)
	}
}

func TestForget(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	left, stay := identity.Member("m_left", "left"), identity.Member("m_stay", "stay")
	gone1, _ := s.Post("tictactoe", left, "탈퇴할 사람의 글")
	*now = now.Add(time.Minute)
	kept, _ := s.Post("tictactoe", stay, "남는 사람의 글")
	*now = now.Add(time.Minute)
	gone2, _ := s.Post("dots", left, "다른 게임의 글")
	// 지운 의견과 남의 신고를 받은 의견도 같이 사라집니다
	s.Delete("dots", gone2.ID, left)
	*now = now.Add(time.Minute)
	s.Post("dots", left, "또 쓴 글")
	s.Report(stay, Report{Game: "tictactoe", Comment: gone1.ID, Reason: "spam"})
	// 탈퇴할 사람이 남의 의견에 한 신고는 남습니다 (가린 수)
	s.Report(left, Report{Game: "tictactoe", Comment: kept.ID, Reason: "spam"})
	s.Post("othello", stay, "탈퇴할 사람의 글이 없는 게임")
	before, _ := os.ReadFile(filepath.Join(dir, "comments", "othello.jsonl"))

	if err := s.Forget("m_left"); err != nil {
		t.Fatal(err)
	}
	check := func(s *Store) {
		t.Helper()
		list, count, _ := s.List("tictactoe", "m_stay")
		if count != 1 || list[0].ID != kept.ID {
			t.Fatalf("tictactoe = %+v", list)
		}
		if _, count, _ := s.List("dots", ""); count != 0 {
			t.Fatalf("dots count = %d", count)
		}
		if list[0].Hidden {
			t.Fatal("한 사람의 신고로는 가려지지 않습니다")
		}
		if _, err := s.Report(left, Report{Game: "tictactoe", Comment: kept.ID, Reason: "spam"}); err != nil {
			t.Fatal(err) // 이미 신고한 것으로 칩니다 (신고 줄이 남음)
		}
	}
	check(s)
	again, _ := open(t, dir)
	check(again)

	for _, game := range []string{"tictactoe", "dots"} {
		data, _ := os.ReadFile(filepath.Join(dir, "comments", game+".jsonl"))
		for _, gone := range []string{"탈퇴할 사람의 글", "다른 게임의 글", "또 쓴 글", `"name":"left"`, gone1.ID, gone2.ID} {
			if strings.Contains(string(data), gone) {
				t.Errorf("%s still has %s:\n%s", game, gone, data)
			}
		}
	}
	if after, _ := os.ReadFile(filepath.Join(dir, "comments", "othello.jsonl")); string(after) != string(before) {
		t.Error("탈퇴할 사람의 글이 없는 파일은 그대로 둡니다")
	}
}

// 남길 때의 이름 대신 지금 계정 이름을 보내고, 없는 계정(탈퇴)은 이름 없이 보냅니다.
func TestAuthorNames(t *testing.T) {
	s, _ := open(t, t.TempDir())
	s.Post("tictactoe", identity.Member("m_a", "old"), "hi")
	s.Names = names{"m_a": "new"}
	if list, _, _ := s.List("tictactoe", ""); list[0].Author.Name != "new" || list[0].Author.Kind != identity.KindMember {
		t.Fatalf("renamed = %+v", list[0].Author)
	}
	s.Names = names{}
	if list, _, _ := s.List("tictactoe", ""); list[0].Author.Kind != identity.KindGone || list[0].Author.Name != "" || list[0].Author.Tag != "" {
		t.Fatalf("deleted = %+v", list[0].Author)
	}
}
