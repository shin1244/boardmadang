# 프로토콜

## HTTP

| 요청 | 응답 |
|---|---|
| `GET /healthz` | `ok` |
| `GET /api/games` | 게임 목록 `[{"id":"tictactoe","module":"/games/tictactoe/index.js","version":"3f1c9a0b2e7d4c56","private":false,"listing":{...},"thumbnail":{...},"plays":12,"released":"…"}]`. `plays`는 둔 판 수로 로비의 인기순에 씁니다 (무효가 된 대국, 행동이 없는 대국, 한 사람이 두 자리에 앉은 대국은 빼고 셈. 0이면 없음). `released`는 올린 게임을 처음 등록한 때로 출시일순에 씁니다 (레포 게임은 없음). `author`는 올린 게임의 제작자 이름으로, 계정의 지금 이름입니다 (레포 게임과 이름을 모르는 게임은 없음, `/api/uploads`에도 없음). 운영자가 AI 모델을 올린 게임에는 `ai`(아래)가 붙습니다. `stars`는 별(즐겨찾기)을 단 계정 수로 로비의 별 많은순에 씁니다 (0이면 없음) |
| `GET /api/locale` | 접속 나라와 화면 언어 `{"country":"KR","lang":"ko"}` |
| `GET /api/me` | 지금 신원 `{"id":"g_…","kind":"guest","tag":"4821"}`. 쿠키가 없으면 게스트를 새로 발급합니다. 계정이면 운영자(`"admin":true`)와 정지(`"suspended":true,"suspendedUntil":"…"`, 영구면 `suspendedUntil` 없음)도 옵니다 |
| `GET /api/account` | 내 계정 `{"name":"shin","provider":"google","created":"…","renameAfter":"…","min":4,"max":8}`. `renameAfter`는 이름을 다시 바꿀 수 있는 때 (지금 바꿀 수 있으면 없음). 계정만 |
| `PATCH /api/account` | 이름 바꾸기 `{"name":"…"}` → `GET /api/account`와 같은 모양. 30일에 한 번 (가입한 뒤 첫 번째는 바로). 안 되는 이름은 `400 {"error":"name length\|name chars\|name reserved\|name same"}`, 너무 일찍 바꾸면 `429 {"error":"rename too soon","renameAfter":"…"}`, 정지된 계정이면 `403 {"error":"suspended"}`. 계정만 |
| `DELETE /api/account` | 탈퇴 `{"confirm":"<지금 이름>"}` → `204`, 세션 쿠키를 지웁니다. 이름이 다르면 `400 {"error":"confirm"}`. 계정만 ([identity.md](identity.md#이름-바꾸기와-탈퇴)) |
| `GET /api/matches/{id}` | 기보 하나. 시드와 행동 기록이 있어 처음부터 다시 둘 수 있습니다 `{"id":"VJ7QHHVKDY","game":"tictactoe","version":"3f1c9a0b2e7d4c56","seed":3551073280,"minutes":10,"players":[{…},{…}],"you":[0],"moves":[{"player":0,"action":{"kind":"click","row":1,"col":1},"at":10854}],"count":1,"winner":0,"reason":"result","clock":[587103,597876],"started":"…","ended":"…"}` |
| `GET /api/matches` | 내가 둔 대국 목록, 최근 것부터 50개 (`moves` 없이). 쿠키가 없으면 `[]` |
| `GET /api/rooms` | 상대를 기다리는 방 목록. 최근에 만들거나 올린 방이 먼저 `[{"room":"K3P9QX","game":"tictactoe","version":"3f1c9a0b2e7d4c56","minutes":10,"host":{"kind":"guest","tag":"4821"},"age":42}]` |
| `GET /api/live` | 진행 중인 대국 목록. 최근에 시작한 대국이 먼저 `[{"room":"K3P9QX","game":"tictactoe","version":"3f1c…","minutes":10,"players":[{…},{…}],"moves":7,"watchers":2,"age":95}]` |
| `GET /api/games/{id}/comments` | 게임의 의견, 최근 것부터 100개와 전체 수 `{"comments":[{"id":"RN92MFYW","author":{"kind":"guest","tag":"5875"},"text":"…","at":"…","mine":true,"reported":true,"hidden":true}],"count":2}` |
| `POST /api/games/{id}/comments` | 의견 남기기 `{"text":"…"}` → `201`과 남긴 의견 |
| `DELETE /api/games/{id}/comments/{comment}` | 내 의견 지우기 → `{"ok":true}` |
| `GET /api/stars` | 내가 별(즐겨찾기)을 단 게임 `{"games":["splat-chess","tictactoe"]}`. 게스트이거나 세션이 없으면 빈 목록. 지금 목록에 없는 게임도 들어 있을 수 있습니다 |
| `PUT /api/games/{id}/star` | 별 달기 → `{"stars":3,"starred":true}` (바뀐 뒤의 별 수). 이미 달았으면 그대로. 계정만, 없는 게임이면 `404` |
| `DELETE /api/games/{id}/star` | 별 떼기 → `{"stars":2,"starred":false}`. 계정만 (정지된 계정도 뗄 수는 있음) |
| `POST /api/reports` | 신고 `{"game":"tictactoe","comment":"RN92MFYW","reason":"spam","detail":"…"}` → `{"ok":true,"hidden":false}`. `comment`가 없으면 게임 신고 |
| `GET /api/uploads` | 내가 올린 게임과 오늘 남은 등록 횟수 `{"games":[{"id":"dots","module":"…","version":"e9ff673cd0205ffa","listing":{…},"thumbnail":{…},"clear":true,"published":"…","hidden":true}],"left":4,"newLeft":0}`. 게임마다 `/api/games`의 항목에 마지막으로 등록한 때와 내렸는지(`hidden`)를 더한 것입니다. `left`는 새 게임과 새 버전을 합친 횟수, `newLeft`는 오늘 더 올릴 수 있는 새 게임 수(하루 1개, `left`를 넘지 않음)입니다. 운영자 계정이면 `"unlimited":true`이고, 하루 등록 횟수에 막히지 않습니다. 계정만 |
| `PATCH /api/uploads/{id}` | 내 게임의 등록 정보만 고치기 `{"listing":{…}}`, 내리기 `{"hidden":true}`, 다시 올리기 `{"hidden":false}` → `{"game":{…}}` (`GET /api/uploads`의 항목). 계정만 |
| `POST /api/drafts` | 게임 zip을 초안으로 올리기. 본문은 zip 그대로(`Content-Type: application/zip`). 계정만 → `201 {"id":"<초안>","module":"/drafts/<초안>/index.js","version":"…","files":[{"path":"index.js","bytes":3640}],"listing":{…},"thumbnail":{…},"thumbnailProblems":["…"]}` |
| `POST /api/drafts/{draft}/publish` | 초안 등록 `{"id":"dots","listing":{…},"thumbnail":{…},"clear":{"version":"…","seed":3551073280,"moves":[{"player":0,"action":{"kind":"click","row":1,"col":1}}],"winner":0}}` → `{"game":{…}}` (`/api/games`의 항목). 계정만 |
| `GET /api/games/{id}/clear` | 제작자 클리어 기보. 올린 게임의 지금 버전만 `{"game":"dots","version":"…","seed":3551073280,"moves":[…],"winner":0,"at":"…"}`. 없으면 `404` |
| `GET /drafts/{draft}/{path}` | 초안의 파일. 등록창이 실행기에 불러와 검사합니다 |
| `GET /uploads/{id}/{version}/{path}` | 올린 게임의 코드. 버전이 곧 내용의 해시라 오래 캐시합니다 (`immutable`) |
| `GET /ai/{game}/{file}` | 게임의 AI 모델(ONNX). 파일 이름이 내용의 해시라 오래 캐시합니다 (`immutable`). 지금 모델만 |
| `GET /api/admin` | 운영자 화면. 신고 목록, 정지된 계정, 최근 운영 기록. 운영자만 ([moderation.md](moderation.md#api)) |
| `POST /api/admin/actions` | 운영 조치 하나 `{"action":"comment.hide","game":"…","comment":"…","note":"…"}` → `{"ok":true}`. 운영자만 |
| `PUT /api/admin/ai/{game}` | AI 모델 올리기 `{"meta":{…},"model":"<model.onnx의 base64>"}` → `{"ai":{…}}` (`/api/games`의 `ai`). `meta`는 `trainer/train.py --export-onnx`가 쓴 `model.json` 그대로. 모델은 16 MB까지 (`413`), 모양이 틀리면 `422 {"error":"…"}`, 없는 게임이면 `404`. 같은 게임의 모델은 바뀝니다. 운영자만 |
| `DELETE /api/admin/ai/{game}` | AI 모델 지우기 → `{"ok":true}`. 요청과 학습 기록은 남습니다. 운영자만 |
| `GET /api/admin/stats?days=30` | 운영자 화면의 통계. 날마다 방문, MAU, 대국, 등록, 가입과 지금 접속. 운영자만 ([moderation.md](moderation.md#통계)) |
| `GET /api/ai/mine` | 내가 올린 게임마다 AI 상태 `{"games":{"<id>":{"request":{…},"training":{…},"ai":{…}}},"next":"…"}`. 없는 칸은 빠집니다. `next`는 다음 AI 요청을 할 수 있는 때로, 지금 할 수 있으면 빠집니다 (일주일에 한 번). 계정만 |
| `POST /api/ai/{game}/request` | AI 만들기 요청 (본문 `{}`, JSON만) → `{"request":{"game":"…","version":"…","by":"…","at":"…","status":"waiting","updated":"…"}}`. 내가 올린 게임의 지금 버전으로. 남의 게임이나 레포 게임이면 `404`, 내린 게임이면 `409 {"error":"hidden"}`, 이미 요청이 있으면 `409 {"error":"request open"}`, 이 버전으로 학습한 모델이 있으면 `409 {"error":"already trained"}`, 다른 게임의 요청이 안 끝났으면 `429 {"error":"another request"}`, 마지막으로 요청한 지 일주일이 안 됐으면 `429 {"error":"too soon","next":"…"}` (거둔 요청은 세지 않음), 정지된 계정이면 `403` |
| `DELETE /api/ai/{game}/request` | 기다리는 중인 내 요청 거두기 → `{"ok":true}`. 운영자가 받아 갔거나 끝난 요청이면 `409 {"error":"no request"}` |
| `GET /api/ai/{game}/training` | 학습 기록 (`snapshots.json` 그대로, 아래). 게임을 올린 사람과 운영자만, 다른 사람에게는 `404`. 로그인 전이면 `401` |
| `GET /api/admin/ai/requests` | AI 요청 목록 `{"requests":[…],"trainings":{"<id>":{"version":"…","minutes":60,"snapshots":7,"updated":"…"}}}`. 안 끝난 요청을 오래된 것부터, 그다음 끝난 요청 30개를 최근 것부터. 운영자만 |
| `POST /api/admin/ai/{game}/code` | 게임 코드 받기 (본문 `{}`, JSON만) → `application/zip` 첨부 `<게임>-<버전>.zip` (`<게임>/` 안에 코드와 `listing.json`). 열린 요청이 있으면 그 버전이고 요청이 학습 중(`training`)이 됩니다. 없으면 지금 버전. 레포 게임이면 `404`. 운영자만 |
| `POST /api/admin/ai/{game}/decline` | 요청 반려 `{"note":"…"}` (500자까지, 제작자에게 보임) → `{"request":{…,"status":"declined"}}`. 열린 요청이 없으면 `409`. 운영자만 |
| `PUT /api/admin/ai/{game}/training` | 학습 기록 올리기. 본문은 `trainer/train.py`가 쓴 `snapshots.json` 그대로 → `{"training":{…}}`. 2 MB까지 (`413`), 모양이 틀리면 `422`. 같은 게임의 기록은 바뀝니다. 운영자만 |

AI 모델을 올리면(`PUT /api/admin/ai/{game}`) 그 게임의 열린 요청이 끝납니다(`done`).
학습 기록은 `{"format":1,"game":"…","version":"…","lang":"ko","minutes":60,"snapshots":[{"minute":10,"iteration":12,"selfplay":{"games":1200,"wins":[500,420],"draws":280,"cut":3,"moves":51000},"eval":{"random":{"first":[w,d,l],"second":[w,d,l]},"perfect":{…},"accuracy":{"policy":0.8,"search":0.95}},"games":[{"seed":1,"moves":[{"player":0,"action":{…}}],"winner":0,"reason":"result"}]}],"updated":"…","by":"…"}`입니다.
`selfplay`는 앞 스냅샷부터 그때까지의 자기대국(`draws`는 `cut`을 포함), `eval`은 그때까지의 마지막 평가이고 없으면 빠집니다 (`selfplay`는 학습 전이면 `null`).
`games`는 그때의 AI끼리 둔 판이고 `reason`은 `result`(게임이 끝냄), `maxActions`(행동 수 상한), `cut`(학습용 무승부 규칙: 같은 판 되풀이, `--max-moves`)입니다.
`updated`와 `by`는 서버가 붙입니다. 다시보기는 `/web/replay.html?training=<게임>&snap=<i>&n=<j>`입니다.

- `version`은 게임 코드 버전입니다. 게임 폴더의 `.js`, `.mjs` 파일(테스트와 `node_modules` 제외)을 `/`로 구분한 상대 경로 순으로
  "경로\0내용\0"씩 이어 SHA-256을 구하고 앞 16글자를 씁니다. 개발 서버와 Go 서버의 계산이 같아야 합니다.
  코드를 한 글자라도 고치면 바뀝니다. 대전할 때 서버에 같이 보내고, 기보에도 남습니다.
- `listing`은 등록 정보(이름, 소개, 룰북, 난이도, 지원 언어, 타이머)입니다. 등록 전이면 `null`입니다.
  보드 크기 같은 규칙 정보는 넣지 않습니다. 브라우저가 `module`을 import해서 게임 모듈에서 직접 읽습니다.
- `thumbnail`은 썸네일(`thumbnail.json`)입니다. 이미지가 아니라 혼자 두던 판을 그대로 찍은 데이터
  `{"board":{…},"pieces":"xo","player":0,"view":{"pieces":[…],"marks":[…]}}`이고, 화면이 보드 렌더러로 다시 그립니다.
  없거나 깨졌으면 `null`이고 화면은 시작 판을 그립니다. 모양은 [sdk/game.d.ts](../sdk/game.d.ts)의 `Thumbnail`입니다.
- `ai`는 그 게임의 AI 모델입니다. 없으면 빠집니다 ([trainer/README.md](../trainer/README.md#브라우저에서-ai와-두기)).
  `{"model":"/ai/tictactoe/<해시 16글자>.onnx","version":"3f1c…","lang":"en","rows":3,"cols":3,"channelNames":["piece:x","piece:o","mark:dot",…,"toPlay"],"specials":[],"nActions":9,"sims":200,"updated":"…"}`.
  `version`은 학습한 게임 코드 버전(모르면 `null`)이고, 관측과 행동의 모양(`rows`, `cols`, `channelNames`, `specials`, `nActions`)이
  지금 게임 코드와 같아야 화면이 "AI와 두기"를 보여 줍니다. `lang`은 학습할 때 `view()`에 준 언어, `sims`는 한 수마다 탐색 횟수입니다.
  `balance`는 학습 마지막 구간에 AI끼리 둔 판의 합계 `{"games":3072,"wins":[선공 승,후공 승],"draws":39,"cut":0,"from":49,"to":60}`이고,
  게임 창이 선공·후공 승률로 보여 줍니다. 이 기능 전에 내보낸 모델이면 빠집니다.
  모델 파일은 서버의 `DATA_DIR/ai/<게임>/`에 `model.json`과 함께 있습니다. 개발 서버도 같은 폴더에서 읽습니다.
- `PUT /api/games/<id>/thumbnail`: 개발 서버 전용. 플레이그라운드의 "Use as thumbnail"이 찍은 판을 `thumbnail.json`에 저장합니다.
  내 컴퓨터에서 온 JSON만 받고, 모양이 틀리면 `422 {"problems":[...]}`입니다.
- `PUT /api/games/<id>/listing`: 개발 서버 전용. 등록창이 등록 정보를 `games/<id>/listing.json`에 저장합니다.

### 게임 올리기 ([server/internal/upload](../server/internal/upload))

등록창이 `npx boardmadang pack`의 zip을 초안으로 올리고(`POST /api/drafts`), 실행기 안에서 자동 검사를 돌리고,
제작자가 직접 한 판을 이긴 뒤(클리어 체크) 등록합니다 (`POST /api/drafts/{draft}/publish`).
등록하면 바로 `/api/games`에 나오고, `module`은 `/uploads/<id>/<버전>/index.js`입니다.
개발 서버에는 이 API가 없어서 등록창은 `GET /api/uploads`가 404면 개발용(레포 게임의 등록 정보 고치기)으로 돕니다.

- zip 규칙: `.js`, `.mjs` 코드(합쳐서 256KB)와 맨 위의 `listing.json`, `thumbnail.json`만 받습니다. 맨 위에 `index.js`가 있어야 합니다.
  경로에는 영문자, 숫자, `_`, `-`, `.`만 쓰고 점으로 시작하는 이름(`..`, 숨김 파일)은 안 됩니다.
  모든 파일이 폴더 하나에 들어 있으면 그 폴더를 맨 위로 봅니다. macOS가 끼워 넣는 `__MACOSX/`, `.DS_Store`는 건너뜁니다.
  다른 JSON을 받지 않는 건 `version`이 `.js`, `.mjs`만 보기 때문입니다. 버전이 같은데 데이터가 다르면 두 플레이어의 판이 어긋납니다.
- 규칙에 맞지 않으면 `422 {"error":"problems","problems":[{"code":"file.badType","file":"notes.txt"}]}`입니다.
  코드: `zip.bad`, `zip.tooBig`(413), `zip.tooManyFiles`, `file.badName`, `file.badType`, `file.duplicate`, `file.tooBig`, `file.badJson`, `file.noIndex`, `code.tooBig`
- 등록할 때 등록 정보를 `listing.js`의 `validateListing`과 같은 규칙으로 다시 검사합니다 (`422`, 문제 코드는 등록창과 같음).
  썸네일은 등록창이 zip의 `thumbnail.json`이나 직접 찍은 판을 게임 코드와 맞는지 본 뒤 `thumbnail`로 보냅니다 (없으면 `null`).
  서버는 `validateThumbnail`과 같은 검사를 하고, 틀리면 `422 thumbnail.invalid`입니다.
- 클리어 체크 ([clear.go](../server/internal/upload/clear.go)): `clear`는 제작자가 등록창에서 혼자 양쪽을 둬서 `result()`가 승자를 정한 판입니다.
  `seed`, 상태를 바꾼 행동만 담은 `moves`(1~4,000개), 승자 `winner`(0 또는 1), 그 판을 둔 코드 `version`입니다.
  - 무승부, 기권, `maxActions` 도달은 클리어가 아닙니다. 등록창이 그런 판은 보내지 않습니다.
  - 새 게임이거나 버전이 바뀌었으면 꼭 있어야 합니다(`422 clear.missing`). 같은 버전을 다시 등록할 때는 `null`이면 전에 깬 판을 그대로 씁니다.
  - `version`이 초안과 다르면 `422 clear.version`, 모양이 틀리면 `422 clear.invalid`입니다.
  - 서버는 게임 코드를 돌리지 않으므로 정말 이긴 판인지는 모르고 모양만 봅니다. 재생해서 검증하는 건 공개한 뒤에 합니다.
  - `/api/games`의 항목에 `"clear":true`가 있으면 `GET /api/games/{id}/clear`로 받아 다시보기(`/web/replay.html?clear=<id>`)에서 봅니다.
- 같은 계정이 같은 id로 다시 등록하면 새 버전이 되고, 옛 버전 코드는 기보 다시보기를 위해 남깁니다. 같은 버전이면 등록 정보만 바뀝니다.
- 등록한 뒤에는 zip 없이 `PATCH /api/uploads/{id}`로 등록 정보만 고치거나 게임을 내립니다. 코드, 썸네일, 클리어 기보는 그대로입니다.
  화면은 내 프로필(`/web/history.html`)의 "내가 올린 게임"이고, 등록 정보 고치기는 등록 화면을 `/web/register.html?edit=<id>`로 엽니다.
  - 하루 등록 횟수에 세지 않고, 한 시간에 30번까지입니다 (`429 {"error":"too many"}`).
  - 내 게임이 아니면 `404`, 바꿀 것이 없으면 `400 {"error":"nothing to change"}`, 등록 정보가 틀리면 등록할 때와 같은 `422`입니다.
  - 내린 게임은 `/api/games`와 클리어 기보에서 빠집니다. 코드(`/uploads/…`)는 그대로 내보내서 이미 둔 대국의 기보는 계속 다시볼 수 있고,
    id도 그대로 주인의 것입니다. 다시 올리거나 새로 등록하면 다시 나옵니다.
- 실패: `409 {"error":"id taken"}` 레포 게임이거나 다른 계정이 올린 id, `400 {"error":"bad id"}` id 모양(영문 소문자, 숫자, `-`로 40자까지),
  `429 {"error":"too many"}` 하루 등록 5번 또는 한 시간에 초안 30번, `429 {"error":"too many new games"}` 새 게임은 하루 1개 (내 게임의 새 버전은 됨. 하루 제한은 운영자에게는 없음),
  `404` 초안이 없거나 남의 것이거나 하루가 지남
- 초안은 하루가 지나면 지우고, 계정마다 최근 3개만 남깁니다. 등록하면 그 초안은 없어집니다.
- 서버는 게임 코드를 돌리지 않습니다. 자동 검사는 올린 사람의 브라우저에서 돌므로 서버는 그 결과를 믿지 않습니다 ([architecture.md](architecture.md#보안)).
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
- 기보의 `version`이 지금 게임 코드와 다르면, 다시보기 화면은 올린 게임의 옛 버전 코드(`/uploads/<id>/<version>/index.js`)로 재생합니다.
  내린 게임도 같습니다. 옛 코드가 없는 레포 게임은 지금 코드로 재생하고 "판이 다르게 보일 수 있다"고 알립니다.
- `/api/locale`: 나라는 앞에 선 프록시가 넣어 주는 헤더에서 읽습니다. GCP 부하 분산기의 커스텀 요청 헤더
  `X-Client-Region: {client_region}`, 없으면 Cloudflare의 `CF-IPCountry`(모르는 나라인 `XX`는 빼고)입니다.
  KR이면 `ko`, 다른 나라면 `en`, 나라를 모르면 `Accept-Language`로 정합니다. 화면 언어 고르기에만 쓰므로
  헤더를 위조해도 문제 없습니다. 유저가 로비에서 직접 고른 언어가 있으면 브라우저가 이 요청보다 그걸 먼저 씁니다.
- `/api/me`: 게스트와 계정, 세션 쿠키는 [identity.md](identity.md)에 정리했습니다.
- 기보(`players`)와 의견(`author`)의 계정 이름은 남긴 때의 이름이 아니라 지금 이름입니다. 탈퇴한 계정은 `{"kind":"gone"}`(태그와 이름 없음)으로 옵니다.
- 정지된 계정은 의견 남기기, 신고, 별 달기, 게임 올리기와 등록, 등록 정보 고치기, 이름 바꾸기가 `403 {"error":"suspended"}`입니다 ([moderation.md](moderation.md#계정-정지)).
- `GET /api/uploads`의 게임에는 운영자가 내렸는지(`"blocked":true`)도 옵니다. 운영자가 내린 게임은 주인이 다시 올릴 수 없습니다.
  Go 서버는 서명한 쿠키로 신원을 정합니다. 개발 서버는 늘 같은 가짜 신원을 돌려주고, `DEV_AS=guest`로 게스트를 흉내 냅니다.
- `/api/games`, `/api/locale`은 개발 서버(`sdk/playground/serve.js`)와 Go 서버(`server/internal/site`)가 같은 모양으로 제공합니다.
  둔 판 수(`plays`), 출시일(`released`), 별 수(`stars`)는 기보와 올린 게임, 즐겨찾기가 있는 Go 서버에만 있습니다.
  Go 서버는 화면(`/web/`), 화면이 import하는 SDK 모듈(`/sdk/playground/`의 `board.js`, `listing.js`, `platform.js`), 게임 코드(`/games/`)도 내보냅니다.
  테스트 파일과 점으로 시작하는 파일은 내보내지 않습니다. 개발 서버에만 있는 것은 플레이그라운드 화면과 `PUT /api/games/<id>/listing`(등록창 저장), `PUT /api/games/<id>/thumbnail`(썸네일 저장)입니다.
  플레이그라운드는 게임 제작자가 자기 컴퓨터에서 쓰는 도구라 사이트의 메뉴와 버튼에는 없습니다.
- 검색 엔진이 읽을 페이지는 Go 서버에만 있습니다 ([server/internal/site/pages.go](../server/internal/site/pages.go)).
  로비는 스크립트가 게임 목록을 채우는 화면이라, 서버가 `listing.json`의 이름, 소개, 룰북을 HTML에 직접 넣은 페이지를 언어마다 따로 내줍니다.

  | 주소 | 내용 |
  |---|---|
  | `GET /ko/games/{id}`, `/en/games/{id}` | 게임 페이지: 룰북, 판 정보, 선공·후공 승률(AI가 있으면), 두러 가기. 등록 정보나 이름이 없는 게임은 `404` |
  | `GET /ko/make`, `/en/make` | 보드게임 만들기 소개와 게임 목록 |
  | `GET /ko/ai`, `/en/ai` | AI 상대 소개와 AI와 둘 수 있는 게임 목록 |
  | `GET /sitemap.xml` | 로비, 소개 페이지, 게임 페이지. 언어별 주소를 `xhtml:link`(hreflang, x-default는 영어)로 묶습니다. `games/private/`의 게임은 뺍니다 |
  | `GET /robots.txt` | `/auth/`, `/drafts/`, 운영자 화면만 막고 sitemap 주소를 알립니다 |

  페이지와 sitemap의 절대 주소는 `PUBLIC_URL`, 없으면 요청의 Host로 만듭니다. `/`는 `/web/`로 `301`입니다.
  개인 화면(`history.html`, `signup.html`, `training.html`, `admin.html`)은 HTML의 `<meta name="robots" content="noindex">`로 뺍니다.

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
  서버는 `seq`의 해시가 `seq - 1`과 같거나, 차례가 그대로인데 이번 차례에 이미 나온 해시면 그 행동이 무시됐다고 봅니다.
- 둔 수(차례가 넘어간 행동)가 `maxActions`에 이르면 클라이언트가 `result {winner: null, reason: "maxActions"}`를 보냅니다.
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
| `limit` | 행동 기록이 상한(5,000)에 닿음 → 무효 (`winner`는 `null`) |
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
| `suspended` | 정지된 계정이 `create`를 보냄. 빠른 매칭과 열린 방에 들어가기는 됩니다 |

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
