package ai

import (
	"encoding/json"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 진행 중인 AI 대국: 방 목록(web/rooms.js)이 온라인 대국 아래에 같이 보여줍니다.
//
// AI 대국은 브라우저 안에서만 돌아서 서버가 모르므로, AI 화면(web/ai.js)이 두는 동안 알려 줍니다.
// 사람이 그 판의 첫 수를 두면 POST /api/ai/{game}/live 를 보내고 LiveBeat마다 다시 보냅니다.
// 판이 끝나거나 화면을 닫으면 DELETE를 보내고, 못 보냈어도 liveTTL 동안 소식이 없으면 목록에서 빠집니다.
// 수는 서버에 오지 않으므로 관전은 못 하고, 누가 어느 게임을 몇 수째 두는지만 보입니다.
//
// 메모리에만 둡니다. 서버를 다시 켜면 비워지지만 대국은 브라우저에서 계속되므로 다음 알림에 다시 나타납니다.
// 목록을 가짜로 채우지 못하게 한 사람(세션)에 한 판만 들고, 수가 liveIdle 동안 늘지 않은 판은 보여주지 않으며,
// 모두 합쳐 maxLive판까지만 받습니다.

const (
	// LiveBeat는 AI 화면이 다시 알리는 간격입니다 (web/ai.js의 LIVE_MS와 같게).
	LiveBeat = 20 * time.Second
	// 뒤에 있는 탭은 브라우저가 타이머를 1분에 한 번으로 늦추므로 그보다 길게 둡니다.
	liveTTL = 90 * time.Second
	// 판을 켜 놓고 자리를 뜬 사람은 목록에서 뺍니다. 다시 두면 돌아옵니다.
	liveIdle = 10 * time.Minute
	maxLive  = 200
	// maxLiveMoves는 받는 수의 상한입니다 (게임의 maxActions보다 넉넉하게).
	maxLiveMoves = 100000
)

var liveLevels = map[string]bool{"easy": true, "normal": true, "hard": true}

// LiveGame은 진행 중인 AI 대국 목록(GET /api/ai/live)의 한 줄입니다. Age는 첫 수를 둔 뒤 지난 초입니다.
type LiveGame struct {
	Game   string              `json:"game"`
	Player protocol.PlayerInfo `json:"player"`
	Level  string              `json:"level"` // easy | normal | hard
	Moves  int                 `json:"moves"`
	Age    int                 `json:"age"`
}

type liveGame struct {
	game, level string
	player      protocol.PlayerInfo
	moves       int
	started     time.Time // 처음 알린 때
	seen        time.Time // 마지막으로 알린 때
	moved       time.Time // 수가 마지막으로 바뀐 때
}

// Live는 진행 중인 AI 대국입니다. 사람 id마다 한 판.
type Live struct {
	mu    sync.Mutex
	now   func() time.Time
	games map[string]*liveGame
}

func NewLive() *Live {
	return &Live{now: time.Now, games: map[string]*liveGame{}}
}

// prune은 소식이 끊긴 판을 버립니다. l.mu를 잡고 부릅니다.
func (l *Live) prune(now time.Time) {
	for id, g := range l.games {
		if now.Sub(g.seen) > liveTTL {
			delete(l.games, id)
		}
	}
}

// Beat는 u가 game을 level로 moves수째 두고 있다고 적습니다. 꽉 차서 새 판을 못 받았으면 false.
// 같은 사람이 다른 게임이나 새 판(수가 줄어듦)을 알리면 앞의 판을 바꿉니다.
func (l *Live) Beat(u identity.User, game, level string, moves int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.prune(now)
	g := l.games[u.ID]
	if g == nil || g.game != game || moves < g.moves {
		if g == nil && len(l.games) >= maxLive {
			return false
		}
		g = &liveGame{game: game, started: now, moved: now}
		l.games[u.ID] = g
	} else if moves != g.moves {
		g.moved = now
	}
	g.level = level
	g.moves = moves
	g.seen = now
	g.player = protocol.PlayerInfo{Kind: u.Kind, Tag: u.Tag, Name: u.Name} // 그사이 이름을 바꿨으면 새 이름으로
	return true
}

// End는 u가 두던 game을 목록에서 뺍니다. 그사이 다른 게임을 두기 시작했으면 그대로 둡니다.
func (l *Live) End(u identity.User, game string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if g := l.games[u.ID]; g != nil && g.game == game {
		delete(l.games, u.ID)
	}
}

// List는 진행 중인 AI 대국을 최근에 시작한 순서로 돌려줍니다.
func (l *Live) List() []LiveGame {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.prune(now)
	out := make([]LiveGame, 0, len(l.games))
	for _, g := range l.games {
		if now.Sub(g.moved) > liveIdle {
			continue
		}
		out = append(out, LiveGame{Game: g.game, Player: g.player, Level: g.level, Moves: g.moves, Age: int(now.Sub(g.started) / time.Second)})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Age != out[j].Age {
			return out[i].Age < out[j].Age
		}
		return out[i].Player.Tag < out[j].Player.Tag // 순서가 새로고침마다 바뀌지 않게
	})
	return out
}

// ServeLive는 GET /api/ai/live 입니다. 누구나 볼 수 있습니다.
func (h Handler) ServeLive(w http.ResponseWriter, r *http.Request) {
	out := []LiveGame{}
	if h.Live != nil {
		out = h.Live.List()
	}
	writeJSON(w, http.StatusOK, out)
}

// liveTarget은 알림을 보낸 사람과 게임입니다. 쿠키가 없으면 401, 모델이 없는 게임이면 404를 쓰고 false.
func (h Handler) liveTarget(w http.ResponseWriter, r *http.Request) (identity.User, string, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return u, "", false
	}
	game := r.PathValue("game")
	if !gamePattern.MatchString(game) || h.Store.Model(game) == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": ErrNotFound.Error()})
		return u, "", false
	}
	return u, game, true
}

// ServeLiveBeat는 POST /api/ai/{game}/live 입니다 (JSON만). 본문은 {"moves":12,"level":"easy"|"normal"|"hard"}.
// 목록에 올렸든 꽉 차서 못 올렸든 204입니다. 쿠키가 없으면 401, 모델이 없는 게임이면 404, 본문이 틀리면 400.
func (h Handler) ServeLiveBeat(w http.ResponseWriter, r *http.Request) {
	u, game, ok := h.liveTarget(w, r)
	if !ok || !h.jsonOnly(w, r) {
		return
	}
	var body struct {
		Moves int    `json:"moves"`
		Level string `json:"level"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	if !liveLevels[body.Level] {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad level"})
		return
	}
	if body.Moves < 0 || body.Moves > maxLiveMoves {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad moves"})
		return
	}
	if h.Live != nil {
		h.Live.Beat(u, game, body.Level, body.Moves)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// ServeLiveEnd는 DELETE /api/ai/{game}/live 입니다. 올린 판이 없어도 204입니다.
func (h Handler) ServeLiveEnd(w http.ResponseWriter, r *http.Request) {
	u, game, ok := h.liveTarget(w, r)
	if !ok {
		return
	}
	if h.Live != nil {
		h.Live.End(u, game)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
