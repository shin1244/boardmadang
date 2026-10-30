package hub

import (
	"slices"
	"time"

	"github.com/shin1244/boardmadang/server/internal/protocol"
)

// 이모티콘: 채팅 대신 정해진 그림(protocol.Emotes)만 주고받습니다. 글을 받지 않으므로 욕설이나 개인정보가 오갈 수 없습니다.

// EmoteEvery는 한 사람이 이모티콘을 보낼 수 있는 간격입니다. 더 빨리 보내면 조용히 버립니다 (도배 방지).
// 화면도 같은 간격으로 버튼을 잠급니다.
var EmoteEvery = 2 * time.Second

// emote는 c가 두고 있는 대국, 없으면 방금 끝낸 대국(재대결을 기다리는 동안)으로 보냅니다.
func (h *Hub) emote(c *Client, id string) {
	now := time.Now()
	if now.Sub(c.lastEmote) < EmoteEvery {
		return
	}
	h.mu.Lock()
	r := c.room
	if r == nil {
		r = c.last
	}
	h.mu.Unlock()
	// r.mu는 h.mu를 놓은 뒤에 잡습니다 (락 순서).
	if r == nil {
		c.sendError("not in a room")
		return
	}
	c.lastEmote = now
	r.emote(c, id)
}

func (r *Room) emote(c *Client, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	seat := slices.Index(r.Players[:], c)
	if seat < 0 {
		return
	}
	r.broadcast(protocol.Emote{Type: protocol.TypeEmote, Player: seat, Emote: id})
}
