#!/bin/bash
# 보드마당 VM의 시작 스크립트입니다 (docs/deploy-gcp.md). VM 메타데이터 startup-script로 들어갑니다.
# VM을 켤 때마다 돌고, 배포할 때 deploy.sh가 다시 돌립니다. 여러 번 돌려도 같은 결과가 되게 씁니다.
#
#   1. Docker가 없으면 설치
#   2. Secret Manager의 비밀값으로 서버 환경변수 파일(/etc/boardmadang/env)을 만듦
#   3. 메타데이터 bm-image의 서버 이미지를 받아 app 컨테이너를 다시 띄움
#   4. Caddy(HTTPS) 컨테이너가 없거나 설정이 바뀌었으면 다시 띄움
#
# 로그: sudo journalctl -u google-startup-scripts
set -euo pipefail

DOMAIN=boardmadang.com
CADDY_IMAGE=caddy:2.10
CONF=/etc/boardmadang
DATA=/var/lib/boardmadang # 기보, 계정, 의견 (DATA_DIR). 디스크 스냅샷으로 백업됩니다

meta() {
  curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"
}
PROJECT=$(meta project/project-id)
IMAGE=$(meta instance/attributes/bm-image || true)

if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y docker.io
fi

install -d -m 700 "$CONF"
install -d -o 65532 -g 65532 "$DATA" # 컨테이너 안의 nonroot 사용자가 씁니다

# 비밀값. SESSION_SECRET은 꼭 있어야 하고, 소셜 로그인은 넣어 둔 것만 켜집니다.
# Secret Manager의 이름은 환경변수 이름을 소문자와 -로 바꾼 것입니다 (GITHUB_CLIENT_ID → github-client-id).
{
  echo "PUBLIC_URL=https://$DOMAIN"
  for name in SESSION_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET; do
    secret=$(echo "$name" | tr 'A-Z_' 'a-z-')
    if value=$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT" 2>/dev/null); then
      echo "$name=$value"
    elif [ "$name" = SESSION_SECRET ]; then
      echo "Secret Manager에 $secret 가 없습니다 (deploy/setup-gcp.sh)" >&2
      exit 1
    fi
  done
} >"$CONF/env.new"
chmod 600 "$CONF/env.new"
mv "$CONF/env.new" "$CONF/env"

# Caddy가 인증서를 받고 app으로 넘깁니다. Host와 X-Forwarded-Proto: https를 그대로 넘겨 쿠키의 Secure와 웹소켓 출처 확인이 맞습니다.
cat >"$CONF/Caddyfile.new" <<EOF
$DOMAIN {
	reverse_proxy app:8080
}
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
EOF

docker network inspect bm >/dev/null 2>&1 || docker network create bm

if [ -n "$IMAGE" ]; then
  gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://${IMAGE%%/*}"
  docker pull "$IMAGE"
  # SIGTERM으로 끝내야 서버가 쓰는 중인 기보를 마저 씁니다
  docker stop -t 15 app >/dev/null 2>&1 || true
  docker rm app >/dev/null 2>&1 || true
  docker run -d --name app --network bm --restart unless-stopped \
    --env-file "$CONF/env" -v "$DATA:/data" -p 127.0.0.1:8080:8080 \
    --log-opt max-size=10m --log-opt max-file=5 \
    "$IMAGE"
else
  echo "메타데이터 bm-image가 없어 서버는 띄우지 않습니다 (deploy/deploy.sh로 배포)" >&2
fi

if cmp -s "$CONF/Caddyfile.new" "$CONF/Caddyfile" && [ "$(docker inspect -f '{{.State.Running}}' caddy 2>/dev/null)" = true ]; then
  rm "$CONF/Caddyfile.new"
else
  mv "$CONF/Caddyfile.new" "$CONF/Caddyfile"
  docker rm -f caddy >/dev/null 2>&1 || true
  docker run -d --name caddy --network bm --restart unless-stopped \
    -p 80:80 -p 443:443 -p 443:443/udp \
    -v "$CONF/Caddyfile:/etc/caddy/Caddyfile:ro" -v caddy_data:/data -v caddy_config:/config \
    --log-opt max-size=10m --log-opt max-file=5 \
    "$CADDY_IMAGE"
fi

# 컨테이너가 쓰지 않는 옛 이미지를 지워 디스크가 차지 않게 합니다
docker image prune -af >/dev/null
