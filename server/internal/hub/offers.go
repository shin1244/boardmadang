package hub

import (
	"slices"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 대국 중의 무승부 제안과, 끝난 뒤의 재대결입니다. 둘 다 양쪽이 원해야 이뤄집니다.

// offerDraw는 player의 무승부 제안입니다. 상대가 이미 제안해 둔 상태면 수락이 되어 무승부로 끝납니다.
// 제안은 누가 행동을 하나 보내면(relay) 없어집니다.
// 같은 사람은 그 사이에 행동이 하나 이상 오가야 다시 제안할 수 있습니다 (조르기 방지).
func (r *Room) offerDraw(player int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended {
		return
	}
	if r.drawBy != nil {
		if *r.drawBy != player {
			r.end(nil, protocol.ReasonAgreed)
		}
		return
	}
	if r.drawAt[player] == len(r.Log) {
		r.Players[player].sendError("too soon")
		return
	}
	r.drawAt[player] = len(r.Log)
	by := player
	r.drawBy = &by
	r.broadcast(protocol.Draw{Type: protocol.TypeDraw, Player: player})
}

// declineDraw는 무승부 제안을 거절합니다. 제안한 쪽이 보내면 철회입니다.
func (r *Room) declineDraw() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ended || r.drawBy == nil {
		return
	}
	r.clearDraw()
}

// clearDraw는 무승부 제안을 지우고 알립니다. r.mu를 잡고 부릅니다.
func (r *Room) clearDraw() {
	r.drawBy = nil
	r.broadcast(protocol.DrawOff{Type: protocol.TypeDrawOff})
}

// rematch는 c의 재대결 요청입니다. c가 방금 끝낸 대국(c.last)으로 보냅니다.
func (h *Hub) rematch(c *Client) {
	h.mu.Lock()
	r := c.last
	h.mu.Unlock()
	// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서).
	if r == nil {
		c.sendError("no rematch")
		return
	}
	r.rematch(c)
}

// rematch는 끝난 대국의 두 사람이 모두 요청하면 자리를 바꿔 새 대국을 시작합니다.
// 한쪽이 나가거나 다른 대국을 찾기 시작하면 할 수 없게 되고, 남은 쪽에 rematchOff를 보냅니다 (cancelRematch).
func (r *Room) rematch(c *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	seat := slices.Index(r.Players[:], c)
	if !r.ended || seat < 0 || r.noRematch {
		c.sendError("no rematch")
		return
	}
	if r.Players[1-seat].closed() {
		r.noRematch = true
		c.Send(protocol.RematchOff{Type: protocol.TypeRematchOff})
		return
	}
	if r.again[seat] {
		return
	}
	r.again[seat] = true
	for _, p := range r.Players {
		p.Send(protocol.Rematch{Type: protocol.TypeRematch, Player: seat})
	}
	if !r.again[1-seat] {
		return
	}
	r.noRematch = true
	r.hub.startRematch(r, [2]*Client{r.Players[1], r.Players[0]}) // 락 순서 r.mu → h.mu
}

// cancelRematch는 by가 나가서 재대결을 할 수 없게 하고 남은 쪽에 알립니다. 이미 시작했거나 취소됐으면 아무것도 안 합니다.
func (r *Room) cancelRematch(by *Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.ended || r.noRematch {
		return
	}
	r.noRematch = true
	for _, p := range r.Players {
		if p != by {
			p.Send(protocol.RematchOff{Type: protocol.TypeRematchOff})
		}
	}
}

// startRematch는 players(자리를 바꾼 순서)로 새 대국을 시작합니다. Room.rematch에서 r.mu를 잡고 부릅니다.
// 그 사이에 한쪽이 나갔거나 다른 대국을 찾기 시작했으면 시작하지 않습니다.
func (h *Hub) startRematch(r *Room, players [2]*Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range players {
		if p.last != r || p.busy() || p.closed() {
			for _, q := range players {
				q.Send(protocol.RematchOff{Type: protocol.TypeRematchOff})
			}
			return
		}
	}
	h.start(h.newRoomID(), r.Game, r.Minutes, r.Version, players, false)
}
