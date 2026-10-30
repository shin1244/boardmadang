// Package account는 소셜 로그인으로 만든 계정을 저장합니다. 설계는 docs/identity.md에 있습니다.
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	accounts.jsonl   계정 기록. 만듦(add)을 한 줄에 하나씩 덧붙입니다
//
// 서버가 켤 때 파일을 처음부터 읽어 메모리에 올려 둡니다. 서버 한 대(VM 디스크)를 전제로 합니다.
// 비밀번호, 이메일, 소셜 로그인의 토큰은 저장하지 않습니다. 로그인한 곳(provider)과 그곳의 사용자 번호(sub)만 남깁니다.
//
// 같은 사람이 Google과 GitHub로 따로 로그인하면 계정이 둘 생깁니다. 이메일이 같다고 합치지 않습니다
// (이메일 확인 여부가 로그인한 곳마다 달라서, 남의 이메일로 만든 계정이 내 계정을 가져갈 수 있습니다).
// 이름은 처음 로그인할 때 사람이 직접 정합니다 (ValidName). 계정은 이름을 정하는 순간 만들어지므로 이름 없는 계정은 없습니다.
// TODO: 로그인한 상태에서 다른 곳을 연결하기, 이름 바꾸기, 탈퇴
package account

import (
	"bufio"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// 계정 이름의 글자 수
const (
	MinName = 2
	MaxName = 12
)

// 이름이 왜 안 되는지. API는 Error()를 그대로 보내고, 화면이 언어별 글로 바꿉니다.
var (
	ErrNameLength   = errors.New("name length")
	ErrNameChars    = errors.New("name chars")
	ErrNameReserved = errors.New("name reserved")
)

// reserved는 이름에 들어가면 안 되는 말입니다 (운영자나 게스트를 사칭하지 못하게). 소문자로 비교합니다.
var reserved = []string{"admin", "moderator", "official", "boardmadang", "guest", "운영자", "관리자", "보드마당", "공식", "게스트"}

// Account는 계정 하나입니다.
type Account struct {
	ID       string
	Provider string // google, github
	Sub      string // 그곳의 사용자 번호. 이름이나 이메일과 달리 바뀌지 않습니다
	Name     string
	Created  time.Time
}

// line은 accounts.jsonl의 한 줄입니다.
type line struct {
	Op       string    `json:"op"` // add
	ID       string    `json:"id"`
	Provider string    `json:"provider"`
	Sub      string    `json:"sub"`
	Name     string    `json:"name"`
	At       time.Time `json:"at"`
}

type Store struct {
	file string
	now  func() time.Time // 테스트에서 시간을 바꾸려고 둡니다

	mu    sync.Mutex
	byID  map[string]*Account
	bySub map[string]*Account // provider + ":" + sub
}

// Open은 dir/accounts.jsonl을 읽어 Store를 엽니다. 파일이 없으면 빈 Store입니다.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		file:  filepath.Join(dir, "accounts.jsonl"),
		now:   time.Now,
		byID:  make(map[string]*Account),
		bySub: make(map[string]*Account),
	}
	f, err := os.Open(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for n := 1; sc.Scan(); n++ {
		var l line
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			// 끝까지 못 쓰고 꺼진 마지막 줄 같은 것. 그 줄만 건너뜁니다.
			log.Printf("계정 기록 %d번째 줄을 읽지 못했습니다: %v", n, err)
			continue
		}
		if l.Op == "add" {
			s.put(&Account{ID: l.ID, Provider: l.Provider, Sub: l.Sub, Name: l.Name, Created: l.At})
		}
	}
	return s, sc.Err()
}

func (s *Store) put(a *Account) {
	s.byID[a.ID] = a
	s.bySub[a.Provider+":"+a.Sub] = a
}

// Name은 계정 이름입니다. identity.Members를 채웁니다.
func (s *Store) Name(id string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return "", false
	}
	return a.Name, true
}

// Find는 provider의 sub 사용자의 계정을 찾습니다. 처음 온 사람이면 false입니다 (이름을 정하게 한 뒤 Create).
func (s *Store) Find(provider, sub string) (identity.User, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.bySub[provider+":"+sub]
	if !ok {
		return identity.User{}, false
	}
	return identity.Member(a.ID, a.Name), true
}

// Create는 provider의 sub 사용자의 계정을 name으로 만듭니다. name은 ValidName을 통과해야 합니다.
// 그 사이에 같은 사람의 계정이 생겼으면(두 번 누름) 그 계정을 돌려주고 created는 false입니다.
func (s *Store) Create(provider, sub, name string) (u identity.User, created bool, err error) {
	if provider == "" || sub == "" {
		return identity.User{}, false, errors.New("account: empty provider or sub")
	}
	name, err = ValidName(name)
	if err != nil {
		return identity.User{}, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.bySub[provider+":"+sub]; ok {
		return identity.Member(a.ID, a.Name), false, nil
	}
	a := &Account{ID: newID(), Provider: provider, Sub: sub, Name: name, Created: s.now().UTC()}
	if err := s.append(line{Op: "add", ID: a.ID, Provider: a.Provider, Sub: a.Sub, Name: a.Name, At: a.Created}); err != nil {
		return identity.User{}, false, err
	}
	s.put(a)
	return identity.Member(a.ID, a.Name), true, nil
}

func (s *Store) append(l line) error {
	data, err := json.Marshal(l)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(data, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func newID() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "m_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

// ValidName은 사람이 정한 이름을 확인하고 앞뒤 공백을 뗀 이름을 돌려줍니다.
// MinName~MaxName 글자의 글자(한글, 영문 등), 숫자, _ - . 만 됩니다. 띄어쓰기는 안 됩니다.
func ValidName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < MinName || n > MaxName {
		return "", ErrNameLength
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' && r != '.' {
			return "", ErrNameChars
		}
	}
	lower := strings.ToLower(name)
	for _, w := range reserved {
		if strings.Contains(lower, w) {
			return "", ErrNameReserved
		}
	}
	return name, nil
}

// Suggest는 로그인한 곳에서 받은 이름을 이름 칸의 기본값으로 다듬습니다. 쓸 수 없는 글자는 빼고 MaxName 글자로 자릅니다.
// 결과가 ValidName을 통과하지 못하면 빈 문자열입니다 (빈 칸으로 보여줍니다).
func Suggest(name string) string {
	var b strings.Builder
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.' {
			b.WriteRune(r)
		}
	}
	runes := []rune(b.String())
	if len(runes) > MaxName {
		runes = runes[:MaxName]
	}
	out, err := ValidName(string(runes))
	if err != nil {
		return ""
	}
	return out
}
