#!/usr/bin/env bash
# GCP에 보드마당을 처음 놓을 때 한 번 돌립니다 (docs/deploy-gcp.md). 이미 있는 것은 건너뛰므로 다시 돌려도 됩니다.
# 레포 루트에서: deploy/setup-gcp.sh    그다음 배포: deploy/deploy.sh
#
# 만드는 것: API, 이미지 저장소, VM 서비스 계정과 권한, 세션 비밀값, 고정 IP, 80·443 방화벽, 매일 디스크 스냅샷, VM
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh

g() { gcloud --project "$PROJECT" --quiet "$@"; }
exists() { g "$@" >/dev/null 2>&1; }

echo "== API 켜기"
g services enable compute.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com

echo "== 이미지 저장소: $REPO"
exists artifacts repositories describe "$REPO" --location "$REGION" ||
  g artifacts repositories create "$REPO" --repository-format docker --location "$REGION"

echo "== VM 서비스 계정: $SA (이미지 받기, 비밀값 읽기, 로그 쓰기만)"
exists iam service-accounts describe "$SA_EMAIL" ||
  g iam service-accounts create "$SA" --display-name "boardmadang VM"
# 막 만든 계정은 권한을 붙일 수 있을 때까지 몇 초 걸립니다
for try in 1 2 3 4 5 6; do
  if g artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
    --member "serviceAccount:$SA_EMAIL" --role roles/artifactregistry.reader >/dev/null &&
    g projects add-iam-policy-binding "$PROJECT" --condition None \
      --member "serviceAccount:$SA_EMAIL" --role roles/secretmanager.secretAccessor >/dev/null &&
    g projects add-iam-policy-binding "$PROJECT" --condition None \
      --member "serviceAccount:$SA_EMAIL" --role roles/logging.logWriter >/dev/null; then
    break
  fi
  [ "$try" = 6 ] && exit 1
  echo "   권한 붙이기 다시 시도 ($try)"
done

echo "== 세션 비밀값: session-secret (값은 화면에 보이지 않습니다)"
exists secrets describe session-secret ||
  openssl rand -base64 48 | tr -d '\n' | g secrets create session-secret --data-file=- --replication-policy automatic

echo "== 고정 IP: $IP_NAME"
exists compute addresses describe "$IP_NAME" --region "$REGION" ||
  g compute addresses create "$IP_NAME" --region "$REGION"
IP=$(g compute addresses describe "$IP_NAME" --region "$REGION" --format 'value(address)')

echo "== 방화벽: $FIREWALL (80은 인증서 발급과 https로 넘기기, 443은 사이트)"
exists compute firewall-rules describe "$FIREWALL" ||
  g compute firewall-rules create "$FIREWALL" --network default --source-ranges 0.0.0.0/0 \
    --allow tcp:80,tcp:443,udp:443 --target-tags "$TAG"

echo "== 매일 디스크 스냅샷: $SNAPSHOTS (한국 시간 새벽 4시, 14일 보관)"
exists compute resource-policies describe "$SNAPSHOTS" --region "$REGION" ||
  g compute resource-policies create snapshot-schedule "$SNAPSHOTS" --region "$REGION" \
    --daily-schedule --start-time 19:00 --max-retention-days 14 --on-source-disk-delete keep-auto-snapshots

echo "== VM: $VM ($MACHINE, $ZONE)"
exists compute instances describe "$VM" --zone "$ZONE" ||
  g compute instances create "$VM" --zone "$ZONE" --machine-type "$MACHINE" \
    --image-family debian-12 --image-project debian-cloud --boot-disk-size 10GB --boot-disk-type pd-balanced \
    --address "$IP" --tags "$TAG" --service-account "$SA_EMAIL" --scopes cloud-platform \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata-from-file startup-script=deploy/startup.sh
if ! g compute disks describe "$VM" --zone "$ZONE" --format 'value(resourcePolicies)' | grep -q "$SNAPSHOTS"; then
  g compute disks add-resource-policies "$VM" --zone "$ZONE" --resource-policies "$SNAPSHOTS"
fi

echo
echo "끝났습니다. 고정 IP: $IP"
echo "Cloudflare DNS에 A 레코드 boardmadang.com → $IP 를 DNS only(회색 구름)로 넣고, deploy/deploy.sh로 배포하세요."
