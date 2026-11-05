// Package star는 게임 즐겨찾기(별)입니다.
//
// DATA_DIR/stars.json에 게임마다 별을 단 계정 id를 씁니다 {"<게임 id>":["m_…",…]}.
// 열 때 한 번 읽어 메모리에 두고, 바뀔 때마다 파일 전체를 다시 씁니다. 서버 한 대(VM 디스크)를 전제로 합니다.
//
// 별은 계정만 답니다 (http.go). 게스트도 받으면 쿠키를 지워 가며 한 사람이 별 수를 부풀릴 수 있기 때문입니다.
// 탈퇴한 계정의 별은 Forget이 지웁니다.
package star

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
)

var ErrBadGame = errors.New("bad game")

var gamePattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

type Store struct {
	file  string
	mu    sync.Mutex
	stars map[string]map[string]bool // 게임 → 별을 단 계정
}

// Open은 dir/stars.json을 읽습니다. 없으면 빈 채로 엽니다.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{file: filepath.Join(dir, "stars.json"), stars: make(map[string]map[string]bool)}
	data, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var saved map[string][]string
	if err := json.Unmarshal(data, &saved); err != nil {
		return nil, err
	}
	for game, users := range saved {
		for _, u := range users {
			s.add(game, u)
		}
	}
	return s, nil
}

func (s *Store) add(game, user string) {
	if s.stars[game] == nil {
		s.stars[game] = make(map[string]bool)
	}
	s.stars[game][user] = true
}

// Stars는 game에 별을 단 계정 수입니다.
func (s *Store) Stars(game string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.stars[game])
}

// Mine은 user가 별을 단 게임 id입니다 (이름순). 지금 목록에 없는 게임도 들어 있을 수 있습니다.
func (s *Store) Mine(user string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	games := []string{}
	for game, users := range s.stars {
		if users[user] {
			games = append(games, game)
		}
	}
	slices.Sort(games)
	return games
}

// Set은 user가 game에 별을 달거나(on) 뗍니다. 이미 그 상태면 그대로 둡니다. 바뀐 뒤의 별 수를 돌려줍니다.
func (s *Store) Set(game, user string, on bool) (int, error) {
	if !gamePattern.MatchString(game) {
		return 0, ErrBadGame
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if on == s.stars[game][user] {
		return len(s.stars[game]), nil
	}
	if on {
		s.add(game, user)
	} else {
		delete(s.stars[game], user)
		if len(s.stars[game]) == 0 {
			delete(s.stars, game)
		}
	}
	if err := s.write(); err != nil {
		// 파일에 못 썼으면 되돌려서 메모리와 파일이 어긋나지 않게 합니다
		if on {
			delete(s.stars[game], user)
			if len(s.stars[game]) == 0 {
				delete(s.stars, game)
			}
		} else {
			s.add(game, user)
		}
		return len(s.stars[game]), err
	}
	return len(s.stars[game]), nil
}

// Forget은 탈퇴한 계정 user의 별을 모두 뗍니다.
func (s *Store) Forget(user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for game, users := range s.stars {
		if users[user] {
			delete(users, user)
			if len(users) == 0 {
				delete(s.stars, game)
			}
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return s.write()
}

// write는 지금 별을 stars.json에 씁니다. mu를 잡고 부릅니다.
// 임시 파일에 쓰고 이름을 바꿔서, 쓰다가 꺼져도 반쯤 쓴 파일이 남지 않습니다.
func (s *Store) write() error {
	out := make(map[string][]string, len(s.stars))
	for game, users := range s.stars {
		list := make([]string, 0, len(users))
		for u := range users {
			list = append(list, u)
		}
		slices.Sort(list)
		out[game] = list
	}
	data, err := json.Marshal(out)
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}
