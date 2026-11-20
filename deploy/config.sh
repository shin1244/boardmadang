# deploy/ 스크립트가 같이 쓰는 값입니다 (docs/deploy-gcp.md).
# gcloud의 기본 프로젝트를 바꾸지 않고, 명령마다 --project로 넘깁니다.
PROJECT=boardmadang
REGION=asia-northeast3
ZONE=asia-northeast3-a
VM=boardmadang
MACHINE=e2-small
REPO=boardmadang # Artifact Registry 저장소
SA=boardmadang-vm
SA_EMAIL=$SA@$PROJECT.iam.gserviceaccount.com
IP_NAME=boardmadang-ip
FIREWALL=boardmadang-web
TAG=boardmadang-web
SNAPSHOTS=boardmadang-daily

# 배포 버튼(.github/workflows/deploy.yml)이 쓰는 것 (deploy/setup-github.sh). 바꾸면 워크플로의 env도 같이 바꿉니다.
GITHUB_REPO=shin1244/boardmadang
GITHUB_OWNER_ID=126842353 # 레포 이름을 바꾸거나 지운 뒤 남이 같은 이름을 가져가도 못 들어오게 주인 계정 번호도 봅니다
DEPLOY_SA=boardmadang-deploy
DEPLOY_SA_EMAIL=$DEPLOY_SA@$PROJECT.iam.gserviceaccount.com
WIF_POOL=github # Workload Identity 풀과 공급자 이름
DEPLOY_USER=deploy # 워크플로가 VM에 SSH로 들어갈 때의 사용자
DEPLOY_KEY_SECRET=deploy-ssh-key # 그 SSH 개인 키를 둔 Secret Manager 이름
