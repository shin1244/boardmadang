package upload

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 클리어 체크 (슈퍼 마리오 메이커 2처럼). 등록하려면 제작자가 등록창에서 혼자 양쪽을 둬서 result()가 승자를 정한 판이 있어야 합니다.
// 무승부, 기권, maxActions 도달은 클리어가 아닙니다. 그 판(시드, 상태를 바꾼 행동, 코드 버전)을 게임과 함께 남기고,
// 누구나 다시보기(web/replay.html?clear=<게임>)로 볼 수 있습니다. 코드를 고쳐 버전이 바뀌면 다시 깨야 합니다.
//
// 서버는 게임 코드를 돌리지 않으므로 정말 이긴 판인지는 모르고 모양만 봅니다.
// 기보를 재생해서 검증하는 건 공개한 뒤에 합니다 (docs/roadmap.md 3).

// MaxClearMoves는 클리어 기보의 행동 수 상한입니다. 상태를 바꾼 행동만 담으므로 실행기의 maxActions 상한과 같습니다.
const MaxClearMoves = 2000

// maxClearBody는 등록 본문에서 클리어 기보가 차지할 수 있는 크기입니다 (행동 하나가 50바이트 안팎).
const maxClearBody = 256 << 10

// Clear는 제작자 클리어 기보입니다.
type Clear struct {
	Version string      `json:"version"` // 이 판을 둔 게임 코드 버전
	Seed    uint32      `json:"seed"`
	Moves   []ClearMove `json:"moves"` // 상태를 바꾼 행동만. 무시된 행동은 판에 영향이 없어 뺍니다
	Winner  int         `json:"winner"`
	At      time.Time   `json:"at"` // 등록한 때
}

type ClearMove struct {
	Player int             `json:"player"`
	Action protocol.Action `json:"action"`
}

// ClearRecord는 GET /api/games/{game}/clear의 응답입니다.
type ClearRecord struct {
	Game string `json:"game"`
	Clear
}

// CheckClear는 등록창이 보낸 클리어 기보를 읽고 모양을 봅니다. version은 등록하는 초안의 버전입니다.
func CheckClear(data json.RawMessage, version string) (*Clear, Problems) {
	var in struct {
		Version string      `json:"version"`
		Seed    *uint32     `json:"seed"`
		Moves   []ClearMove `json:"moves"`
		Winner  *int        `json:"winner"`
	}
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&in); err != nil {
		return nil, Problems{{Code: "clear.invalid"}}
	}
	if in.Version != version {
		return nil, Problems{{Code: "clear.version"}}
	}
	if in.Seed == nil || in.Winner == nil || (*in.Winner != 0 && *in.Winner != 1) || len(in.Moves) == 0 || len(in.Moves) > MaxClearMoves {
		return nil, Problems{{Code: "clear.invalid", Max: MaxClearMoves}}
	}
	for _, m := range in.Moves {
		if (m.Player != 0 && m.Player != 1) || !validAction(m.Action) {
			return nil, Problems{{Code: "clear.invalid", Max: MaxClearMoves}}
		}
	}
	return &Clear{Version: in.Version, Seed: *in.Seed, Moves: in.Moves, Winner: *in.Winner}, nil
}

// validAction은 대전 서버(internal/hub)의 validAction과 같은 모양 검사입니다.
// 좌표는 플랫폼 상한(rows, cols ≤ 32) 안이어야 합니다.
func validAction(a protocol.Action) bool {
	if a.Kind == "" || len(a.Kind) > 32 {
		return false
	}
	if a.Kind == "click" {
		return a.Row >= 0 && a.Row < 32 && a.Col >= 0 && a.Col < 32
	}
	return a.Row == 0 && a.Col == 0
}

// ClearOf는 게임의 지금 버전 클리어 기보입니다. 없으면 ErrNotFound (클리어 체크 전에 올린 게임).
func (s *Store) ClearOf(id string) (ClearRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.games[id]
	if g == nil || !g.cleared() || (s.Reserved != nil && s.Reserved(id)) {
		return ClearRecord{}, ErrNotFound
	}
	return ClearRecord{Game: id, Clear: *g.Clear}, nil
}

// cleared는 지금 버전의 클리어 기보가 있는지입니다.
func (g *gameMeta) cleared() bool {
	return g.Clear != nil && g.Clear.Version == g.Version
}

// isNull은 JSON 칸이 없거나 null인지입니다.
func isNull(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) == 0 || string(bytes.TrimSpace(raw)) == "null"
}
