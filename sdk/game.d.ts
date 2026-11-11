// 보드마당 게임 API 타입 정의.
// 게임은 JS로 만들어도 됩니다. JS 파일 위에 아래처럼 적으면 편집기 자동완성을 받을 수 있습니다.
//   /** @type {import('boardmadang').Game<State>} */          npm 패키지 (npm i -D boardmadang)
//   /** @type {import('../../sdk/game').Game<State>} */       이 레포의 games/ 안에서

/** 0 = 선공, 1 = 후공 */
export type Player = 0 | 1;

/** 보드 위의 자리. 항상 0부터 시작하며, 보드 모드와 상관없이 0 ~ rows-1, 0 ~ cols-1 입니다. */
export interface Cell {
  row: number;
  col: number;
}

/** 플레이어의 행동 하나. 클릭이거나, 게임이 specialActions로 선언한 행동(예: 'pass')입니다. */
export type Action =
  | { kind: 'click'; row: number; col: number }
  | { kind: string };

export interface BoardConfig {
  /** 'cells' = 칸 안에 놓기 (체스), 'points' = 교차점에 놓기 (바둑), 'both' = 둘 다 */
  places: 'cells' | 'points' | 'both';
  /** 놓을 수 있는 자리의 줄 수. 교차점 모드라도 "선의 개수"를 적습니다 (바둑 19줄 → 19). */
  rows: number;
  cols: number;
  look?: 'plain' | 'checker' | 'wood';
  /** 화점. true면 보드 크기에 맞는 기본 위치, 배열이면 그 자리들 */
  starPoints?: boolean | Cell[];
  /** 가장자리 좌표 표시 (a~h, 1~8) */
  labels?: boolean;
  /** 이 플레이어의 화면은 180도 뒤집어서 보여줍니다 (체스의 흑) */
  flipForPlayer?: Player;
  /**
   * 판 밖 영역 (8개까지). 판 전체 칸 가운데 이 직사각형들을 판에서 떼어 판의 위 · 아래 · 옆에 따로 떨어진 패널로 그립니다.
   * 기물 고르기 패널, 손에 든 기물, 지금 고른 조각의 미리보기 같은 것을 판 밖에 둘 때 씁니다.
   * 좌표는 그대로라서 view(), 클릭, legal(), AI는 영역이 없을 때와 똑같이 rows × cols 좌표를 씁니다.
   * 판은 영역을 뺀 가운데 직사각형입니다 (top 영역들의 아래, bottom 영역들의 위, left · right 영역들의 사이).
   * 판에도 영역에도 들지 않는 칸은 그리지 않고 누를 수도 없습니다. 좌표 글자(labels)와 기본 화점은 판만 셉니다.
   */
  areas?: Area[];
}

/** 판 밖 영역 하나. row, col은 왼쪽 위 칸, rows, cols는 크기입니다 (판 전체 좌표) */
export interface Area {
  /** 판의 어느 쪽에 붙일지. flipForPlayer로 뒤집힌 화면에서는 반대쪽에 보입니다 */
  side: 'top' | 'bottom' | 'left' | 'right';
  row: number;
  col: number;
  rows: number;
  cols: number;
}

/**
 * 판 아래에 보일 특수 행동 버튼 하나. kind는 specialActions 가운데 하나입니다.
 * view().buttons를 주면 거기 적은 버튼만 그 순서와 글자로 보이고, legal()이 있으면 legal()에 없는 버튼은 흐리게 눌리지 않습니다.
 * 주지 않으면 예전처럼 specialActions 전부가 이름 그대로 보입니다.
 */
export interface Button {
  kind: string;
  /** 버튼 글자 (40자까지). lang으로 씁니다. 없으면 kind */
  label?: string;
}

/** 클릭 옮기기: from 칸을 누르면(마우스를 올리면) to 칸을 누른(올린) 것으로 칩니다 */
export interface Alias {
  from: Cell;
  to: Cell;
}

/**
 * 칸 위에 덧그리는 표시.
 * - dot: 둘 수 있는 곳        - ring: 선택한 기물
 * - last-move: 마지막 수      - danger: 위험 (체크 등)
 * - ghost: 반투명 기물 (piece 필요)
 * - blocked: 아직/영원히 쓸 수 없는 칸 (어둡게)
 * - frame: 칸 테두리 (color 필요) — 목표 칸, 진영 같은 "특별한 칸" 표시
 */
export type MarkType = 'dot' | 'ring' | 'last-move' | 'danger' | 'ghost' | 'blocked' | 'frame';

/**
 * 판 팔레트의 이름 붙은 색. 실제 색은 플랫폼이 정해서 어느 게임이든 판이 한 계열로 보입니다.
 * '#rrggbb'도 쓸 수 있지만, 판 색과 어울리게 하려면 이 이름이나 플레이어 색(0, 1)을 쓰세요.
 */
export type ColorName = 'green' | 'yellow' | 'gray';

export interface Mark extends Cell {
  type: MarkType;
  /** ghost에 그릴 기물 */
  piece?: string;
  /** frame의 색. 0 / 1이면 플레이어 색, 'green' · 'yellow' · 'gray'면 판 팔레트의 색, 아니면 '#rrggbb' */
  color?: Player | ColorName | string;
  /** frame의 두께. 칸 한 변에 대한 % (1~30). 없으면 9% */
  width?: number;
}

/**
 * 두 칸의 가운데를 잇는 반투명한 선. 말 위에 그립니다.
 * hover가 있으면 마우스를 그 칸에 올렸을 때만 보입니다 (돌을 두기 전의 미리보기 같은 것).
 * legal()이 있으면 둘 수 있는 칸에만 마우스가 올라간 것으로 칩니다.
 * 선은 AI 관측에 들어가지 않고, hover가 있는 선은 썸네일에도 들어가지 않습니다.
 */
export interface Line {
  from: Cell;
  to: Cell;
  /** 0 / 1이면 플레이어 색, 'green' · 'yellow' · 'gray'면 판 팔레트의 색, 아니면 '#rrggbb'. 없으면 진한 회색 */
  color?: Player | ColorName | string;
  /** 두께. 칸 한 변에 대한 % (1~50). 없으면 20% */
  width?: number;
  /** 이 칸에 마우스를 올렸을 때만 그립니다 */
  hover?: Cell;
}

/** 화면에 보일 것. 그리는 건 플랫폼이 합니다. */
export interface View {
  /**
   * 기물. from이 있으면 "방금 그 칸에서 왔다"는 뜻이라, 플랫폼이 새 화면을 처음 그릴 때 from에서 제자리로 움직여 보여 줍니다.
   * 화면에서 곧게 아래로 내려오면 떨어지듯 점점 빠르게, 그 밖은 미끄러지듯 움직입니다. 판 밖 영역에서 판으로 와도 됩니다.
   * 움직임은 기물마다 따로 봅니다. 같은 움직임은 한 번만 보이므로 다음 수까지 같은 from을 계속 줘도 되고 (기물 고르기 같은 행동 뒤에 다시 움직이지 않음),
   * 그 사이에 다른 기물에 새 from을 붙이면 그 기물만 움직입니다.
   * from은 AI 관측과 썸네일에 들어가지 않습니다.
   */
  pieces: Array<Cell & { piece: string; from?: Cell }>;
  marks?: Mark[];
  /**
   * 칸 칠하기. 0 / 1이면 플레이어 색, 'green' · 'yellow' · 'gray'면 판 팔레트의 색, 아니면 '#rrggbb'.
   * hover가 있으면 마우스를 그 칸에 올렸을 때만, 그 칸의 원래 칠하기 대신 연하게 그립니다 (두면 칠해질 칸의 미리보기).
   * legal()이 있으면 둘 수 있는 칸에만 마우스가 올라간 것으로 칩니다. hover가 있는 칠하기는 AI 관측과 썸네일에 들어가지 않습니다.
   */
  tint?: Array<Cell & { color: Player | ColorName | string; hover?: Cell }>;
  /** 칸 위의 숫자나 짧은 글자 (만칼라의 씨앗 수 등) */
  text?: Array<Cell & { text: string }>;
  /** 두 칸을 잇는 선 */
  lines?: Line[];
  /**
   * 클릭 옮기기. 마우스나 손가락이 from 칸에 있으면 to 칸에 있는 것으로 쳐서, 호버(미리보기)도 클릭도 to 칸입니다.
   * 조각이 판 밖으로 넘치는 끝 칸을 눌러도 들어맞는 자리에 놓게 하거나, 열 아무 데나 눌러 그 열에 두게 할 때 씁니다.
   * legal()에는 to 칸만 넣으면 되므로 AI가 보는 행동이 겹치지 않습니다. AI 관측과 썸네일에 들어가지 않습니다.
   */
  aliases?: Alias[];
  /** 판 아래 특수 행동 버튼의 순서와 글자 (8개까지). 없으면 specialActions 전부를 이름 그대로 보여 줍니다 */
  buttons?: Button[];
  /**
   * 한 번 보이고 끝나는 효과. 잡혀서 없어진 기물처럼 이 화면에는 없는 기물을 그 칸에 그려 놓고 효과를 보여 줍니다.
   * 같은 효과는 한 번만 보이므로 다음 수까지 같은 effects를 계속 줘도 됩니다.
   * AI 관측과 썸네일에 들어가지 않습니다.
   */
  effects?: Effect[];
  /** 보드 위 안내 문구 */
  message?: string;
}

/**
 * 효과 하나. 칸, 기물, 종류, id가 모두 같으면 같은 효과라 다시 보이지 않습니다.
 * 같은 칸에서 같은 기물이 연달아 사라질 수 있으면 id(사라진 기물의 번호 같은 것)를 붙여 구별합니다.
 */
export interface Effect extends Cell {
  /** 사라지는 기물 */
  piece: string;
  /** 'shatter': 금이 가고 조각으로 갈라져 튀며 흐려집니다. 없으면 'shatter' */
  type?: 'shatter';
  /** 같은 칸 · 기물의 효과를 구별하는 값 (32자까지의 글자나 정수) */
  id?: string | number;
}

/** winner가 null이면 무승부입니다. */
export interface Result {
  winner: Player | null;
  reason?: string;
}

/** 플랫폼이 시드로 만들어 주는 결정적 난수. Math.random() 대신 이것만 씁니다. */
export interface Rng {
  /** 0 이상 1 미만 */
  next(): number;
  /** 0 이상 n 미만의 정수 */
  int(n: number): number;
}

/** 플랫폼이 지원하는 언어 (많이 쓰는 언어 10개) */
export type Lang = 'ko' | 'en' | 'ja' | 'zh' | 'es' | 'fr' | 'de' | 'pt' | 'ru' | 'ar';

/** 언어별 글자 */
export type Localized = Partial<Record<Lang, string>>;

/** 하, 중, 상 */
export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * 언어별 지원 수준.
 * - full: 완전 번역. 소개, 룰북, 게임 안 글자(view의 message, result의 reason)까지 그 언어로 나옵니다.
 *   게임 안 글자는 제작자가 직접 번역합니다.
 * - rulebook: 일부 번역. 소개와 룰북만 그 언어로 쓰고, 게임 안 글자는 완전 번역 언어로 나옵니다.
 */
export type Support = 'full' | 'rulebook';

/**
 * 타이머. 각 플레이어가 자기 차례에 쓸 수 있는 총 시간입니다 (체스 시계). 다 쓰면 집니다.
 */
export interface Timer {
  /** 기본 타이머 (분, 1~180). null이면 타이머 없음. 빠른 매칭은 이 시간으로 합니다. */
  minutes: number | null;
  /** true면 방 만들기에서 방장이 시간을 정할 수 있습니다 (분 단위, 타이머 없음도 가능). */
  custom: boolean;
}

/**
 * 등록 정보. 게임 코드에 넣지 않고 등록창에서 입력합니다 (개발 서버는 games/<id>/listing.json).
 * 코드를 다시 올리지 않아도 소개, 룰북, 번역을 고칠 수 있습니다.
 */
export interface Listing {
  /** 지원하는 언어와 수준. 완전 번역 언어가 하나 이상 있어야 합니다. */
  languages: Partial<Record<Lang, Support>>;
  difficulty: Difficulty;
  timer: Timer;
  /** 아래 셋은 지원하는 언어마다 씁니다. */
  name: Localized;
  /** 게임 목록에 보일 한두 줄 소개 */
  description: Localized;
  /** 규칙 설명. 빈 줄로 문단을 나눕니다. */
  rulebook: Localized;
}

/**
 * 썸네일 (thumbnail.json). 게임 목록에 보일 판입니다. 이미지가 아니라 플레이그라운드에서 혼자 두던 판을
 * "Use as thumbnail"로 그대로 찍은 데이터이고, 사이트가 보드 렌더러로 다시 그립니다.
 * 판 설정과 기물 세트까지 들어 있어서 게임 코드 없이 그릴 수 있습니다. 없으면 시작 판을 보여줍니다.
 * 코드에서 board나 pieces를 바꾸면 다시 찍어야 합니다 (npx boardmadang check가 알려줍니다).
 */
export interface Thumbnail {
  board: BoardConfig;
  pieces: Game<unknown>['pieces'];
  /** 찍은 플레이어 화면 (flipForPlayer면 뒤집어 그립니다) */
  player: Player;
  /** 그 순간의 view(). 언어마다 다른 message는 넣지 않습니다. */
  view: Omit<View, 'message'>;
}

/** 글자 패의 방향. n이 패 주인이 볼 때 앞이고 시계 방향으로 돕니다 */
export type TileArrow = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** 글자 패: 장기 · 쇼기 말처럼 네모난 패에 글자를 쓰고, 갈 수 있는 방향을 작은 삼각형으로 보여 줍니다 */
export interface TilePiece {
  /** view()의 piece에 쓰는 이름 (32자까지) */
  name: string;
  /** 패에 쓸 글자, 1~2자 */
  text: string;
  /** 주인. 그 플레이어 색으로 칠하고 주인 쪽을 보고 서게 그립니다 (화면 아래쪽 플레이어의 패는 바로, 위쪽은 거꾸로) */
  player?: 0 | 1;
  /** 갈 수 있는 방향 표시 (겹치지 않게) */
  arrows?: TileArrow[];
}

export interface Game<S> {
  /** 영문 소문자 id (URL에 쓰입니다) */
  id: string;
  board: BoardConfig;
  /**
   * 내장 기물 세트 이름, 또는 이 게임이 쓰는 기물 목록 (이름마다 AI 관측 채널이 됩니다).
   * 목록의 항목은 이름(원에 이름 앞 두 글자) 또는 글자 패(TilePiece)입니다.
   */
  pieces: 'chess' | 'go-stones' | 'xo' | Array<string | TilePiece>;
  /**
   * 플레이어마다 이름 옆에 보일 기물 [선공, 후공] (pieces에 있는 이름). 예: `['black', 'white']`.
   * 없으면 플레이어 색 점(빨강, 파랑)이 보입니다.
   */
  playerPieces?: [string, string];
  /** 좌표가 아닌 행동 (8개까지). 플랫폼이 버튼으로 보여줍니다. 버튼 글자와 순서는 view()의 buttons로 정합니다. 기권은 플랫폼 기능이라 넣지 않습니다. */
  specialActions?: string[];
  /**
   * 둔 수가 이 횟수에 이르면 무승부로 끝납니다. 게임이 반드시 끝나게 하는 안전장치입니다.
   * 수는 차례가 넘어간(`turn()`이 다른 값이 된) 행동입니다. 기물 고르기처럼 차례가 그대로인 행동은 세지 않습니다.
   */
  maxActions: number;

  /** 시작 상태. 상태는 JSON으로 그대로 직렬화할 수 있어야 합니다 (Set, Map, 클래스 금지). */
  setup(rng: Rng): S;

  /**
   * 행동 하나를 적용한 새 상태를 돌려줍니다. 받은 state는 고치지 않습니다.
   * 차례가 아니거나 둘 수 없는 행동이면 state를 그대로 돌려주면 됩니다 (무시).
   * 무시했는지는 플랫폼이 상태 해시로 판단하므로, 내용이 같은 새 객체를 돌려줘도 됩니다.
   */
  play(state: S, player: Player, action: Action): S;

  /**
   * 끝났으면 결과, 진행 중이면 null. reason은 lang으로 씁니다. 승자는 lang과 상관없이 같아야 합니다.
   * lang은 등록창에서 '완전 번역'으로 고른 언어 중 하나입니다. 유저 화면 언어를 완전 번역하지 않으면
   * 첫 번째 완전 번역 언어가 옵니다.
   */
  result(state: S, lang: Lang): Result | null;

  /** 이 플레이어 화면에 보일 것. message와 buttons의 label 같은 글자는 lang으로 씁니다 (result와 같은 규칙). 그 밖의 내용은 lang과 상관없이 같아야 합니다. */
  view(state: S, player: Player, lang: Lang): View;

  /**
   * 지금 누구 차례인지. 끝났거나 아무도 차례가 아니면 null.
   * 플랫폼은 이걸로 대국 시계를 돌리고, AI 학습은 탐색할 때 둘 차례를 압니다.
   * play()는 이 플레이어의 행동만 받아들여야 합니다 (검사가 랜덤 대국으로 확인합니다).
   * 선택 → 이동처럼 한 차례에 클릭이 여러 번이어도, 차례가 넘어갈 때만 바뀌면 됩니다.
   */
  turn(state: S): Player | null;

  /** (선택) 지금 둘 수 있는 행동 목록. AI 학습의 행동 마스크와 호버 표시에 쓰입니다. */
  legal?(state: S, player: Player): Action[];

  /**
   * (선택) 판에 안 보이는 상태를 AI에게 알려줄 추가 정보.
   * [채널][row][col] 형태의 숫자 배열입니다. 예: 체스의 캐슬링 권리, 바둑의 패 자리.
   */
  observe?(state: S, player: Player): number[][][];
}
