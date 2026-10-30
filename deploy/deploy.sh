#!/usr/bin/env bash
# 지금 커밋을 이미지로 만들어 VM에 올립니다 (docs/deploy-gcp.md). 레포 루트에서: deploy/deploy.sh
# 서버가 다시 켜지므로 진행 중인 대국은 사라집니다. 대국이 적은 시간에 합니다.
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh

if [ -n "$(git status --porcelain)" ]; then
  echo "커밋하지 않은 변경이 있습니다. 올린 이미지가 어느 커밋인지 알 수 있게 먼저 커밋하세요." >&2
  exit 1
fi
IMAGE=$REGION-docker.pkg.dev/$PROJECT/$REPO/server:$(git rev-parse --short=12 HEAD)

echo "== 이미지 빌드: $IMAGE"
gcloud builds submit --project "$PROJECT" --region "$REGION" --tag "$IMAGE" .

echo "== VM에 배포: $VM"
gcloud compute instances add-metadata "$VM" --project "$PROJECT" --zone "$ZONE" \
  --metadata "bm-image=$IMAGE" --metadata-from-file startup-script=deploy/startup.sh
gcloud compute ssh "$VM" --project "$PROJECT" --zone "$ZONE" --quiet \
  --command 'sudo google_metadata_script_runner startup && curl -sf http://127.0.0.1:8080/healthz && echo " ← 서버 응답"'
