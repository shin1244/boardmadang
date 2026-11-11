# boardmadang

[boardmadang.com](https://boardmadang.com)에 올릴 1대1 보드게임을 만드는 도구입니다.
**규칙만** 쓰면 됩니다. 보드 그리기, 온라인 대전, 그리고 나중에 AI 상대까지 보드마당이 맡습니다.

[English](https://github.com/shin1244/boardmadang/blob/main/sdk/README.md)

## 바로 시작하기

[Node.js](https://nodejs.org) 18 이상이 필요합니다.

```bash
npx boardmadang new my-game
cd my-game
npx boardmadang dev
```

나오는 주소를 브라우저로 엽니다. 두 플레이어의 판이 나란히 보여서 혼자 양쪽을 둬볼 수 있습니다.
처음 만든 게임은 틱택토입니다. `index.js`의 규칙을 고치고 새로고침하세요.

## 명령

| 명령 | 하는 일 |
|---|---|
| `npx boardmadang new <폴더>` | 틱택토에서 시작하는 새 게임을 만듭니다. 폴더 이름이 게임 id가 됩니다. |
| `npx boardmadang dev` | 플레이그라운드를 엽니다. 혼자 양쪽을 두고 [썸네일](#썸네일)을 찍습니다. |
| `npx boardmadang check` | 사이트에 올릴 때와 같은 검사를 합니다. |
| `npx boardmadang pack` | 검사를 통과하면 올릴 `<id>.zip`을 만듭니다. |

zip은 boardmadang.com의 **게임 등록** 화면(<https://boardmadang.com/web/register.html>)에서 올립니다.
로그인이 필요합니다. 화면이 브라우저에서 같은 검사를 한 번 더 하고, 혼자 양쪽을 둬서 한 판을 이기면(클리어 체크) 등록 정보를 넣어 등록합니다.
이긴 판은 제작자 클리어 기보로 남고, 코드를 고쳐 다시 올리면 다시 깨야 합니다. 썸네일도 이 화면에서 찍을 수 있습니다.

## 게임 폴더

```
my-game/
├─ index.js        게임 (필수)
├─ *.js, *.mjs     index.js가 불러오는 다른 파일 (선택)
├─ listing.json    이름, 소개, 룰북, 난이도, 언어, 타이머 (선택)
├─ thumbnail.json  게임 목록에 보일 그림 (선택, 플레이그라운드에서 찍음)
└─ package.json    index.js가 모듈이라고 Node에 알려 줌 (new가 만듦)
```

## 게임은 이렇게 생겼습니다

게임은 객체 하나입니다. 틱택토로 보면 이렇습니다.

```js
export default {
  id: 'my-game',
  board: { places: 'cells', rows: 3, cols: 3 }, // 3×3 판, 칸 안에 놓음
  pieces: 'xo',                                  // 기본 제공 X, O
  maxActions: 9,                                 // 이 수 안에 반드시 끝나야 함

  // 시작 상태
  setup(rng) {
    return { board: Array(9).fill(null), turn: 0 };
  },

  // 플레이어가 칸을 눌렀습니다. 새 상태를 돌려줍니다.
  // 둘 수 없는 수(내 차례가 아님, 이미 찬 칸)면 받은 상태를 그대로 돌려줍니다.
  play(state, player, action) {
    const i = action.row * 3 + action.col;
    if (player !== state.turn || state.board[i] !== null) return state;
    const board = state.board.slice(); // 복사해서 고칩니다. 받은 상태는 건드리지 않습니다
    board[i] = player;
    return { board, turn: 1 - player };
  },

  // 누구 차례인가요? 0 또는 1. 끝났으면 null (대국 시계가 멈춥니다).
  turn(state) {
    return state.turn; // (끝났으면 여기서 null을 돌려줍니다)
  },

  // 끝났나요? { winner: 0 또는 1 }, 무승부는 { winner: null }. 아직이면 null.
  result(state, lang) {
    return null; // (여기서 세 줄이 됐는지 봅니다)
  },

  // 이 플레이어 화면에 그릴 것
  view(state, player, lang) {
    const pieces = [];
    state.board.forEach((p, i) => {
      if (p !== null) pieces.push({ row: Math.floor(i / 3), col: i % 3, piece: p === 0 ? 'x' : 'o' });
    });
    return { pieces, message: state.turn === player ? '당신 차례' : '상대 차례' };
  },
};
```

이게 전부입니다. 누가 칸을 누르면 보드마당이 그 클릭을 `{ kind: 'click', row, col }`로 바꿔 `play()`를 부릅니다.
두 플레이어의 브라우저가 같은 클릭을 같은 순서로 `play()`에 넣으므로, 둘은 늘 같은 판을 봅니다.
게임 코드는 네트워크, 화면, 상대가 누구인지를 전혀 신경 쓰지 않아도 됩니다.
사이트에서는 게임 코드를 샌드박스에 가둬서 돌리므로 `fetch`, 저장소, `eval`, `Worker`는 쓸 수 없습니다.

## 꼭 지킬 네 가지

1. **같은 입력이면 같은 결과.** `Math.random()`, `Date.now()`를 쓰지 마세요.
   무작위가 필요하면 `setup(rng)`로 받은 `rng`를 씁니다 (`rng.next()`, `rng.int(n)`).
   어기면 두 플레이어의 판이 서로 달라집니다.
2. **받은 상태를 고치지 마세요.** 복사해서 새 상태를 돌려줍니다.
3. **상태는 평범한 JSON으로.** 숫자, 글자, 참/거짓, 배열, 평범한 객체만 씁니다.
   `Set`, `Map`, 클래스, 함수는 넣지 마세요.
4. **둘 수 없는 수는 무시합니다.** 받은 상태를 그대로 돌려주면 됩니다. 누구 차례인지는 게임이 정하고,
   `play()`는 `turn()`이 말한 플레이어의 수만 받아들입니다.

`npx boardmadang check`가 네 가지를 모두 잡아 주고, 랜덤 대국 200판으로 속도와 크기 제한도 봅니다.

## 있으면 좋은 것

| 추가할 것 | 언제 |
|---|---|
| `legal(state, player)` | 지금 둘 수 있는 수 목록. 마우스를 올렸을 때 표시가 나오고, AI 학습에 도움이 됩니다. |
| `observe(state, player)` | 판에 안 보이는 정보 (체스의 캐슬링 권리 같은 것). AI가 씁니다. |
| `specialActions: ['pass']` | 판 밖의 행동 (8개까지). 보드마당이 판 아래 버튼으로 보여주고 `{ kind: 'pass' }`를 보냅니다. 버튼 글자는 [아래](#판-밖-패널-버튼-움직임)처럼 정할 수 있습니다. |

기권은 사이트에 이미 있어서 게임이 처리하지 않습니다.

## 그리기 (`view`)

보여줄 것을 돌려주면 그리는 건 보드마당이 합니다.

```js
view(state, player, lang) {
  return {
    pieces:  [{ row: 1, col: 1, piece: 'x' }],
    marks:   [{ row: 1, col: 1, type: 'last-move' }],
    tint:    [{ row: 0, col: 0, color: 0 }],  // 플레이어 0의 색으로 칸 칠하기
    text:    [{ row: 2, col: 2, text: '4' }], // 칸 위 짧은 글자
    lines:   [{ from: { row: 0, col: 0 }, to: { row: 2, col: 2 }, color: 1 }], // 두 칸을 잇는 선
    message: '당신 차례',
  };
}
```

| 표시 | 뜻 |
|---|---|
| `dot` | 둘 수 있는 곳 |
| `ring` | 고른 기물 |
| `last-move` | 마지막 수 |
| `danger` | 위험 (체크 같은 것) |
| `ghost` | 반투명 기물 (`piece` 필요), 미리보기 |
| `blocked` | 쓸 수 없는 칸 (어둡게) |
| `frame` | 색 테두리 (`color` 필요), 목표 칸 같은 것. `width`로 두께를 칸 한 변의 1~30%로 정합니다 (기본 9%) |

**색:** `color`에는 플레이어 색(`0`, `1`), 판 팔레트의 이름 붙은 색(`'green'`, `'yellow'`, `'gray'`), 또는 `'#rrggbb'`를 씁니다.
판 바탕(`look`의 `plain`, `checker`, `wood`), 플레이어 색, 표시 색, 체스 기물과 돌은 보드마당이 한 팔레트로 그려서 어느 게임이든 판이 한 계열로 보입니다.
`'#rrggbb'`는 판 색과 어울리지 않을 수 있으니, 되도록 플레이어 색이나 이름 붙은 색을 쓰세요.

**선 (`lines`):** 두 칸의 가운데를 잇는 반투명한 선을 말 위에 그립니다. `color`(기본 진한 회색), `width`(칸 한 변의 1~50%, 기본 20%)를 정할 수 있습니다.
`hover: { row, col }`을 붙이면 마우스를 그 칸에 올렸을 때만 보입니다. 돌을 두기 전에 "여기 두면 이 돌들과 이어진다"를 미리 보여 줄 때 씁니다.
`legal()`이 있으면 둘 수 있는 칸에만 마우스가 올라간 것으로 칩니다. 선은 AI 관측에 들어가지 않고, `hover`가 있는 선은 썸네일에도 들어가지 않습니다.

**칠하기 미리보기:** `tint`에도 `hover: { row, col }`을 붙일 수 있습니다. 마우스를 그 칸에 올렸을 때만, 그 칸의 원래 칠하기 대신 연하게 그립니다.
"여기로 가면 이 칸들이 내 색이 된다"를 보여 줄 때 씁니다. `hover`가 있는 칠하기는 AI 관측과 썸네일에 들어가지 않습니다.

**휴대폰에서:** 손가락에는 마우스 올리기가 없어서, 판을 누른 채로 밀면 손가락 아래 칸의 미리보기(`hover`가 있는 선과 칠하기)가 보이고 손을 뗀 칸에 둡니다.
톡 치면 지금처럼 바로 둡니다. 미리보기가 없는 말을 누르면 누르는 순간 그 칸을 클릭하므로, 기물을 골라 그대로 끌어서 갈 칸에 놓을 수도 있습니다 (리체스처럼).

**판 설정:** `places`는 `'cells'`(칸 안, 체스처럼) 또는 `'points'`(줄이 만나는 곳, 바둑처럼)입니다.
`rows`, `cols`는 놓을 수 있는 자리 수입니다 (32까지). `look`(`'plain'`, `'checker'`, `'wood'`), `starPoints`(화점),
`labels`(가장자리 좌표), `flipForPlayer`(한 플레이어 화면을 뒤집어 보여줌, 체스의 흑처럼)도 있습니다.

**기물:** 기본 세트(`'xo'`, `'go-stones'`, `'chess'`)를 쓰거나 `['red', 'blue']`처럼 이름을 직접 정합니다.
직접 정한 이름은 목록 순서대로 색이 정해지는 원에 이름 앞 두 글자로 그립니다.

장기 · 쇼기 말처럼 그리고 싶으면 이름 대신 **글자 패**를 넣습니다. 네모난 패에 글자를 쓰고, 갈 수 있는 방향을 가장자리의 작은 삼각형으로 보여 줍니다.

```js
pieces: [
  { name: 'wK', text: '王', player: 0, arrows: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] },
  { name: 'wP', text: '子', player: 0, arrows: ['n'] },
  { name: 'bK', text: '王', player: 1, arrows: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] },
  // …
],
```

- `name`: `view()`의 `piece`에 쓰는 이름입니다. AI 관측도 이 이름으로 나뉩니다.
- `text`: 패에 쓸 글자, 1~2자.
- `player`(선택): 패의 주인. 그 플레이어 색으로 칠하고, 주인 쪽을 보고 서게 그립니다. 화면 아래쪽 플레이어의 패는 바로, 위쪽 플레이어의 패는 거꾸로 섭니다 (`flipForPlayer`로 뒤집은 화면에서도 그렇습니다).
- `arrows`(선택): 방향 표시. `'n'`이 주인이 볼 때 앞이고 `'ne'`, `'e'`, `'se'`, `'s'`, `'sw'`, `'w'`, `'nw'`로 시계 방향입니다.

이름과 글자 패를 한 목록에 섞어 써도 됩니다. 글자 패가 있는 칸의 `text`는 패 글자를 가리지 않게 칸 귀퉁이에 작게 씁니다 (손에 든 기물 수 같은 것).

## 판 밖 패널, 버튼, 움직임

기물 고르기 칸, 손에 든 기물, 다음 조각 미리보기처럼 판이 아닌 것을 판 칸에 섞어 두지 않아도 됩니다.
아래 넷은 모두 골라 쓰는 것이고, 안 쓰면 예전과 똑같이 그립니다.

```js
board: {
  places: 'cells', rows: 13, cols: 12,
  // 오른쪽 4칸을 판에서 떼어, 판 오른쪽에 따로 떨어진 패널 두 개로 그립니다
  areas: [
    { side: 'right', row: 0, col: 8, rows: 4, cols: 4 }, // 고른 조각 미리보기
    { side: 'right', row: 5, col: 8, rows: 2, cols: 4 }, // 고를 수 있는 조각
  ],
},
specialActions: ['rotate'],

view(state, player, lang) {
  return {
    pieces: [
      // from: 방금 0줄에서 떨어졌다 → 떨어지는 모습으로 보여 줍니다
      { row: 12, col: 3, piece: 'black', from: { row: 0, col: 3 } },
      { row: 5, col: 8, piece: 'black' },                              // 패널 칸도 보통 칸처럼
    ],
    // 판 끝(6, 7열)을 눌러도 조각이 들어맞는 5열을 누른 것으로
    aliases: [{ from: { row: 0, col: 6 }, to: { row: 0, col: 5 } }, { from: { row: 0, col: 7 }, to: { row: 0, col: 5 } }],
    // 판 아래 버튼의 글자와 순서
    buttons: [{ kind: 'rotate', label: lang === 'ko' ? '↻ 돌리기' : '↻ Rotate' }],
  };
},
```

**판 밖 영역 (`board.areas`):** 판 전체 칸 가운데 직사각형을 골라 판의 위(`top`), 아래(`bottom`), 왼쪽(`left`), 오른쪽(`right`)에
따로 떨어진 패널로 그립니다 (8개까지). 좌표는 그대로라서 `view()`, 클릭, `legal()`, AI는 영역이 없을 때와 똑같이 판 전체 좌표를 씁니다.
판은 영역을 뺀 가운데 직사각형이고, 판에도 영역에도 들지 않는 칸(위 예에서 4줄과 7~12줄의 오른쪽 4칸)은 그리지 않으며 누를 수도 없습니다.
영역끼리 겹치거나 판을 가운데 남기지 않으면 `check`가 알려 주고, 그때는 영역 없이 판 전체를 그립니다.
`flipForPlayer`로 뒤집은 화면에서는 영역도 반대쪽에 보입니다. 좌표 글자(`labels`)와 기본 화점, 로비와 게임 페이지에 보이는 판 크기(위 예에서 13×8)는 판만 셉니다.

**버튼 (`view().buttons`):** `specialActions`의 버튼을 어떤 순서로, 어떤 글자로 보일지 정합니다. 글자는 `lang`으로 씁니다.
적은 버튼만 보이므로 지금 쓸 수 없는 버튼은 빼도 되고, `legal()`이 있으면 `legal()`에 없는 버튼은 흐리게 보이고 눌리지 않습니다.
`buttons`를 주지 않으면 예전처럼 `specialActions` 전부가 이름 그대로 보입니다.

**클릭 옮기기 (`view().aliases`):** 마우스나 손가락이 `from` 칸에 있으면 `to` 칸에 있는 것으로 칩니다. 클릭도 `hover` 미리보기도 `to` 칸입니다.
"조각의 왼쪽 끝을 누른 열에 놓는다" 같은 게임에서 오른쪽으로 넘치는 끝 칸을 눌러도 들어맞는 자리에 놓게 할 때 씁니다.
`legal()`에는 `to` 칸만 넣으면 되어서 AI가 보는 행동이 겹치지 않습니다.

**움직임 (`pieces[].from`):** 기물에 `from`을 붙이면 "방금 그 칸에서 왔다"는 뜻입니다. 보드마당이 그 화면을 처음 그릴 때 `from`에서 제자리로 움직여 보여 줍니다.
화면에서 곧게 아래로 내려오면 떨어지듯 점점 빠르게, 그 밖은 미끄러지듯 움직입니다. 움직임은 기물마다 따로 봅니다. 같은 움직임은 한 번만 보이므로 다음 수까지 같은 `from`을 계속 줘도 되고, 그 사이에 다른 기물(손에 든 조각 같은 것)에 새 `from`을 붙이면 그 기물만 움직입니다.
보는 사람이 움직임 줄이기를 켜 두었거나 다시보기에서 여러 수를 건너뛸 때는 움직이지 않고 바로 그립니다.

`areas`는 썸네일에 남고, `from`, `aliases`, `buttons`는 AI 관측과 썸네일에 들어가지 않습니다.

## 썸네일

이미지는 올리지 않습니다. 게임 목록의 그림은 **실제 판을 찍은 것**입니다.
플레이그라운드에서 원하는 장면까지 둔 뒤 판 아래 **Use as thumbnail** 버튼을 누르면, 그 판이 `thumbnail.json`에 저장됩니다.
사이트는 이걸 게임과 같은 보드 렌더러로 그립니다.

- 썸네일이 없으면 시작 판을 보여줍니다.
- 나중에 코드에서 `board`나 `pieces`를 바꾸면 다시 찍으세요. `check`가 알려 줍니다.
- 사이트의 게임 등록 화면에서도 직접 깨기를 하면서 같은 방법으로 찍을 수 있습니다.

## listing.json: 사이트에 보일 글

`listing.json`에는 플레이어가 읽는 것이 들어갑니다. 이름, 한 줄 소개, 룰북, 난이도(`easy`, `normal`, `hard`),
언어, 타이머입니다. 등록할 때 사이트에서 써도 됩니다.

```json
{
  "languages": { "ko": "full", "en": "full" },
  "difficulty": "easy",
  "timer": { "minutes": 10, "custom": true },
  "name": { "ko": "틱택토", "en": "Tic-tac-toe" },
  "description": { "ko": "한 줄을 먼저 채우면 이깁니다.", "en": "Fill a line first to win." },
  "rulebook": { "ko": "두 사람이 번갈아…", "en": "Two players take turns…" }
}
```

- **언어:** `full`(완전 번역)은 게임 안 글자(`view`의 `message`, `result`의 `reason`)까지 그 언어로 나옵니다.
  `rulebook`(일부 번역)은 이름, 소개, 룰북만입니다. 보드마당은 `full`로 고른 언어 중 하나를 `lang`으로 넘기므로,
  게임 안 글자는 언어별 작은 표로 두면 편합니다.
- **타이머:** 체스 시계처럼 각자 쓸 수 있는 총 시간(분)입니다 (1~180, 없으면 `null`).
  `custom: true`면 방장이 시간을 정할 수 있습니다.

## 제한

| | 최대 |
|---|---|
| 판 크기 (`rows`, `cols`) | 32 |
| 기물 종류 | 32 |
| `maxActions` | 2,000 |
| 게임 코드 | 256 KB |
| 상태 (JSON) | 64 KB |
| `play()` 한 번 | 평균 2 ms, 최대 50 ms |

큰 게임도 사람끼리 대전은 똑같이 됩니다. AI는 정해진 학습 예산만 받아서, 큰 게임일수록 약하게 나올 뿐입니다.

## 편집기 자동 완성

게임 위에 타입 주석을 달면 VS Code 같은 편집기에서 자동 완성이 됩니다.
타입을 찾으려면 게임 폴더에 `npm i -D boardmadang`으로 패키지를 설치하세요.

```js
/** @type {import('boardmadang').Game<State>} */
export default { /* … */ };
```

전체 타입은 [game.d.ts](https://github.com/shin1244/boardmadang/blob/main/sdk/game.d.ts)에 있습니다.

## 자주 묻는 질문

**내 게임은 누구 것인가요?** 만든 사람의 것입니다. 이 SDK는 MIT이고, 게임은 보드마당 서버처럼 AGPL이 되지 않습니다.
→ [LICENSING.md](https://github.com/shin1244/boardmadang/blob/main/LICENSING.md)

**코드를 숨길 수 있나요?** 저작권으로 보호받지만, 게임은 플레이어의 브라우저에서 돌아가므로
브라우저 개발자 도구로 누구나 코드를 볼 수 있습니다. 모든 웹사이트가 마찬가지입니다.

**서버를 알아야 하나요?** 아니요. 게임은 규칙뿐입니다. 매칭, 시계, 끊겼다 다시 붙기, 다시보기, 관전은
모두 보드마당이 합니다.
