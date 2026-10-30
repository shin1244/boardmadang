# GCP 배포

## 리전: 서울(`asia-northeast3`) 하나면 충분합니다

턴제 보드게임은 지연 시간에 둔감합니다. 한 수에 수 초씩 생각하는 게임에서 왕복 수십~백여 ms
차이는 체감되지 않습니다. 해외 유저가 생겨도 리전을 늘릴 이유는 거의 없습니다.

> 비용이 중요하면: GCP 무료 등급의 `e2-micro` VM은 **미국 리전**(`us-west1`, `us-central1`,
> `us-east1`)에서만 무료입니다. 한국에서 미국 서부까지 왕복 지연은 대략 130~150ms인데,
> 턴제 게임에는 문제없는 수준입니다.

## 실행 환경 비교

서버가 **방 상태를 메모리에** 들고 있다는 점이 선택을 좌우합니다.

| | Compute Engine VM | Cloud Run |
|---|---|---|
| 웹소켓 | 제한 없음 | 지원하지만 **연결 하나가 최대 60분**에서 끊김 |
| 메모리 속 방 상태 | VM 하나면 그대로 유지 | 인스턴스가 여러 개 뜨면 방이 갈라짐 → 최대 인스턴스 1 필요 |
| 0으로 축소 | 안 됨 (항상 켜짐) | 됨 (접속이 없으면 비용 0, 대신 콜드 스타트) |
| HTTPS(`wss://`) | 직접 설정 (Caddy 같은 리버스 프록시) | 자동 |
| 난이도 | 서버 관리 필요 | 배포만 하면 됨 |

**MVP에는 VM 하나를 추천합니다.**
- Cloud Run은 웹소켓을 60분에 끊습니다. 끊긴 플레이어는 15초 안에 다시 붙으면 이어 두지만,
  긴 대국마다 한 번씩 끊겼다 붙는 게 보이고, 그 순간 새 인스턴스로 붙으면 방이 없어 집니다.
- 구성: `e2-small` VM 1대 (서울) + 컨테이너로 서버 실행 + Caddy로 HTTPS 자동 발급.

## 도메인과 HTTPS (boardmadang.com)

Go 서버 하나가 API, 웹소켓, 화면(`web/`), 게임 코드(`games/`), SDK(`sdk/`), `/api/games`, `/api/locale`을 모두 맡습니다
(`server/internal/site`). 등록창의 저장(`PUT /api/games/<id>/listing`)만 아직 개발 서버에 있어서, 운영에서는 저장이 404입니다.

1. **고정 IP**: VM에 고정 외부 IP를 예약해 붙입니다 (VPC 네트워크 → IP 주소 → 외부 고정 주소 예약).
2. **DNS**: 도메인을 산 곳(또는 Cloud DNS)에서 레코드를 넣습니다.

   | 이름 | 종류 | 값 |
   |---|---|---|
   | `boardmadang.com` (`@`) | A | VM의 고정 IP |
   | `www` | CNAME | `boardmadang.com` |

3. **HTTPS**: VM에서 Caddy가 인증서를 자동으로 받고 갱신합니다. 방화벽에서 80, 443을 열어 둡니다 (80은 인증서 발급에 씁니다).

   ```
   # /etc/caddy/Caddyfile
   boardmadang.com {
       reverse_proxy localhost:8080
   }
   www.boardmadang.com {
       redir https://boardmadang.com{uri} permanent
   }
   ```

   Caddy는 웹소켓을 그대로 넘기고, `X-Forwarded-Proto: https`를 붙여 줍니다. 서버는 이것을 보고 쿠키에 `Secure`를 붙입니다.
   Host도 그대로 넘기므로 웹소켓의 같은 출처 확인이 통과합니다 (`ALLOWED_ORIGINS`는 비워 둡니다).
4. **서버 환경변수**: `PUBLIC_URL=https://boardmadang.com`, `SESSION_SECRET`(32자 이상), `DATA_DIR`(영구 디스크),
   소셜 로그인 ID와 비밀값. `DEV_LOGIN`은 넣지 않습니다.
5. **소셜 로그인**: 운영용 OAuth 앱은 개발용과 따로 둡니다.
   - GitHub: 새 OAuth App. Homepage `https://boardmadang.com`, callback `https://boardmadang.com/auth/github/callback`
   - Google: 웹 클라이언트에 리디렉션 URI `https://boardmadang.com/auth/google/callback`을 더합니다.
     동의 화면(브랜딩)에 홈페이지, 개인정보처리방침 주소, 승인된 도메인 `boardmadang.com`을 넣고 앱을 게시해야
     테스트 사용자가 아닌 사람도 로그인할 수 있습니다. 도메인 소유 확인은 Google Search Console에서 합니다.

## 단일 인스턴스의 한계와 다음 단계

- **서버가 재시작되면 진행 중인 대국이 사라집니다.** MVP에서는 감수합니다.
  방이 메모리에만 있어서 15초 유예로도 이어지지 않습니다. 배포는 대국이 적은 시간에 합니다.
- 끝난 대국의 기보는 `DATA_DIR`(기본 `data`) 아래에 파일로 저장합니다. 한 판에 1KB 안팎이라 디스크 걱정은 거의 없습니다.
  VM의 영구 디스크에 두면 서버를 다시 켜도 남습니다. 백업은 디스크 스냅샷 일정으로 합니다.
- 서버를 여러 대로 늘리면 파일로는 안 됩니다. 그때 기보를 DB(Firestore, Cloud SQL 중 하나)나 Cloud Storage로 옮깁니다.
- 인스턴스를 여러 개 띄우려면 같은 게임의 대기열이 한곳에 모여야 합니다. 그때 매칭만 Redis 같은 공용 저장소로 옮깁니다.

## AI 학습 서버는 따로

학습은 실시간 대국과 무관한 일괄 작업이라 리전이 중요하지 않습니다.
GPU가 있고 싼 리전에서 **Spot VM**으로 돌리면 비용을 크게 줄일 수 있습니다.

## 컨테이너 빌드

레포 루트에서 빌드합니다. 이미지에 서버와 함께 `web/`, `sdk/`, `games/`가 `/site`로 들어갑니다.

```bash
docker build -t boardmadang .
docker run --rm -p 8080:8080 -v boardmadang-data:/data --env-file .env boardmadang
```

- http://localhost:8080 을 열면 로비가 보입니다.
- 기보와 계정은 컨테이너 안의 `/data`에 씁니다. 볼륨(`-v boardmadang-data:/data`)을 붙이지 않으면 컨테이너를 지울 때 같이 사라집니다.
- 게임을 더하거나 고치면 이미지를 다시 빌드합니다. `games/private/`는 깃허브에 올라가지 않으므로, 깨끗하게 클론한 곳에서 빌드하면 들어가지 않습니다.
- `.env`는 이미지에 넣지 않습니다 (`.dockerignore`). 비밀값은 실행할 때 `--env-file`이나 환경변수로 넘깁니다.
