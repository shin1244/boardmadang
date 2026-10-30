package hub

import (
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// clock은 대국 시계입니다 (체스 시계). 각자 자기 차례에만 자기 시간이 줄고, 다 쓰면 집니다.
//
// 서버는 규칙을 몰라서 누구 차례인지 모릅니다. 그래서 클라이언트가 해시와 같이 보내는 차례(게임의 turn())로 시계를 넘깁니다.
// 연결이 끊겨 기다리는 동안에도 그 사람 차례면 시계는 계속 갑니다.
type clock struct {
	remaining [2]time.Duration // running이 아닌 쪽은 정확하고, running 쪽은 since부터 더 줄어든 값입니다
	running   int              // 시계가 가는 플레이어. -1이면 멈춤
	since     time.Time
	timer     *time.Timer // 시간이 다 되는 순간에 울립니다
	gen       int         // 타이머가 늦게 울려도 지난 차례에 반응하지 않게 세는 번호
}

func newClock(each time.Duration) *clock {
	return &clock{remaining: [2]time.Duration{each, each}, running: -1}
}

// now는 지금 남은 시간입니다. 가는 쪽의 시간을 뺀 값이고, 0보다 작아지지 않습니다.
func (c *clock) now(t time.Time) [2]time.Duration {
	rem := c.remaining
	if c.running >= 0 {
		rem[c.running] = max(0, rem[c.running]-t.Sub(c.since))
	}
	return rem
}

// setTurn은 시계를 turn의 차례로 넘깁니다 (nil이면 멈춤). 바뀌었으면 양쪽에 Clock을 보냅니다. r.mu를 잡고 부릅니다.
func (r *Room) setTurn(turn *int) {
	c := r.clock
	if c == nil {
		return
	}
	next := -1
	if turn != nil {
		next = *turn
	}
	if next == c.running {
		return
	}
	t := time.Now()
	c.remaining = c.now(t)
	c.running = next
	c.since = t
	c.gen++
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	r.broadcast(*r.clockMsg())
	if next < 0 {
		return
	}
	if c.remaining[next] <= 0 {
		r.end(other(next), protocol.ReasonTimeout)
		return
	}
	gen := c.gen
	c.timer = time.AfterFunc(c.remaining[next], func() { r.flag(next, gen) })
}

// flag는 player의 시간이 다 됐을 때 타이머가 부릅니다.
func (r *Room) flag(player, gen int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.clock
	if r.ended || c.gen != gen || c.running != player {
		return
	}
	c.remaining = c.now(time.Now())
	c.remaining[player] = 0
	c.running = -1
	r.end(other(player), protocol.ReasonTimeout)
}

// stopClock은 대국이 끝날 때 시계를 멈추고 마지막 시간을 보냅니다. r.mu를 잡고 부릅니다.
func (r *Room) stopClock() {
	c := r.clock
	if c == nil {
		return
	}
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	t := time.Now()
	c.remaining = c.now(t)
	c.running = -1
	c.gen++
	r.broadcast(*r.clockMsg())
}

// clockMsg는 지금 시계입니다. 타이머가 없으면 nil.
func (r *Room) clockMsg() *protocol.Clock {
	c := r.clock
	if c == nil {
		return nil
	}
	rem := c.now(time.Now())
	msg := &protocol.Clock{Type: protocol.TypeClock, Remaining: [2]int64{rem[0].Milliseconds(), rem[1].Milliseconds()}}
	if c.running >= 0 {
		p := c.running
		msg.Running = &p
	}
	return msg
}
