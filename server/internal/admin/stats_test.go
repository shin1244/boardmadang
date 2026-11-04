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
	if d := day("2026-11-03"); d.Plays != 2 {
		t.Fatalf("11-03: %+v", d)
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
	if len(st.Top) != 2 || st.Top[0] != (TopGame{"tictactoe", 2}) || st.Top[1] != (TopGame{"dots", 1}) {
		t.Fatalf("top: %+v", st.Top)
	}

	if code, st := f.stats(t, "?days=2", &f.boss); code != http.StatusOK || len(st.Days) != 2 || st.Days[0].Day != "2026-11-02" ||
		len(st.Top) != 1 || st.Days[0].NewGames != 0 {
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
