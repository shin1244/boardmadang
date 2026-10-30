package hub

import (
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
)

// Room은 매칭된 두 플레이어의 대국 하나입니다.
//
// 서버가 아는 건 시드와 행동 기록뿐이고, 판의 상태는 각 클라이언트가 계산합니다.
// 하지만 Seed + Log만 있으면 판을 언제든 다시 만들 수 있어서
// 끊겼던 플레이어의 복원, 기보 다시보기, 결과 검증이 모두 이 두 필드로 해결됩니다.
type Room struct {
	hub     *Hub
	ID      string
	Game    string
	Version string // 게임 코드 버전. 기보에 남깁니다
	Seed    uint32
	Minutes *int // 타이머(분). nil이면 없음
	Players [2]*Client

	mu  sync.Mutex
	Log []protocol.Relay // 인덱스 = 순번

	hashes  map[int][2]*report // 순번 → 양쪽이 보고한 상태 해시와 차례. -1은 시작 상태. 양쪽이 모이면 agreed로 옮깁니다
	agreed  map[int]string     // 순번 → 양쪽이 같다고 확인한 해시. 직전 것만 남깁니다
	ignored [2]int             // 플레이어별 무시된 행동 수 (해시가 직전과 같았던 행동)
	results [2]*protocol.Result
	ended   bool
	final   *protocol.Ended // 끝난 결과. 끊긴 채로 끝난 대국에 돌아온 플레이어에게 보여줍니다

	away    [2]*time.Timer // 연결이 끊긴 자리의 유예 타이머. nil이면 연결돼 있습니다
	awayGen [2]int         // 타이머가 늦게 울려도 지난 끊김에 반응하지 않게 세는 번호

	clock    *clock // 대국 시계 (clock.go). 타이머가 없으면 nil
	clockSeq int    // 시계에 반영한 가장 최근 순번

	started time.Time
	at      []int64 // Log[i]가 시작부터 몇 ms 뒤에 왔는지. 기보에 남깁니다

	drawBy    *int   // 무승부를 제안해 둔 자리. 없으면 nil (offers.go)
	drawAt    [2]int // 자리별로 마지막에 제안했을 때의 행동 수. 그 뒤로 행동이 있어야 다시 제안할 수 있습니다
	again     [2]bool
	noRematch bool // 재대결을 이미 시작했거나 할 수 없게 됨

	watchers map[*Client]struct{} // 관전자 (watch.go)
}

// report는 한 플레이어가 보고한 상태 해시와 그 상태에서 누구 차례인지입니다.
type report struct {
	hash string
	turn *int
}

func newRoom(h *Hub, id, game, version string, seed uint32, minutes *int, players [2]*Client) *Room {
	r := &Room{
		hub:      h,
		ID:       id,
		Game:     game,
		Version:  version,
		Seed:     seed,
		Minutes:  minutes,
		Players:  players,
		hashes:   make(map[int][2]*report),
		agreed:   make(map[int]string),
		clockSeq: -2,
		started:  time.Now(),
		drawAt:   [2]int{-1, -1},
		watchers: make(map[*Client]struct{}),
	}
	if minutes != nil {
		r.clock = newClock(time.Duration(*minutes) * MinuteUnit)
	}
	return r
}

// relay는 player의 행동에 다음 순번을 붙여 기록하고 양쪽에 보냅니다.
// 행동이 규칙에 맞는지는 검사하지 않습니다. 그건 클라이언트의 게임 로직이 합니다.
// 무승부 제안이 있었으면 행동 하나로 없어집니다.
//
// maxActions는 서버가 세지 않습니다. 무시된 행동은 세지 않아야 하는데, 그건 해시가 모여야 알 수 있습니다.
// 상태를 바꾼 행동 수는 양쪽 클라이언트가 세고, maxActions에 이르면 무승부 결과를 보고합니다.
func (r *Room) relay(player int, a protocol.Action) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended {
		return
	}
	if r.drawBy != nil {
		r.clearDraw()
	}
	msg := protocol.Relay{Type: protocol.TypeRelay, Seq: len(r.Log), Player: player, Action: a}
	r.Log = append(r.Log, msg)
	r.at = append(r.at, time.Since(r.started).Milliseconds())
	r.broadcast(msg)
	if len(r.Log) >= MaxLog {
		r.end(nil, protocol.ReasonLimit)
	}
}

// reportHash는 player가 보고한 seq번째 상태 해시와 차례를 기록합니다.
//
// 각 클라이언트는 순번 차례대로 해시를 보내므로, 양쪽의 seq 해시가 모였을 때는 seq-1도 이미 확인돼 있습니다.
//
// 시계는 양쪽을 기다리지 않고 먼저 온 보고의 차례로 넘깁니다. 늦은 쪽의 네트워크 지연을 둔 사람이 떠안지 않게 하려는 것입니다.
// 거짓 차례를 먼저 보내도 상대 보고와 다르면 대국이 무효가 되므로 얻는 게 없습니다.
func (r *Room) reportHash(player, seq int, hash string, turn *int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended || seq < -1 || seq >= len(r.Log) {
		return
	}
	if _, done := r.agreed[seq]; done {
		return
	}
	got := r.hashes[seq]
	if got[player] != nil {
		return // 같은 순번을 두 번 보내면 처음 것만 씁니다
	}
	got[player] = &report{hash: hash, turn: turn}
	if seq > r.clockSeq {
		r.clockSeq = seq
		r.setTurn(turn)
		if r.ended { // 시간이 이미 다 됐음
			return
		}
	}
	if got[1-player] == nil {
		r.hashes[seq] = got
		return
	}

	delete(r.hashes, seq)
	if got[0].hash != got[1].hash || !samePlayer(got[0].turn, got[1].turn) {
		r.broadcast(protocol.Desync{Type: protocol.TypeDesync, Seq: seq})
		r.end(nil, protocol.ReasonDesync)
		return
	}
	r.agreed[seq] = hash
	delete(r.agreed, seq-2)
	if seq < 0 {
		return
	}

	// 상태가 직전과 같으면 그 행동은 게임 로직이 무시한 것입니다.
	if hash == r.agreed[seq-1] {
		p := r.Log[seq].Player
		r.ignored[p]++
		if r.ignored[p] > MaxIgnored {
			r.end(other(p), protocol.ReasonSpam)
		}
	}
}

// reportResult는 player가 보고한 게임 결과를 기록합니다.
// 양쪽이 보고하면 비교해서, 같으면 그 결과로, 다르면 분쟁(disagree)으로 끝냅니다.
func (r *Room) reportResult(player int, res protocol.Result) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended || r.results[player] != nil {
		return
	}
	r.results[player] = &res
	a, b := r.results[0], r.results[1]
	if a == nil || b == nil {
		return
	}
	if samePlayer(a.Winner, b.Winner) {
		r.end(a.Winner, protocol.ReasonResult)
	} else {
		r.end(nil, protocol.ReasonDisagree)
	}
}

// resign은 player의 기권입니다. 게임 로직이 아니라 플랫폼이 처리합니다.
func (r *Room) resign(player int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.end(other(player), protocol.ReasonResign)
}

// playerLeft는 c의 연결이 끊겼을 때 부릅니다. 바로 지게 하지 않고 ReconnectGrace만큼 기다립니다.
// 상대에게는 away를 보내 남은 시간을 보여주게 합니다.
func (r *Room) playerLeft(player int, c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// 이미 돌아와서 자리에 다른 연결이 앉아 있으면, 늦게 도착한 옛 연결의 정리입니다.
	if r.ended || r.Players[player] != c || r.away[player] != nil {
		return
	}
	r.awayGen[player]++
	gen := r.awayGen[player]
	r.away[player] = time.AfterFunc(ReconnectGrace, func() { r.expire(player, gen) })
	r.hub.markAway(c.user.ID, r) // 락 순서 r.mu → h.mu
	away := protocol.Away{Type: protocol.TypeAway, Player: player, Seconds: int(ReconnectGrace / time.Second)}
	r.Players[1-player].Send(away)
	r.toWatchers(away)
}

// expire는 유예 시간이 끝났을 때 타이머가 부릅니다. 그때까지 안 돌아왔으면 상대가 이깁니다.
func (r *Room) expire(player, gen int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.away[player] == nil || r.awayGen[player] != gen {
		return
	}
	r.away[player] = nil
	r.hub.clearAway(r.Players[player].user.ID, r)
	r.end(other(player), protocol.ReasonLeft)
}

// resume은 끊겼던 c를 자리로 돌려보내고 Seed와 Log를 보내 판을 복원하게 합니다.
// 기다리는 동안 대국이 끝났으면(상대 기권 등) 복원한 뒤 그 결과도 보냅니다.
// c와 같은 신원의 끊긴 자리가 없으면(유예 시간이 이미 끝남) false입니다.
func (r *Room) resume(c *Client) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	seat := -1
	for i, p := range r.Players {
		if r.away[i] != nil && p.user.ID == c.user.ID {
			seat = i
			break
		}
	}
	if seat < 0 {
		return false
	}
	r.away[seat].Stop()
	r.away[seat] = nil
	r.Players[seat] = c
	otherSeat := 1 - seat
	stillAway := r.away[otherSeat] != nil && r.Players[otherSeat].user.ID == c.user.ID
	r.hub.seatClient(c, r, seat, r.ended, stillAway) // 락 순서 r.mu → h.mu

	opp := r.Players[otherSeat].user
	c.Send(protocol.Resumed{
		Type:     protocol.TypeResumed,
		Room:     r.ID,
		Game:     r.Game,
		Player:   seat,
		Seed:     r.Seed,
		Opponent: protocol.PlayerInfo{Kind: opp.Kind, Tag: opp.Tag, Name: opp.Name},
		Minutes:  r.Minutes,
		Clock:    r.clockMsg(),
		Draw:     r.drawBy,
		Log:      r.logCopy(),
	})
	if r.ended {
		c.Send(*r.final)
	} else {
		back := protocol.Back{Type: protocol.TypeBack, Player: seat}
		r.Players[otherSeat].Send(back)
		r.toWatchers(back)
	}
	return true
}

// end는 대국을 끝내고 기보를 저장한 뒤 양쪽과 관전자에게 Ended를 보냅니다. 두 번 불려도 한 번만 처리합니다. r.mu를 잡고 부릅니다.
func (r *Room) end(winner *int, reason string) {
	if r.ended {
		return
	}
	r.ended = true
	r.stopClock()
	r.final = &protocol.Ended{Type: protocol.TypeEnded, Winner: winner, Reason: reason}
	if r.hub.records != nil {
		m := r.record(winner, reason)
		r.hub.records.Save(m)
		r.final.Record = m.ID
	}
	r.broadcast(*r.final)
	r.hub.removeRoom(r) // 락 순서 r.mu → h.mu
	r.watchers = nil
}

// record는 끝난 대국의 기보입니다. 무효가 된 대국(desync 등)도 남깁니다. 분쟁을 확인할 때 씁니다.
func (r *Room) record(winner *int, reason string) *record.Match {
	m := &record.Match{
		ID:      record.NewID(),
		Game:    r.Game,
		Version: r.Version,
		Seed:    r.Seed,
		Minutes: r.Minutes,
		Moves:   make([]record.Move, len(r.Log)),
		Winner:  winner,
		Reason:  reason,
		Started: r.started,
		Ended:   time.Now(),
	}
	for i, p := range r.Players {
		u := p.user
		m.Players[i] = record.Player{ID: u.ID, Kind: u.Kind, Tag: u.Tag, Name: u.Name}
	}
	for i, l := range r.Log {
		m.Moves[i] = record.Move{Player: l.Player, Action: l.Action, At: r.at[i]}
	}
	if r.clock != nil {
		rem := r.clock.remaining // stopClock이 끝난 시각으로 맞춰 둡니다
		m.Clock = &[2]int64{rem[0].Milliseconds(), rem[1].Milliseconds()}
	}
	return m
}

// broadcast는 양쪽 플레이어와 관전자에게 보냅니다. r.mu를 잡고 부릅니다.
func (r *Room) broadcast(msg any) {
	for _, p := range r.Players {
		p.Send(msg)
	}
	r.toWatchers(msg)
}

// logCopy는 보낼 행동 기록의 복사본입니다. 아직 행동이 없어도 null이 아닌 []로 보냅니다. r.mu를 잡고 부릅니다.
func (r *Room) logCopy() []protocol.Relay {
	return append([]protocol.Relay{}, r.Log...)
}

func other(player int) *int {
	o := 1 - player
	return &o
}

// samePlayer는 두 플레이어 번호(nil = 없음)가 같은지입니다. 승자와 차례를 비교할 때 씁니다.
func samePlayer(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
