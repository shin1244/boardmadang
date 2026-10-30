// Package protocol은 클라이언트와 서버가 주고받는 웹소켓 메시지를 정의합니다.
// 설명과 예시는 docs/protocol.md에 있습니다.
//
// 서버는 게임 규칙을 모릅니다. 행동을 받아 순번을 붙여 양쪽에 그대로 전달할 뿐입니다 (락스텝).
package protocol

import "encoding/json"

// 클라이언트 → 서버
const (
	TypeJoin   = "join"
	TypeAction = "action"
	TypeHash   = "hash"
	TypeResult = "result"
	TypeResign = "resign"
)

// 서버 → 클라이언트
const (
	TypeWaiting = "waiting"
	TypeMatched = "matched"
	TypeResumed = "resumed"
	TypeAway    = "away"
	TypeBack    = "back"
	TypeRelay   = "relay"
	TypeDesync  = "desync"
	TypeEnded   = "ended"
	TypeError   = "error"
)

// Ended.Reason 값
const (
	ReasonResult   = "result"   // 양쪽이 같은 결과를 보고함
	ReasonResign   = "resign"   // 한쪽이 기권
	ReasonLeft     = "left"     // 한쪽 연결이 끊기고 유예 시간 안에 돌아오지 않음
	ReasonDesync   = "desync"   // 해시 불일치로 무효
	ReasonDisagree = "disagree" // 양쪽 결과 보고가 다름
	ReasonSpam     = "spam"     // 한쪽이 무시된 행동을 너무 많이 보냄 → 상대 승
	ReasonLimit    = "limit"    // 행동 기록이 상한에 닿음 → 무효
)

// Action은 플레이어의 행동 하나입니다. 서버는 내용을 해석하지 않고 그대로 전달합니다.
// Row와 Col에 omitempty를 붙이면 안 됩니다. 0도 올바른 좌표이기 때문입니다.
type Action struct {
	Kind string `json:"kind"` // "click" 또는 게임이 선언한 특수 행동 ("pass" 등)
	Row  int    `json:"row"`
	Col  int    `json:"col"`
}

// ---- 클라이언트 → 서버 ----

type Join struct {
	Type string `json:"type"`
	Game string `json:"game"`
}

// ActionMsg에는 순번이 없습니다. 순번은 서버가 받은 순서대로 붙입니다.
type ActionMsg struct {
	Type   string `json:"type"`
	Action Action `json:"action"`
}

type Hash struct {
	Type string `json:"type"`
	Seq  int    `json:"seq"`
	Hash string `json:"hash"`
}

// Result의 Winner가 nil이면 무승부입니다.
type Result struct {
	Type   string `json:"type"`
	Winner *int   `json:"winner"`
	Reason string `json:"reason,omitempty"`
}

type Resign struct {
	Type string `json:"type"`
}

// ---- 서버 → 클라이언트 ----

// Waiting은 대기열에 들어갔다는 알림입니다. 상대가 오면 Matched가 갑니다.
type Waiting struct {
	Type string `json:"type"`
	Game string `json:"game"`
}

// Seed는 32비트입니다. JS 숫자는 2^53을 넘으면 정밀도를 잃기 때문입니다.
type Matched struct {
	Type     string     `json:"type"`
	Room     string     `json:"room"`
	Game     string     `json:"game"`
	Player   int        `json:"player"`
	Seed     uint32     `json:"seed"`
	Opponent PlayerInfo `json:"opponent"`
}

// PlayerInfo는 상대에게 보여줄 신원입니다. id는 넣지 않습니다 (docs/identity.md).
type PlayerInfo struct {
	Kind string `json:"kind"`           // "guest" 또는 "member"
	Tag  string `json:"tag"`            // 네 자리 숫자 ("게스트 4821")
	Name string `json:"name,omitempty"` // 계정만
}

// Resumed는 끊겼던 플레이어가 유예 시간 안에 돌아왔을 때 보냅니다.
// 클라이언트는 Seed로 setup()한 뒤 Log를 처음부터 재생해서 판을 복원합니다.
// 재생하면서 보내는 해시와 결과 중 이미 보고한 것은 서버가 무시합니다.
type Resumed struct {
	Type     string     `json:"type"`
	Room     string     `json:"room"`
	Game     string     `json:"game"`
	Player   int        `json:"player"`
	Seed     uint32     `json:"seed"`
	Opponent PlayerInfo `json:"opponent"`
	Log      []Relay    `json:"log"`
}

// Away는 상대의 연결이 끊겼다는 알림입니다. Seconds 안에 돌아오지 않으면 남은 쪽이 이깁니다.
type Away struct {
	Type    string `json:"type"`
	Player  int    `json:"player"`
	Seconds int    `json:"seconds"`
}

// Back은 끊겼던 상대가 돌아왔다는 알림입니다.
type Back struct {
	Type   string `json:"type"`
	Player int    `json:"player"`
}

// Relay는 순번이 붙은 행동입니다. 보낸 사람에게도 돌려보내며,
// 클라이언트는 내 행동도 Relay로 받은 뒤에 적용합니다.
type Relay struct {
	Type   string `json:"type"`
	Seq    int    `json:"seq"`
	Player int    `json:"player"`
	Action Action `json:"action"`
}

type Desync struct {
	Type string `json:"type"`
	Seq  int    `json:"seq"`
}

// Ended의 Winner가 nil이면 무승부이거나 무효입니다.
type Ended struct {
	Type   string `json:"type"`
	Winner *int   `json:"winner"`
	Reason string `json:"reason"`
}

type Error struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// PeekType은 메시지 종류만 먼저 읽습니다. 종류를 보고 알맞은 구조체로 다시 읽으면 됩니다.
func PeekType(data []byte) (string, error) {
	var head struct {
		Type string `json:"type"`
	}
	err := json.Unmarshal(data, &head)
	return head.Type, err
}
