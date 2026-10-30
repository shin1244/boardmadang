# 프로토콜

## HTTP

| 요청 | 응답 |
|---|---|
| `GET /healthz` | `ok` |
| `GET /api/games` | 게임 목록 `[{"id":"tictactoe","module":"/games/tictactoe/index.js","private":false,"listing":{...}}]` |
| `GET /api/locale` | 접속 나라와 화면 언어 `{"country":"KR","lang":"ko"}` |
| `GET /api/me` | 지금 신원 `{"id":"g_…","kind":"guest","tag":"4821"}`. 쿠키가 없으면 게스트를 새로 발급합니다 |

- `listing`은 등록 정보(이름, 소개, 룰북, 난이도, 지원 언어)입니다. 등록 전이면 `null`입니다.
  보드 크기 같은 규칙 정보는 넣지 않습니다. 브라우저가 `module`을 import해서 게임 모듈에서 직접 읽습니다.
- `PUT /api/games/<id>/listing`: 개발 서버 전용. 등록창이 등록 정보를 `games/<id>/listing.json`에 저장합니다.
  내 컴퓨터에서 온 요청과 계정만 받고(게스트면 `403 {"error":"member only"}`), 검사에 걸리면 `422 {"problems":[...]}`를 돌려줍니다.
  검사 규칙은 [sdk/playground/listing.js](../sdk/playground/listing.js)에 있고, 운영 서버도 같은 규칙으로 검사합니다.
- `/api/locale`: 나라는 GCP 부하 분산기의 커스텀 요청 헤더 `X-Client-Region: {client_region}`에서 읽습니다.
  KR이면 `ko`, 다른 나라면 `en`, 나라를 모르면 `Accept-Language`로 정합니다. 화면 언어 고르기에만 쓰므로
  헤더를 위조해도 문제 없습니다. 유저가 로비에서 직접 고른 언어가 있으면 브라우저가 이 요청보다 그걸 먼저 씁니다.
- `/api/me`: 게스트와 계정, 세션 쿠키는 [identity.md](identity.md)에 정리했습니다.
  Go 서버는 서명한 쿠키로 신원을 정합니다. 개발 서버는 늘 같은 가짜 신원을 돌려주고, `DEV_AS=guest`로 게스트를 흉내 냅니다.
- `/api/games`, `/api/locale`은 지금 개발 서버(`sdk/playground/serve.js`)만 제공합니다. Go 서버도 같은 모양으로 제공할 예정입니다.

# 웹소켓

- 주소: `GET /ws`
- 세션 쿠키(`bm_session`)가 있어야 합니다. 없거나 깨졌으면 `401`입니다. 브라우저는 `/api/me`를 먼저 불러 쿠키를 받아 둡니다.
- 모든 메시지는 JSON이고 `type` 필드로 종류를 구분합니다.
- Go 정의: [server/internal/protocol/messages.go](../server/internal/protocol/messages.go)

## 클라이언트 → 서버

| type | 언제 | 예시 |
|---|---|---|
| `join` | 매칭 대기열에 들어갈 때. 대국이 끝나면 같은 연결로 다시 보낼 수 있습니다 | `{"type":"join","game":"tictactoe"}` |
| `action` | 내 행동 (클릭, 패스 등) | `{"type":"action","action":{"kind":"click","row":0,"col":2}}` |
| `hash` | 행동을 적용한 뒤 상태 해시. 시작 상태는 `seq: -1` | `{"type":"hash","seq":4,"hash":"9f2c…"}` |
| `result` | 게임 로직이 끝났다고 판정했을 때 | `{"type":"result","winner":0,"reason":"5목"}` |
| `resign` | 기권 (게임 로직이 아니라 플랫폼이 처리) | `{"type":"resign"}` |

- 대기열에서 빠지려면 연결을 닫습니다. 대기열은 끊기는 즉시 빠집니다.
- **대국 중에 끊기면 15초를 기다립니다.** 와이파이가 잠깐 끊기거나 휴대폰 화면이 꺼진 정도는 버티게 하려는 것입니다.
  - 상대에게 `away`가 갑니다. 그동안 상대는 계속 둘 수 있고, 행동은 기록에 쌓입니다.
  - 같은 신원(세션 쿠키)으로 다시 붙어 `join`을 보내면 대기열 대신 `resumed`가 옵니다. 게임 id가 달라도 끊긴 대국이 먼저입니다.
    클라이언트는 `seed`로 `setup()`한 뒤 `log`를 처음부터 재생합니다. 재생하면서 보내는 `hash`, `result` 중 이미 보고한 것은 서버가 무시합니다.
  - 상대에게 `back`이 갑니다.
  - 기다리는 동안 대국이 끝났으면(상대 기권 등) `resumed` 바로 뒤에 `ended`가 옵니다.
  - 15초 안에 안 돌아오면 상대가 이깁니다 (`left`). 그 뒤에 `join`하면 평범하게 대기열에 들어갑니다.
  - 새로고침도 같은 흐름이라 대국이 이어집니다.
- `action`에는 **순번을 넣지 않습니다.** 순번은 서버가 받은 순서대로 붙입니다.
- `winner`가 `null`이면 무승부입니다.
- `matched`를 받으면 `setup()`한 시작 상태의 해시를 `seq: -1`로 보냅니다.
  서버는 `seq`의 해시가 `seq - 1`과 같으면 그 행동이 무시됐다고 봅니다.
- 상태를 바꾼 행동이 `maxActions`에 이르면 클라이언트가 `result {winner: null, reason: "maxActions"}`를 보냅니다.
  양쪽이 같은 기록으로 같은 수를 세므로 보고가 일치합니다.

## 서버 → 클라이언트

| type | 언제 | 예시 |
|---|---|---|
| `waiting` | 대기열에 들어갔을 때 | `{"type":"waiting","game":"tictactoe"}` |
| `resumed` | 끊겼다가 15초 안에 돌아와 `join`했을 때 | `{"type":"resumed","room":"K3P9QX","game":"tictactoe","player":1,"seed":3141592653,"opponent":{…},"log":[{"type":"relay","seq":0,…}]}` |
| `away` | 상대 연결이 끊겼을 때 | `{"type":"away","player":0,"seconds":15}` |
| `back` | 끊겼던 상대가 돌아왔을 때 | `{"type":"back","player":0}` |
| `matched` | 상대가 정해졌을 때 | `{"type":"matched","room":"K3P9QX","game":"tictactoe","player":1,"seed":3141592653,"opponent":{"kind":"guest","tag":"4821"}}` |
| `relay` | 누군가의 행동 (내 행동도 포함) | `{"type":"relay","seq":4,"player":0,"action":{"kind":"click","row":1,"col":1}}` |
| `desync` | 양쪽 해시가 달랐을 때 | `{"type":"desync","seq":4}` |
| `ended` | 대국이 끝났을 때 | `{"type":"ended","winner":0,"reason":"result"}` |
| `error` | 잘못된 요청 | `{"type":"error","message":"unknown game"}` |

- **내 행동도 서버를 거쳐 `relay`로 돌아온 뒤에 적용합니다.** 내 화면에 바로 적용하면
  양쪽이 동시에 클릭했을 때 순서가 달라져 어긋납니다.
- 선후공은 서버가 랜덤으로 정합니다. 같은 신원끼리도 매칭됩니다 (탭 두 개로 혼자 둬볼 수 있게). 랭킹이 생기면 막습니다.
- `opponent`에는 상대의 `kind`, `tag`, `name`(계정만)만 들어갑니다. 상대의 `id`는 보내지 않습니다.
- `seed`는 32비트 정수입니다. JS 숫자는 2⁵³을 넘으면 정밀도를 잃기 때문입니다.

### `ended`의 `reason`

| reason | 뜻 |
|---|---|
| `result` | 양쪽이 같은 결과를 보고함 |
| `resign` | 한쪽이 기권 |
| `left` | 한쪽 연결이 끊기고 15초 안에 돌아오지 않음 → 남은 쪽 승 |
| `desync` | 해시 불일치로 무효 (`winner`는 `null`) |
| `disagree` | 양쪽 결과 보고가 다름 (`winner`는 `null`, 분쟁으로 기록) |
| `spam` | 한쪽이 무시된 행동을 너무 많이 보냄 → 상대 승 |
| `limit` | 행동 기록이 상한(3,000)에 닿음 → 무효 (`winner`는 `null`) |

### `error`의 `message`

| message | 뜻 |
|---|---|
| `bad message` | JSON이 아니거나 모양이 틀림 |
| `unknown game` | 게임 id 모양이 틀림 (영문 소문자, 숫자, `-`, 40자 이하) |
| `already joined` | 이미 대기 중이거나 대국 중인데 `join`을 보냄 |
| `not in a room` | 대국 중이 아닌데 `action`, `hash`, `result`, `resign`을 보냄 |
| `bad action` / `bad hash` / `bad result` | 값이 틀림. 클릭 좌표는 0~31, 해시는 64자 이하, `winner`는 0, 1, `null` |
| `too many actions` | 초당 행동 수 제한(20)을 넘음. 그 행동은 버립니다 |

- 메시지 하나는 1 KB까지입니다. 넘으면 연결을 끊습니다.
- 서버가 보낼 메시지가 64개 넘게 밀리면(느린 연결) 연결을 끊습니다.

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
