# 라이선스 안내

## 폴더별 라이선스

| 폴더 | 라이선스 | 뜻 |
|---|---|---|
| `sdk/` | MIT | 게임 API 규격. 누구나 제약 없이 씁니다 |
| `games/` | MIT | 예제 게임. 복사해서 내 게임의 출발점으로 써도 됩니다 |
| 그 외 전부 (`server/`, 앞으로의 `web/`, `trainer/`) | AGPL-3.0 ([LICENSE](LICENSE)) | 플랫폼을 수정해서 서비스로 운영하면 수정본도 공개해야 합니다 |

## 내가 올린 게임도 AGPL이 되나요?

**아니요.** 올린 게임의 라이선스는 제작자가 정합니다.

- 게임은 MIT인 `sdk/`의 규격만 따르고, 플랫폼 코드를 가져다 쓰지 않습니다.
- 게임은 플랫폼과 분리된 Web Worker에서 실행되고, JSON 메시지로만 대화합니다.
- AGPL의 의무는 **플랫폼 코드를 수정해서 서비스하는 사람**에게만 생깁니다.
  게임을 올리는 사람과 게임을 하는 사람은 아무 의무가 없습니다.

플러그인 형태의 코드는 해석의 여지가 있을 수 있어서, 저작권자로서 아래 추가 허가(AGPL 7조)를
명시합니다. 이 허가는 `server/`, `web/`, `trainer/` 등 AGPL이 적용되는 모든 코드에 함께 적용됩니다.

```
Additional permission under GNU AGPL version 3 section 7

As a special exception, the copyright holders of boardmadang give you
permission to write, run, upload and distribute game modules that interact
with boardmadang only through the game API defined in the sdk/ directory,
under terms of your choice. Such game modules are not considered works
based on boardmadang, and running them on a boardmadang server does not
make them subject to the GNU AGPL.
```

풀이: `sdk/`의 게임 API로만 플랫폼과 소통하는 게임은 보드마당의 파생물로 보지 않습니다.
이런 게임은 원하는 라이선스로 만들고, 올리고, 배포할 수 있으며, 보드마당 서버에서 실행돼도
AGPL이 적용되지 않습니다.

> 이 문구는 정식 서비스를 열기 전에 법률 전문가의 검토를 받을 예정입니다.

## 저장소에 기여하면

저장소에 보내는 코드와 문서는 [기여자 라이선스 동의서(CLA)](CLA.md)를 따릅니다. 저작권은 기여자에게 남고,
관리자는 기여물을 이 표의 라이선스로 공개하는 것 말고도 다른 조건(상용 라이선스 포함)으로 배포할 수 있습니다.
보드마당 서비스에 게임을 올리는 것은 기여가 아니므로 CLA와 관계없습니다.

## 알아두세요: 게임 코드는 브라우저에서 보입니다

게임은 플레이어의 브라우저에서 실행되므로, 어떤 라이선스를 고르든 게임을 하는 사람은
개발자 도구로 코드를 읽을 수 있습니다. 모든 웹 프론트엔드가 마찬가지입니다.
저작권으로 법적 보호는 받지만, 기술적으로 숨겨지지는 않습니다.

## 서비스 약관 (예정)

플랫폼이 게임을 실행하고 AI를 학습·배포하려면 제작자의 허락이 필요합니다. 약관은 이 원칙으로 씁니다.

- 게임의 저작권은 제작자에게 그대로 남습니다.
- 플랫폼은 서비스 운영(대전, 기보, 화면 표시)과 AI 학습·제공에 필요한 범위에서만
  **독점적이지 않은 사용 권한**을 받습니다.
- 제작자가 게임을 내리면 새로운 사용(대전, 학습)도 멈춥니다.
