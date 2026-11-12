package stats

// AI 대국 수: 브라우저 안에서만 도는 AI 대국(web/ai.js)을 날마다, 게임마다 셉니다.
//
// 서버는 AI 대국을 보지 못하므로 화면이 알려 줍니다 (POST /api/ai/{game}/plays, internal/ai).
// 사람이 그 판의 첫 수를 두면 AIPlay, 판이 끝나면(기권 포함) AIEnd와 사람 쪽 결과입니다.
// 한 수도 안 둔 판은 세지 않습니다 (온라인 대국의 기준과 같음).
//
// 누가 뒀는지는 남기지 않고 수만 남깁니다. 한 사람이 수를 부풀리지 못하게, 오늘 그 사람이 센 판 수만
// 방문과 같은 해시로 메모리에 들고 있다가 날이 바뀌면 버립니다 (서버를 다시 켜도 비워집니다).
// 한 사람이 하루에 셀 수 있는 판은 AIPerDay까지이고, 끝난 판은 그 사람이 오늘 시작한 판보다 많을 수 없습니다.
//
//	stats/ai/<날짜>.json   그날 게임마다 {"<게임 id>":{"plays":3,"ends":2,"wins":1,"draws":0}}

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// AIPerDay는 한 사람이 하루에 셀 수 있는 AI 대국 수입니다. 넘으면 세지 않습니다 (한 판 3분이면 다섯 시간).
const AIPerDay = 100

// AI 대국이 끝났을 때 사람 쪽 결과 (AIEnd의 result).
const (
	AIWin  = "win"
	AILose = "lose"
	AIDraw = "draw"
)

// AICount는 하루, 게임 하나의 AI 대국 수입니다.
type AICount struct {
	Plays int `json:"plays"` // 사람이 한 수 이상 둔 판
	Ends  int `json:"ends"`  // 그중 끝까지 둔 판 (기권 포함)
	Wins  int `json:"wins"`  // 끝난 판 중 사람이 이긴 판
	Draws int `json:"draws"` // 끝난 판 중 비긴 판 (나머지는 AI가 이김)
}

// aiPerson은 오늘 한 사람이 센 판입니다 (메모리에만).
type aiPerson struct{ plays, ends int }

var aiFile = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.json$`)

func (t *Tracker) aiDir() string { return filepath.Join(t.dir, "ai") }

// loadAI는 stats/ai의 날마다 파일을 읽습니다. open에서 부릅니다.
func (t *Tracker) loadAI() error {
	entries, err := os.ReadDir(t.aiDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		m := aiFile.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(t.aiDir(), e.Name()))
		if err != nil {
			return err
		}
		var games map[string]*AICount
		if err := json.Unmarshal(data, &games); err != nil {
			log.Printf("AI 대국 수 파일을 읽지 못해 건너뜁니다 %s: %v", e.Name(), err)
			continue
		}
		for game, c := range games {
			if c == nil {
				delete(games, game)
			}
		}
		t.ai[m[1]] = games
	}
	return nil
}

// AIPlay는 u가 game에서 AI와 둔 판 하나를 셉니다 (사람이 그 판의 첫 수를 둠).
// 로봇이거나 오늘 AIPerDay판을 넘겼으면 세지 않고 false입니다.
func (t *Tracker) AIPlay(r *http.Request, u identity.User, game string) bool {
	return t.aiCount(r, u, game, func(p *aiPerson, c *AICount) bool {
		if p.plays >= AIPerDay {
			return false
		}
		p.plays++
		c.Plays++
		return true
	})
}

// AIEnd는 u의 AI 대국 하나가 끝난 것을 셉니다. result는 사람 쪽에서 AIWin, AILose, AIDraw입니다.
// 오늘 센 판보다 많이 끝낼 수는 없어서, 그때와 result가 틀릴 때와 로봇이면 세지 않고 false입니다.
func (t *Tracker) AIEnd(r *http.Request, u identity.User, game, result string) bool {
	if result != AIWin && result != AILose && result != AIDraw {
		return false
	}
	return t.aiCount(r, u, game, func(p *aiPerson, c *AICount) bool {
		if p.ends >= p.plays {
			return false
		}
		p.ends++
		c.Ends++
		switch result {
		case AIWin:
			c.Wins++
		case AIDraw:
			c.Draws++
		}
		return true
	})
}

// aiCount는 오늘 u와 game의 칸을 꺼내 bump로 바꾸고, 바뀌었으면 오늘 파일을 다시 씁니다.
func (t *Tracker) aiCount(r *http.Request, u identity.User, game string, bump func(*aiPerson, *AICount) bool) bool {
	if u.ID == "" || game == "" || botAgent.MatchString(r.UserAgent()) {
		return false
	}
	h := t.hash(u.ID)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.roll()
	p := t.aiToday[h]
	if p == nil {
		p = &aiPerson{}
		t.aiToday[h] = p
	}
	games := t.ai[t.today]
	if games == nil {
		games = make(map[string]*AICount)
		t.ai[t.today] = games
	}
	c := games[game]
	if c == nil {
		c = &AICount{}
	}
	if !bump(p, c) {
		return false
	}
	games[game] = c
	if err := t.writeAI(t.today); err != nil {
		log.Printf("AI 대국 수를 남기지 못했습니다: %v", err)
	}
	return true
}

// writeAI는 그날의 AI 대국 수 파일을 통째로 다시 씁니다 (임시 파일에 쓰고 이름 바꾸기). mu를 잡고 부릅니다.
func (t *Tracker) writeAI(day string) error {
	data, err := json.Marshal(t.ai[day])
	if err != nil {
		return err
	}
	if err := os.MkdirAll(t.aiDir(), 0o755); err != nil {
		return err
	}
	file := filepath.Join(t.aiDir(), day+".json")
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

// AIDaily는 from 날부터의 AI 대국 수입니다 (날짜 → 게임 → 수).
func (t *Tracker) AIDaily(from string) map[string]map[string]AICount {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]map[string]AICount)
	for day, games := range t.ai {
		if day < from {
			continue
		}
		copied := make(map[string]AICount, len(games))
		for game, c := range games {
			copied[game] = *c
		}
		out[day] = copied
	}
	return out
}
