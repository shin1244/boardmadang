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
}
