// Package record는 끝난 대국의 기보(시드 + 행동 기록)와 결과를 파일로 남깁니다.
//
// 락스텝이라 시드와 행동 기록만 있으면 판을 처음부터 다시 만들 수 있습니다. 한 판은 보통 수 KB입니다.
// DATA_DIR 아래에 이렇게 씁니다.
//
//	matches/<id 앞 두 글자>/<id>.json   대국 하나
//	users/<user id>.log                 그 유저가 둔 대국 id. 한 줄에 하나, 끝난 순서대로
//
// 서버 한 대(VM 디스크)를 전제로 합니다. 서버를 여러 대로 늘리면 DB나 Cloud Storage로 옮깁니다.
//
// 게임 코드의 버전(코드 파일의 해시)도 같이 남깁니다. 제작자가 코드를 고치면 예전 기보가 다르게 재생될 수 있어서,
// 다시보기 화면이 지금 코드와 버전이 다르면 알려 줍니다.
// TODO: 옛 버전의 코드도 보관해서 그 코드로 재생하기
package record

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// Player는 대국에 앉은 사람입니다. ID는 서버 안에서만 씁니다 (브라우저에는 View로 빼고 보냅니다).
type Player struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Tag  string `json:"tag"`
	Name string `json:"name,omitempty"`
}

// Move는 행동 하나입니다. 순번은 Moves 안의 위치입니다.
type Move struct {
	Player int             `json:"player"`
	Action protocol.Action `json:"action"`
	At     int64           `json:"at"` // 대국 시작부터 지난 ms
}

// Match는 끝난 대국 하나입니다.
type Match struct {
	ID      string    `json:"id"`
	Game    string    `json:"game"`
	Version string    `json:"version,omitempty"` // 게임 코드 버전. 버전을 모르던 클라이언트의 대국이면 없음
	Seed    uint32    `json:"seed"`
	Minutes *int      `json:"minutes"` // 타이머(분). null이면 없음
	Players [2]Player `json:"players"`
	Moves   []Move    `json:"moves"`
	Winner  *int      `json:"winner"`
	Reason  string    `json:"reason"`          // protocol의 Reason* 값
	Clock   *[2]int64 `json:"clock,omitempty"` // 끝났을 때 남은 시간(ms). 타이머가 없으면 없음
	Started time.Time `json:"started"`
	Ended   time.Time `json:"ended"`
}

// 기보 id. 방 코드와 같은 글자를 쓰지만, 방 코드는 다시 쓰이므로 따로 만듭니다.
const idAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

var (
	idPattern   = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{10}$`)
	userPattern = regexp.MustCompile(`^[a-z]_[a-z0-9]{1,64}$`)
)

// NewID는 새 기보 id입니다 (10글자, 약 50비트). 아는 사람만 볼 수 있는 링크로도 쓰므로 맞히기 어려워야 합니다.
func NewID() string {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}

// ValidID는 id가 기보 id 모양인지입니다. 경로에 넣기 전에 꼭 봅니다.
func ValidID(id string) bool { return idPattern.MatchString(id) }

type Store struct {
	dir string

	mu      sync.Mutex
	pending map[string]*Match // 파일에 쓰는 중인 대국. 다 쓸 때까지 Get이 여기서 찾습니다

	writeMu sync.Mutex // users/*.log에 덧붙이는 것을 한 번에 하나씩
	wg      sync.WaitGroup
}

// Open은 dir 아래에 기보를 저장하는 Store를 엽니다. 폴더가 없으면 만듭니다.
func Open(dir string) (*Store, error) {
	for _, sub := range []string{"matches", "users"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	return &Store{dir: dir, pending: make(map[string]*Match)}, nil
}

// Save는 대국을 저장합니다. 파일은 뒤에서 쓰고 바로 돌아오므로 방의 락을 잡은 채로 불러도 됩니다.
// 쓰는 동안에도 Get과 ListByUser에는 바로 보입니다. 실패하면 로그만 남깁니다.
func (s *Store) Save(m *Match) {
	s.mu.Lock()
	s.pending[m.ID] = m
	s.mu.Unlock()
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		if err := s.write(m); err != nil {
			log.Printf("기보 저장 실패 %s: %v", m.ID, err)
		}
		s.mu.Lock()
		delete(s.pending, m.ID)
		s.mu.Unlock()
	}()
}

// Close는 쓰는 중인 기보를 다 쓸 때까지 기다립니다. 서버를 끌 때 부릅니다.
func (s *Store) Close() { s.wg.Wait() }

func (s *Store) path(id string) string {
	return filepath.Join(s.dir, "matches", id[:2], id+".json")
}

func (s *Store) write(m *Match) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	file := s.path(m.ID)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	// 반쯤 쓴 파일이 보이지 않게 임시 파일에 쓰고 이름을 바꿉니다.
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		return err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for i, p := range m.Players {
		if !userPattern.MatchString(p.ID) || (i == 1 && p.ID == m.Players[0].ID) {
			continue // 혼자 두 자리에 앉았으면 한 번만
		}
		f, err := os.OpenFile(filepath.Join(s.dir, "users", p.ID+".log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(f, m.ID)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// ErrNotFound는 그런 기보가 없을 때입니다.
var ErrNotFound = errors.New("record not found")

func (s *Store) Get(id string) (*Match, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	s.mu.Lock()
	m := s.pending[id]
	s.mu.Unlock()
	if m != nil {
		return m, nil
	}
	data, err := os.ReadFile(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m = new(Match)
	if err := json.Unmarshal(data, m); err != nil {
		return nil, err
	}
	return m, nil
}

// ListByUser는 userID가 둔 대국을 최근 것부터 limit개 돌려줍니다.
func (s *Store) ListByUser(userID string, limit int) ([]*Match, error) {
	if !userPattern.MatchString(userID) {
		return nil, nil
	}
	data, err := os.ReadFile(filepath.Join(s.dir, "users", userID+".log"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	ids := strings.Fields(string(data))

	// 아직 쓰는 중인 대국은 목록 파일에 없을 수 있습니다.
	s.mu.Lock()
	var fresh []*Match
	for _, m := range s.pending {
		if (m.Players[0].ID == userID || m.Players[1].ID == userID) && !slices.Contains(ids, m.ID) {
			fresh = append(fresh, m)
		}
	}
	s.mu.Unlock()
	slices.SortFunc(fresh, func(a, b *Match) int { return a.Ended.Compare(b.Ended) })
	for _, m := range fresh {
		ids = append(ids, m.ID)
	}

	var out []*Match
	for i := len(ids) - 1; i >= 0 && len(out) < limit; i-- {
		m, err := s.Get(ids[i])
		if err != nil {
			continue // 지워졌거나 깨진 파일은 건너뜁니다
		}
		out = append(out, m)
	}
	return out, nil
}
