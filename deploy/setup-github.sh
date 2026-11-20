#!/usr/bin/env bash
# GitHub Actions의 배포 버튼(.github/workflows/deploy.yml)이 GCP에 들어올 수 있게 처음 한 번 돌립니다 (docs/deploy-gcp.md).
# 레포 루트에서: deploy/setup-github.sh    이미 있는 것은 건너뛰므로 다시 돌려도 됩니다.
#
# 만드는 것
#   - 배포 서비스 계정 boardmadang-deploy: 이미지 올리기, 이 VM의 메타데이터 바꾸기, 배포 키 읽기만
#   - Workload Identity 풀 github: 이 레포의 main 브랜치에서 돈 워크플로만 위 계정으로 들어옵니다. 키 파일이나 GitHub 비밀값은 없습니다
#   - 배포용 SSH 키: 공개 키는 VM 메타데이터(사용자 deploy), 개인 키는 Secret Manager deploy-ssh-key. 화면에 나오지 않습니다
set -euo pipefail
cd "$(dirname "$0")/.."
. deploy/config.sh

g() { gcloud --project "$PROJECT" --quiet "$@"; }
exists() { g "$@" >/dev/null 2>&1; }
NUMBER=$(g projects describe "$PROJECT" --format 'value(projectNumber)')
PRINCIPALS="principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/$WIF_POOL/attribute.repository/$GITHUB_REPO"

echo "== API 켜기"
g services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

echo "== 배포 서비스 계정: $DEPLOY_SA"
exists iam service-accounts describe "$DEPLOY_SA_EMAIL" ||
  g iam service-accounts create "$DEPLOY_SA" --display-name "boardmadang deploy (GitHub Actions)"

echo "== Workload Identity 풀: $WIF_POOL ($GITHUB_REPO의 main만)"
exists iam workload-identity-pools describe "$WIF_POOL" --location global ||
  g iam workload-identity-pools create "$WIF_POOL" --location global --display-name "GitHub Actions"
exists iam workload-identity-pools providers describe "$WIF_POOL" --location global --workload-identity-pool "$WIF_POOL" ||
  g iam workload-identity-pools providers create-oidc "$WIF_POOL" --location global --workload-identity-pool "$WIF_POOL" \
    --display-name "GitHub Actions" --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref \
    --attribute-condition "assertion.repository_owner_id=='$GITHUB_OWNER_ID' && assertion.repository=='$GITHUB_REPO' && assertion.ref=='refs/heads/main'"

echo "== 배포용 SSH 키: $DEPLOY_KEY_SECRET"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if exists secrets describe "$DEPLOY_KEY_SECRET"; then
  g secrets versions access latest --secret "$DEPLOY_KEY_SECRET" >"$tmp/key"
  chmod 600 "$tmp/key"
  ssh-keygen -y -f "$tmp/key" >"$tmp/key.pub"
else
  ssh-keygen -q -t ed25519 -N '' -C "$DEPLOY_USER" -f "$tmp/key"
  g secrets create "$DEPLOY_KEY_SECRET" --data-file "$tmp/key" --replication-policy automatic
fi
read -r type body _ <"$tmp/key.pub"
entry="$DEPLOY_USER:$type $body $DEPLOY_USER"
g compute instances describe "$VM" --zone "$ZONE" \
  --format 'value(metadata.items.filter(key:ssh-keys).extract(value).flatten())' >"$tmp/ssh-keys"
if grep -qF "$type $body" "$tmp/ssh-keys"; then
  echo "   VM에 이미 있습니다"
else
  # 이 VM에만 붙는 키입니다. 프로젝트의 ssh-keys(gcloud compute ssh가 쓰는 것)는 그대로 둡니다
  { grep -v '^\s*$' "$tmp/ssh-keys" || true; echo "$entry"; } >"$tmp/ssh-keys.new"
  g compute instances add-metadata "$VM" --zone "$ZONE" --metadata-from-file ssh-keys="$tmp/ssh-keys.new"
fi

echo "== 권한 (이미지 올리기, 이 VM의 메타데이터, 배포 키 읽기)"
# 막 만든 계정은 권한을 붙일 수 있을 때까지 몇 초 걸립니다
member="serviceAccount:$DEPLOY_SA_EMAIL"
for try in 1 2 3 4 5 6; do
  if g iam service-accounts add-iam-policy-binding "$DEPLOY_SA_EMAIL" \
    --member "$PRINCIPALS" --role roles/iam.workloadIdentityUser >/dev/null &&
    g artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" \
      --member "$member" --role roles/artifactregistry.writer >/dev/null &&
    g compute instances add-iam-policy-binding "$VM" --zone "$ZONE" \
      --member "$member" --role roles/compute.instanceAdmin.v1 >/dev/null &&
    g iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
      --member "$member" --role roles/iam.serviceAccountUser >/dev/null &&
    g projects add-iam-policy-binding "$PROJECT" --condition None \
      --member "$member" --role roles/compute.viewer >/dev/null &&
    g secrets add-iam-policy-binding "$DEPLOY_KEY_SECRET" \
      --member "$member" --role roles/secretmanager.secretAccessor >/dev/null; then
    break
  fi
  [ "$try" = 6 ] && exit 1
  echo "   권한 붙이기 다시 시도 ($try)"
  sleep 5
done

echo
echo "끝났습니다. GitHub의 Actions 탭 → Deploy → Run workflow로 배포합니다."
echo "워크플로의 WIF_PROVIDER가 다음과 같은지 확인하세요:"
echo "  projects/$NUMBER/locations/global/workloadIdentityPools/$WIF_POOL/providers/$WIF_POOL"
