# 프로토콜

## HTTP

| 요청 | 응답 |
|---|---|
| `GET /healthz` | `ok` |
| `GET /api/games` | 게임 목록 `[{"id":"tictactoe","module":"/games/tictactoe/index.js","version":"3f1c9a0b2e7d4c56","private":false,"listing":{...}}]` |
| `GET /api/locale` | 접속 나라와 화면 언어 `{"country":"KR","lang":"ko"}` |
| `GET /api/me` | 지금 신원 `{"id":"g_…","kind":"guest","tag":"4821"}`. 쿠키가 없으면 게스트를 새로 발급합니다 |
| `GET /api/matches/{id}` | 기보 하나. 시드와 행동 기록이 있어 처음부터 다시 둘 수 있습니다 `{"id":"VJ7QHHVKDY","game":"tictactoe","version":"3f1c9a0b2e7d4c56","seed":3551073280,"minutes":10,"players":[{…},{…}],"you":[0],"moves":[{"player":0,"action":{"kind":"click","row":1,"col":1},"at":10854}],"count":1,"winner":0,"reason":"result","clock":[587103,597876],"started":"…","ended":"…"}` |
| `GET /api/matches` | 내가 둔 대국 목록, 최근 것부터 50개 (`moves` 없이). 쿠키가 없으면 `[]` |
| `GET /api/rooms` | 상대를 기다리는 방 목록. 최근에 만들거나 올린 방이 먼저 `[{"room":"K3P9QX","game":"tictactoe","version":"3f1c9a0b2e7d4c56","minutes":10,"host":{"kind":"guest","tag":"4821"},"age":42}]` |
| `GET /api/live` | 진행 중인 대국 목록. 최근에 시작한 대국이 먼저 `[{"room":"K3P9QX","game":"tictactoe","version":"3f1c…","minutes":10,"players":[{…},{…}],"moves":7,"watchers":2,"age":95}]` |
| `GET /api/games/{id}/comments` | 게임의 의견, 최근 것부터 100개와 전체 수 `{"comments":[{"id":"RN92MFYW","author":{"kind":"guest","tag":"5875"},"text":"…","at":"…","mine":true,"reported":true,"hidden":true}],"count":2}` |
| `POST /api/games/{id}/comments` | 의견 남기기 `{"text":"…"}` → `201`과 남긴 의견 |
| `DELETE /api/games/{id}/comments/{comment}` | 내 의견 지우기 → `{"ok":true}` |
| `POST /api/reports` | 신고 `{"game":"tictactoe","comment":"RN92MFYW","reason":"spam","detail":"…"}` → `{"ok":true,"hidden":false}`. `comment`가 없으면 게임 신고 |

- `version`은 게임 코드 버전입니다. 게임 폴더의 `.js`, `.mjs` 파일(테스트와 `node_modules` 제외)을 `/`로 구분한 상대 경로 순으로
  "경로\0내용\0"씩 이어 SHA-256을 구하고 앞 16글자를 씁니다. 개발 서버와 Go 서버의 계산이 같아야 합니다.
  코드를 한 글자라도 고치면 바뀝니다. 대전할 때 서버에 같이 보내고, 기보에도 남습니다.
- `listing`은 등록 정보(이름, 소개, 룰북, 난이도, 지원 언어, 타이머)입니다. 등록 전이면 `null`입니다.
  보드 크기 같은 규칙 정보는 넣지 않습니다. 브라우저가 `module`을 import해서 게임 모듈에서 직접 읽습니다.
- `PUT /api/games/<id>/listing`: 개발 서버 전용. 등록창이 등록 정보를 `games/<id>/listing.json`에 저장합니다.
  내 컴퓨터에서 온 요청과 계정만 받고(게스트면 `403 {"error":"member only"}`), 검사에 걸리면 `422 {"problems":[...]}`를 돌려줍니다.
  검사 규칙은 [sdk/playground/listing.js](../sdk/playground/listing.js)에 있고, 운영 서버도 같은 규칙으로 검사합니다.
  타이머를 켰는데 게임 코드에 `turn()`이 없으면 `422 {"problems":[{"code":"timer.needsTurn"}]}`입니다.
- `/api/matches`: 끝난 대국은 Go 서버가 기보로 저장합니다 (`server/internal/record`). 무효가 된 대국도 남깁니다.
  - 기보 id(10글자)를 아는 사람은 누구나 볼 수 있습니다. 링크로 공유하는 용도입니다.
  - 플레이어의 내부 id는 보내지 않고, 보는 사람이 앉았던 자리를 `you`로 붙입니다 (안 둔 사람이면 `[]`, 혼자 두 자리면 `[0,1]`).
  - `at`은 대국 시작부터 그 행동이 서버에 온 시각(ms), `clock`은 끝났을 때 남은 시간(ms)입니다.
  - 개발 서버는 쿠키를 붙여 Go 서버에 그대로 묻습니다.
- `/api/rooms`: 방 목록은 Go 서버의 메모리에만 있습니다. 개발 서버는 Go 서버에 물어 그대로 넘깁니다.
  `age`는 마지막으로 만들거나 올린 뒤 지난 초, `minutes`가 `null`이면 타이머 없음입니다. 최대 200개입니다.
- `/api/live`: 관전할 수 있는 대국입니다. `age`는 시작한 뒤 지난 초, `moves`는 지금까지의 행동 수, `watchers`는 관전자 수입니다. 최대 200개입니다.
- 의견과 신고 (`server/internal/comment`):
  - 남기기, 지우기, 신고는 세션 쿠키가 있어야 합니다 (게스트도 됩니다). 없으면 `401 {"error":"no session"}`.
    POST는 `Content-Type: application/json`만 받습니다 (`415`). 다른 사이트에서 보내지 못하게 하려는 것입니다.
  - 의견은 500자, 20줄까지이고 한 사람이 15초에 한 번 남길 수 있습니다. 오류는 `400 empty`, `400 too long`, `429 too soon`.
  - 남이 쓴 의견을 지우면 `403 not yours`, 없는 의견이면 `404 not found`입니다.
  - 신고 사유(`reason`)는 `spam`, `abuse`, `adult`, `copyright`, `broken`, `other`입니다. `detail`은 300자까지입니다.
    내 의견은 신고할 수 없고(`400 own comment`), 같은 것을 두 번 신고하면 그냥 받습니다. 한 사람이 한 시간에 20번까지입니다 (`429 too many reports`).
  - 서로 다른 세 사람이 신고한 의견은 `hidden: true`가 되고 글(`text`)을 보내지 않습니다.
  - `author`에는 쓴 사람의 `kind`, `tag`, `name`만 들어갑니다. `mine`은 보는 사람이 쓴 의견, `reported`는 보는 사람이 이미 신고한 의견입니다.
- 기보의 `version`이 지금 게임 코드와 다르면 다시보기 화면이 "판이 다르게 보일 수 있다"고 알립니다.
  예전 코드를 보관해 그 코드로 재생하는 건 아직 하지 않습니다.
- `/api/locale`: 나라는 앞에 선 프록시가 넣어 주는 헤더에서 읽습니다. GCP 부하 분산기의 커스텀 요청 헤더
  `X-Client-Region: {client_region}`, 없으면 Cloudflare의 `CF-IPCountry`(모르는 나라인 `XX`는 빼고)입니다.
  KR이면 `ko`, 다른 나라면 `en`, 나라를 모르면 `Accept-Language`로 정합니다. 화면 언어 고르기에만 쓰므로
  헤더를 위조해도 문제 없습니다. 유저가 로비에서 직접 고른 언어가 있으면 브라우저가 이 요청보다 그걸 먼저 씁니다.
- `/api/me`: 게스트와 계정, 세션 쿠키는 [identity.md](identity.md)에 정리했습니다.
  Go 서버는 서명한 쿠키로 신원을 정합니다. 개발 서버는 늘 같은 가짜 신원을 돌려주고, `DEV_AS=guest`로 게스트를 흉내 냅니다.
- `/api/games`, `/api/locale`은 개발 서버(`sdk/playground/serve.js`)와 Go 서버(`server/internal/site`)가 같은 모양으로 제공합니다.
  Go 서버는 화면(`/web/`), 화면이 import하는 SDK 모듈(`/sdk/playground/`의 `board.js`, `listing.js`, `platform.js`), 게임 코드(`/games/`)도 내보냅니다.
  테스트 파일과 점으로 시작하는 파일은 내보내지 않습니다. 개발 서버에만 있는 것은 플레이그라운드 화면과 `PUT /api/games/<id>/listing`(등록창 저장)입니다.
  플레이그라운드는 게임 제작자가 자기 컴퓨터에서 쓰는 도구라 사이트의 메뉴와 버튼에는 없습니다.

# 웹소켓

- 주소: `GET /ws`
- 세션 쿠키(`bm_session`)가 있어야 합니다. 없거나 깨졌으면 `401`입니다. 브라우저는 `/api/me`를 먼저 불러 쿠키를 받아 둡니다.
- 모든 메시지는 JSON이고 `type` 필드로 종류를 구분합니다.
- Go 정의: [server/internal/protocol/messages.go](../server/internal/protocol/messages.go)

## 클라이언트 → 서버

| type | 언제 | 예시 |
|---|---|---|
| `join` | 빠른 매칭 대기열에 들어갈 때. 같은 게임, 같은 타이머, 같은 코드 버전끼리 만납니다. 대국이 끝나면 같은 연결로 다시 보낼 수 있습니다 | `{"type":"join","game":"tictactoe","minutes":10,"version":"3f1c…"}` |
| `create` | 방을 만들어 방 목록에 올릴 때 | `{"type":"create","game":"tictactoe","minutes":5,"version":"3f1c…"}` |
| `enter` | 방 목록의 방에 들어갈 때. 먼저 들어온 한 명만 되고, 방장과 코드 버전이 같아야 합니다 | `{"type":"enter","room":"K3P9QX","version":"3f1c…"}` |
| `watch` | 진행 중인 대국을 관전할 때 | `{"type":"watch","room":"K3P9QX"}` |
| `bump` | 방장이 자기 방을 목록 맨 위로 다시 올릴 때 (1분에 한 번) | `{"type":"bump"}` |
| `action` | 내 행동 (클릭, 패스 등) | `{"type":"action","action":{"kind":"click","row":0,"col":2}}` |
| `hash` | 행동을 적용한 뒤 상태 해시와 그 상태에서 누구 차례인지(`turn()`, 없으면 `null`). 시작 상태는 `seq: -1` | `{"type":"hash","seq":4,"hash":"9f2c…","turn":1}` |
| `result` | 게임 로직이 끝났다고 판정했을 때 | `{"type":"result","winner":0,"reason":"5목"}` |
| `resign` | 기권 (게임 로직이 아니라 플랫폼이 처리) | `{"type":"resign"}` |
| `draw` | 무승부 제안. 상대가 이미 제안해 둔 상태면 수락이 되어 무승부로 끝납니다 | `{"type":"draw"}` |
| `decline` | 상대의 무승부 제안 거절. 제안한 쪽이 보내면 철회 | `{"type":"decline"}` |
| `rematch` | 대국이 끝난 뒤 재대결 요청. 상대도 보내면 선후공을 바꿔 새 대국이 시작됩니다 | `{"type":"rematch"}` |
| `emote` | 이모티콘. 대국 중과, 끝난 뒤 다음 대국을 찾기 전까지 보낼 수 있습니다. 2초에 하나, 더 빨리 보내면 버립니다 | `{"type":"emote","emote":"hello"}` |

- 대기열이나 방 목록에서 빠지려면 연결을 닫습니다. 끊기는 즉시 빠지고, 방장이 끊기면 방도 바로 없어집니다.
- `minutes`는 타이머(분, 1~180)이고 `null`이면 타이머 없음입니다. 브라우저는 빠른 매칭에 등록 정보의 기본 타이머를,
  방 만들기에는 방장이 고른 시간을 넣습니다 (제작자가 커스텀을 막았으면 기본 타이머).
  서버는 아직 등록 정보를 몰라서 범위만 봅니다. 다른 값을 보내도 같은 값을 보낸 사람끼리만 만납니다.
- **대국 중에 끊기면 15초를 기다립니다.** 와이파이가 잠깐 끊기거나 휴대폰 화면이 꺼진 정도는 버티게 하려는 것입니다.
  - 상대에게 `away`가 갑니다. 그동안 상대는 계속 둘 수 있고, 행동은 기록에 쌓입니다.
  - 같은 신원(세션 쿠키)으로 다시 붙어 `join`(또는 `create`, `enter`)을 보내면 대기열 대신 `resumed`가 옵니다. 게임 id가 달라도 끊긴 대국이 먼저입니다.
    클라이언트는 `seed`로 `setup()`한 뒤 `log`를 처음부터 재생합니다. 재생하면서 보내는 `hash`, `result` 중 이미 보고한 것은 서버가 무시합니다.
  - 상대에게 `back`이 갑니다.
  - 기다리는 동안 대국이 끝났으면(상대 기권 등) `resumed` 바로 뒤에 `ended`가 옵니다.
  - 15초 안에 안 돌아오면 상대가 이깁니다 (`left`). 그 뒤에 `join`하면 평범하게 대기열에 들어갑니다.
  - 새로고침도 같은 흐름이라 대국이 이어집니다.
  - 타이머가 있으면 기다리는 동안에도 그 사람 차례면 시계가 갑니다. 15초보다 먼저 시간이 다 되면 `timeout`으로 끝납니다.
- `version`은 게임 코드 버전(`/api/games`의 `version`, 16진수 64자 이하)입니다. 비워 보내도 되고, 그러면 비운 사람끼리만 만납니다.
  코드가 다르면 같은 행동에도 판이 달라져 `desync`가 나므로, 다른 버전끼리는 매칭하지 않습니다.
- **무승부 제안**은 누가 행동을 하나 보내면(`relay`) 없어집니다. 거절당한 뒤 다시 제안하려면 그 사이에 행동이 하나 이상 오가야 합니다.
- **이모티콘**은 채팅 대신입니다. 글을 받지 않고 정해진 그림의 id만 받습니다 (욕설이나 개인정보가 오갈 수 없게).
  id 목록은 서버(`protocol.Emotes`)와 화면(`web/emotes.js`)이 같아야 합니다: `hello`, `please`, `think`, `wow`, `haha`, `oops`, `sad`, `gg`.
  기보에는 남기지 않고, 끊겼다가 돌아와도 다시 보내지 않습니다. 상대 이모티콘을 끄는 것은 화면이 정합니다 (이 브라우저에 저장).
- **재대결**은 끝난 대국의 두 사람이 모두 `rematch`를 보내야 시작됩니다. 한쪽이 연결을 닫거나 `join`, `create`, `enter`, `watch`로
  다른 대국을 찾기 시작하면 남은 쪽에 `rematchOff`가 가고 그 대국으로는 재대결할 수 없습니다.
- **관전자**는 행동을 보낼 수 없습니다. 연결을 닫으면 빠집니다. 대국이 끝나면 `ended`를 받고 관전도 끝납니다.
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
| `created` | 방을 만들었을 때. 누가 들어오면 `matched`가 옵니다 | `{"type":"created","room":"K3P9QX","game":"tictactoe","minutes":5,"bumpEvery":60}` |
| `bumped` | 방을 목록 맨 위로 올렸을 때 | `{"type":"bumped"}` |
| `resumed` | 끊겼다가 15초 안에 돌아와 `join`했을 때 | `{"type":"resumed","room":"K3P9QX","game":"tictactoe","player":1,"seed":3141592653,"opponent":{…},"minutes":10,"clock":{…},"draw":0,"log":[{"type":"relay","seq":0,…}]}` |
| `away` | 상대 연결이 끊겼을 때 | `{"type":"away","player":0,"seconds":15}` |
| `back` | 끊겼던 상대가 돌아왔을 때 | `{"type":"back","player":0}` |
| `draw` | 누가 무승부를 제안했을 때 (양쪽과 관전자에게) | `{"type":"draw","player":0}` |
| `drawOff` | 무승부 제안이 없어졌을 때 (거절, 철회, 다음 행동) | `{"type":"drawOff"}` |
| `rematch` | 누가 재대결을 원할 때 (양쪽에게). 둘 다 원하면 바로 `matched`가 옵니다 | `{"type":"rematch","player":1}` |
| `rematchOff` | 상대가 나가거나 다른 대국을 찾아 재대결을 할 수 없게 됐을 때 | `{"type":"rematchOff"}` |
| `emote` | 누가 이모티콘을 보냈을 때 (보낸 쪽을 포함해 양쪽과 관전자에게) | `{"type":"emote","player":0,"emote":"hello"}` |
| `watching` | 관전을 시작했을 때. `resumed`처럼 `seed`로 `setup()`한 뒤 `log`를 재생합니다. 그 뒤로는 `relay`, `clock`, `draw`, `drawOff`, `away`, `back`, `ended`를 같이 받습니다 | `{"type":"watching","room":"K3P9QX","game":"tictactoe","version":"3f1c…","seed":3141592653,"minutes":10,"players":[{…},{…}],"clock":{…},"log":[…]}` |
| `matched` | 상대가 정해졌을 때. 방에 들어왔으면 `room`은 그 방 코드입니다 | `{"type":"matched","room":"K3P9QX","game":"tictactoe","player":1,"seed":3141592653,"opponent":{"kind":"guest","tag":"4821"},"minutes":10}` |
| `clock` | 대국 시계가 넘어가거나 멈출 때 (타이머가 있을 때만) | `{"type":"clock","remaining":[598512,600000],"running":1}` |
| `relay` | 누군가의 행동 (내 행동도 포함) | `{"type":"relay","seq":4,"player":0,"action":{"kind":"click","row":1,"col":1}}` |
| `desync` | 양쪽 해시가 달랐을 때 | `{"type":"desync","seq":4}` |
| `ended` | 대국이 끝났을 때. `record`는 저장한 기보 id입니다 | `{"type":"ended","winner":0,"reason":"result","record":"VJ7QHHVKDY"}` |
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
| `timeout` | 한쪽이 시간을 다 씀 → 상대 승 |
| `agreed` | 무승부 제안을 상대가 수락함 (`winner`는 `null`) |

### `error`의 `message`

| message | 뜻 |
|---|---|
| `bad message` | JSON이 아니거나 모양이 틀림 |
| `unknown game` | 게임 id 모양이 틀림 (영문 소문자, 숫자, `-`, 40자 이하) |
| `already joined` | 이미 대기 중이거나, 방을 만들었거나, 대국 중인데 `join`, `create`, `enter`를 보냄 |
| `bad minutes` | 타이머가 1~180분도 `null`도 아님 |
| `bad version` | 코드 버전이 16진수 64자 이하가 아님 |
| `room not found` | 들어가거나 관전하려는 방이 없음 (이미 시작했거나 끝났거나 방장이 나감) |
| `version mismatch` | 방장과 게임 코드 버전이 다름 |
| `not hosting` / `too soon` | 방이 없는데 `bump`를 보냄 / 마지막으로 올린 지 1분이 안 됨. 무승부 제안을 거절당한 뒤 행동 없이 다시 제안해도 `too soon` |
| `no rematch` | 끝난 대국이 없거나 아직 대국 중인데 `rematch`를 보냄, 또는 이미 재대결을 할 수 없게 됨 |
| `too many watchers` | 관전자가 상한(100)에 닿음 |
| `not in a room` | 대국 중이 아닌데 `action`, `hash`, `result`, `resign`, `draw`, `decline`을 보냄. 대국 중도 끝난 대국도 없는데 `emote`를 보냄 |
| `bad action` / `bad hash` / `bad result` | 값이 틀림. 클릭 좌표는 0~31, 해시는 64자 이하, `turn`과 `winner`는 0, 1, `null` |
| `too many actions` | 초당 행동 수 제한(20)을 넘음. 그 행동은 버립니다 |
| `bad emote` | 없는 이모티콘 |
| `member only` | 게스트가 `create`를 보냄. 방은 계정만 만들 수 있습니다 |

- 메시지 하나는 1 KB까지입니다. 넘으면 연결을 끊습니다.
- 서버가 보낼 메시지가 64개 넘게 밀리면(느린 연결) 연결을 끊습니다.

## 대국 시계

타이머가 있는 대국은 서버가 체스 시계를 돌립니다. 각자 자기 차례에만 자기 시간이 줄고, 다 쓰면 집니다 (`timeout`).

- 서버는 규칙을 몰라서 누구 차례인지 모릅니다. 클라이언트가 `hash`에 같이 보내는 `turn`(게임의 `turn()`)으로 압니다.
- 시계는 그 순번의 **먼저 온** 보고로 넘깁니다. 늦은 쪽의 네트워크 지연을 둔 사람이 떠안지 않게 하려는 것입니다.
  양쪽 `turn`이 다르면 해시가 다른 것과 같이 `desync`로 무효입니다. 그래서 거짓 차례를 먼저 보내도 얻는 게 없습니다.
- `turn`이 `null`이면 시계가 멈춥니다. 게임이 끝나면 `turn()`이 `null`이어야 합니다.
- `clock`의 `remaining`은 보낸 순간의 남은 시간(ms)이고, `running`의 시계는 그 뒤로 줄어듭니다. 화면은 이걸 받아 줄여 보여주기만 하고,
  시간이 다 됐는지는 서버가 정합니다. 대국이 끝날 때 멈춘 시계(`running: null`)가 `ended` 바로 앞에 한 번 더 옵니다.

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
