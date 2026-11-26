package main

import (
	"bytes"
	"database/sql"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/comment"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
	"github.com/shin1244/boardmadang/server/internal/star"
	"github.com/shin1244/boardmadang/server/internal/stats"
)

func intp(n int) *int { return &n }

func guest(id string) identity.User { return identity.User{ID: id, Kind: identity.KindGuest} }

// fixture는 서버의 저장소(account, record, comment, star, stats)로 DATA_DIR을 채웁니다.
// 파일 모양을 손으로 흉내 내지 않고 서버 코드가 쓴 그대로를 읽어 보려는 것입니다.
func fixture(t *testing.T) (data, site string, alice, bob identity.User) {
	t.Helper()
	data, site = t.TempDir(), t.TempDir()

	accounts, err := account.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	alice, _, err = accounts.Create("google", "sub-a", "alice1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := accounts.Rename(alice.ID, "alice2"); err != nil {
		t.Fatal(err)
	}
	bob, _, err = accounts.Create("github", "sub-b", "bobby1")
	if err != nil {
		t.Fatal(err)
	}
	if err := accounts.Suspend(bob.ID, time.Time{}); err != nil {
		t.Fatal(err)
	}
	gone, _, err := accounts.Create("google", "sub-c", "carol1")
	if err != nil {
		t.Fatal(err)
	}
	if err := accounts.Delete(gone.ID); err != nil {
		t.Fatal(err)
	}

	records, err := record.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 11, 3, 23, 50, 0, 0, stats.KST)
	click := func(p, row, col int, at int64) record.Move {
		return record.Move{Player: p, Action: protocol.Action{Kind: "click", Row: row, Col: col}, At: at}
	}
	seat := func(u identity.User) record.Player {
		return record.Player{ID: u.ID, Kind: u.Kind, Name: u.Name}
	}
	g := guest("g_guest1")
	matches := []*record.Match{
		// 선공 승, 한국 날짜로 다음 날(11월 4일)에 끝남
		{ID: "AAAAAAAAAA", Game: "tictactoe", Version: "v1", Minutes: intp(10), Players: [2]record.Player{seat(alice), seat(g)},
			Moves:  []record.Move{click(0, 1, 1, 900), click(1, 0, 0, 2500), click(0, 2, 2, 4000)},
			Winner: intp(0), Reason: protocol.ReasonResult, Clock: &[2]int64{598000, 597000},
			Started: start, Ended: start.Add(15 * time.Minute)},
		// 무승부 합의, 타이머 없음
		{ID: "BBBBBBBBBB", Game: "tictactoe", Players: [2]record.Player{seat(g), seat(bob)},
			Moves:  []record.Move{click(0, 0, 1, 1000), {Player: 1, Action: protocol.Action{Kind: "pass"}, At: 2000}},
			Reason: protocol.ReasonAgreed, Started: start, Ended: start.Add(time.Minute)},
		// 무효 (세지 않음)
		{ID: "CCCCCCCCCC", Game: "tictactoe", Players: [2]record.Player{seat(alice), seat(bob)},
			Moves: []record.Move{click(0, 0, 0, 100)}, Reason: protocol.ReasonDesync, Started: start, Ended: start.Add(time.Second)},
		// 혼자 두 자리 (세지 않음), 레포에 없는 게임
		{ID: "DDDDDDDDDD", Game: "oldgame", Players: [2]record.Player{seat(alice), seat(alice)},
			Moves: []record.Move{click(0, 0, 0, 100)}, Winner: intp(1), Reason: protocol.ReasonResign, Started: start, Ended: start.Add(time.Second)},
	}
	for _, m := range matches {
		records.Save(m)
	}
	records.Close()

	comments, err := comment.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	kept, err := comments.Post("tictactoe", alice, "재밌어요")
	if err != nil {
		t.Fatal(err)
	}
	deleted, err := comments.Post("tictactoe", bob, "지울 글")
	if err != nil {
		t.Fatal(err)
	}
	if err := comments.Delete("tictactoe", deleted.ID, bob); err != nil {
		t.Fatal(err)
	}
	for _, by := range []string{"g_r1", "g_r2", "g_r3"} {
		if _, err := comments.Report(guest(by), comment.Report{Game: "tictactoe", Comment: kept.ID, Reason: "spam"}); err != nil {
			t.Fatal(err)
		}
	}

	stars, err := star.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, u := range []identity.User{alice, bob} {
		if _, err := stars.Set("tictactoe", u.ID, true); err != nil {
			t.Fatal(err)
		}
	}

	tracker, err := stats.Open(data)
	if err != nil {
		t.Fatal(err)
	}
	tracker.Seen(alice.ID, true)
	tracker.Seen(g.ID, false)
	tracker.Seen(g.ID, false) // 같은 날 두 번은 한 번
	req := httptest.NewRequest("POST", "/api/ai/tictactoe/plays", nil)
	tracker.AIPlay(req, g, "tictactoe")
	tracker.AIEnd(req, g, "tictactoe", stats.AIWin)
	// 끝난 날의 방문 수 (서버가 날짜가 바뀔 때 남기는 줄)
	writeFile(t, filepath.Join(data, "stats", "days.jsonl"),
		`{"day":"2026-11-02","visitors":5,"members":2,"mau":9,"mauMembers":3}`+"\n"+
			`{"day":"2026-11-03","visitors":7,"members":3,"mau":11,"mauMembers":4}`+"\n")

	// 올린 게임 (upload의 game.json 모양)
	writeFile(t, filepath.Join(data, "uploads", "rockfall", "game.json"), `{
  "id": "rockfall", "owner": "`+alice.ID+`", "version": "abc123",
  "listing": {"name": {"ko": "돌 떨구기", "en": "Rockfall"}, "difficulty": "normal"},
  "created": "2026-11-01T03:00:00Z",
  "published": [{"version": "aaa111", "at": "2026-11-01T03:00:00Z"}, {"version": "abc123", "at": "2026-11-02T03:00:00Z"}],
  "hidden": true
}`)
	// 레포 게임
	writeFile(t, filepath.Join(site, "games", "tictactoe", "index.js"), "export default {}\n")
	writeFile(t, filepath.Join(site, "games", "tictactoe", "listing.json"), `{"name":{"ko":"틱택토","en":"Tic-tac-toe"},"difficulty":"easy"}`)
	return data, site, alice, bob
}

func writeFile(t *testing.T, file, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func open(t *testing.T, file string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

// one은 결과가 한 줄인 쿼리를 dest에 읽습니다.
func one(t *testing.T, db *sql.DB, q string, dest ...any) {
	t.Helper()
	if err := db.QueryRow(q).Scan(dest...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func TestExport(t *testing.T) {
	data, site, alice, bob := fixture(t)
	out := filepath.Join(t.TempDir(), "sub", "out.db")
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, stats.KST)
	sum, err := Export(data, site, out, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Skipped) != 0 {
		t.Errorf("Skipped = %v", sum.Skipped)
	}
	want := map[string]int{"games": 3, "game_releases": 2, "accounts": 2, "matches": 4, "match_players": 8, "match_actions": 7,
		"comments": 2, "stars": 2, "visits": 2, "daily_visits": 2, "ai_plays": 1, "export_info": 2}
	for table, n := range want {
		if sum.Rows[table] != n {
			t.Errorf("Rows[%s] = %d, want %d", table, sum.Rows[table], n)
		}
	}
	db := open(t, out)

	var name, provider, created string
	var renamed sql.NullString
	var suspended int
	one(t, db, "SELECT name, provider, created_day, renamed_at, suspended FROM accounts WHERE id = '"+alice.ID+"'",
		&name, &provider, &created, &renamed, &suspended)
	if name != "alice2" || provider != "google" || created == "" || !renamed.Valid || suspended != 0 {
		t.Errorf("alice = %q %q %q %v %d", name, provider, created, renamed, suspended)
	}
	one(t, db, "SELECT suspended FROM accounts WHERE id = '"+bob.ID+"'", &suspended)
	if suspended != 1 {
		t.Errorf("bob suspended = %d", suspended)
	}

	// 시각은 한국 시간, 날짜는 끝난 한국 날짜
	var started, ended, day string
	var duration float64
	var winner, timer sql.NullInt64
	var counted, actions int
	var left0 int64
	one(t, db, "SELECT started_at, ended_at, day, duration_sec, winner, timer_minutes, counted, actions, clock_left0_ms FROM matches WHERE id = 'AAAAAAAAAA'",
		&started, &ended, &day, &duration, &winner, &timer, &counted, &actions, &left0)
	if started != "2026-11-03 23:50:00" || ended != "2026-11-04 00:05:00" || day != "2026-11-04" || duration != 900 ||
		winner.Int64 != 0 || !winner.Valid || timer.Int64 != 10 || counted != 1 || actions != 3 || left0 != 598000 {
		t.Errorf("match A = %s %s %s %v %v %v %d %d %d", started, ended, day, duration, winner, timer, counted, actions, left0)
	}
	one(t, db, "SELECT winner, timer_minutes, counted FROM matches WHERE id = 'BBBBBBBBBB'", &winner, &timer, &counted)
	if winner.Valid || timer.Valid || counted != 1 {
		t.Errorf("match B = %v %v %d", winner, timer, counted)
	}
	var n int
	one(t, db, "SELECT count(*) FROM matches WHERE counted = 1", &n)
	if n != 2 {
		t.Errorf("counted = %d, want 2 (무효와 혼자 둔 대국은 빠짐)", n)
	}
	var kind string
	var row, col int
	one(t, db, "SELECT kind, row, col FROM match_actions WHERE match_id = 'BBBBBBBBBB' AND seq = 1", &kind, &row, &col)
	if kind != "pass" {
		t.Errorf("action = %s %d %d", kind, row, col)
	}
	var player string
	var pname sql.NullString
	one(t, db, "SELECT player_id, kind, name FROM match_players WHERE match_id = 'AAAAAAAAAA' AND seat = 1", &player, &kind, &pname)
	if player != "g_guest1" || kind != "guest" || pname.Valid {
		t.Errorf("seat 1 = %s %s %v", player, kind, pname)
	}

	// 지운 의견은 글을 넣지 않고, 세 명이 신고한 의견은 가려짐
	var text sql.NullString
	var deleted, reporters, hidden int
	one(t, db, "SELECT text, deleted, reporters, hidden FROM comments WHERE author_id = '"+alice.ID+"'", &text, &deleted, &reporters, &hidden)
	if text.String != "재밌어요" || deleted != 0 || reporters != 3 || hidden != 1 {
		t.Errorf("kept comment = %v %d %d %d", text, deleted, reporters, hidden)
	}
	one(t, db, "SELECT text, deleted FROM comments WHERE author_id = '"+bob.ID+"'", &text, &deleted)
	if text.Valid || deleted != 1 {
		t.Errorf("deleted comment = %v %d", text, deleted)
	}

	var source string
	var owner, version sql.NullString
	var gameHidden int
	one(t, db, "SELECT source, name_ko, owner_id, version, hidden FROM games WHERE id = 'rockfall'", &source, &name, &owner, &version, &gameHidden)
	if source != "upload" || name != "돌 떨구기" || owner.String != alice.ID || version.String != "abc123" || gameHidden != 1 {
		t.Errorf("rockfall = %s %s %v %v %d", source, name, owner, version, gameHidden)
	}
	one(t, db, "SELECT source, name_ko FROM games WHERE id = 'tictactoe'", &source, &name)
	if source != "repo" || name != "틱택토" {
		t.Errorf("tictactoe = %s %s", source, name)
	}
	one(t, db, "SELECT source FROM games WHERE id = 'oldgame'", &source)
	if source != "unknown" {
		t.Errorf("oldgame = %s", source)
	}

	var members, plays, wins int
	one(t, db, "SELECT count(*), sum(member) FROM visits", &n, &members)
	if n != 2 || members != 1 {
		t.Errorf("visits = %d, members %d", n, members)
	}
	one(t, db, "SELECT visitors FROM daily_visits WHERE day = '2026-11-03'", &n)
	if n != 7 {
		t.Errorf("daily_visits = %d", n)
	}
	one(t, db, "SELECT plays, wins FROM ai_plays WHERE game_id = 'tictactoe'", &plays, &wins)
	if plays != 1 || wins != 1 {
		t.Errorf("ai_plays = %d %d", plays, wins)
	}
	var exported string
	one(t, db, "SELECT value FROM export_info WHERE key = 'exported_at'", &exported)
	if exported != "2026-11-26 12:00:00" {
		t.Errorf("exported_at = %s", exported)
	}

	// 로그인한 곳의 사용자 번호는 어디에도 넣지 않음
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"sub-a", "sub-b"} {
		if bytes.Contains(raw, []byte(sub)) {
			t.Errorf("결과 파일에 %s가 들어 있습니다", sub)
		}
	}
}

// 다시 돌리면 파일을 새로 만들고, 데이터 폴더는 건드리지 않습니다.
func TestExportAgainReadOnly(t *testing.T) {
	data, site, _, _ := fixture(t)
	before := snapshot(t, data)
	out := filepath.Join(t.TempDir(), "out.db")
	for range 2 {
		if _, err := Export(data, site, out, time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	one(t, open(t, out), "SELECT count(*) FROM matches", &n)
	if n != 4 {
		t.Errorf("matches = %d after running twice", n)
	}
	if after := snapshot(t, data); len(after) != len(before) {
		t.Errorf("데이터 폴더가 바뀌었습니다: %d → %d개", len(before), len(after))
	} else {
		for p, mod := range before {
			if after[p] != mod {
				t.Errorf("%s가 바뀌었습니다", p)
			}
		}
	}
}

func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		data := ""
		if !info.IsDir() {
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			data = string(b)
		}
		out[p] = data
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// 깨진 파일은 건너뛰고 알려 줍니다. 비어 있는 폴더도 됩니다.
func TestExportSkipsBroken(t *testing.T) {
	data := t.TempDir()
	writeFile(t, filepath.Join(data, "matches", "AA", "AAAAAAAAAA.json"), `{"id":`)
	writeFile(t, filepath.Join(data, "matches", "AA", "AAAAAAAAAB.json.tmp"), `{"id":`)
	writeFile(t, filepath.Join(data, "accounts.jsonl"), `{"op":"add","id":"m_x","provider":"google","name":"xxxx","at":"2026-11-01T00:00:00Z"}`+"\n"+`{"op":"ren`)
	out := filepath.Join(t.TempDir(), "out.db")
	sum, err := Export(data, t.TempDir(), out, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(sum.Skipped) != 2 || sum.Rows["accounts"] != 1 || sum.Rows["matches"] != 0 {
		t.Errorf("Skipped = %v, Rows = %v", sum.Skipped, sum.Rows)
	}
	if _, err := Export(filepath.Join(data, "없음"), t.TempDir(), out, time.Now()); err == nil {
		t.Error("없는 데이터 폴더인데 만들었습니다")
	}
}
