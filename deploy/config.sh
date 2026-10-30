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
