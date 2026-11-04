package record

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

func sample(a, b string) *Match {
	w := 0
	return &Match{
		ID:      NewID(),
		Game:    "tictactoe",
		Seed:    42,
		Players: [2]Player{{ID: a, Kind: "guest", Tag: "1111"}, {ID: b, Kind: "guest", Tag: "2222"}},
		Moves:   []Move{{Player: 0, Action: protocol.Action{Kind: "click", Row: 1, Col: 1}, At: 1200}},
		Winner:  &w,
		Reason:  protocol.ReasonResign,
		Started: time.Now().Add(-time.Minute),
		Ended:   time.Now(),
	}
}

func TestSaveAndGet(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := sample("g_aaa", "g_bbb")
	s.Save(m)
	// 쓰는 중에도 바로 보입니다
	if got, err := s.Get(m.ID); err != nil || got.ID != m.ID {
		t.Fatalf("get while pending: %v %v", got, err)
	}
	s.Close()

	// 서버를 다시 켜도 남아 있습니다
	s2, _ := Open(dir)
	got, err := s2.Get(m.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Seed != 42 || len(got.Moves) != 1 || got.Moves[0].Action.Row != 1 || got.Moves[0].At != 1200 || *got.Winner != 0 {
		t.Fatalf("read back: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "matches", m.ID[:2], m.ID+".json")); err != nil {
		t.Fatal(err)
	}
}

func TestGetRejectsBadIDs(t *testing.T) {
	s, _ := Open(t.TempDir())
	for _, id := range []string{"", "../../etc", "ABCDEFGHJ", "abcdefghjk", "ABCDEFGHJK/"} {
		if _, err := s.Get(id); err != ErrNotFound {
			t.Errorf("Get(%q) = %v, want ErrNotFound", id, err)
		}
	}
}

func TestListByUser(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	var ids []string
	for i := 0; i < 3; i++ {
		m := sample("g_me", "g_other")
		m.Ended = time.Now().Add(time.Duration(i) * time.Second)
		s.Save(m)
		s.Close() // 순서대로 쓰이게 하나씩 기다립니다
		ids = append(ids, m.ID)
	}
	self := sample("g_me", "g_me") // 탭 두 개로 혼자 둔 판
	s.Save(self)
	s.Close()

	list, err := s.ListByUser("g_me", 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{self.ID, ids[2], ids[1], ids[0]}
	if len(list) != len(want) {
		t.Fatalf("got %d matches, want %d", len(list), len(want))
	}
	for i, m := range list {
		if m.ID != want[i] {
			t.Fatalf("list[%d] = %s, want %s (newest first)", i, m.ID, want[i])
		}
	}
	if list, _ := s.ListByUser("g_me", 2); len(list) != 2 {
		t.Fatalf("limit: got %d", len(list))
	}
	if list, _ := s.ListByUser("g_other", 10); len(list) != 3 {
		t.Fatalf("opponent sees %d matches, want 3", len(list))
	}
	// 혼자 둔 판은 목록 파일에 한 번만
	data, _ := os.ReadFile(filepath.Join(dir, "users", "g_me.log"))
	if n := strings.Count(string(data), self.ID); n != 1 {
		t.Fatalf("self-play match listed %d times", n)
	}
	if list, _ := s.ListByUser("../x", 10); list != nil {
		t.Fatal("bad user id should list nothing")
	}
}

func TestListIncludesPending(t *testing.T) {
	s, _ := Open(t.TempDir())
	m := sample("g_me", "g_other")
	s.mu.Lock()
	s.pending[m.ID] = m // 아직 파일에 안 쓴 상태
	s.mu.Unlock()
	list, _ := s.ListByUser("g_me", 10)
	if len(list) != 1 || list[0].ID != m.ID {
		t.Fatalf("pending match missing from list: %v", list)
	}
}

func TestPlays(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	other := sample("g_a", "g_b")
	other.Game = "dots"
	solo := sample("g_a", "g_a")
	invalid := sample("g_a", "g_b")
	invalid.Reason = protocol.ReasonDesync
	empty := sample("g_a", "g_b")
	empty.Moves = nil
	empty.Reason = protocol.ReasonLeft
	for _, m := range []*Match{sample("g_a", "g_b"), sample("g_c", "g_d"), other, solo, invalid, empty} {
		s.Save(m)
	}
	// 쓰는 중에도 바로 셉니다
	if s.Plays("tictactoe") != 2 || s.Plays("dots") != 1 || s.Plays("none") != 0 {
		t.Fatalf("plays while pending: %d %d", s.Plays("tictactoe"), s.Plays("dots"))
	}
	s.Close()

	// 서버를 다시 켜도 plays.json에서 읽습니다
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s2.Plays("tictactoe") != 2 || s2.Plays("dots") != 1 {
		t.Fatalf("plays after reopen: %d %d", s2.Plays("tictactoe"), s2.Plays("dots"))
	}

	// plays.json이 없거나 깨졌으면 기보를 훑어 다시 셉니다 (판 수를 세기 전에 쌓인 기보)
	for _, body := range []string{"", "{broken", "null"} {
		file := filepath.Join(dir, "plays.json")
		os.Remove(file)
		if body != "" {
			os.WriteFile(file, []byte(body), 0o644)
		}
		s3, err := Open(dir)
		if err != nil {
			t.Fatalf("%q: %v", body, err)
		}
		if s3.Plays("tictactoe") != 2 || s3.Plays("dots") != 1 {
			t.Fatalf("%q: rebuilt plays %d %d", body, s3.Plays("tictactoe"), s3.Plays("dots"))
		}
		if data, _ := os.ReadFile(file); string(data) != `{"dots":1,"tictactoe":2}` {
			t.Fatalf("%q: rebuilt plays.json %s", body, data)
		}
	}
}

func TestNewIDIsValid(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := NewID()
		if !ValidID(id) || seen[id] {
			t.Fatalf("bad or repeated id %q", id)
		}
		seen[id] = true
	}
}

func TestAdoptGuest(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	base := time.Now()
	at := func(m *Match, min int) *Match { m.Ended = base.Add(time.Duration(min) * time.Minute); return m }

	// 계정이 예전에 둔 대국 사이사이에 게스트로 둔 대국이 끼어 있습니다
	old := at(sample("m_shin", "g_xxx"), 1)
	g1 := at(sample("g_me", "g_yyy"), 2)
	mid := at(sample("g_zzz", "m_shin"), 3)
	g2 := at(sample("g_me", "g_me"), 4) // 혼자 두 자리
	for _, m := range []*Match{old, g1, mid, g2} {
		s.Save(m)
		s.Close()
	}

	member := Player{ID: "m_shin", Kind: "member", Tag: "0193", Name: "shin"}
	n, err := s.Adopt("g_me", member)
	if err != nil || n != 2 {
		t.Fatalf("Adopt = %d, %v; want 2", n, err)
	}
	list, _ := s.ListByUser("m_shin", 10)
	var got []string
	for _, m := range list {
		got = append(got, m.ID)
	}
	if want := []string{g2.ID, mid.ID, g1.ID, old.ID}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("member list = %v, want %v", got, want)
	}
	if list, _ := s.ListByUser("g_me", 10); len(list) != 0 {
		t.Errorf("guest still has %d matches", len(list))
	}
	m, _ := s.Get(g2.ID)
	if m.Players[0] != member || m.Players[1] != member {
		t.Errorf("players not moved: %+v", m.Players)
	}
	m, _ = s.Get(g1.ID)
	if m.Players[0] != member || m.Players[1].ID != "g_yyy" {
		t.Errorf("only the guest should move: %+v", m.Players)
	}

	// 두 번 불러도 괜찮습니다
	if n, err := s.Adopt("g_me", member); n != 0 || err != nil {
		t.Errorf("second Adopt = %d, %v", n, err)
	}
}

func TestForget(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	leaving := Player{ID: "m_left", Kind: "member", Tag: "0001", Name: "left"}
	vs := sample("", "g_other")
	vs.Players[0] = leaving
	solo := sample("", "")
	solo.Players = [2]Player{leaving, leaving}
	both := sample("", "m_also")
	both.Players[0] = leaving
	for _, m := range []*Match{vs, solo, both} {
		s.Save(m)
	}
	s.Close()
	plays := s.Plays("tictactoe")

	if err := s.Forget("m_left"); err != nil {
		t.Fatal(err)
	}
	gone := Player{ID: "gone-0", Kind: "gone"}
	if m, _ := s.Get(vs.ID); m.Players[0] != gone || m.Players[1].ID != "g_other" {
		t.Errorf("vs = %+v", m.Players)
	}
	if m, _ := s.Get(solo.ID); m.Players[0] != (Player{ID: "gone", Kind: "gone"}) || m.Players[1] != m.Players[0] {
		t.Errorf("혼자 둔 대국은 두 자리가 같아야 합니다 (counts): %+v", m.Players)
	}
	// 상대도 나중에 탈퇴하면 자리마다 다른 id라 혼자 둔 대국이 되지 않습니다
	if err := s.Forget("m_also"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.Get(both.ID); m.Players[0] != gone || m.Players[1] != (Player{ID: "gone-1", Kind: "gone"}) || !counts(m) {
		t.Errorf("both = %+v", m.Players)
	}
	// 파일에 이름이 남지 않습니다
	for _, m := range []*Match{vs, solo, both} {
		data, _ := os.ReadFile(filepath.Join(dir, "matches", m.ID[:2], m.ID+".json"))
		if strings.Contains(string(data), "left") || strings.Contains(string(data), "m_") {
			t.Errorf("%s still names the account: %s", m.ID, data)
		}
	}
	if list, _ := s.ListByUser("m_left", 10); len(list) != 0 {
		t.Errorf("forgotten account still has %d matches", len(list))
	}
	if list, _ := s.ListByUser("g_other", 10); len(list) != 1 {
		t.Errorf("상대의 기록은 남아야 합니다: %d", len(list))
	}

	// 탈퇴할 때 진행 중이던 대국이 나중에 끝나도 지운 자리로 씁니다
	late := sample("", "g_other")
	late.Players[0] = leaving
	s.Save(late)
	s.Close()
	if m, _ := s.Get(late.ID); m.Players[0] != gone {
		t.Errorf("late = %+v", m.Players)
	}
	if late.Players[0] != leaving {
		t.Error("Save에 넘긴 대국을 고치면 안 됩니다 (Get이 쓰는 중에 그대로 내줍니다)")
	}
	if _, err := os.Stat(filepath.Join(dir, "users", "m_left.log")); !os.IsNotExist(err) {
		t.Errorf("목록 파일이 다시 생기면 안 됩니다: %v", err)
	}
	if got := s.Plays("tictactoe"); got != plays+1 {
		t.Errorf("Plays = %d, want %d", got, plays+1)
	}
	// 기록이 없는 계정도 괜찮습니다
	if err := s.Forget("m_nothing"); err != nil {
		t.Error(err)
	}
}

// names는 테스트용 계정 저장소입니다.
type names map[string]string

func (n names) Name(id string) (string, bool) {
	name, ok := n[id]
	return name, ok
}

// 기보에 남은 이름 대신 지금 계정 이름을 보내고, 없는 계정(탈퇴)은 이름 없이 보냅니다.
func TestViewNames(t *testing.T) {
	m := sample("g_guest", "")
	m.Players[1] = Player{ID: "m_renamed", Kind: "member", Tag: "0002", Name: "old"}
	h := Handler{Names: names{"m_renamed": "new"}}
	v := h.viewOf(m, "", false)
	if v.Players[0] != (protocol.PlayerInfo{Kind: "guest", Tag: "1111"}) || v.Players[1] != (protocol.PlayerInfo{Kind: "member", Tag: "0002", Name: "new"}) {
		t.Fatalf("players = %+v", v.Players)
	}
	h.Names = names{}
	if v := h.viewOf(m, "", false); v.Players[1] != (protocol.PlayerInfo{Kind: "gone"}) {
		t.Fatalf("deleted = %+v", v.Players[1])
	}
	// 이름 저장소가 없으면(로그인을 켜지 않은 서버) 남은 이름 그대로
	if v := (Handler{}).viewOf(m, "", false); v.Players[1].Name != "old" {
		t.Fatalf("no names = %+v", v.Players[1])
	}
}

func TestDaily(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	at := func(game, when string) *Match {
		m := sample("g_a", "g_b")
		m.Game = game
		m.Ended, _ = time.Parse(time.RFC3339, when)
		return m
	}
	solo := at("tictactoe", "2026-11-03T03:00:00Z")
	solo.Players[1] = solo.Players[0]
	for _, m := range []*Match{
		at("tictactoe", "2026-11-03T14:59:00Z"), // 한국 11월 3일 23:59
		at("tictactoe", "2026-11-03T15:00:00Z"), // 한국 11월 4일 0:00
		at("dots", "2026-11-04T01:00:00Z"),
		solo, // 판 수에 세지 않는 대국은 날마다 수에도 빠집니다
	} {
		s.Save(m)
	}
	want := map[string]map[string]int{
		"2026-11-03": {"tictactoe": 1},
		"2026-11-04": {"tictactoe": 1, "dots": 1},
	}
	check := func(label string, s *Store) {
		t.Helper()
		got := s.Daily("2026-11-01")
		if len(got) != len(want) || got["2026-11-03"]["tictactoe"] != 1 || got["2026-11-04"]["tictactoe"] != 1 || got["2026-11-04"]["dots"] != 1 {
			t.Fatalf("%s: %v", label, got)
		}
		if late := s.Daily("2026-11-04"); len(late) != 1 || late["2026-11-04"] == nil {
			t.Fatalf("%s from 11-04: %v", label, late)
		}
	}
	check("pending", s)
	// 돌려받은 것을 고쳐도 저장소는 그대로입니다
	s.Daily("2026-11-01")["2026-11-03"]["tictactoe"] = 99
	check("after edit", s)
	s.Close()

	s2, _ := Open(dir)
	check("reopen", s2)

	// days.json만 없으면(날마다 수를 세기 전의 데이터) 기보를 훑어 그것만 다시 셉니다. plays.json은 그대로 둡니다
	os.WriteFile(filepath.Join(dir, "plays.json"), []byte(`{"tictactoe":5}`), 0o644)
	os.Remove(filepath.Join(dir, "days.json"))
	s3, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	check("rebuilt", s3)
	if s3.Plays("tictactoe") != 5 {
		t.Fatalf("plays.json was replaced: %d", s3.Plays("tictactoe"))
	}
	if _, err := os.Stat(filepath.Join(dir, "days.json")); err != nil {
		t.Fatalf("days.json not written: %v", err)
	}
}
