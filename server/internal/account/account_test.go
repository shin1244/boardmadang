package account

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func TestLoginFindsOrCreates(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, created, err := s.Login("github", "42", "shin")
	if err != nil || !created {
		t.Fatalf("first login: %+v, %v, %v", a, created, err)
	}
	if !strings.HasPrefix(a.ID, "m_") || a.Kind != identity.KindMember || a.Name != "shin" || len(a.Tag) != 4 {
		t.Fatalf("bad member: %+v", a)
	}

	// 같은 곳의 같은 사람이면 같은 계정. 이름은 처음 것 그대로
	b, created, err := s.Login("github", "42", "renamed")
	if err != nil || created || b != a {
		t.Fatalf("second login = %+v, %v, %v; want %+v", b, created, err, a)
	}
	// 번호가 같아도 다른 곳이면 다른 계정
	c, created, _ := s.Login("google", "42", "shin")
	if !created || c.ID == a.ID {
		t.Fatalf("google login should be a new account: %+v", c)
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
	a, _, _ := s.Login("google", "1001", "재근")

	// 끝까지 못 쓴 줄이 있어도 나머지는 읽습니다
	f, _ := os.OpenFile(filepath.Join(dir, "accounts.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"op":"add","id":"m_bro`)
	f.Close()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, created, _ := s.Login("google", "1001", "")
	if created || b != a {
		t.Fatalf("after reopen = %+v (created %v), want %+v", b, created, a)
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"shin":                         "shin",
		"  Jae\n\tGeun  ":              "Jae Geun",
		"":                             "player",
		"\x00\x07":                     "player",
		strings.Repeat("가", 30):        strings.Repeat("가", MaxName),
		strings.Repeat("a", 19) + " b": strings.Repeat("a", 19),
	} {
		if got := CleanName(in); got != want {
			t.Errorf("CleanName(%q) = %q, want %q", in, got, want)
		}
	}
}
