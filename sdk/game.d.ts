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

export interface Mark extends Cell {
  type: MarkType;
  /** ghost에 그릴 기물 */
  piece?: string;
  /** frame의 색. 0 / 1이면 플랫폼이 정한 플레이어 색, 문자열이면 '#rrggbb' */
  color?: Player | string;
}

/** 화면에 보일 것. 그리는 건 플랫폼이 합니다. */
export interface View {
  pieces: Array<Cell & { piece: string }>;
  marks?: Mark[];
  /** 칸 칠하기. 0 / 1이면 플랫폼이 정한 플레이어 색, 문자열이면 '#rrggbb' */
  tint?: Array<Cell & { color: Player | string }>;
  /** 칸 위의 숫자나 짧은 글자 (만칼라의 씨앗 수 등) */
  text?: Array<Cell & { text: string }>;
  /** 보드 위 안내 문구 */
  message?: string;
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
 * 타이머를 쓰려면 게임에 turn()이 있어야 합니다.
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
 * 「썸네일로」로 그대로 찍은 데이터이고, 사이트가 보드 렌더러로 다시 그립니다.
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

export interface Game<S> {
  /** 영문 소문자 id (URL에 쓰입니다) */
  id: string;
  board: BoardConfig;
  /** 내장 기물 세트 이름, 또는 이 게임이 쓰는 기물 id 목록 (AI 관측 채널이 됩니다) */
  pieces: 'chess' | 'go-stones' | 'xo' | string[];
  /** 좌표가 아닌 행동. 플랫폼이 버튼으로 보여줍니다. 기권은 플랫폼 기능이라 넣지 않습니다. */
  specialActions?: string[];
  /**
   * 상태를 바꾼 행동이 이 횟수에 이르면 무승부로 끝납니다. 게임이 반드시 끝나게 하는 안전장치입니다.
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

  /** 이 플레이어 화면에 보일 것. message 같은 글자는 lang으로 씁니다 (result와 같은 규칙). 그 밖의 내용은 lang과 상관없이 같아야 합니다. */
  view(state: S, player: Player, lang: Lang): View;

  /**
   * (선택) 지금 누구 차례인지. 끝났거나 아무도 차례가 아니면 null.
   * 플랫폼은 이걸로 대국 시계를 돌립니다. 없으면 이 게임은 타이머를 쓸 수 없습니다.
   * 선택 → 이동처럼 한 차례에 클릭이 여러 번이어도, 차례가 넘어갈 때만 바뀌면 됩니다.
   */
  turn?(state: S): Player | null;

  /** (선택) 지금 둘 수 있는 행동 목록. AI 학습의 행동 마스크와 호버 표시에 쓰입니다. */
  legal?(state: S, player: Player): Action[];

  /**
   * (선택) 판에 안 보이는 상태를 AI에게 알려줄 추가 정보.
   * [채널][row][col] 형태의 숫자 배열입니다. 예: 체스의 캐슬링 권리, 바둑의 패 자리.
   */
  observe?(state: S, player: Player): number[][][];
}
