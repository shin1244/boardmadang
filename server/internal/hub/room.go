package hub

import "github.com/shin1244/boardmadang/server/internal/protocol"

// Room은 매칭된 두 플레이어의 대국 하나입니다.
//
// 서버가 아는 건 시드와 행동 기록뿐이고, 판의 상태는 각 클라이언트가 계산합니다.
// 하지만 Seed + Log만 있으면 판을 언제든 다시 만들 수 있어서
// 재접속(기록을 보내 재생), 기보 다시보기, 결과 검증이 모두 이 두 필드로 해결됩니다.
type Room struct {
	ID      string
	Game    string
	Seed    uint32
	Players [2]*Client

	Log []protocol.Relay // 인덱스 = 순번

	hashes  map[int][2]string // 순번 → 양쪽이 보고한 상태 해시. -1은 시작 상태
	ignored [2]int            // 플레이어별 무시된 행동 수 (해시가 직전과 같았던 행동)
	results [2]*protocol.Result
	ended   bool
}

// relay는 player의 행동에 다음 순번을 붙여 기록하고 양쪽에 보냅니다.
// 행동이 규칙에 맞는지는 검사하지 않습니다. 그건 클라이언트의 게임 로직이 합니다.
//
// maxActions는 서버가 세지 않습니다. 무시된 행동은 세지 않아야 하는데, 그건 해시가 모여야 알 수 있습니다.
// 상태를 바꾼 행동 수는 양쪽 클라이언트가 세고, maxActions에 이르면 무승부 결과를 보고합니다.
//
// TODO: ended면 무시 / 연결당 초당 행동 수 제한 / Log에 추가 / 양쪽 Send
func (r *Room) relay(player int, a protocol.Action) {}

// reportHash는 player가 보고한 seq번째 상태 해시를 기록합니다.
//
// TODO:
//   - 양쪽 해시가 모이면 비교 → 다르면 양쪽에 Desync, end(nil, ReasonDesync)
//   - 같고 seq-1의 해시와도 같으면 Log[seq]의 행동은 무시된 것 → 보낸 플레이어의 ignored++
//   - ignored가 상한(docs/abuse-and-limits.md)을 넘으면 상대 승, end(&상대, ReasonSpam)
func (r *Room) reportHash(player, seq int, hash string) {}

// reportResult는 player가 보고한 게임 결과를 기록합니다.
//
// TODO: 양쪽이 보고하면 비교 → 같으면 end(winner, ReasonResult), 다르면 end(nil, ReasonDisagree)
func (r *Room) reportResult(player int, res protocol.Result) {}

// end는 대국을 끝내고 양쪽에 Ended를 보냅니다. 두 번 불려도 한 번만 처리합니다.
//
// TODO: 결과와 Log를 저장소에 남기기 (기보, 랭킹, 나중에 AI 학습 데이터)
func (r *Room) end(winner *int, reason string) {}
