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

## 지금 구성 (`deploy/`)

GCP 프로젝트 `boardmadang`에 이렇게 놓았습니다. gcloud의 기본 프로젝트는 건드리지 않고, 스크립트가 명령마다 `--project boardmadang`을 붙입니다.

| 무엇 | 이름 | 설명 |
|---|---|---|
| VM | `boardmadang` | `e2-small`, `asia-northeast3-a`, Debian 12, 디스크 10GB |
| 고정 IP | `boardmadang-ip` | `34.64.41.206` |
| 방화벽 | `boardmadang-web` | 80, 443 (태그 `boardmadang-web`인 VM만) |
| 이미지 저장소 | Artifact Registry `boardmadang` | `asia-northeast3-docker.pkg.dev/boardmadang/boardmadang/server:<커밋>` |
| 비밀값 | Secret Manager | `session-secret`, 소셜 로그인을 켜면 `google-client-id` 등 |
| 백업 | 스냅샷 일정 `boardmadang-daily` | 매일 한국 시간 새벽 4시, 14일 보관 |
| VM 서비스 계정 | `boardmadang-vm` | 이미지 받기, 비밀값 읽기, 로그 쓰기만 |

운영에서는 Go 서버 하나가 화면(`web/`), 게임 코드(`games/`), `/api/games`, `/api/locale`까지 전부 맡습니다 (`server/internal/site`).
컨테이너 이미지에 같이 들어가므로 개발 서버(`sdk/playground/serve.js`)는 띄우지 않습니다.

- **처음 한 번**: `deploy/setup-gcp.sh`. 위의 것을 만듭니다. 이미 있는 것은 건너뜁니다.
- **배포**: 커밋한 뒤 `deploy/deploy.sh`. Cloud Build로 이미지를 만들고, VM 메타데이터 `bm-image`를 바꾼 뒤 SSH로 시작 스크립트를 다시 돌립니다.
  서버가 다시 켜지므로 진행 중인 대국은 사라집니다.
- **VM 안**: [deploy/startup.sh](../deploy/startup.sh)가 켤 때마다 돌며 Docker를 깔고, Secret Manager에서 `/etc/boardmadang/env`를 만들고,
  `app`(서버)과 `caddy`(HTTPS) 컨테이너를 띄웁니다. 기보, 계정, 의견은 `/var/lib/boardmadang`에 남습니다.
- **로그**: `gcloud compute ssh boardmadang --project boardmadang --zone asia-northeast3-a` 뒤에
  `sudo docker logs app`, `sudo docker logs caddy`, `sudo journalctl -u google-startup-scripts`.
- **비용** (대략): VM, 디스크, 고정 IP를 합해 한 달에 20달러 안팎입니다. 이미지 빌드는 Cloud Build 무료 사용량 안에 들어갑니다.

## 도메인과 HTTPS (boardmadang.com)

1. **고정 IP**: `setup-gcp.sh`가 예약해 VM에 붙였습니다 (`34.64.41.206`).
2. **DNS**: 도메인을 산 곳(또는 Cloud DNS)에서 레코드를 넣습니다.

   | 이름 | 종류 | 값 |
   |---|---|---|
   | `boardmadang.com` (`@`) | A | VM의 고정 IP |
   | `www` | CNAME | `boardmadang.com` |

   boardmadang.com의 DNS는 Cloudflare에 있습니다. 처음에는 두 레코드를 **DNS only**(회색 구름)로 넣어 Caddy가 인증서를 받게 합니다.
   나중에 프록시(주황 구름)를 켜려면 SSL/TLS 모드를 **Full (strict)**로 둡니다. 웹소켓도 그대로 지나가고,
   서버가 50초마다 핑을 보내므로 Cloudflare의 유휴 연결 제한(100초)에 걸리지 않습니다.
   프록시를 켜면 Cloudflare가 `CF-IPCountry`로 접속 나라를 알려 주고, `/api/locale`이 이것으로 화면 언어를 고릅니다.
   켜지 않으면 브라우저의 `Accept-Language`로 고릅니다 (GCP 부하 분산기의 `X-Client-Region`은 VM 구성에는 없습니다).

3. **HTTPS**: VM의 Caddy 컨테이너가 인증서를 자동으로 받고 갱신합니다. 방화벽에서 80, 443을 열어 두었습니다 (80은 인증서 발급에 씁니다).
   DNS를 넣기 전에는 발급에 실패하고 혼자 다시 시도합니다. DNS를 넣은 뒤 빨리 받으려면 VM에서 `sudo docker restart caddy`.
   설정은 `startup.sh`가 `/etc/boardmadang/Caddyfile`에 씁니다.

   ```
   boardmadang.com {
       reverse_proxy app:8080
   }
   www.boardmadang.com {
       redir https://boardmadang.com{uri} permanent
   }
   ```

   Caddy는 웹소켓을 그대로 넘기고, `X-Forwarded-Proto: https`를 붙여 줍니다. 서버는 이것을 보고 쿠키에 `Secure`를 붙입니다.
   Host도 그대로 넘기므로 웹소켓의 같은 출처 확인이 통과합니다 (`ALLOWED_ORIGINS`는 비워 둡니다).
4. **서버 환경변수**: `startup.sh`가 `PUBLIC_URL=https://boardmadang.com`과 Secret Manager의 비밀값으로 만듭니다.
   `DATA_DIR`, `SITE_DIR`은 이미지에 정해져 있습니다. `DEV_LOGIN`은 넣지 않습니다.
5. **소셜 로그인**: 운영용 OAuth 앱은 개발용과 따로 둡니다.
   - GitHub: 새 OAuth App. Homepage `https://boardmadang.com`, callback `https://boardmadang.com/auth/github/callback`
   - Google: 웹 클라이언트에 리디렉션 URI `https://boardmadang.com/auth/google/callback`을 더합니다.
     동의 화면(브랜딩)에 홈페이지, 개인정보처리방침 주소, 승인된 도메인 `boardmadang.com`을 넣고 앱을 게시해야
     테스트 사용자가 아닌 사람도 로그인할 수 있습니다. 도메인 소유 확인은 Google Search Console에서 합니다.

   만든 ID와 비밀값을 Secret Manager에 넣고 `deploy/deploy.sh`로 다시 배포하면 켜집니다.
   명령마다 값을 붙여 넣고 Enter, 그다음 Ctrl+D(윈도우 명령 프롬프트는 Ctrl+Z, Enter)로 끝냅니다.

   ```bash
   gcloud secrets create github-client-id --project boardmadang --data-file=-
   gcloud secrets create github-client-secret --project boardmadang --data-file=-
   gcloud secrets create google-client-id --project boardmadang --data-file=-
   gcloud secrets create google-client-secret --project boardmadang --data-file=-
   ```

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

레포 루트에서 빌드합니다. 서버와 함께 화면, SDK 모듈, 게임 코드가 이미지의 `/site`(`SITE_DIR`)에 들어갑니다.

```bash
docker build -t boardmadang .
docker run --rm -p 8080:8080 -v boardmadang-data:/data boardmadang
```

http://localhost:8080 에서 로비가 뜹니다.

- 기보는 컨테이너 안의 `/data`에 씁니다. 볼륨(`-v boardmadang-data:/data`)을 붙이지 않으면 컨테이너를 지울 때 같이 사라집니다.
- 비공개 게임(`games/private/`), `.env`, 개발 중에 쌓인 `server/data/`는 `.dockerignore`로 빼서 이미지에 들어가지 않습니다.
  비공개 게임을 이미지에 넣으면 사이트에서 누구나 그 코드를 받아 갈 수 있습니다.
