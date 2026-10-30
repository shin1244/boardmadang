# 플레이어 신원 (게스트와 계정)

| | 게스트 | 계정 |
|---|---|---|
| 만드는 법 | 사이트에 처음 들어오면 서버가 자동으로 발급 | Google 또는 GitHub로 로그인 (카카오는 예정) |
| 대전 참여 (빠른 매칭, 열린 방에 들어가기), 관전 | 됨 | 됨 |
| 방 만들기 (방 목록에 올리기) | **안 됨** | 됨 |
| 의견 남기기, 신고 | **안 됨** (예전에 남긴 내 의견 지우기는 됨) | 됨 |
| 게임 업로드·등록 정보 수정 | **안 됨** | 됨 (자기 게임만) |
| 랭킹 | 정하지 않음 | 됨 (예정) |

로그인이 없어도 대전하려면 서버가 "이 연결이 누구인지"는 알아야 합니다. 그래서 신원을 먼저 만들고,
로그인은 이 구조에 붙였습니다. 로그인은 "게스트를 계정으로 바꾸는 일"입니다.

## 모양

모든 플레이어는 같은 모양입니다. 게스트도 계정도 서버 코드에서는 `identity.User` 하나로 다룹니다.

```json
{ "id": "g_5kq2v7x9m3a1c8d4e6f0", "kind": "guest", "tag": "4821" }
{ "id": "m_…", "kind": "member", "name": "shin", "tag": "0193" }
```

| 필드 | 뜻 |
|---|---|
| `id` | 바뀌지 않는 고유 번호. 게스트는 `g_`, 계정은 `m_`로 시작합니다. 기록(대국, 업로드)은 이 값으로 남깁니다 |
| `kind` | `guest` 또는 `member` |
| `tag` | id에서 계산한 네 자리 숫자. 이름이 같은 사람을 구분하고, 게스트는 화면에 "게스트 4821"로 나옵니다 |
| `name` | 계정만. 게스트 이름은 화면 언어로 브라우저가 만듭니다 ("게스트 4821" / "Guest 4821") |

계정 이름은 처음 로그인할 때 사람이 직접 정합니다 (`/web/signup.html`). 이름 칸의 기본값은 GitHub 아이디(`login`)나
Google 이름(`given_name`, 성은 뺍니다)입니다. 로그인한 곳에서 이름을 바꿔도 여기 이름은 그대로입니다 (이름 바꾸기는 예정).

- 2~12글자. 글자(한글, 영문 등), 숫자, `_` `-` `.`만 됩니다. 띄어쓰기와 이모지는 안 됩니다.
- 운영자나 게스트를 사칭할 수 있는 말(`admin`, `moderator`, `official`, `boardmadang`, `guest`, 운영자, 관리자, 보드마당, 공식, 게스트)이
  들어가면 안 됩니다. 대소문자를 가리지 않습니다.
- 같은 이름이 있어도 됩니다.

## 세션 토큰

서버는 게스트를 저장하지 않습니다. 대신 서명한 토큰을 쿠키로 줍니다.

```
bm_session = v1.<내용 base64url>.<서명 base64url>
내용 = {"id":"g_…","kind":"guest","iat":1793345000}
서명 = HMAC-SHA256(SESSION_SECRET, "v1." + 내용)
```

- **계정 토큰도 같은 모양**입니다 (`"kind":"member"`). 이름은 토큰에 넣지 않고, 확인할 때마다 계정 저장소에서 읽습니다.
  저장소에 없는 계정의 토큰은 받지 않습니다.
- **위조 불가**: 서명 비밀값(`SESSION_SECRET`)은 서버만 압니다. 내용을 바꾸면 서명이 맞지 않아 새 게스트로 취급합니다.
- **쿠키 설정**: `HttpOnly`(게임 코드나 스크립트가 못 읽음), `SameSite=Lax`, HTTPS면 `Secure`, 180일.
  `/api/me`를 부를 때마다 다시 발급해서, 자주 오는 게스트는 만료되지 않습니다.
- **비밀값이 없으면**: 서버가 시작할 때 임시 비밀값을 만들고 경고를 남깁니다. 개발용입니다.
  서버를 다시 켜면 모든 게스트가 새 게스트가 됩니다. 운영에서는 반드시 환경변수로 넣습니다.
- 게스트는 쿠키를 지우면 사라집니다. 게스트 기록은 그 사람에게 다시 연결할 방법이 없습니다.

## 어디서 쓰나

| 곳 | 하는 일 |
|---|---|
| `GET /api/me` | 쿠키가 없거나 깨졌으면 새 게스트를 발급하고, 지금 신원을 돌려줍니다. 브라우저는 페이지를 열 때 한 번 부릅니다 |
| `GET /api/auth/providers` | 켜진 로그인 방법 `{"providers":["google","github"]}`. 비었으면 로그인 버튼이 "준비 중"입니다 |
| `GET /auth/{google\|github}?next=/web/…` | 로그인 시작. 그곳의 로그인 화면으로 보냅니다 |
| `GET /auth/{google\|github}/callback` | 그곳에서 돌아오는 주소. 계정을 찾거나 만들고 쿠키를 계정 토큰으로 바꾼 뒤 `next`로 돌려보냅니다 |
| `POST /auth/logout` | 쿠키를 지웁니다. 다음 `/api/me`에서 새 게스트가 됩니다 |
| `GET /ws` | 쿠키에서 신원을 읽습니다. 없으면 `401`. 브라우저는 `/api/me`를 먼저 불러 쿠키를 받아 둡니다 |
| `matched` 메시지 | 상대의 `kind`, `tag`, `name`만 보냅니다. **`id`는 보내지 않습니다** (다른 사람의 신원 토큰을 만들 수는 없지만, 기록을 추적하는 데 쓰일 수 있어서) |
| 업로드·등록 정보 저장 | 계정만 됩니다. 게스트면 `403 {"error":"member only"}` |
| `POST /api/games/{game}/comments`, `POST /api/reports` | 의견 남기기와 신고는 계정만 됩니다. 게스트면 `403 {"error":"member only"}` |
| `create` 메시지 (방 만들기) | 계정만 됩니다. 게스트면 `{"type":"error","message":"member only"}` |

## 소셜 로그인

OAuth 2.0 authorization code 방식입니다 (`server/internal/auth`). 외부 라이브러리 없이 표준 라이브러리로 씁니다.

1. 로그인 버튼 → `GET /auth/github?next=<지금 화면>`. 서버가 무작위 `state`를 만들어 `bm_oauth` 쿠키
   (`Path=/auth/`, 10분, `HttpOnly`)에 넣고 GitHub 로그인 화면으로 보냅니다.
2. GitHub이 `/auth/github/callback?code=…&state=…`로 돌려보냅니다. 쿠키의 `state`와 주소의 `state`가 같아야 합니다
   (다른 사이트가 남의 계정으로 로그인시키는 것을 막습니다). 쿠키는 한 번 쓰고 지웁니다.
3. `code`를 토큰으로 바꾸고, 그 토큰으로 사용자 번호(GitHub `id`, Google `sub`)와 이름만 읽습니다. 토큰은 저장하지 않습니다.
4. (로그인한 곳, 사용자 번호)로 계정을 찾습니다. 있으면 5로 갑니다.
   처음 온 사람이면 가입 정보(로그인한 곳, 사용자 번호, 이름 기본값, `next`)를 서명해 `bm_signup` 쿠키
   (`Path=/auth/`, 30분, `HttpOnly`)에 넣고 이름을 정하는 화면(`/web/signup.html`)으로 보냅니다.
   화면은 `GET /auth/signup`으로 기본값을 받고, `POST /auth/signup {"name":"…"}`로 계정(`m_…`)을 만듭니다.
   이름이 규칙에 맞지 않으면 `400 {"error":"name length" | "name chars" | "name reserved"}`, 쿠키가 없거나 시간이 지났으면
   `401 {"error":"expired"}`입니다. 계정은 `DATA_DIR/accounts.jsonl`에 남깁니다. 비밀번호, 이메일, 토큰은 저장하지 않습니다.
5. 쓰던 쿠키가 게스트면 그 게스트로 둔 대국을 계정으로 옮깁니다. 기보의 자리를 계정으로 바꾸고,
   게스트의 대국 목록을 계정의 목록에 끝난 순서대로 합칩니다. 의견(`comments`)은 옮기지 않습니다.
6. 쿠키를 계정 토큰으로 바꾸고 `next`로 돌려보냅니다 (가입했으면 화면이 `next`로 갑니다). `next`는 이 사이트 안의 경로만 받습니다.

실패하면 `next`에 `?login_error=<이유>`를 붙여 돌려보내고, 화면이 로그인 메뉴에 이유를 보여줍니다.

| 이유 | 뜻 |
|---|---|
| `cancelled` | 그곳에서 사용자가 취소함 |
| `expired` | `bm_oauth` 쿠키가 없음 (10분이 지났거나 다른 브라우저에서 돌아옴) |
| `state` | `state`가 맞지 않음 |
| `provider` | 토큰이나 사용자 정보를 받지 못함 |
| `server` | 계정 저장 실패 |

**같은 사람이 Google과 GitHub로 따로 로그인하면 계정이 둘 생깁니다.** 이메일이 같다고 합치지 않습니다.
로그인한 곳마다 이메일 확인 여부가 달라서, 남의 이메일로 만든 계정이 내 계정을 가져갈 수 있기 때문입니다.

### 소셜 로그인 켜기

ID와 비밀값이 둘 다 있는 곳만 켜집니다 (`.env.example`). 하나도 없으면 로그인 버튼이 "준비 중"으로 보이고 게스트로만 들어옵니다.

| | 만드는 곳 | 돌아올 주소 |
|---|---|---|
| Google | [Google Cloud 콘솔 → 사용자 인증 정보](https://console.cloud.google.com/apis/credentials) → OAuth 클라이언트 ID (웹 애플리케이션). 처음이면 OAuth 동의 화면부터 만듭니다 | `<PUBLIC_URL>/auth/google/callback` |
| GitHub | [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) → New OAuth App | `<PUBLIC_URL>/auth/github/callback` |

```bash
PUBLIC_URL=https://boardmadang.com \
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… \
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… \
go run ./cmd/server
```

개발할 때는 개발 서버(`node sdk/playground/serve.js`)가 `/auth/…`를 Go 서버로 넘기므로 돌아올 주소를
`http://localhost:5173/auth/<google|github>/callback`으로 등록하고 `PUBLIC_URL=http://localhost:5173`을 넣습니다.
GitHub OAuth App은 돌아올 주소를 하나만 받으므로 개발용 앱을 따로 만듭니다.

OAuth 앱 없이 계정 기능(의견, 방 만들기)을 시험하려면 Go 서버를 `DEV_LOGIN=1`로 켭니다. 로그인 메뉴에
"개발용 로그인"이 생기고, 누르면 바로 `dev` 계정으로 들어옵니다. **운영에서는 절대 켜지 않습니다** (누구나 같은 계정으로 들어옵니다).

## 아직 하지 않은 것

- 로그아웃은 이 브라우저의 쿠키만 지웁니다. 다른 기기의 토큰까지 끊는 "모든 기기에서 로그아웃"과 강제 만료는
  계정마다 "이 시각 이전 토큰은 거절"을 두어 붙입니다.
- 로그인한 상태에서 다른 로그인 방법 연결하기, 이름 바꾸기, 탈퇴
- 게스트로 남긴 의견을 계정으로 옮기기

## 아직 정하지 않은 것

- 게스트 대국을 랭킹에 넣을지
- 게스트 대국 기록을 얼마나 보관할지
