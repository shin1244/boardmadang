package stats

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func TestAICountsPlaysAndResults(t *testing.T) {
	dir := t.TempDir()
	c := &clock{kst("2026-11-12 10:00")}
	tr, err := open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/ai/nakseok/plays", nil)
	alice := identity.User{ID: "g_alice"}
	bob := identity.User{ID: "m_bob", Kind: identity.KindMember}

	// 시작하지 않은 판은 끝낼 수 없습니다
	if tr.AIEnd(r, alice, "nakseok", AIWin) {
		t.Fatal("AIEnd before AIPlay counted")
	}
	for range 2 {
		if !tr.AIPlay(r, alice, "nakseok") {
			t.Fatal("AIPlay not counted")
		}
	}
	tr.AIEnd(r, alice, "nakseok", AIWin)
	tr.AIEnd(r, alice, "nakseok", AIDraw)
	if tr.AIEnd(r, alice, "nakseok", AILose) {
		t.Fatal("more ends than plays counted")
	}
	tr.AIPlay(r, bob, "nakseok")
	tr.AIEnd(r, bob, "nakseok", AILose)
	tr.AIPlay(r, bob, "cellmoku")
	if tr.AIEnd(r, bob, "cellmoku", "lost") {
		t.Fatal("bad result counted")
	}

	want := map[string]AICount{
		"nakseok":  {Plays: 3, Ends: 3, Wins: 1, Draws: 1},
		"cellmoku": {Plays: 1},
	}
	check := func(tr *Tracker) {
		t.Helper()
		got := tr.AIDaily("2026-11-12")["2026-11-12"]
		if len(got) != len(want) {
			t.Fatalf("games = %+v", got)
		}
		for game, w := range want {
			if got[game] != w {
				t.Fatalf("%s = %+v, want %+v", game, got[game], w)
			}
		}
	}
	check(tr)
	if len(tr.AIDaily("2026-11-13")) != 0 {
		t.Fatal("AIDaily ignores from")
	}

	// 파일에는 수만 있고 누가 뒀는지는 없습니다. 다시 열어도 같습니다
	data, err := os.ReadFile(filepath.Join(dir, "stats", "ai", "2026-11-12.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "alice") || strings.Contains(string(data), tr.hash("g_alice")) {
		t.Fatalf("file names a player: %s", data)
	}
	again, err := open(dir, c.now)
	if err != nil {
		t.Fatal(err)
	}
	check(again)
}

func TestAIPerDayCap(t *testing.T) {
	c := &clock{kst("2026-11-12 10:00")}
	tr, err := open(t.TempDir(), c.now)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/ai/nakseok/plays", nil)
	u := identity.User{ID: "g_busy"}
	for i := range AIPerDay {
		if !tr.AIPlay(r, u, "nakseok") {
			t.Fatalf("play %d not counted", i+1)
		}
	}
	if tr.AIPlay(r, u, "nakseok") {
		t.Fatal("play over AIPerDay counted")
	}
	// 다음 날에는 다시 셉니다. 어제 시작한 판을 오늘 끝낼 수는 없습니다
	c.t = kst("2026-11-13 00:10")
	if tr.AIEnd(r, u, "nakseok", AIWin) {
		t.Fatal("end of yesterday's play counted today")
	}
	if !tr.AIPlay(r, u, "nakseok") {
		t.Fatal("cap not reset on a new day")
	}
	days := tr.AIDaily("2026-11-12")
	if days["2026-11-12"]["nakseok"].Plays != AIPerDay || days["2026-11-13"]["nakseok"].Plays != 1 {
		t.Fatalf("days = %+v", days)
	}
}

func TestAIIgnoresBotsAndAnonymous(t *testing.T) {
	c := &clock{kst("2026-11-12 10:00")}
	tr, err := open(t.TempDir(), c.now)
	if err != nil {
		t.Fatal(err)
	}
	bot := httptest.NewRequest("POST", "/api/ai/nakseok/plays", nil)
	bot.Header.Set("User-Agent", "Mozilla/5.0 HeadlessChrome/120")
	if tr.AIPlay(bot, identity.User{ID: "g_1"}, "nakseok") {
		t.Fatal("bot counted")
	}
	r := httptest.NewRequest("POST", "/api/ai/nakseok/plays", nil)
	if tr.AIPlay(r, identity.User{}, "nakseok") || tr.AIPlay(r, identity.User{ID: "g_1"}, "") {
		t.Fatal("no id or no game counted")
	}
	if len(tr.AIDaily("")["2026-11-12"]) != 0 {
		t.Fatalf("counted: %+v", tr.AIDaily(""))
	}
}
