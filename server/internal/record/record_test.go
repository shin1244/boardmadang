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
