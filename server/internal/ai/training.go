package ai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 학습 기록 (스냅샷).
//
// trainer/train.py는 학습하는 동안 몇 분마다(--snapshot-every) 그때의 AI끼리 둔 판 몇 개와 자기대국 통계를
// snapshots.json에 남깁니다. 운영자가 모델과 같이(또는 기록만) 올리면 게임 주인과 운영자만 봅니다.
// 제작자는 시간이 갈수록 AI가 그럴듯하게 두는지, 한쪽만 이기거나 같은 판을 되풀이하는지(규칙 허점이나 꼼수) 보고
// 판마다 다시보기(web/replay.html?training=<게임>)로 엽니다.
//
//	ai/<게임 id>/training.json   올린 snapshots.json을 검사해 정리한 것 + 올린 때, 올린 운영자

const (
	TrainingFormat = 1       // snapshots.json의 format (trainer/train.py의 SNAPSHOT_FORMAT)
	MaxTraining    = 2 << 20 // snapshots.json 크기
	MaxSnapshots   = 40      // 1시간을 10분마다 찍으면 7개. 길게 학습해도 들어가게
	MaxShowGames   = 8       // 스냅샷마다 판 수
	MaxShowMoves   = 4000    // 한 판의 행동 수. upload.MaxClearMoves와 같은 이유 (maxActions 2,000수에 기물 고르기)
)

// Training은 학습 기록입니다. 앞쪽은 train.py가 쓰는 칸이고, 뒤쪽은 서버가 채웁니다.
type Training struct {
	Format    int        `json:"format"`
	Game      string     `json:"game"`
	Version   *string    `json:"version"` // 학습한 게임 코드 버전. 다시보기는 이 버전의 코드로 둡니다
	Lang      string     `json:"lang"`
	Minutes   float64    `json:"minutes"` // 학습 예산 (--minutes)
	Snapshots []Snapshot `json:"snapshots"`
	Updated   time.Time  `json:"updated"` // 서버가 채움
	By        string     `json:"by"`      // 서버가 채움: 올린 운영자 계정 id
}

// Snapshot은 학습 중 한 순간입니다.
type Snapshot struct {
	Minute    float64        `json:"minute"`    // 학습을 시작하고 몇 분 뒤인지 (0이면 학습 전)
	Iteration int            `json:"iteration"` // 그때까지 끝낸 반복
	Selfplay  *SelfplayStats `json:"selfplay"`  // 앞 스냅샷부터 이때까지의 자기대국. 학습 전이면 null
	Eval      *Eval          `json:"eval,omitempty"`
	Games     []ShowGame     `json:"games"` // 그때의 AI끼리 둔 판
}

// SelfplayStats는 자기대국 통계입니다. 한쪽만 이기거나(필승법, 규칙 허점) 같은 판을 되풀이해 끊긴 판(cut)이 많으면 살펴볼 만합니다.
type SelfplayStats struct {
	Games int    `json:"games"`
	Wins  [2]int `json:"wins"` // 선공, 후공이 이긴 판
	Draws int    `json:"draws"`
	Cut   int    `json:"cut"`   // 학습용 무승부 규칙(같은 판 반복, --max-moves)으로 끊은 판. draws에 들어 있습니다
	Moves int    `json:"moves"` // 모든 판의 수를 더한 것
}

// Eval은 그때 평가한 결과입니다 (train.py의 evaluate). 없는 칸은 빠집니다.
type Eval struct {
	Random   *WDL      `json:"random,omitempty"`
	Perfect  *WDL      `json:"perfect,omitempty"`
	Accuracy *Accuracy `json:"accuracy,omitempty"`
}

// WDL은 AI가 선공일 때와 후공일 때의 [승, 무, 패]입니다.
type WDL struct {
	First  [3]int `json:"first"`
	Second [3]int `json:"second"`
}

// Accuracy는 완전 탐색한 판에서 가장 좋은 수를 고른 비율입니다 (신경망만, 탐색까지).
type Accuracy struct {
	Policy float64 `json:"policy"`
	Search float64 `json:"search"`
}

// ShowGame은 AI끼리 둔 한 판입니다. 기보처럼 시드와 행동으로 처음부터 다시 둡니다.
type ShowGame struct {
	Seed   uint32 `json:"seed"`
	Moves  []Move `json:"moves"`
	Winner *int   `json:"winner"` // null이면 무승부
	Reason string `json:"reason"` // result(게임이 끝냄) | maxActions | cut(학습용 무승부 규칙)
}

type Move struct {
	Player int             `json:"player"`
	Action protocol.Action `json:"action"`
}

// TrainingInfo는 학습 기록의 요약입니다 (내 게임 목록, 운영자 화면).
type TrainingInfo struct {
	Version   *string   `json:"version"`
	Minutes   float64   `json:"minutes"`
	Snapshots int       `json:"snapshots"`
	Updated   time.Time `json:"updated"`
}

func (t Training) info() TrainingInfo {
	return TrainingInfo{Version: t.Version, Minutes: t.Minutes, Snapshots: len(t.Snapshots), Updated: t.Updated}
}

// checkTraining은 snapshots.json을 읽고 모양을 봅니다.
func checkTraining(game string, data []byte) (Training, error) {
	bad := func(format string, args ...any) error { return BadMeta{fmt.Sprintf(format, args...)} }
	if len(data) > MaxTraining {
		return Training{}, bad("snapshots.json must be up to 2MB")
	}
	var t Training
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&t); err != nil {
		return Training{}, bad("snapshots.json is not valid JSON")
	}
	finite := func(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
	switch {
	case t.Format != TrainingFormat:
		return Training{}, bad("format must be %d", TrainingFormat)
	case t.Game != game:
		return Training{}, bad("these snapshots are for %q", t.Game)
	case t.Version != nil && !versionPattern.MatchString(*t.Version):
		return Training{}, bad("version must be 16 hex digits or null")
	case !langPattern.MatchString(t.Lang):
		return Training{}, bad("lang")
	case !finite(t.Minutes) || t.Minutes < 0 || t.Minutes > 7*24*60:
		return Training{}, bad("minutes")
	case len(t.Snapshots) < 1 || len(t.Snapshots) > MaxSnapshots:
		return Training{}, bad("snapshots must be 1-%d", MaxSnapshots)
	}
	for i, s := range t.Snapshots {
		if err := s.check(); err != nil {
			return Training{}, bad("snapshot %d: %s", i, err.Error())
		}
	}
	return t, nil
}

func (s *Snapshot) check() error {
	finite := func(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
	nonneg := func(xs ...int) bool {
		for _, x := range xs {
			if x < 0 {
				return false
			}
		}
		return true
	}
	if !finite(s.Minute) || s.Minute < 0 || s.Minute > 7*24*60 || s.Iteration < 0 {
		return fmt.Errorf("minute and iteration")
	}
	if p := s.Selfplay; p != nil {
		if !nonneg(p.Games, p.Wins[0], p.Wins[1], p.Draws, p.Cut, p.Moves) || p.Wins[0]+p.Wins[1]+p.Draws > p.Games || p.Cut > p.Draws {
			return fmt.Errorf("selfplay")
		}
	}
	if e := s.Eval; e != nil {
		for _, w := range []*WDL{e.Random, e.Perfect} {
			if w != nil && !nonneg(append(w.First[:], w.Second[:]...)...) {
				return fmt.Errorf("eval")
			}
		}
		if a := e.Accuracy; a != nil && !(a.Policy >= 0 && a.Policy <= 1 && a.Search >= 0 && a.Search <= 1) {
			return fmt.Errorf("accuracy")
		}
	}
	if len(s.Games) > MaxShowGames {
		return fmt.Errorf("up to %d games", MaxShowGames)
	}
	for _, g := range s.Games {
		if len(g.Moves) > MaxShowMoves {
			return fmt.Errorf("up to %d moves a game", MaxShowMoves)
		}
		if g.Winner != nil && *g.Winner != 0 && *g.Winner != 1 {
			return fmt.Errorf("winner")
		}
		if g.Reason != "result" && g.Reason != "maxActions" && g.Reason != "cut" {
			return fmt.Errorf("reason")
		}
		for _, m := range g.Moves {
			if (m.Player != 0 && m.Player != 1) || !validAction(m.Action) {
				return fmt.Errorf("moves")
			}
		}
	}
	if s.Games == nil {
		s.Games = []ShowGame{}
	}
	return nil
}

// validAction은 대전 서버(internal/hub)와 클리어 기보(internal/upload)의 모양 검사와 같습니다.
func validAction(a protocol.Action) bool {
	if a.Kind == "" || len(a.Kind) > 32 {
		return false
	}
	if a.Kind == "click" {
		return a.Row >= 0 && a.Row < 32 && a.Col >= 0 && a.Col < 32
	}
	return a.Row == 0 && a.Col == 0
}

// PutTraining은 운영자 by가 올린 학습 기록을 저장합니다. 같은 게임의 기록이 있으면 바꿉니다.
func (s *Store) PutTraining(by, game string, data []byte) (TrainingInfo, error) {
	t, err := checkTraining(game, data)
	if err != nil {
		return TrainingInfo{}, err
	}
	t.Updated = s.now().UTC()
	t.By = by
	out, err := json.Marshal(t)
	if err != nil {
		return TrainingInfo{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, game)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return TrainingInfo{}, err
	}
	if err := writeFile(filepath.Join(dir, "training.json"), append(out, '\n')); err != nil {
		return TrainingInfo{}, err
	}
	s.trainings[game] = t.info()
	return t.info(), nil
}

// TrainingOf는 학습 기록의 요약입니다.
func (s *Store) TrainingOf(game string) (TrainingInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.trainings[game]
	return t, ok
}

// Trainings는 게임마다 학습 기록 요약입니다 (운영자 화면).
func (s *Store) Trainings() map[string]TrainingInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]TrainingInfo, len(s.trainings))
	for k, v := range s.trainings {
		out[k] = v
	}
	return out
}

// trainingFile은 저장한 training.json 그대로입니다. 없으면 ErrNoModel처럼 os.ErrNotExist.
func (s *Store) trainingFile(game string) ([]byte, error) {
	s.mu.Lock()
	_, ok := s.trainings[game]
	s.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(filepath.Join(s.dir, game, "training.json"))
}
