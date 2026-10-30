# 웹소켓 프로토콜

- 주소: `GET /ws`
- 모든 메시지는 JSON이고 `type` 필드로 종류를 구분합니다.
- Go 정의: [server/internal/protocol/messages.go](../server/internal/protocol/messages.go)

## 클라이언트 → 서버

| type | 언제 | 예시 |
|---|---|---|
| `join` | 매칭 대기열에 들어갈 때 | `{"type":"join","game":"tictactoe"}` |
| `action` | 내 행동 (클릭, 패스 등) | `{"type":"action","action":{"kind":"click","row":0,"col":2}}` |
| `hash` | 행동을 적용한 뒤 상태 해시. 시작 상태는 `seq: -1` | `{"type":"hash","seq":4,"hash":"9f2c…"}` |
| `result` | 게임 로직이 끝났다고 판정했을 때 | `{"type":"result","winner":0,"reason":"5목"}` |
| `resign` | 기권 (게임 로직이 아니라 플랫폼이 처리) | `{"type":"resign"}` |

- `action`에는 **순번을 넣지 않습니다.** 순번은 서버가 받은 순서대로 붙입니다.
- `winner`가 `null`이면 무승부입니다.
- `matched`를 받으면 `setup()`한 시작 상태의 해시를 `seq: -1`로 보냅니다.
  서버는 `seq`의 해시가 `seq - 1`과 같으면 그 행동이 무시됐다고 봅니다.
- 상태를 바꾼 행동이 `maxActions`에 이르면 클라이언트가 `result {winner: null, reason: "maxActions"}`를 보냅니다.
  양쪽이 같은 기록으로 같은 수를 세므로 보고가 일치합니다.

## 서버 → 클라이언트

| type | 언제 | 예시 |
|---|---|---|
| `matched` | 상대가 정해졌을 때 | `{"type":"matched","room":"K3P9QX","game":"tictactoe","player":1,"seed":3141592653}` |
| `relay` | 누군가의 행동 (내 행동도 포함) | `{"type":"relay","seq":4,"player":0,"action":{"kind":"click","row":1,"col":1}}` |
| `desync` | 양쪽 해시가 달랐을 때 | `{"type":"desync","seq":4}` |
| `ended` | 대국이 끝났을 때 | `{"type":"ended","winner":0,"reason":"result"}` |
| `error` | 잘못된 요청 | `{"type":"error","message":"unknown game"}` |

- **내 행동도 서버를 거쳐 `relay`로 돌아온 뒤에 적용합니다.** 내 화면에 바로 적용하면
  양쪽이 동시에 클릭했을 때 순서가 달라져 어긋납니다.
- `seed`는 32비트 정수입니다. JS 숫자는 2⁵³을 넘으면 정밀도를 잃기 때문입니다.

### `ended`의 `reason`

| reason | 뜻 |
|---|---|
| `result` | 양쪽이 같은 결과를 보고함 |
| `resign` | 한쪽이 기권 |
| `left` | 한쪽 연결이 끊김 → 남은 쪽 승 |
| `desync` | 해시 불일치로 무효 (`winner`는 `null`) |
| `disagree` | 양쪽 결과 보고가 다름 (`winner`는 `null`, 분쟁으로 기록) |
| `spam` | 한쪽이 무시된 행동을 너무 많이 보냄 → 상대 승 |

## 흐름 예시 (틱택토)

```
A → join {game:"tictactoe"}
B → join {game:"tictactoe"}
S → A: matched {player:0, seed}      S → B: matched {player:1, seed}
A → hash {seq:-1}                    B → hash {seq:-1}
A → action {click 1,1}
S → A, B: relay {seq:0, player:0, click 1,1}
A → hash {seq:0}                     B → hash {seq:0}
…
A → result {winner:0}                B → result {winner:0}
S → A, B: ended {winner:0, reason:"result"}
```
