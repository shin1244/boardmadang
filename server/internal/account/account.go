// Package account는 소셜 로그인으로 만든 계정을 저장합니다. 설계는 docs/identity.md에 있습니다.
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	accounts.jsonl   계정 기록. 만듦(add), 이름 바꿈(rename), 정지(suspend)와 풂(unsuspend)을 한 줄에 하나씩 덧붙입니다
//
// 서버가 켤 때 파일을 처음부터 읽어 메모리에 올려 둡니다. 서버 한 대(VM 디스크)를 전제로 합니다.
// 비밀번호, 이메일, 소셜 로그인의 토큰은 저장하지 않습니다. 로그인한 곳(provider)과 그곳의 사용자 번호(sub)만 남깁니다.
//
// 같은 사람이 Google과 GitHub로 따로 로그인하면 계정이 둘 생깁니다. 이메일이 같다고 합치지 않습니다
// (이메일 확인 여부가 로그인한 곳마다 달라서, 남의 이메일로 만든 계정이 내 계정을 가져갈 수 있습니다).
// 이름은 처음 로그인할 때 사람이 직접 정합니다 (ValidName). 계정은 이름을 정하는 순간 만들어지므로 이름 없는 계정은 없습니다.
// 이름은 RenameEvery에 한 번 바꿀 수 있습니다 (가입한 뒤 첫 번째는 바로).
// 운영자는 계정을 정지(suspend)하고 풀(unsuspend) 수 있습니다. 정지된 동안은 쓰기를 막습니다 (identity.WriteDenied).
//
// 탈퇴(Delete)하면 그 계정의 줄을 파일에서 아예 지웁니다 (파일을 새로 씁니다). 그 계정의 세션 토큰은 identity가
// 저장소에서 계정을 못 찾아 바로 거절합니다. 기보, 의견, 올린 게임은 http.go의 Handler.Forget이 지웁니다.
// TODO: 로그인한 상태에서 다른 곳을 연결하기
package account

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// 계정 이름의 글자 수. 영문과 숫자만 되므로 바이트 수와 같습니다
const (
	MinName = 4
	MaxName = 8
)

// RenameEvery는 이름을 다시 바꿀 수 있을 때까지의 시간입니다. 남을 흉내 내려고 이름을 자주 바꾸지 못하게 합니다.
const RenameEvery = 30 * 24 * time.Hour

// 이름이 왜 안 되는지. API는 Error()를 그대로 보내고, 화면이 언어별 글로 바꿉니다.
var (
	ErrNameLength   = errors.New("name length")
	ErrNameChars    = errors.New("name chars")
	ErrNameReserved = errors.New("name reserved")
	ErrNameSame     = errors.New("name same")       // 지금 이름과 같음
	ErrRenameSoon   = errors.New("rename too soon") // RenameEvery가 지나지 않음
	ErrSuspended    = errors.New("suspended")       // 정지된 계정은 이름을 바꿀 수 없음
	ErrNotFound     = errors.New("not found")
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
	Renamed  time.Time // 마지막으로 이름을 바꾼 때. 안 바꿨으면 0

	// 운영자가 정지한 계정 (Suspend). SuspendedUntil이 0이면 영구, 지났으면 풀린 것입니다 (SuspendedAt으로 봅니다).
	Suspended      bool
	SuspendedUntil time.Time
}

// SuspendedAt은 now에 정지된 상태인지입니다.
func (a Account) SuspendedAt(now time.Time) bool {
	return a.Suspended && (a.SuspendedUntil.IsZero() || now.Before(a.SuspendedUntil))
}

// RenameAfter는 이름을 다시 바꿀 수 있는 때입니다. 지금 바꿀 수 있으면 0입니다.
func (a Account) RenameAfter(now time.Time) time.Time {
	if a.Renamed.IsZero() || now.Sub(a.Renamed) >= RenameEvery {
		return time.Time{}
	}
	return a.Renamed.Add(RenameEvery)
}

// line은 accounts.jsonl의 한 줄입니다.
type line struct {
	Op       string    `json:"op"` // add, rename, suspend, unsuspend
	ID       string    `json:"id"`
	Provider string    `json:"provider,omitempty"` // add만
	Sub      string    `json:"sub,omitempty"`      // add만
	Name     string    `json:"name,omitempty"`     // add, rename
	Until    time.Time `json:"until,omitzero"`     // suspend만. 없으면 영구
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
		switch l.Op {
		case "add":
			s.put(&Account{ID: l.ID, Provider: l.Provider, Sub: l.Sub, Name: l.Name, Created: l.At})
		case "rename":
			if a := s.byID[l.ID]; a != nil {
				a.Name, a.Renamed = l.Name, l.At
			}
		case "suspend":
			if a := s.byID[l.ID]; a != nil {
				a.Suspended, a.SuspendedUntil = true, l.Until
			}
		case "unsuspend":
			if a := s.byID[l.ID]; a != nil {
				a.Suspended, a.SuspendedUntil = false, time.Time{}
			}
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

// Get은 계정 하나입니다 (내 계정 화면).
func (s *Store) Get(id string) (Account, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return Account{}, false
	}
	return *a, true
}

// Rename은 계정 이름을 name으로 바꿉니다. name은 ValidName을 통과해야 하고, 지난번에 바꾼 지 RenameEvery가 지나야 합니다.
// 기보와 의견에는 남긴 때의 이름이 저장되어 있지만, 화면에 보낼 때 지금 이름으로 바꿔 보냅니다 (internal/record, internal/comment).
func (s *Store) Rename(id, name string) (Account, error) {
	name, err := ValidName(name)
	if err != nil {
		return Account{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return Account{}, ErrNotFound
	}
	if name == a.Name {
		return Account{}, ErrNameSame
	}
	now := s.now().UTC()
	if a.SuspendedAt(now) {
		return Account{}, ErrSuspended
	}
	if !a.RenameAfter(now).IsZero() {
		return Account{}, ErrRenameSoon
	}
	if err := s.append(line{Op: "rename", ID: id, Name: name, At: now}); err != nil {
		return Account{}, err
	}
	a.Name, a.Renamed = name, now
	return *a, nil
}

// Delete는 계정을 지웁니다 (탈퇴). 파일에서도 그 계정의 줄(로그인한 곳의 사용자 번호, 지난 이름)을 모두 지웁니다.
// 같은 곳으로 다시 로그인하면 새 계정을 만듭니다.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return ErrNotFound
	}
	rest := make([]*Account, 0, len(s.byID)-1)
	for _, o := range s.byID {
		if o != a {
			rest = append(rest, o)
		}
	}
	if err := s.rewrite(rest); err != nil {
		return err
	}
	delete(s.byID, a.ID)
	delete(s.bySub, a.Provider+":"+a.Sub)
	return nil
}

// Suspend는 계정을 until까지 정지합니다 (운영자, internal/admin). until이 0이면 영구입니다. 이미 정지돼 있으면 기간을 바꿉니다.
func (s *Store) Suspend(id string, until time.Time) error {
	return s.setSuspended(id, line{Op: "suspend", ID: id, Until: until.UTC()})
}

// Unsuspend는 정지를 풉니다.
func (s *Store) Unsuspend(id string) error {
	return s.setSuspended(id, line{Op: "unsuspend", ID: id})
}

func (s *Store) setSuspended(id string, l line) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok {
		return ErrNotFound
	}
	l.At = s.now().UTC()
	if err := s.append(l); err != nil {
		return err
	}
	a.Suspended, a.SuspendedUntil = l.Op == "suspend", l.Until
	return nil
}

// Suspension은 계정이 지금 정지돼 있는지와 풀리는 때(영구면 0)입니다. identity.Suspensions를 채웁니다.
func (s *Store) Suspension(id string) (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.byID[id]
	if !ok || !a.SuspendedAt(s.now()) {
		return time.Time{}, false
	}
	return a.SuspendedUntil, true
}

// Suspended는 지금 정지된 계정입니다. 풀리는 때가 가까운 것부터, 영구 정지는 맨 뒤에.
func (s *Store) Suspended() []Account {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var out []Account
	for _, a := range s.byID {
		if a.SuspendedAt(now) {
			out = append(out, *a)
		}
	}
	slices.SortFunc(out, func(a, b Account) int {
		switch {
		case a.SuspendedUntil.IsZero() != b.SuspendedUntil.IsZero():
			if a.SuspendedUntil.IsZero() {
				return 1
			}
			return -1
		case !a.SuspendedUntil.Equal(b.SuspendedUntil):
			return a.SuspendedUntil.Compare(b.SuspendedUntil)
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// Joined는 지금 있는 계정마다 가입한 때입니다. 탈퇴한 계정은 빠집니다. 운영자 화면의 통계에 씁니다.
func (s *Store) Joined() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]time.Time, 0, len(s.byID))
	for _, a := range s.byID {
		out = append(out, a.Created)
	}
	return out
}

// rewrite는 accounts.jsonl을 list의 계정만으로 새로 씁니다. 계정마다 add 한 줄(지금 이름), 이름을 바꿨으면 rename 한 줄,
// 지금 정지돼 있으면 suspend 한 줄입니다.
// 반쯤 쓴 파일이 보이지 않게 임시 파일에 쓰고 이름을 바꿉니다. s.mu를 잡고 부릅니다.
func (s *Store) rewrite(list []*Account) error {
	slices.SortFunc(list, func(a, b *Account) int { return a.Created.Compare(b.Created) })
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf) // 한 줄에 하나씩 쓰고 줄바꿈을 붙입니다
	for _, a := range list {
		if err := enc.Encode(line{Op: "add", ID: a.ID, Provider: a.Provider, Sub: a.Sub, Name: a.Name, At: a.Created}); err != nil {
			return err
		}
		if !a.Renamed.IsZero() {
			if err := enc.Encode(line{Op: "rename", ID: a.ID, Name: a.Name, At: a.Renamed}); err != nil {
				return err
			}
		}
		if a.SuspendedAt(s.now()) {
			if err := enc.Encode(line{Op: "suspend", ID: a.ID, Until: a.SuspendedUntil, At: s.now().UTC()}); err != nil {
				return err
			}
		}
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
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
// MinName~MaxName 글자의 영문(대소문자)과 숫자만 됩니다. 한글, 기호, 띄어쓰기는 안 됩니다.
// 글자를 먼저 봅니다 ("신준규"는 글자 수보다 한글이 안 된다고 알려 주는 게 맞으므로).
// 이 규칙 전에 정한 이름(한글 등)은 그대로 쓰고, 바꿀 때만 이 규칙을 따릅니다.
func ValidName(name string) (string, error) {
	name = strings.TrimSpace(name)
	for _, r := range name {
		if !nameChar(r) {
			return "", ErrNameChars
		}
	}
	if n := len(name); n < MinName || n > MaxName {
		return "", ErrNameLength
	}
	lower := strings.ToLower(name)
	for _, w := range reserved {
		if strings.Contains(lower, w) {
			return "", ErrNameReserved
		}
	}
	return name, nil
}

// nameChar는 이름에 쓸 수 있는 글자입니다 (영문과 숫자).
func nameChar(r rune) bool {
	return 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9'
}

// Suggest는 로그인한 곳에서 받은 이름을 이름 칸의 기본값으로 다듬습니다. 쓸 수 없는 글자는 빼고 MaxName 글자로 자릅니다.
// 결과가 ValidName을 통과하지 못하면 빈 문자열입니다 (빈 칸으로 보여줍니다. 한글 이름이면 대개 빈 칸).
func Suggest(name string) string {
	var b strings.Builder
	for _, r := range name {
		if nameChar(r) && b.Len() < MaxName {
			b.WriteRune(r)
		}
	}
	out, err := ValidName(b.String())
	if err != nil {
		return ""
	}
	return out
}
