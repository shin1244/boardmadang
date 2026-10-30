// Package protocol은 클라이언트와 서버가 주고받는 웹소켓 메시지를 정의합니다.
// 설명과 예시는 docs/protocol.md에 있습니다.
//
// 서버는 게임 규칙을 모릅니다. 행동을 받아 순번을 붙여 양쪽에 그대로 전달할 뿐입니다 (락스텝).
package protocol

import "encoding/json"

// 클라이언트 → 서버
const (
	TypeJoin    = "join"
	TypeCreate  = "create"
	TypeEnter   = "enter"
	TypeBump    = "bump"
	TypeAction  = "action"
	TypeHash    = "hash"
	TypeResult  = "result"
	TypeResign  = "resign"
	TypeDraw    = "draw"    // 무승부 제안. 상대가 제안해 둔 상태면 수락
	TypeDecline = "decline" // 무승부 제안 거절 (제안한 쪽이 보내면 철회)
	TypeRematch = "rematch" // 끝난 대국의 재대결 요청. 상대도 보내면 자리를 바꿔 시작
)

// 서버 → 클라이언트
const (
	TypeWaiting = "waiting"
	TypeCreated = "created"
	TypeBumped  = "bumped"
	TypeMatched = "matched"
	TypeClock   = "clock"
	TypeResumed = "resumed"
	TypeAway    = "away"
	TypeBack    = "back"
	TypeRelay   = "relay"
	TypeDesync  = "desync"
	TypeEnded   = "ended"
	TypeError   = "error"

	// TypeDraw: 누가 무승부를 제안했는지 (양쪽에게). TypeRematch: 누가 재대결을 원하는지 (양쪽에게)
	TypeDrawOff    = "drawOff"    // 무승부 제안이 없어짐 (거절, 철회, 다음 행동)
	TypeRematchOff = "rematchOff" // 재대결을 할 수 없게 됨 (상대가 나가거나 다른 대국을 찾음)
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
	ReasonTimeout  = "timeout"  // 한쪽이 시간을 다 씀 → 상대 승
	ReasonAgreed   = "agreed"   // 무승부 합의
)

// Action은 플레이어의 행동 하나입니다. 서버는 내용을 해석하지 않고 그대로 전달합니다.
// Row와 Col에 omitempty를 붙이면 안 됩니다. 0도 올바른 좌표이기 때문입니다.
type Action struct {
	Kind string `json:"kind"` // "click" 또는 게임이 선언한 특수 행동 ("pass" 등)
	Row  int    `json:"row"`
	Col  int    `json:"col"`
}

// ---- 클라이언트 → 서버 ----

// Join은 빠른 매칭입니다. Minutes는 타이머(분), null이면 타이머 없음.
// 같은 게임, 같은 타이머, 같은 코드 버전끼리만 매칭합니다. 브라우저는 등록 정보의 기본 타이머를 넣어 보냅니다.
//
// Version은 브라우저가 불러온 게임 코드의 버전입니다 (/api/games의 version, 코드 파일의 해시).
// 코드가 다르면 같은 행동으로 다른 판이 되어 무효가 나므로 섞지 않고, 기보에도 남깁니다.
type Join struct {
	Type    string `json:"type"`
	Game    string `json:"game"`
	Minutes *int   `json:"minutes"`
	Version string `json:"version"`
}

// Create는 방 만들기입니다. 방 목록(GET /api/rooms)에 올라가고, 누가 Enter하면 대국이 시작됩니다.
type Create struct {
	Type    string `json:"type"`
	Game    string `json:"game"`
	Minutes *int   `json:"minutes"`
	Version string `json:"version"`
}

// Enter는 방 목록의 방에 들어가기입니다. 방장과 코드 버전이 다르면 "version mismatch" 오류입니다.
type Enter struct {
	Type    string `json:"type"`
	Room    string `json:"room"`
	Version string `json:"version"`
}

// Bump는 방장이 자기 방을 목록 맨 위로 올리는 것입니다. BumpEvery마다 한 번 됩니다.
type Bump struct {
	Type string `json:"type"`
}

// ActionMsg에는 순번이 없습니다. 순번은 서버가 받은 순서대로 붙입니다.
type ActionMsg struct {
	Type   string `json:"type"`
	Action Action `json:"action"`
}

// Hash의 Turn은 그 상태에서 누구 차례인지입니다 (게임의 turn(), 없으면 null).
// 서버는 먼저 온 보고의 Turn으로 대국 시계를 넘기고, 양쪽 Turn이 다르면 해시가 다른 것처럼 무효로 합니다.
type Hash struct {
	Type string `json:"type"`
	Seq  int    `json:"seq"`
	Hash string `json:"hash"`
	Turn *int   `json:"turn"`
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

// Created는 방을 만들었다는 알림입니다. 누가 들어오면 Matched가 갑니다.
// BumpEvery초마다 Bump로 방을 목록 맨 위에 다시 올릴 수 있습니다.
type Created struct {
	Type      string `json:"type"`
	Room      string `json:"room"`
	Game      string `json:"game"`
	Minutes   *int   `json:"minutes"`
	BumpEvery int    `json:"bumpEvery"`
}

// Bumped는 방을 목록 맨 위로 올렸다는 알림입니다.
type Bumped struct {
	Type string `json:"type"`
}

// Clock은 대국 시계입니다. 시계가 넘어갈 때마다 보냅니다.
// Remaining은 보낸 순간의 남은 시간(ms)이고, Running의 시계는 그 뒤로 줄어듭니다. Running이 null이면 멈춤.
type Clock struct {
	Type      string   `json:"type"`
	Remaining [2]int64 `json:"remaining"`
	Running   *int     `json:"running"`
}

// OpenRoom은 방 목록(GET /api/rooms)의 한 줄입니다. Age는 마지막으로 올린 뒤 지난 초입니다.
type OpenRoom struct {
	Room    string     `json:"room"`
	Game    string     `json:"game"`
	Version string     `json:"version"`
	Minutes *int       `json:"minutes"`
	Host    PlayerInfo `json:"host"`
	Age     int        `json:"age"`
}

// Seed는 32비트입니다. JS 숫자는 2^53을 넘으면 정밀도를 잃기 때문입니다.
type Matched struct {
	Type     string     `json:"type"`
	Room     string     `json:"room"`
	Game     string     `json:"game"`
	Player   int        `json:"player"`
	Seed     uint32     `json:"seed"`
	Opponent PlayerInfo `json:"opponent"`
	Minutes  *int       `json:"minutes"` // 타이머(분). null이면 없음
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
	Minutes  *int       `json:"minutes"`
	Clock    *Clock     `json:"clock,omitempty"` // 타이머가 있으면 지금 시계
	Draw     *int       `json:"draw,omitempty"`  // 무승부를 제안해 둔 자리. 없으면 없음
	Log      []Relay    `json:"log"`
}

// Draw는 Player가 무승부를 제안했다는 알림입니다. 제안한 쪽에게도 갑니다.
// 제안은 상대가 수락(draw)하거나 거절(decline)하거나, 누가 행동을 하나 보내면 없어집니다 (DrawOff).
type Draw struct {
	Type   string `json:"type"`
	Player int    `json:"player"`
}

type DrawOff struct {
	Type string `json:"type"`
}

// Rematch는 Player가 재대결을 원한다는 알림입니다. 양쪽이 원하면 자리를 바꿔 새 대국이 시작되고 Matched가 갑니다.
type Rematch struct {
	Type   string `json:"type"`
	Player int    `json:"player"`
}

type RematchOff struct {
	Type string `json:"type"`
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
// Ended의 Record는 저장한 기보의 id입니다 (GET /api/matches/{id}). 저장하지 않는 서버면 없습니다.
type Ended struct {
	Type   string `json:"type"`
	Winner *int   `json:"winner"`
	Reason string `json:"reason"`
	Record string `json:"record,omitempty"`
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
