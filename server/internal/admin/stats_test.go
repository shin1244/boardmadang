package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
	"github.com/shin1244/boardmadang/server/internal/stats"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

func (f *fixture) stats(t *testing.T, query string, u *identity.User) (int, Stats) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/admin/stats"+query, nil)
	if u != nil {
		req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: f.h.IDs.Sign(*u)})
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	var st Stats
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
			t.Fatal(err)
		}
	}
	return rec.Code, st
}

func TestStats(t *testing.T) {
	f := setup(t) // 지금은 2026-11-03 12:10 UTC (한국 11월 3일 21:10). dots는 11월 1일에 처음 등록
	// 처음 등록하고 한 번 더 등록한 게임 하나를 더 둡니다
	maze := `{"id":"maze","owner":"m_x","version":"1","listing":{},"thumbnail":null,"created":"2026-10-20T03:00:00Z",` +
		`"published":[{"version":"1","at":"2026-10-20T03:00:00Z"},{"version":"2","at":"2026-11-02T16:00:00Z"}]}`
	os.MkdirAll(filepath.Join(f.dir, "uploads", "maze"), 0o755)
	os.WriteFile(filepath.Join(f.dir, "uploads", "maze", "game.json"), []byte(maze), 0o644)
	uploads, err := upload.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.h.Uploads = uploads

	records, err := record.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(records.Close)
	match := func(game string, ended time.Time) {
		w := 0
		records.Save(&record.Match{
			ID: record.NewID(), Game: game,
			Players: [2]record.Player{{ID: "g_a", Kind: "guest"}, {ID: "g_b", Kind: "guest"}},
			Moves:   []record.Move{{Action: protocol.Action{Kind: "click"}}},
			Winner:  &w, Reason: protocol.ReasonResign, Started: ended.Add(-time.Minute), Ended: ended,
		})
	}
	match("tictactoe", base)
	match("tictactoe", base.Add(-time.Hour))
	match("dots", time.Date(2026, 11, 1, 5, 0, 0, 0, time.UTC))
	match("dots", time.Date(2026, 9, 1, 5, 0, 0, 0, time.UTC)) // 30일보다 전
	f.h.Records = records
	f.h.Live = func() (int, int) { return 3, 1 }
	// AI 대국 수는 stats가 날마다 남긴 파일에서 읽습니다 (stats의 ai.go)
	os.MkdirAll(filepath.Join(f.dir, "stats", "ai"), 0o755)
	os.WriteFile(filepath.Join(f.dir, "stats", "ai", "2026-11-03.json"),
		[]byte(`{"dots":{"plays":5,"ends":4,"wins":1,"draws":1},"maze":{"plays":1,"ends":0,"wins":0,"draws":0}}`), 0o644)
	visits, err := stats.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.h.Visits = visits

	code, st := f.stats(t, "", &f.boss)
	if code != http.StatusOK {
		t.Fatalf("GET = %d", code)
	}
	if st.Today != "2026-11-03" || len(st.Days) != DefaultStatsDays || st.Days[len(st.Days)-1].Day != st.Today || st.Days[0].Day != "2026-10-05" {
		t.Fatalf("days: today %s, %d days from %s", st.Today, len(st.Days), st.Days[0].Day)
	}
	day := func(d string) DayStats {
		i := slices.IndexFunc(st.Days, func(x DayStats) bool { return x.Day == d })
		if i < 0 {
			t.Fatalf("no day %s", d)
		}
		return st.Days[i]
	}
	if d := day("2026-11-03"); d.Plays != 2 || d.AIPlays != 6 || d.AIEnds != 4 || d.AIWins != 1 || d.AIDraws != 1 {
		t.Fatalf("11-03: %+v", d)
	}
	if d := day("2026-11-02"); d.AIPlays != 0 {
		t.Fatalf("11-02: %+v", d)
	}
	if d := day("2026-11-01"); d.Plays != 1 || d.NewGames != 1 || d.Updates != 0 {
		t.Fatalf("11-01: %+v", d)
	}
	if d := day("2026-10-20"); d.NewGames != 1 {
		t.Fatalf("10-20: %+v", d)
	}
	if d := day("2026-11-03"); d.Updates != 1 { // 11월 2일 16:00 UTC는 한국 11월 3일 1:00
		t.Fatalf("update day: %+v", d)
	}
	if st.Uploads != 2 || st.Accounts != 4 || st.Online != 3 || st.Playing != 1 {
		t.Fatalf("totals: %+v", st)
	}
	// 온라인과 AI 판을 더한 수로 줄 세웁니다: dots 1+5, tictactoe 2+0, maze 0+1
	if len(st.Top) != 3 || st.Top[0] != (TopGame{"dots", 1, 5}) || st.Top[1] != (TopGame{"tictactoe", 2, 0}) || st.Top[2] != (TopGame{"maze", 0, 1}) {
		t.Fatalf("top: %+v", st.Top)
	}

	// 11월 1일의 dots 한 판은 이틀 밖이라 빠집니다
	if code, st := f.stats(t, "?days=2", &f.boss); code != http.StatusOK || len(st.Days) != 2 || st.Days[0].Day != "2026-11-02" ||
		len(st.Top) != 3 || st.Top[0] != (TopGame{"dots", 0, 5}) || st.Days[0].NewGames != 0 {
		t.Fatalf("days=2: %d %+v", code, st)
	}
	for _, q := range []string{"?days=0", "?days=366", "?days=x"} {
		if code, _ := f.stats(t, q, &f.boss); code != http.StatusBadRequest {
			t.Fatalf("%s = %d", q, code)
		}
	}
	if code, _ := f.stats(t, "", &f.author); code != http.StatusForbidden {
		t.Fatalf("non-admin = %d", code)
	}
	if code, _ := f.stats(t, "", nil); code != http.StatusUnauthorized {
		t.Fatalf("no cookie = %d", code)
	}
}

// 나라별 방문은 기간의 날마다 온 사람을 나라별로 더합니다. 나라를 모르는 방문은 따로 셉니다
func TestStatsCountries(t *testing.T) {
	f := setup(t)
	// stats는 실제 시계로 날을 나누므로 날짜도 실제 시계로 정합니다. 그제는 나라를 세기 전이라 빠집니다
	today := stats.Day(time.Now())
	yesterday := stats.AddDays(today, -1)
	os.MkdirAll(filepath.Join(f.dir, "stats"), 0o755)
	os.WriteFile(filepath.Join(f.dir, "stats", "days.jsonl"), []byte(
		`{"day":"`+stats.AddDays(today, -2)+`","visitors":7,"members":1,"mau":7,"mauMembers":1}`+"\n"+
			`{"day":"`+yesterday+`","visitors":5,"members":1,"mau":8,"mauMembers":1,"countries":{"KR":3,"JP":1}}`+"\n"), 0o644)
	visits, err := stats.Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.h.Visits = visits

	if _, st := f.stats(t, "", &f.boss); st.Geo || len(st.Countries) != 2 || st.CountryUnknown != 1 || st.Retention == nil {
		t.Fatalf("나라 파일 없음: %+v %d %v", st.Countries, st.CountryUnknown, st.Geo)
	}
	visits.Locate = func(*http.Request) string { return "US" }
	visits.Visit(httptest.NewRequest("GET", "/api/me", nil), identity.User{ID: "g_x", Kind: identity.KindGuest})
	_, st := f.stats(t, "", &f.boss)
	want := []CountryVisits{{"KR", 3}, {"JP", 1}, {"US", 1}}
	if !st.Geo || !slices.Equal(st.Countries, want) || st.CountryUnknown != 1 || st.CountriesSince != yesterday {
		t.Fatalf("countries = %+v, unknown %d, geo %v, since %s", st.Countries, st.CountryUnknown, st.Geo, st.CountriesSince)
	}
	// 오늘만 보면 어제는 빠집니다
	if _, st := f.stats(t, "?days=1", &f.boss); !slices.Equal(st.Countries, []CountryVisits{{"US", 1}}) || st.CountryUnknown != 0 || st.CountriesSince != today {
		t.Fatalf("days=1: %+v %d", st.Countries, st.CountryUnknown)
	}
}
