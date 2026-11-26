# 데이터 분석

서버가 `DATA_DIR`에 남긴 파일(기보, 계정, 의견, 방문 기록 등)을 SQLite 파일 하나(`boardmadang.db`)로 옮겨 SQL로 분석합니다.
서버는 지금처럼 파일에 쓰고, 옮기는 도구([`server/cmd/dbexport`](../server/cmd/dbexport))는 그 파일을 읽기만 합니다.

| 파일 | 내용 |
|---|---|
| [`queries.sql`](queries.sql) | 분석 쿼리 예시 (DAU, 게임별 인기, 끝난 이유, 선공 승률, 리텐션 등) |
| [`server/cmd/dbexport/schema.sql`](../server/cmd/dbexport/schema.sql) | 표와 칸의 뜻 |
| `data/`, `*.tgz`, `*.db` | 받아 온 데이터와 만든 파일. 실제 이용자의 정보라 깃에 올라가지 않습니다 (`.gitignore`) |

## 1. 데이터 받아 오기

### 내 컴퓨터의 개발 서버 데이터로 해 보기

개발 서버(`cd server && go run ./cmd/server`)로 대국을 몇 판 두면 `server/data/`에 쌓입니다. 이것으로 먼저 해 볼 수 있습니다.
2단계로 건너뛰고 `-data`를 빼고 돌리면 됩니다.

### 운영 서버의 데이터

운영 VM의 `/var/lib/boardmadang`을 묶어 내려받습니다. 서버를 멈출 필요는 없습니다.
AI 모델, 올리다 만 초안, 방문 해시의 키(`stats/key`), 신고와 운영 기록은 분석에 쓰지 않으므로 빼고 묶습니다.
명령은 레포 루트에서 돌리고, 윈도우 PowerShell에서도 그대로 됩니다.

VM에서 묶기:

```bash
gcloud compute ssh boardmadang --project boardmadang --zone asia-northeast3-a --command 'sudo tar czf /tmp/boardmadang-data.tgz -C /var/lib/boardmadang --exclude=./ai --exclude=./drafts --exclude=./stats/key --exclude=./admin.jsonl --exclude=./reports.jsonl . && sudo chown $(id -un) /tmp/boardmadang-data.tgz'
```

내려받기:

```bash
gcloud compute scp boardmadang:/tmp/boardmadang-data.tgz analysis/ --project boardmadang --zone asia-northeast3-a
```

VM에 남은 묶음 지우기:

```bash
gcloud compute ssh boardmadang --project boardmadang --zone asia-northeast3-a --command 'rm /tmp/boardmadang-data.tgz'
```

풀기 (다시 받을 때는 예전 `analysis/data` 폴더를 먼저 지웁니다. 서버가 지운 파일이 남아 있지 않게):

```bash
mkdir analysis/data
```

```bash
tar xzf analysis/boardmadang-data.tgz -C analysis/data
```

## 2. SQLite 파일 만들기

```bash
cd server
go run ./cmd/dbexport -data ../analysis/data
```

`-data`를 빼면 개발 서버의 `server/data/`를 읽습니다. 결과는 `analysis/boardmadang.db`이고, 돌릴 때마다 새로 만듭니다.

```
../analysis/boardmadang.db를 만들었습니다.
  accounts       6줄
  matches        220줄
  ...
```

쓰다 멈춘 줄처럼 읽지 못한 것은 건너뛰고 끝에 알려 줍니다.

## 3. 열어 보기

- **DB Browser for SQLite** (https://sqlitebrowser.org, 무료): "데이터베이스 열기"로 `analysis/boardmadang.db`를 열고,
  "데이터 보기" 탭에서 표를 둘러보거나 "SQL 실행" 탭에 `queries.sql`의 쿼리를 하나씩 붙여 넣어 실행합니다.
- **sqlite3** 명령: `sqlite3 analysis/boardmadang.db` 뒤에 `.mode box`를 치고 쿼리를 붙여 넣습니다.
- **Python**: 표준 라이브러리 `sqlite3`로 열 수 있고, pandas가 있으면 `pd.read_sql("SELECT …", conn)`로 표를 받아 그래프를 그릴 수 있습니다.

## 4. 들어 있는 표

| 표 | 한 줄이 | 기간 |
|---|---|---|
| `games` | 게임 하나 (레포 게임, 올린 게임) | 전부 |
| `game_releases` | 올린 게임을 등록한 한 번 | 전부 |
| `accounts` | 계정 하나 (탈퇴한 계정은 없음) | 전부 |
| `matches` | 끝난 대국 하나 | 전부 (기보는 지우지 않음) |
| `match_players` | 대국에 앉은 사람 (대국마다 선공, 후공 두 줄) | 전부 |
| `match_actions` | 대국의 행동(클릭) 하나 | 전부 |
| `comments` | 게임 의견 하나 | 전부 |
| `stars` | 즐겨찾기 하나 | 지금 |
| `visits` | 그날 온 사람 하나 (누구인지 모르는 해시) | 최근 30일 |
| `daily_visits` | 하루의 DAU, MAU | 방문을 세기 시작한 날부터 |
| `ai_plays` | 하루, 게임 하나의 AI 대국 수 | 전부 |

시각은 모두 한국 시간이고, `day`는 한국 날짜입니다. 서버의 운영자 화면과 같은 기준입니다.
대국은 `counted = 1`로 거르면 무효, 행동 없음, 혼자 두 자리에 앉은 대국이 빠져 로비의 판 수와 같아집니다.

넣지 않는 것: 로그인한 곳의 사용자 번호(sub), 신고와 운영 기록, 쓴 사람이 지운 의견의 글, 게임 코드.

## 5. 사람이 적을 때 읽는 법

- **비율보다 사람 수를 봅니다.** 10명 중 1명이 10%p라서 "D1 리텐션 40%"보다 "새로 온 5명 중 2명이 다음 날 왔다"가 정확합니다.
- **사람별 활동표(`queries.sql`의 8번)를 자주 봅니다.** 한 번 두고 안 온 사람, 매일 오는 사람이 한눈에 보입니다.
- **선공 승률은 30판쯤부터 봅니다.** 그 전에는 우연으로 크게 흔들립니다.
- **리텐션은 기보로 봅니다(9번).** 기보는 지우지 않아서 30일보다 긴 기간도 볼 수 있습니다. 방문 기록(10번)은 30일만 남습니다.

## 6. 아직 볼 수 없는 것

지금 서버가 남기지 않아서 볼 수 없습니다. 필요하면 기록을 더합니다 (2단계).

- 빠른 매칭을 기다리다 그냥 나간 사람
- 방문만 하고 대국을 두지 않은 사람: 방문 해시와 대국의 사람 id를 일부러 잇지 않습니다
- 게스트가 계정을 만든 경우: 게스트 id(g_)와 계정 id(m_)가 이어지지 않습니다
- AI 대국을 누가 몇 판 뒀는지: 날마다, 게임마다 수만 셉니다
- 어디서(나라, 지역) 접속했는지: IP 주소를 모으지 않습니다

## 개인정보

`analysis/data/`, 받아 온 `.tgz`, 만든 `.db`에는 실제 이용자의 계정 이름과 대국 기록이 들어 있습니다.
내 컴퓨터에만 두고, 다 쓰면 지웁니다. 다른 사람에게 보여 줄 때는 쿼리로 모은 수만 보여 줍니다.
