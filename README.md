# 보드마당 (boardmadang)

직접 만든 **1대1 격자 보드게임**을 올리면, 바로 온라인 대전을 할 수 있고
**AI 상대까지 자동으로 학습**되는 플랫폼입니다.

제작자는 게임 규칙만 씁니다. 보드 그리기, 매칭, 네트워크, 화면 뒤집기,
AI 학습은 전부 플랫폼이 합니다.

> 지금은 초기 단계입니다. 게스트 신원, Google·GitHub 로그인, 매칭, 행동 중계, 기보 저장까지 동작합니다.

## 핵심 아이디어

```
A가 클릭 → 플랫폼이 (row, col)로 변환 → 서버는 순번만 붙여 양쪽에 그대로 전달
→ 양쪽 브라우저가 같은 게임 로직에 같은 클릭을 같은 순서로 넣음 → 같은 결과
```

서버는 **게임 규칙을 하나도 모릅니다** (락스텝 방식).
자세한 설계는 [docs/architecture.md](docs/architecture.md)를 보세요.

## 게임 제작 규칙

| # | 규칙 | 이유 |
|---|---|---|
| 1 | **마우스만** 사용합니다 | 모든 입력이 "클릭 좌표"로 통일됩니다 |
| 2 | **격자 보드**만 됩니다. 칸(`cells`)이나 교차점(`points`)에 두고, 크기는 제작자가 정합니다 | 플랫폼이 보드를 대신 그립니다 |
| 3 | 플랫폼은 **좌표만 전달**하고, 좌표의 의미는 제작자의 로직이 정합니다 | 서버가 규칙을 몰라도 됩니다 |
| 4 | 로직은 **결정적**이어야 합니다. 랜덤은 플랫폼이 준 `rng`만 씁니다 | 양쪽 화면이 어긋나지 않습니다 |
| 5 | **완전정보 게임**만 됩니다 (숨겨진 패, 주사위 없음) | 양쪽 브라우저가 전체 상태를 갖기 때문입니다 |
| 6 | 로직은 **순수 함수**입니다. 화면, 네트워크, 저장소에 접근할 수 없습니다 | 업로드된 코드를 Web Worker에 가둡니다 |
| 7 | **최대 행동 수**(`maxActions`)가 있어야 합니다. 상태를 바꾼 행동만 셉니다 | 게임이 반드시 끝나야 AI 학습이 됩니다 |

게임 API 명세는 [sdk/README.md](sdk/README.md)에 있습니다.

## 폴더 구조

```
server/    Go 백엔드: 매칭, 클릭 중계, 결과 기록          (AGPL-3.0)
sdk/       게임 API 명세와 타입, 나중에 로컬 실행기         (MIT)
games/     예제 게임: 틱택토, 바둑, 체스                    (MIT)
trainer/   (예정) AlphaZero 방식 AI 학습 파이프라인
docs/      설계 문서
web/       프론트엔드: 로비(게임 목록), 게임 등록창, 대전 화면         (AGPL-3.0)
```

## 실행

```bash
cd server
go run ./cmd/server
```

```bash
curl http://localhost:8080/healthz
```

Go 서버는 화면과 게임 코드도 내보내므로, 운영과 같은 모양 그대로 http://localhost:8080 에서 로비와 대전이 됩니다.
게임 등록창의 저장(`PUT /api/games/<id>/listing`)만 아래의 개발 서버에서 됩니다.

설정은 환경변수로 합니다. [.env.example](.env.example)을 참고하세요.

로비(게임 목록)와 [플레이그라운드](sdk/README.md#내-컴퓨터에서-돌려보기-플레이그라운드)는 Go 서버 없이 개발 서버로 띄웁니다.

```bash
node sdk/playground/serve.js
```

온라인 대전까지 해보려면 Go 서버를 같이 켭니다. 개발 서버가 `/ws`와 `/api/me`를 Go 서버로 넘기므로
브라우저는 http://localhost:5173 하나만 씁니다. 같은 브라우저의 탭 두 개로 대전 찾기를 누르면 서로 매칭됩니다.

```bash
cd server && go run ./cmd/server
```

8080 포트를 다른 프로그램이 쓰고 있으면 Go 서버의 포트를 바꾸고 개발 서버에 알려줍니다.

```bash
cd server && PORT=8081 go run ./cmd/server
```

```bash
GO_SERVER=http://localhost:8081 node sdk/playground/serve.js
```

- 로비: http://localhost:5173
- 플레이그라운드: http://localhost:5173/sdk/playground/?game=tictactoe
- 게임 등록: http://localhost:5173/web/register.html (이름, 룰북, 난이도, 지원 언어, 타이머를 `games/<id>/listing.json`에 저장)
- 방 목록: http://localhost:5173/web/rooms.html (아래에 진행 중인 대국이 있고, 관전할 수 있습니다)
- 로그인: 상단의 로그인 버튼 (Google, GitHub). 켜는 법은 [docs/identity.md](docs/identity.md#소셜-로그인-켜기)에 있습니다.
  의견 남기기와 방 만들기는 계정만 됩니다. OAuth 앱 없이 시험하려면 Go 서버를 `DEV_LOGIN=1`로 켜고 "개발용 로그인"을 누릅니다.
- 내 대국 (상단의 내 이름을 누름): http://localhost:5173/web/history.html. 끝난 대국은 `server/data/`에 기보로 저장되고, 여기서 다시볼 수 있습니다.

로비는 `games/`와 `games/private/`에 있는 게임을 자동으로 보여줍니다. 카드의 '혼자 둬보기'는 플레이그라운드를,
'대전 찾기'는 대전 화면(`web/match.html`)을 열어 같은 타이머의 상대를 찾고, '방 만들기'는 방 목록에 방을 올립니다.

## 라이선스

- `sdk/`, `games/`: **MIT** — 게임 제작자가 제약 없이 씁니다.
- 그 외 전부(`server/`, `web/`, 앞으로의 `trainer/`): **AGPL-3.0** — 수정해서 서비스로 운영하면 수정본도 공개해야 합니다.

**올린 게임은 AGPL이 되지 않습니다.** 게임의 라이선스는 제작자가 정하며, 이를 AGPL 7조의
추가 허가로 명시해 두었습니다. 자세한 내용은 [LICENSING.md](LICENSING.md)를 보세요.

기여하기 전에 [기여자 라이선스 동의서(CLA)](CLA.md)에 서명을 받습니다. 저작권은 기여자에게 남습니다.
자세한 내용은 [CONTRIBUTING.md](CONTRIBUTING.md)를 보세요.
