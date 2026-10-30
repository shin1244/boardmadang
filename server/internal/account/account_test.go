package account

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
