package record

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

var aiAt = time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)

func aiStore(t *testing.T, dir string) (*AIStore, *time.Time) {
	t.Helper()
	s, err := OpenAI(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := aiAt
	s.now = func() time.Time { return now }
	return s, &now
}

func click(player, row, col int, at int64) Move {
	return Move{Player: player, Action: protocol.Action{Kind: "click", Row: row, Col: col}, At: at}
}

func aiReport(id string, moves ...Move) AIReport {
	return AIReport{ID: id, Version: "8345048c42920d27", Seed: 7, Seat: 1, Level: "normal", Sims: 100, Moves: moves}
}

func TestAIReportGrowsAndEnds(t *testing.T) {
	dir := t.TempDir()
	s, now := aiStore(t, dir)
	u := identity.User{ID: "g_guest1", Kind: identity.KindGuest, Tag: "4821"}
	id := NewID()

	// AI가 먼저(선공) 두고 사람이 둔 뒤에 처음 보냅니다
	if err := s.Report(u, "KR", "tictactoe", "abc.onnx", aiReport(id, click(0, 1, 1, 400), click(1, 0, 0, 3000))); err != nil {
		t.Fatal(err)
	}
	m, err := s.Get(id)
	if err != nil {
		t.Fatal(err)
	}
	if m.AI == nil || m.AI.Seat != 0 || m.AI.Model != "abc.onnx" || m.AI.Level != "normal" || m.AI.Sims != 100 {
		t.Fatalf("ai side = %+v", m.AI)
	}
	if m.Players[1].ID != u.ID || m.Players[1].Country != "KR" || m.Players[0].ID != AIPlayerID || m.Players[0].Kind != KindAI {
		t.Fatalf("players = %+v", m.Players)
	}
	if want := aiAt.Add(-3 * time.Second); !m.Started.Equal(want) || m.Reason != "" || !m.Ended.IsZero() {
		t.Fatalf("started %v reason %q ended %v, want started %v and open", m.Started, m.Reason, m.Ended, want)
	}

	// 수가 늘면 덮어쓰고, 나라는 처음 것 그대로
	*now = now.Add(20 * time.Second)
	moves := []Move{click(0, 1, 1, 400), click(1, 0, 0, 3000), click(0, 2, 2, 3500)}
	if err := s.Report(u, "US", "tictactoe", "new.onnx", aiReport(id, moves...)); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.Get(id); len(m.Moves) != 3 || m.Players[1].Country != "KR" || m.AI.Model != "abc.onnx" || !m.Updated.Equal(*now) {
		t.Fatalf("after second report: %+v", m)
	}
	if err := s.Report(u, "KR", "tictactoe", "", aiReport(id, moves[:1]...)); !errors.As(err, new(BadReport)) {
		t.Fatalf("fewer moves = %v, want BadReport", err)
	}

	// 다른 사람, 다른 판(시드, 자리, 게임)은 같은 id를 쓸 수 없습니다
	other := identity.User{ID: "g_other", Kind: identity.KindGuest}
	if err := s.Report(other, "", "tictactoe", "", aiReport(id, moves...)); !errors.Is(err, ErrNotYours) {
		t.Fatalf("other person = %v", err)
	}
	r := aiReport(id, moves...)
	r.Seed = 8
	if err := s.Report(u, "", "tictactoe", "", r); !errors.Is(err, ErrNotYours) {
		t.Fatalf("other seed = %v", err)
	}
	r = aiReport(id, moves...)
	r.Seat = 0
	if err := s.Report(u, "", "tictactoe", "", r); !errors.Is(err, ErrNotYours) {
		t.Fatalf("other seat = %v", err)
	}
	if err := s.Report(u, "", "omok", "", aiReport(id, moves...)); !errors.Is(err, ErrNotYours) {
		t.Fatalf("other game = %v", err)
	}

	// 서버를 다시 켜도 파일에서 이어 받고, 끝나면 더 받지 않습니다
	s2, now2 := aiStore(t, dir)
	*now2 = now.Add(time.Minute)
	r = aiReport(id, append(moves, click(1, 1, 0, 9000))...)
	r.End = &AIEnd{Winner: nil, Reason: AIReasonResult}
	if err := s2.Report(u, "", "tictactoe", "", r); err != nil {
		t.Fatal(err)
	}
	m, _ = s2.Get(id)
	if m.Reason != AIReasonResult || m.Winner != nil || !m.Ended.Equal(*now2) || len(m.Moves) != 4 {
		t.Fatalf("ended = %+v", m)
	}
	if err := s2.Report(u, "", "tictactoe", "", r); !errors.Is(err, ErrEnded) {
		t.Fatalf("after end = %v", err)
	}
}

func TestAIReportRejectsBadShapes(t *testing.T) {
	s, _ := aiStore(t, t.TempDir())
	u := identity.User{ID: "g_guest1", Kind: identity.KindGuest}
	good := aiReport(NewID(), click(1, 0, 0, 100))
	for name, change := range map[string]func(r *AIReport){
		"id":        func(r *AIReport) { r.ID = "../../etc" },
		"version":   func(r *AIReport) { r.Version = "<b>" },
		"seat":      func(r *AIReport) { r.Seat = 2 },
		"level":     func(r *AIReport) { r.Level = "godlike" },
		"sims":      func(r *AIReport) { r.Sims = 0 },
		"player":    func(r *AIReport) { r.Moves = []Move{click(2, 0, 0, 1)} },
		"off board": func(r *AIReport) { r.Moves = []Move{click(0, 32, 0, 1)} },
		"time back": func(r *AIReport) { r.Moves = []Move{click(0, 0, 0, 5), click(1, 0, 1, 4)} },
		"winner":    func(r *AIReport) { r.End = &AIEnd{Winner: ptrInt(3), Reason: AIReasonResult} },
		"reason":    func(r *AIReport) { r.End = &AIEnd{Reason: "boom"} },
		"too long":  func(r *AIReport) { r.Moves = make([]Move, MaxAIMoves+1) },
	} {
		r := good
		change(&r)
		if err := s.Report(u, "", "tictactoe", "", r); !errors.As(err, new(BadReport)) {
			t.Errorf("%s: got %v, want BadReport", name, err)
		}
	}
	if err := s.Report(u, "", "tictactoe", "", good); err != nil {
		t.Fatalf("good report: %v", err)
	}
}

func ptrInt(n int) *int { return &n }

func TestAIReportDailyLimit(t *testing.T) {
	s, now := aiStore(t, t.TempDir())
	u := identity.User{ID: "g_busy", Kind: identity.KindGuest}
	for i := 0; i < AIPerDay; i++ {
		if err := s.Report(u, "", "tictactoe", "", aiReport(NewID(), click(1, 0, 0, 1))); err != nil {
			t.Fatalf("report %d: %v", i, err)
		}
	}
	if err := s.Report(u, "", "tictactoe", "", aiReport(NewID(), click(1, 0, 0, 1))); !errors.Is(err, ErrTooMany) {
		t.Fatalf("over the limit = %v", err)
	}
	// 다른 사람은 상관없고, 다음 날(한국 날짜)에는 다시 받습니다
	if err := s.Report(identity.User{ID: "g_calm"}, "", "tictactoe", "", aiReport(NewID(), click(1, 0, 0, 1))); err != nil {
		t.Fatalf("someone else: %v", err)
	}
	*now = now.Add(24 * time.Hour)
	if err := s.Report(u, "", "tictactoe", "", aiReport(NewID(), click(1, 0, 0, 1))); err != nil {
		t.Fatalf("next day: %v", err)
	}
}

func TestAIForgetAndAdopt(t *testing.T) {
	dir := t.TempDir()
	s, _ := aiStore(t, dir)
	guest := identity.User{ID: "g_guest1", Kind: identity.KindGuest, Tag: "0001"}
	member := identity.User{ID: "m_bee", Kind: identity.KindMember, Tag: "0002", Name: "bee"}
	asGuest, asMember := NewID(), NewID()
	if err := s.Report(guest, "JP", "tictactoe", "", aiReport(asGuest, click(1, 0, 0, 1))); err != nil {
		t.Fatal(err)
	}
	if err := s.Report(member, "KR", "tictactoe", "", aiReport(asMember, click(1, 0, 0, 1))); err != nil {
		t.Fatal(err)
	}

	// 게스트가 로그인하면 그 판이 계정으로 옮겨집니다 (나라는 그 판의 것)
	to := Player{ID: member.ID, Kind: member.Kind, Tag: member.Tag, Name: member.Name}
	if n, err := s.Adopt(guest.ID, to); err != nil || n != 1 {
		t.Fatalf("adopt = %d, %v", n, err)
	}
	if m, _ := s.Get(asGuest); m.Players[1].ID != member.ID || m.Players[1].Country != "JP" {
		t.Fatalf("adopted seat = %+v", m.Players[1])
	}
	if _, err := os.Stat(filepath.Join(dir, "aimatches", "users", guest.ID+".log")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("guest log still there: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "aimatches", "users", member.ID+".log"))
	if got := strings.Fields(string(data)); len(got) != 2 || got[0] != asMember || got[1] != asGuest {
		t.Fatalf("member log = %q", got)
	}

	// 탈퇴하면 두 판 모두 이름과 나라 없는 자리로 바뀝니다
	if err := s.Forget(member.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{asGuest, asMember} {
		m, _ := s.Get(id)
		if p := m.Players[1]; p.Kind != identity.KindGone || p.Name != "" || p.Country != "" || strings.HasPrefix(p.ID, "m_") {
			t.Fatalf("%s after forget = %+v", id, p)
		}
		if m.Players[0].ID != AIPlayerID {
			t.Fatalf("ai seat changed: %+v", m.Players[0])
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "aimatches", "users", member.ID+".log")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("member log still there: %v", err)
	}
}
