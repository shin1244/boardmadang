package stats

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// clock은 테스트에서 돌리는 시계입니다.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func kst(s string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", s, KST)
	if err != nil {
		panic(err)
	}
	return t
}

// last는 Range의 마지막 날(오늘)입니다.
func last(t *testing.T, tr *Tracker, n int) Visits {
	t.Helper()
	out, _ := tr.Range(n)
	return out[len(out)-1]
}

func TestDayIsKST(t *testing.T) {
	if got := Day(time.Date(2026, 11, 3, 14, 59, 0, 0, time.UTC)); got != "2026-11-03" {
		t.Fatalf("23:59 KST = %s", got)
	}
	if got := Day(time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)); got != "2026-11-04" {
		t.Fatalf("00:00 KST = %s", got)
	}
	if got := AddDays("2026-11-04", -30); got != "2026-10-05" {
		t.Fatalf("AddDays = %s", got)
	}
}

func TestCountsOncePerDay(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-11-04 09:00")}
	tr, err := open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	tr.Seen("m_alice", true)
	tr.Seen("m_alice", true)
	tr.Seen("g_1", false)
	tr.Seen("g_2", false)
	if v := last(t, tr, 1); v.Day != "2026-11-04" || v.Visitors != 3 || v.Members != 1 || v.MAU != 3 || v.MAUMembers != 1 {
		t.Fatalf("today: %+v", v)
	}

	// 파일에는 번호 대신 해시만 남습니다
	data, _ := os.ReadFile(filepath.Join(dir, "stats", "visits", "2026-11-04.log"))
	if strings.Contains(string(data), "alice") || strings.Contains(string(data), "g_1") || strings.Count(string(data), "\n") != 3 {
		t.Fatalf("visit file:\n%s", data)
	}

	// 서버를 다시 켜도 같은 사람을 두 번 세지 않습니다 (키도 그대로)
	tr2, err := open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	tr2.Seen("m_alice", true)
	tr2.Seen("g_3", false)
	if v := last(t, tr2, 1); v.Visitors != 4 || v.Members != 1 {
		t.Fatalf("after restart: %+v", v)
	}
}

func TestDaysAndMAU(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-11-01 23:59")}
	tr, _ := open(dir, c.now)
	tr.Seen("m_alice", true)
	tr.Seen("g_1", false)

	c.t = kst("2026-11-02 00:00") // 자정이 지나면 새 날
	tr.Seen("m_alice", true)
	tr.Seen("m_bob", true)
	// 11월 3일에는 아무도 오지 않았습니다
	c.t = kst("2026-11-04 12:00")
	tr.Seen("g_2", false)

	out, since := tr.Range(5)
	if since != "2026-11-01" {
		t.Fatalf("since = %q", since)
	}
	want := []Visits{
		{Day: "2026-10-31"},
		{Day: "2026-11-01", Visitors: 2, Members: 1, MAU: 2, MAUMembers: 1},
		{Day: "2026-11-02", Visitors: 2, Members: 2, MAU: 3, MAUMembers: 2},
		{Day: "2026-11-03", MAU: 3, MAUMembers: 2}, // 아무도 오지 않은 날도 MAU는 있습니다
		{Day: "2026-11-04", Visitors: 1, MAU: 4, MAUMembers: 2},
	}
	for i := range want {
		if out[i] != want[i] {
			t.Fatalf("day %d = %+v, want %+v", i, out[i], want[i])
		}
	}

	// 끝난 날의 수는 days.jsonl에 남아 다시 켜도 같습니다
	tr2, _ := open(dir, c.now)
	out2, _ := tr2.Range(5)
	for i := range want {
		if out2[i] != want[i] {
			t.Fatalf("after restart day %d = %+v, want %+v", i, out2[i], want[i])
		}
	}
}

func TestOldDaysAreDeleted(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-10-01 10:00")}
	tr, _ := open(dir, c.now)
	tr.Seen("m_alice", true)
	c.t = kst("2026-10-30 10:00") // 30일째: 10월 1일은 아직 MAU에 들어갑니다
	tr.Seen("g_1", false)
	if v := last(t, tr, 1); v.MAU != 2 {
		t.Fatalf("day 30: %+v", v)
	}
	c.t = kst("2026-10-31 10:00") // 31일째: 10월 1일은 빠지고 그날 파일을 지웁니다
	if v := last(t, tr, 1); v.MAU != 1 || v.MAUMembers != 0 {
		t.Fatalf("day 31: %+v", v)
	}
	if _, err := os.Stat(filepath.Join(dir, "stats", "visits", "2026-10-01.log")); !os.IsNotExist(err) {
		t.Fatalf("old visit file still there: %v", err)
	}
	// 지운 날의 수는 남습니다
	out, since := tr.Range(31)
	if since != "2026-10-01" || out[0] != (Visits{Day: "2026-10-01", Visitors: 1, Members: 1, MAU: 1, MAUMembers: 1}) {
		t.Fatalf("closed day: %q %+v", since, out[0])
	}
	// 같은 사람이 다시 와도 새로 셉니다
	tr.Seen("m_alice", true)
	if v := last(t, tr, 1); v.Visitors != 1 || v.MAU != 2 {
		t.Fatalf("returning: %+v", v)
	}
}

func TestSkipsBots(t *testing.T) {
	c := &clock{kst("2026-11-04 09:00")}
	tr, _ := open(t.TempDir(), c.now)
	for _, agent := range []string{
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
	} {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.Header.Set("User-Agent", agent)
		tr.Visit(r, identity.User{ID: "g_bot", Kind: identity.KindGuest})
	}
	r := httptest.NewRequest("GET", "/api/me", nil)
	r.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")
	tr.Visit(r, identity.User{ID: "m_alice", Kind: identity.KindMember})
	if v := last(t, tr, 1); v.Visitors != 1 || v.Members != 1 {
		t.Fatalf("bots counted: %+v", v)
	}
}

func TestNothingYet(t *testing.T) {
	c := &clock{kst("2026-11-04 09:00")}
	tr, _ := open(t.TempDir(), c.now)
	out, since := tr.Range(3)
	if since != "" || len(out) != 3 || out[2] != (Visits{Day: "2026-11-04"}) || out[0].Day != "2026-11-02" {
		t.Fatalf("empty: %q %+v", since, out)
	}
}
