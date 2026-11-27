package record

// AI 대국의 기보 (AIStore).
//
// AI 대국은 브라우저 안에서만 돌아서 서버가 모르므로, AI 화면(web/ai.js)이 두는 동안 그 판을 보내 줍니다
// (POST /api/ai/{game}/match, internal/ai의 matches.go). 처음부터 지금까지의 수를 통째로 보내고, 서버는 파일을 덮어씁니다.
// 요청 하나를 놓쳐도 다음 요청이 채우고, 서버를 다시 켜도 파일에서 이어 받습니다.
// 끝 소식 없이 끊긴 판(화면을 닫음, 새로 고침)은 마지막으로 받은 수까지 Reason ""로 남습니다. 분석(cmd/dbexport)에서 나간 판으로 봅니다.
//
// 브라우저가 보고한 것이라 믿을 수 없으므로 분석에만 쓰고, 로비의 판 수, 내 대국 목록, 다시보기에는 넣지 않습니다.
// 그래서 온라인 대국과 폴더를 따로 씁니다.
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	aimatches/<id 앞 두 글자>/<id>.json   AI 대국 하나 (Match, AI가 있음)
//	aimatches/users/<user id>.log        그 사람이 둔 AI 대국 id. 처음 받은 순서대로 한 줄에 하나 (탈퇴, 게스트 옮기기에 씁니다)

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/stats"
)

const (
	// AIPerDay는 한 사람이 하루(한국 날짜)에 새로 남길 수 있는 AI 대국 수입니다. 넘으면 그날은 새 판을 받지 않습니다
	AIPerDay = 300
	// MaxAIMoves는 AI 대국 하나의 행동 수 상한입니다 (hub.MaxLog와 같게)
	MaxAIMoves = 2*2000 + 2*500
	// maxAIAt은 행동 시각의 상한입니다 (대국 시작부터). 켜 놓고 며칠 두는 판도 받습니다
	maxAIAt = int64(7 * 24 * time.Hour / time.Millisecond)
	// aiOpenTTL 동안 소식이 없는 판은 메모리에서 내립니다 (파일에는 그대로 남고, 다시 오면 파일에서 읽습니다)
	aiOpenTTL = time.Hour
)

// AI 대국에서 AI 자리의 사람 (Player). 탈퇴, 게스트 옮기기에 걸리지 않게 userPattern과 다른 모양입니다.
const (
	AIPlayerID = "ai"
	KindAI     = "ai"
)

// AI 대국이 끝난 이유 (AIEnd.Reason). 규칙대로 끝남(수 상한, 둘 사람이 없음 포함)은 온라인 대국과 같은 값입니다.
const (
	AIReasonResult = protocol.ReasonResult
	AIReasonResign = protocol.ReasonResign // 사람이 기권
	AIReasonStuck  = "stuck"               // AI가 둘 수 있는 수를 못 찾음 (무승부로 끝냄)
)

var aiLevels = map[string]bool{"easy": true, "normal": true, "hard": true}

var (
	ErrNotYours = errors.New("not your match")      // 그 id로 다른 사람(이나 다른 판)이 이미 두고 있음
	ErrEnded    = errors.New("match already ended") // 이미 끝난 판
	ErrTooMany  = errors.New("too many matches today")
)

// BadReport는 보낸 판의 모양이 틀렸을 때입니다.
type BadReport struct{ Reason string }

func (e BadReport) Error() string { return "bad match: " + e.Reason }

// AIReport는 AI 화면이 보내는 판 하나입니다 (POST /api/ai/{game}/match의 본문). Moves는 처음부터 지금까지 전부입니다.
type AIReport struct {
	ID      string `json:"id"`      // 화면이 판마다 만든 기보 id (NewID와 같은 모양)
	Version string `json:"version"` // 게임 코드 버전
	Seed    uint32 `json:"seed"`
	Seat    int    `json:"seat"`  // 사람이 앉은 자리
	Level   string `json:"level"` // easy | normal | hard
	Sims    int    `json:"sims"`
	Moves   []Move `json:"moves"`
	End     *AIEnd `json:"end,omitempty"` // 끝났으면
}

// AIEnd는 AI 대국이 끝난 결과입니다.
type AIEnd struct {
	Winner *int   `json:"winner"` // 이긴 자리. null이면 무승부
	Reason string `json:"reason"` // AIReason* 값
}

func (rep AIReport) check() error {
	switch {
	case !ValidID(rep.ID):
		return BadReport{"id"}
	case len(rep.Version) > 64 || strings.Trim(rep.Version, "0123456789abcdef") != "":
		return BadReport{"version"}
	case rep.Seat != 0 && rep.Seat != 1:
		return BadReport{"seat"}
	case !aiLevels[rep.Level]:
		return BadReport{"level"}
	case rep.Sims < 1 || rep.Sims > 2000:
		return BadReport{"sims"}
	case len(rep.Moves) > MaxAIMoves:
		return BadReport{"too many moves"}
	}
	last := int64(0)
	for _, m := range rep.Moves {
		if (m.Player != 0 && m.Player != 1) || !ValidAction(m.Action) || m.At < last || m.At > maxAIAt {
			return BadReport{"moves"}
		}
		last = m.At
	}
	if e := rep.End; e != nil {
		if e.Winner != nil && *e.Winner != 0 && *e.Winner != 1 {
			return BadReport{"winner"}
		}
		switch e.Reason {
		case AIReasonResult, AIReasonResign, AIReasonStuck:
		default:
			return BadReport{"reason"}
		}
	}
	return nil
}

// ValidAction은 행동의 모양만 봅니다 (hub의 validAction과 같은 규칙). 좌표는 플랫폼 상한(rows, cols ≤ 32) 안이어야 합니다.
func ValidAction(a protocol.Action) bool {
	if a.Kind == "" || len(a.Kind) > 32 {
		return false
	}
	if a.Kind == "click" {
		return a.Row >= 0 && a.Row < 32 && a.Col >= 0 && a.Col < 32
	}
	return a.Row == 0 && a.Col == 0
}

// AIStore는 DATA_DIR/aimatches입니다. OpenAI로 엽니다.
type AIStore struct {
	dir string
	now func() time.Time

	mu    sync.Mutex        // 파일 쓰기까지 한 번에 하나씩 (판마다 20초에 한 번쯤이라 충분합니다)
	open  map[string]*Match // 끝나지 않은 판
	day   string            // daily를 센 한국 날짜
	daily map[string]int    // 그날 사람마다 새로 받은 판 수
}

// OpenAI는 dir/aimatches를 엽니다. 폴더가 없으면 만듭니다.
func OpenAI(dir string) (*AIStore, error) {
	root := filepath.Join(dir, "aimatches")
	if err := os.MkdirAll(filepath.Join(root, "users"), 0o755); err != nil {
		return nil, err
	}
	return &AIStore{dir: root, now: time.Now, open: map[string]*Match{}, daily: map[string]int{}}, nil
}

func (s *AIStore) path(id string) string { return filepath.Join(s.dir, id[:2], id+".json") }

func (s *AIStore) userLog(id string) string { return filepath.Join(s.dir, "users", id+".log") }

// get은 끝나지 않은 판이면 메모리에서, 아니면 파일에서 읽습니다. 없으면 ErrNotFound. s.mu를 잡고 부릅니다.
func (s *AIStore) get(id string) (*Match, error) {
	if m := s.open[id]; m != nil {
		return m, nil
	}
	data, err := os.ReadFile(s.path(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m := new(Match)
	if err := json.Unmarshal(data, m); err != nil {
		return nil, err
	}
	return m, nil
}

// write는 판 하나를 파일에 씁니다. s.mu를 잡고 부릅니다.
func (s *AIStore) write(m *Match) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	file := s.path(m.ID)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	return writeAtomic(file, data)
}

// Get은 AI 대국 하나입니다 (시험과 운영용). 없으면 ErrNotFound.
func (s *AIStore) Get(id string) (*Match, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.get(id)
	if err != nil {
		return nil, err
	}
	c := *m
	return &c, nil
}

// Report는 u가 game을 두는 판 rep를 남깁니다. 처음 받는 판이면 country(사람이 접속한 나라)와 model(지금 그 게임의 신경망 파일)도 남깁니다.
// 이미 받은 판이면 같은 사람, 같은 판(게임, 시드, 자리)이어야 하고 수가 줄면 안 됩니다. 끝난 판은 더 받지 않습니다 (ErrEnded).
func (s *AIStore) Report(u identity.User, country, game, model string, rep AIReport) error {
	if err := rep.check(); err != nil {
		return err
	}
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune(now)

	prev, err := s.get(rep.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	var m Match
	if prev != nil {
		human := prev.Players[rep.Seat]
		if prev.AI == nil || prev.Game != game || prev.Seed != rep.Seed || prev.AI.Seat != 1-rep.Seat || human.ID != u.ID {
			return ErrNotYours
		}
		if prev.Reason != "" {
			return ErrEnded
		}
		if len(rep.Moves) < len(prev.Moves) {
			return BadReport{"moves went back"}
		}
		// 메모리의 판은 바꾸지 않고 복사본을 고칩니다 (쓰기에 실패하면 그대로).
		// 그사이 이름을 바꿨으면 새 이름으로 씁니다
		m = *prev
		m.Players[rep.Seat].Name = u.Name
	} else {
		if day := stats.Day(now); day != s.day {
			s.day, s.daily = day, map[string]int{}
		}
		if s.daily[u.ID] >= AIPerDay {
			return ErrTooMany
		}
		m = Match{
			ID:      rep.ID,
			Game:    game,
			Version: rep.Version,
			Seed:    rep.Seed,
			AI:      &AISide{Seat: 1 - rep.Seat, Level: rep.Level, Sims: rep.Sims, Model: model},
			Started: now,
		}
		if n := len(rep.Moves); n > 0 {
			// 화면은 사람이 첫 수를 둔 뒤에야 보내므로, 그때까지 지난 시간만큼 앞당깁니다
			m.Started = now.Add(-time.Duration(rep.Moves[n-1].At) * time.Millisecond)
		}
		m.Players[rep.Seat] = Player{ID: u.ID, Kind: u.Kind, Tag: u.Tag, Name: u.Name, Country: country}
		m.Players[1-rep.Seat] = Player{ID: AIPlayerID, Kind: KindAI}
	}
	m.Moves = rep.Moves
	m.Updated = now
	if rep.End != nil {
		m.Winner, m.Reason, m.Ended = rep.End.Winner, rep.End.Reason, now
	}
	if err := s.write(&m); err != nil {
		return err
	}
	if prev == nil {
		s.daily[u.ID]++
		if userPattern.MatchString(u.ID) {
			if err := appendLine(s.userLog(u.ID), m.ID); err != nil {
				return err
			}
		}
	}
	if m.Reason != "" {
		delete(s.open, m.ID)
	} else {
		s.open[m.ID] = &m
	}
	return nil
}

// prune은 오래 소식이 없는 판을 메모리에서 내립니다. s.mu를 잡고 부릅니다.
func (s *AIStore) prune(now time.Time) {
	for id, m := range s.open {
		if now.Sub(m.Updated) > aiOpenTTL {
			delete(s.open, id)
		}
	}
}

// appendLine은 file 끝에 한 줄을 덧붙입니다.
func appendLine(file, line string) error {
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(f, line)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// ids는 그 사람의 목록 파일에 있는 AI 대국 id입니다. 파일이 없으면 비어 있습니다. s.mu를 잡고 부릅니다.
func (s *AIStore) ids(userID string) ([]string, error) {
	data, err := os.ReadFile(s.userLog(userID))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return strings.Fields(string(data)), err
}

// Forget은 탈퇴한 계정 userID를 AI 대국에서 지웁니다. 그 자리는 id와 이름, 나라 없이 "탈퇴한 사용자"로 바꾸고 목록 파일을 지웁니다.
func (s *AIStore) Forget(userID string) error {
	if !userPattern.MatchString(userID) {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ids, err := s.ids(userID)
	if err != nil {
		return err
	}
	for _, id := range ids {
		m, err := s.get(id)
		if err != nil {
			continue // 지워졌거나 깨진 파일은 건너뜁니다
		}
		c := *m
		forgetSeats(&c, func(p string) bool { return p == userID })
		if err := s.write(&c); err != nil {
			return err
		}
		delete(s.open, id) // 그 사람의 세션은 이제 거절되므로 더 오지 않습니다
	}
	err = os.Remove(s.userLog(userID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Adopt는 게스트가 둔 AI 대국을 계정으로 옮깁니다. 게스트가 로그인할 때 부릅니다 (Store.Adopt와 같이).
// 자리를 계정으로 바꾸고(그 판의 나라는 그대로), 게스트의 목록을 계정의 목록 끝에 붙입니다. 옮긴 판 수를 돌려줍니다.
func (s *AIStore) Adopt(guestID string, to Player) (int, error) {
	if !userPattern.MatchString(guestID) || !userPattern.MatchString(to.ID) || guestID == to.ID {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ids, err := s.ids(guestID)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	have, err := s.ids(to.ID)
	if err != nil {
		return 0, err
	}
	moved := 0
	for _, id := range ids {
		m, err := s.get(id)
		if err != nil {
			continue
		}
		c := *m
		for i, p := range c.Players {
			if p.ID == guestID {
				q := to
				q.Country = p.Country
				c.Players[i] = q
			}
		}
		if err := s.write(&c); err != nil {
			return moved, err
		}
		if s.open[id] != nil {
			s.open[id] = &c
		}
		if !slices.Contains(have, id) {
			if err := appendLine(s.userLog(to.ID), id); err != nil {
				return moved, err
			}
		}
		moved++
	}
	return moved, os.Remove(s.userLog(guestID))
}
