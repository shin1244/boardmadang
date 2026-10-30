# 기여하기

보드마당에 관심 가져 주셔서 고맙습니다. 버그 제보, 문서 수정, 예제 게임, 기능 제안 모두 환영합니다.

## 기여자 라이선스 동의서 (CLA)

풀 리퀘스트를 받기 전에 [CLA.md](CLA.md)에 서명을 받습니다. 처음 풀 리퀘스트를 열면 봇이 댓글로 안내하고,
아래 문장을 그 풀 리퀘스트에 그대로 댓글로 남기면 서명됩니다. 한 번 서명하면 다시 하지 않습니다.

```
I have read the CLA Document and I hereby sign the CLA
```

- **저작권은 기여자에게 그대로 남습니다.** 동의서는 관리자가 기여물을 AGPL·MIT 말고 다른 조건(상용 라이선스 포함)으로도
  배포할 수 있게 하는 라이선스입니다. 왜 필요한지는 [CLA.md](CLA.md)의 요약을 보세요.
- 풀 리퀘스트의 **모든 커밋 작성자**가 서명해야 합니다. 커밋 작성자 이메일이 GitHub 계정에 등록돼 있어야 봇이 알아봅니다
  (`git config user.email`을 GitHub에 등록한 이메일로).
- 보드마당 서비스에 **게임을 올리는 것**은 기여가 아니므로 서명할 필요가 없습니다. 게임의 라이선스는 제작자가 정합니다 ([LICENSING.md](LICENSING.md)).

## 풀 리퀘스트 전에

```bash
cd server && go vet ./... && go test ./...
node --test sdk/playground/*.test.js games/*/*.test.js
```

- 주변 코드와 같은 모양으로 씁니다. 주석과 문서는 한국어로, 쉬운 말로 씁니다.
- 동작이 바뀌면 `docs/`의 설계 문서도 같이 고칩니다.
- 화면 글자는 `web/i18n.js`에 한국어와 영어를 같이 넣습니다.

## 관리자 메모

CLA 봇(`.github/workflows/cla.yml`)은 기본 브랜치에 있어야 돌고, 서명을 `cla-signatures` 브랜치에 쌓습니다.
처음 한 번 그 브랜치를 만들어 둡니다.

```bash
git fetch origin
git push origin origin/<기본 브랜치>:refs/heads/cla-signatures
```

- 저장소 주인이 연 풀 리퀘스트는 검사하지 않습니다. 남의 커밋을 내 풀 리퀘스트로 가져올 때는 그 사람의 서명을 먼저 받아 둡니다
  (그 사람의 풀 리퀘스트에서 서명하게 하거나, 서명 기록을 확인).
- `cla-signatures` 브랜치의 기록은 지우거나 고치지 않습니다. 서명의 증거입니다.
