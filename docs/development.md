# 내 컴퓨터에서 실행하기

## Go 서버

```bash
cd server
go run ./cmd/server
```

```bash
curl http://localhost:8080/healthz
```

설정은 환경변수로 합니다. [.env.example](../.env.example)을 참고하세요.

Go 서버 하나가 화면까지 모두 보여줍니다. http://localhost:8080 을 열면 로비가 보이고, 대전, 로그인, 기보가 다 됩니다.
운영(boardmadang.com)도 이 서버 하나로 돌립니다 ([deploy-gcp.md](deploy-gcp.md)).

## 개발 서버 (Node)

개발 서버는 게임을 만들 때 씁니다. 게임 등록창의 저장(`games/<id>/listing.json`에 쓰기)은 아직 개발 서버에만 있습니다.
로비(게임 목록)와 [플레이그라운드](../sdk/README.ko.md#바로-시작하기)는 Go 서버 없이 개발 서버로 띄울 수 있습니다.

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

## 화면 주소

- 로비: http://localhost:5173
- 플레이그라운드: http://localhost:5173/sdk/playground/?game=tictactoe
- 게임 등록: http://localhost:5173/web/register.html (이름, 룰북, 난이도, 지원 언어, 타이머를 `games/<id>/listing.json`에 저장)
- 방 목록: http://localhost:5173/web/rooms.html (아래에 진행 중인 대국이 있고, 관전할 수 있습니다)
- 약관과 개인정보: http://localhost:5173/web/legal.html (주요 화면 아래의 바닥글에서 엽니다)
- 로그인: 상단의 로그인 버튼 (Google, GitHub). 켜는 법은 [identity.md](identity.md#소셜-로그인-켜기)에 있습니다.
  의견 남기기와 방 만들기는 계정만 됩니다. OAuth 앱 없이 시험하려면 Go 서버를 `DEV_LOGIN=1`로 켜고 "개발용 로그인"을 누릅니다.
- 내 프로필 (상단의 내 이름을 누름): http://localhost:5173/web/history.html. 내가 올린 게임(Go 서버만)과 내 대국이 있습니다.
  끝난 대국은 `server/data/`에 기보로 저장되고, 여기서 다시볼 수 있습니다.

로비는 `games/`와 `games/private/`에 있는 게임을 자동으로 보여줍니다. 카드의 '혼자 둬보기'는 플레이그라운드를,
'대전 찾기'는 대전 화면(`web/match.html`)을 열어 같은 타이머의 상대를 찾고, '방 만들기'는 방 목록에 방을 올립니다.

## 테스트

```bash
cd server && go vet ./... && go test ./...
node --test sdk/test/*.test.js sdk/playground/*.test.js games/*/*.test.js
```
