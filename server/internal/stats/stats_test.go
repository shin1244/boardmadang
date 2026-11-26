package stats

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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
		if !reflect.DeepEqual(out[i], want[i]) {
			t.Fatalf("day %d = %+v, want %+v", i, out[i], want[i])
		}
	}

	// 끝난 날의 수는 days.jsonl에 남아 다시 켜도 같습니다
	tr2, _ := open(dir, c.now)
	out2, _ := tr2.Range(5)
	for i := range want {
		if !reflect.DeepEqual(out2[i], want[i]) {
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
	if since != "2026-10-01" || !reflect.DeepEqual(out[0], Visits{Day: "2026-10-01", Visitors: 1, Members: 1, MAU: 1, MAUMembers: 1}) {
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
	if since != "" || len(out) != 3 || !reflect.DeepEqual(out[2], Visits{Day: "2026-11-04"}) || out[0].Day != "2026-11-02" {
		t.Fatalf("empty: %q %+v", since, out)
	}
}

// 나라는 그날 처음 왔을 때의 나라로 세고, 끝난 날의 수(days.jsonl)와 다시 켠 뒤에도 남습니다. IP 주소는 어디에도 남지 않습니다.
func TestCountries(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-11-01 10:00")}
	tr, _ := open(dir, c.now)
	from := map[string]string{"1.1.1.1": "KR", "2.2.2.2": "US", "3.3.3.3": "kr", "4.4.4.4": ""}
	tr.Locate = func(r *http.Request) string { return from[r.RemoteAddr] }
	visit := func(ip, id string) {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.RemoteAddr = ip
		tr.Visit(r, identity.User{ID: id, Kind: identity.KindGuest})
	}
	visit("4.4.4.4", "g_1") // 나라를 모름
	visit("1.1.1.1", "g_1") // 다시 오면 나라를 채움
	visit("2.2.2.2", "g_1") // 나라를 안 뒤로는 그대로 KR
	visit("2.2.2.2", "g_2")
	visit("3.3.3.3", "g_3") // 나라 코드 모양이 아니면 모름
	visit("4.4.4.4", "g_4") // 모름
	tr.Seen("m_alice", true)
	want := map[string]int{"KR": 1, "US": 1}
	if got := last(t, tr, 1); got.Visitors != 5 || !reflect.DeepEqual(got.Countries, want) {
		t.Fatalf("today = %+v", got)
	}

	c.t = kst("2026-11-02 10:00")
	visit("2.2.2.2", "g_1")
	out, _ := tr.Range(2)
	if !reflect.DeepEqual(out[0].Countries, want) || !reflect.DeepEqual(out[1].Countries, map[string]int{"US": 1}) {
		t.Fatalf("Range = %+v", out)
	}
	days, _ := os.ReadFile(filepath.Join(dir, "stats", "days.jsonl"))
	if !strings.Contains(string(days), `"countries":{"KR":1,"US":1}`) {
		t.Errorf("days.jsonl = %s", days)
	}
	for _, f := range []string{"stats/days.jsonl", "stats/visits/2026-11-01.log", "stats/visits/2026-11-02.log"} {
		data, _ := os.ReadFile(filepath.Join(dir, f))
		if strings.Contains(string(data), "1.1.1.1") || strings.Contains(string(data), "2.2.2.2") {
			t.Errorf("%s에 IP 주소가 남았습니다: %s", f, data)
		}
	}

	// 다시 켜면 오늘 파일에서 나라를 다시 읽습니다. 예전 모양(나라 없는 줄)과 깨진 나라도 읽습니다
	file := filepath.Join(dir, "stats", "visits", "2026-11-02.log")
	f, _ := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("g 0123456789abcdef\ng fedcba9876543210 <script>\n")
	f.Close()
	tr2, _ := open(dir, c.now)
	if got := last(t, tr2, 1); got.Visitors != 3 || !reflect.DeepEqual(got.Countries, map[string]int{"US": 1}) {
		t.Fatalf("after restart = %+v", got)
	}
}

// 나라를 모른 채 센 사람이 그날 다시 오면 나라를 채우고, 다시 켜도 한 사람으로 그 나라에 셉니다
func TestCountryFilledLater(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-11-01 10:00")}
	tr, _ := open(dir, c.now)
	tr.Seen("m_alice", true) // 나라를 세기 전 (배포 전)에 옴
	tr.Locate = func(*http.Request) string { return "KR" }
	tr.Visit(httptest.NewRequest("GET", "/api/me", nil), identity.User{ID: "m_alice", Kind: identity.KindMember})
	tr.Visit(httptest.NewRequest("GET", "/api/me", nil), identity.User{ID: "m_alice", Kind: identity.KindMember})
	want := map[string]int{"KR": 1}
	if got := last(t, tr, 1); got.Visitors != 1 || got.Members != 1 || !reflect.DeepEqual(got.Countries, want) {
		t.Fatalf("today = %+v", got)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "stats", "visits", "2026-11-01.log"))
	if lines := strings.Count(string(data), "\n"); lines != 2 {
		t.Errorf("visit file has %d lines: %q", lines, data)
	}
	tr2, _ := open(dir, c.now)
	if got := last(t, tr2, 1); got.Visitors != 1 || got.Members != 1 || !reflect.DeepEqual(got.Countries, want) {
		t.Fatalf("after restart = %+v", got)
	}
}

// 리텐션: 기록이 남은 첫 7일 뒤부터, 그날 처음 온 사람이 다음 날, 7일째, 언제든 다시 왔는지 셉니다
func TestRetention(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-10-25 10:00")}
	tr, _ := open(dir, c.now)
	tr.Seen("g_old", false) // 기록의 첫날에 온 사람: 11월 1일에 다시 와도 새로 온 사람이 아님
	if got := tr.Retention(30); len(got) != 0 {
		t.Fatalf("기록이 7일 안 됐는데 %+v", got)
	}
	at := func(day string, ids ...string) {
		c.t = kst(day + " 12:00")
		for _, id := range ids {
			tr.Seen(id, strings.HasPrefix(id, "m_"))
		}
	}
	at("2026-11-01", "g_old", "g_a", "m_b")
	at("2026-11-02", "g_a")
	at("2026-11-08", "m_b", "g_c")
	at("2026-11-09", "g_a", "g_c")

	ptr := func(n int) *int { return &n }
	want := map[string]Cohort{
		"2026-11-01": {Day: "2026-11-01", New: 2, D1: ptr(1), D7: ptr(1), Returned: 2},
		"2026-11-02": {Day: "2026-11-02", New: 0, D1: ptr(0), D7: ptr(0), Returned: 0},
		"2026-11-08": {Day: "2026-11-08", New: 1, D1: ptr(1), D7: nil, Returned: 1}, // 9일이 오늘: 지금까지
		"2026-11-09": {Day: "2026-11-09", New: 0, D1: nil, D7: nil, Returned: 0},
	}
	got := tr.Retention(30)
	if len(got) != 9 || got[0].Day != "2026-11-01" || got[8].Day != "2026-11-09" {
		t.Fatalf("days: %d %+v", len(got), got)
	}
	for _, g := range got {
		if w, ok := want[g.Day]; ok && !reflect.DeepEqual(g, w) {
			t.Errorf("%s = %+v (d1 %v d7 %v), want %+v", g.Day, g, deref(g.D1), deref(g.D7), w)
		}
	}
	// 짧은 기간을 봐도 새로 온 사람은 앞의 기록 전체로 가립니다
	if short := tr.Retention(2); len(short) != 2 || !reflect.DeepEqual(short[0], want["2026-11-08"]) {
		t.Fatalf("Retention(2) = %+v", short)
	}
	// 다시 켜도 같습니다 (방문 파일에서 읽음)
	tr2, _ := open(dir, c.now)
	if again := tr2.Retention(30); !reflect.DeepEqual(again, got) {
		t.Fatalf("after restart = %+v", again)
	}
}

func deref(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}
