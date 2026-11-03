package account

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func TestFindAndCreate(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := s.Find("github", "42"); ok {
		t.Fatal("found before create")
	}
	if _, _, err := s.Create("github", "42", "운영자"); !errors.Is(err, ErrNameReserved) {
		t.Fatalf("reserved name: %v", err)
	}
	a, created, err := s.Create("github", "42", " shin ")
	if err != nil || !created {
		t.Fatalf("create: %+v, %v, %v", a, created, err)
	}
	if !strings.HasPrefix(a.ID, "m_") || a.Kind != identity.KindMember || a.Name != "shin" || len(a.Tag) != 4 {
		t.Fatalf("bad member: %+v", a)
	}
	if got, ok := s.Find("github", "42"); !ok || got != a {
		t.Fatalf("Find = %+v, %v", got, ok)
	}
	// 두 번 눌러도 계정은 하나. 이름은 처음 것 그대로
	b, created, err := s.Create("github", "42", "other")
	if err != nil || created || b != a {
		t.Fatalf("second create = %+v, %v, %v; want %+v", b, created, err, a)
	}
	// 번호가 같아도 다른 곳이면 다른 계정. 이름이 같아도 됩니다 (태그로 구분)
	c, created, _ := s.Create("google", "42", "shin")
	if !created || c.ID == a.ID {
		t.Fatalf("google should be a new account: %+v", c)
	}
	if name, ok := s.Name(a.ID); !ok || name != "shin" {
		t.Errorf("Name = %q, %v", name, ok)
	}
	if _, ok := s.Name("m_nobody"); ok {
		t.Error("unknown id found")
	}
}

func TestReopen(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	a, _, _ := s.Create("google", "1001", "재근")

	// 끝까지 못 쓴 줄이 있어도 나머지는 읽습니다
	f, _ := os.OpenFile(filepath.Join(dir, "accounts.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"op":"add","id":"m_bro`)
	f.Close()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if b, ok := s.Find("google", "1001"); !ok || b != a {
		t.Fatalf("after reopen = %+v, want %+v", b, a)
	}
}

func TestValidName(t *testing.T) {
	for in, want := range map[string]error{
		"shin":          nil,
		"재근":            nil,
		"a_b-c.d":       nil,
		"Player123":     nil,
		"a":             ErrNameLength,
		"123456789abcd": ErrNameLength,
		"":              ErrNameLength,
		"two words":     ErrNameChars,
		"<b>hi":         ErrNameChars,
		"hi😀":           ErrNameChars,
		"Admin":         ErrNameReserved,
		"보드마당짱":         ErrNameReserved,
		"Guest4821":     ErrNameReserved,
		"게스트1234":       ErrNameReserved,
	} {
		if _, err := ValidName(in); err != want {
			t.Errorf("ValidName(%q) = %v, want %v", in, err, want)
		}
	}
}

func TestSuggest(t *testing.T) {
	for in, want := range map[string]string{
		"octo-cat":              "octo-cat",
		"Jae Geun":              "JaeGeun",
		"a":                     "",
		"admin":                 "",
		strings.Repeat("가", 20): strings.Repeat("가", MaxName),
	} {
		if got := Suggest(in); got != want {
			t.Errorf("Suggest(%q) = %q, want %q", in, got, want)
		}
	}
}

// open은 시계를 마음대로 넘길 수 있는 Store입니다.
func open(t *testing.T, dir string) (*Store, *time.Time) {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	return s, &now
}

func TestRename(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	a, _, _ := s.Create("google", "1", "shin")

	if _, err := s.Rename(a.ID, "운영자"); !errors.Is(err, ErrNameReserved) {
		t.Fatalf("reserved: %v", err)
	}
	if _, err := s.Rename(a.ID, " shin "); !errors.Is(err, ErrNameSame) {
		t.Fatalf("same name: %v", err)
	}
	if _, err := s.Rename("m_nobody", "other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown id: %v", err)
	}
	// 가입한 뒤 첫 번째는 바로 됩니다
	got, err := s.Rename(a.ID, "준규")
	if err != nil || got.Name != "준규" || !got.Renamed.Equal(*now) {
		t.Fatalf("rename = %+v, %v", got, err)
	}
	if name, _ := s.Name(a.ID); name != "준규" {
		t.Fatalf("Name = %q", name)
	}
	if u, _ := s.Find("google", "1"); u.Name != "준규" {
		t.Fatalf("Find = %+v", u)
	}
	// RenameEvery가 지나야 다시 바꿉니다
	*now = now.Add(RenameEvery - time.Minute)
	if _, err := s.Rename(a.ID, "shin2"); !errors.Is(err, ErrRenameSoon) {
		t.Fatalf("too soon: %v", err)
	}
	if after := got.RenameAfter(*now); !after.Equal(got.Renamed.Add(RenameEvery)) {
		t.Fatalf("RenameAfter = %v", after)
	}
	*now = now.Add(time.Minute)
	if _, err := s.Rename(a.ID, "shin2"); err != nil {
		t.Fatal(err)
	}

	// 다시 켜도 지금 이름과 바꾼 때가 남습니다
	s2, _ := open(t, dir)
	b, ok := s2.Get(a.ID)
	if !ok || b.Name != "shin2" || !b.Renamed.Equal(*now) || b.Provider != "google" {
		t.Fatalf("after reopen = %+v, %v", b, ok)
	}
}

func TestDelete(t *testing.T) {
	dir := t.TempDir()
	s, now := open(t, dir)
	a, _, _ := s.Create("github", "42", "leaving")
	*now = now.Add(time.Hour)
	b, _, _ := s.Create("google", "7", "staying")
	s.Rename(b.ID, "stayed")
	s.Rename(a.ID, "left")

	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if _, ok := s.Name(a.ID); ok {
		t.Fatal("deleted account still has a name")
	}
	if _, ok := s.Find("github", "42"); ok {
		t.Fatal("deleted account still found")
	}
	// 파일에도 그 계정의 줄이 없습니다 (로그인한 곳의 번호, 지난 이름까지)
	data, _ := os.ReadFile(filepath.Join(dir, "accounts.jsonl"))
	for _, gone := range []string{a.ID, `"42"`, "leaving", "left"} {
		if strings.Contains(string(data), gone) {
			t.Errorf("accounts.jsonl still has %s:\n%s", gone, data)
		}
	}

	// 남은 계정은 다시 켜도 그대로입니다. 지운 사람은 다시 로그인하면 새 계정입니다
	want, _ := s.Get(b.ID)
	s2, _ := open(t, dir)
	got, ok := s2.Get(b.ID)
	same := got.ID == want.ID && got.Provider == want.Provider && got.Sub == want.Sub && got.Name == want.Name &&
		got.Created.Equal(want.Created) && got.Renamed.Equal(want.Renamed)
	if !ok || !same || got.Name != "stayed" || got.Renamed.IsZero() {
		t.Fatalf("after reopen = %+v, %v; want %+v", got, ok, want)
	}
	if _, ok := s2.Get(a.ID); ok {
		t.Fatal("deleted account came back")
	}
	c, created, _ := s2.Create("github", "42", "again")
	if !created || c.ID == a.ID {
		t.Fatalf("recreate = %+v, %v", c, created)
	}
}
