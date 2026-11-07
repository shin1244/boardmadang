// 게임 어댑터: 제작자의 게임 코드를 강화학습 환경으로 감쌉니다 (docs/architecture.md의 "AI 학습").
//
//   관측   view()의 기물 + 표시 + 칠한 칸 + 숫자, 두는 쪽, observe() → [채널][rows][cols]
//   행동   클릭 rows × cols 개 + specialActions. 번호 = row * cols + col, 특수 행동은 그 뒤
//   마스크 legal()이 있으면 그 행동 중에서, 없으면 모든 행동 중에서 실제로 상태를 바꾸는 것만
//   차례   turn()
//   보상   result()의 승 +1 / 패 −1 / 무 0. 둔 수가 maxActions에 이르면 무승부
//   수     차례가 넘어간 행동 하나. 기물 고르기처럼 차례가 그대로인 행동은 수가 아니고, 그 차례에 이미 나온
//          판으로 돌아가는 행동은 아무것도 안 한 것이라 무시된 행동으로 봅니다 (혼자 맴돌며 같은 판을 만들지 못하게)
//
// 대국 화면과 같은 규칙으로 돕니다 (sdk/check.js의 랜덤 대국과 같음).
// play()가 오류를 던지거나 상태를 그대로 두면 무시된 행동, view()가 오류면 빈 판, result()가 오류면 진행 중입니다.
// 상태가 바뀌었는지는 플랫폼과 같은 해시로 봅니다.
//
// 이 파일은 Node 전용 API를 쓰지 않습니다 (게임 불러오기는 load.js). 나중에 브라우저의 AI 대국에서도 씁니다.

import { hashOf, makeRng } from '../sdk/playground/platform.js';

/** 내장 기물 세트의 기물 이름 (sdk/playground/board.js) */
const PIECE_SETS = {
  xo: ['x', 'o'],
  'go-stones': ['black', 'white'],
  chess: ['w', 'b'].flatMap((c) => [...'KQRBNP'].map((p) => c + p)),
};

/** view()의 marks 종류 (sdk/game.d.ts의 MarkType) */
const MARK_TYPES = ['dot', 'ring', 'last-move', 'danger', 'ghost', 'blocked', 'frame'];

function attempt(f, fallback) {
  try {
    return f();
  } catch {
    return fallback;
  }
}

/**
 * 판 하나. state와 해시, 지금까지 둔 수(maxActions 무승부를 셈), 이번 차례에 나온 판의 해시들(차례가 시작된 판부터)입니다.
 * @typedef {{ state: any, hash: string, moves: number, turnHashes: string[] }} Position
 */

export class Env {
  /**
   * @param {object} game 게임 모듈의 default export
   * @param {{ lang?: string }} [opts] result()와 view()에 넘길 언어 (게임이 완전 번역한 언어)
   */
  constructor(game, { lang = 'en' } = {}) {
    for (const k of ['setup', 'play', 'result', 'view', 'turn']) {
      if (typeof game?.[k] !== 'function') throw new Error(`${k}() is missing`);
    }
    this.game = game;
    this.lang = lang;
    const { rows, cols } = game.board;
    this.rows = rows;
    this.cols = cols;
    this.specials = game.specialActions ?? [];
    this.nActions = rows * cols + this.specials.length;
    // 직접 정의한 기물은 이름 문자열이거나 글자 패 { name, ... } 입니다. 관측 채널은 이름마다 하나
    this.pieces = Array.isArray(game.pieces) ? game.pieces.map((p) => (typeof p === 'string' ? p : p?.name)) : PIECE_SETS[game.pieces];
    if (!this.pieces) throw new Error(`unknown piece set: ${game.pieces}`);
    this.maxActions = game.maxActions;

    const first = this.start(0);
    // observe()의 채널 수는 시작 판에서 정하고, 판마다 같아야 합니다
    this.observeChannels = game.observe ? this.observe(first).length : 0;
    // 기물 + 표시 종류 + 칠한 칸(0, 1, 그 밖의 색) + 숫자 + 두는 쪽 + observe()
    this.channels = this.pieces.length + MARK_TYPES.length + 3 + 1 + 1 + this.observeChannels;
  }

  /** 관측 채널 이름 (디버그와 문서용) */
  channelNames() {
    return [
      ...this.pieces.map((p) => `piece:${p}`),
      ...MARK_TYPES.map((m) => `mark:${m}`),
      'tint:0', 'tint:1', 'tint:other', 'text', 'toPlay',
      ...Array.from({ length: this.observeChannels }, (_, i) => `observe:${i}`),
    ];
  }

  /** 새 판 */
  start(seed) {
    const state = this.game.setup(makeRng(seed));
    const hash = hashOf(state);
    return { state, hash, moves: 0, turnHashes: [hash] };
  }

  /** 지금 둘 차례인 플레이어 (turn()). 아무도 아니면 null */
  toPlay(pos) {
    const t = attempt(() => this.game.turn(pos.state), null);
    return t === 0 || t === 1 ? t : null;
  }

  /**
   * 끝났으면 { winner: 0 | 1 | null }, 진행 중이면 null.
   * maxActions에 이르렀거나, 아무도 차례가 아니거나, 둘 수 있는 수가 없으면 무승부로 봅니다.
   * @param {{ action: number, pos: Position }[] | null} [moves] 이미 구한 children(pos) (없으면 둘 수 있는 수는 보지 않음)
   */
  outcome(pos, moves = null) {
    const r = attempt(() => this.game.result(pos.state, this.lang), null);
    if (r) return { winner: r.winner === 0 || r.winner === 1 ? r.winner : null };
    if (pos.moves >= this.maxActions) return { winner: null };
    if (this.toPlay(pos) === null) return { winner: null };
    if (moves && moves.length === 0) return { winner: null };
    return null;
  }

  /** 행동 번호 → 게임에 보낼 행동 */
  actionOf(i) {
    const n = this.rows * this.cols;
    if (i < n) return { kind: 'click', row: Math.floor(i / this.cols), col: i % this.cols };
    return { kind: this.specials[i - n] };
  }

  /** 게임의 행동 → 행동 번호. 행동 공간 밖이면 -1 */
  indexOf(action) {
    if (action?.kind === 'click') {
      const { row, col } = action;
      if (!Number.isInteger(row) || !Number.isInteger(col)) return -1;
      if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return -1;
      return row * this.cols + col;
    }
    const k = this.specials.indexOf(action?.kind);
    return k < 0 ? -1 : this.rows * this.cols + k;
  }

  /** player가 둬 볼 행동 번호들. legal()이 있으면 그 목록, 없으면 모든 행동 */
  candidates(pos, player) {
    if (typeof this.game.legal !== 'function') return Array.from({ length: this.nActions }, (_, i) => i);
    const listed = attempt(() => this.game.legal(pos.state, player), []);
    return [...new Set((Array.isArray(listed) ? listed : []).map((a) => this.indexOf(a)))]
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
  }

  /** player가 행동 i를 둔 판. 무시된 행동이거나 이번 차례에 이미 나온 판으로 돌아가면 null */
  apply(pos, player, i) {
    const state = attempt(() => this.game.play(pos.state, player, this.actionOf(i)), pos.state);
    const hash = hashOf(state);
    if (hash === pos.hash) return null;
    // 차례가 넘어갔거나 판이 끝났으면 한 수입니다
    if (attempt(() => this.game.turn(state), null) !== player) return { state, hash, moves: pos.moves + 1, turnHashes: [hash] };
    if (pos.turnHashes.includes(hash)) return null;
    return { state, hash, moves: pos.moves, turnHashes: [...pos.turnHashes, hash] };
  }

  /** 둘 차례인 쪽이 행동 하나를 둡니다. 무시된 행동이면 null */
  step(pos, i) {
    const player = this.toPlay(pos);
    return player === null ? null : this.apply(pos, player, i);
  }

  /**
   * 탐색이 펼칠 행동들. legal()이 있으면 그 목록을 믿고, 판은 탐색이 처음 방문할 때 둬 봅니다 (pos 없음).
   * 없으면 children()처럼 모든 행동을 둬 보고 상태를 바꾸는 것만 판과 함께 돌려줍니다.
   * @returns {{ action: number, pos?: Position }[]}
   */
  expandable(pos) {
    const player = this.toPlay(pos);
    if (player === null) return [];
    if (typeof this.game.legal === 'function') return this.candidates(pos, player).map((action) => ({ action }));
    return this.children(pos);
  }

  /** 지금 둘 수 있는 행동과 그 뒤의 판. 실제로 상태를 바꾸는 행동만 남깁니다 */
  children(pos) {
    const player = this.toPlay(pos);
    if (player === null) return [];
    const out = [];
    for (const action of this.candidates(pos, player)) {
      const next = this.apply(pos, player, action);
      if (next) out.push({ action, pos: next });
    }
    return out;
  }

  observe(pos) {
    const player = this.toPlay(pos) ?? 0;
    const o = attempt(() => this.game.observe(pos.state, player), null);
    return Array.isArray(o) ? o : [];
  }

  /**
   * 신경망 입력. 두는 쪽의 화면(view)을 채널로 펼칩니다. 기물 이름은 절대값(선공의 기물, 후공의 기물)이라
   * 누가 두는지를 따로 한 채널로 알려 줍니다.
   * @param {Float32Array} [out] 길이 channels × rows × cols. 주면 거기에 씁니다
   */
  encode(pos, out = new Float32Array(this.channels * this.rows * this.cols)) {
    const { rows, cols } = this;
    const plane = rows * cols;
    out.fill(0);
    const set = (ch, row, col, v = 1) => {
      if (Number.isInteger(row) && Number.isInteger(col) && row >= 0 && row < rows && col >= 0 && col < cols) {
        out[ch * plane + row * cols + col] = v;
      }
    };
    const player = this.toPlay(pos) ?? 0;
    const view = attempt(() => this.game.view(pos.state, player, this.lang), null) ?? {};
    let ch = 0;
    for (const p of Array.isArray(view.pieces) ? view.pieces : []) {
      const k = this.pieces.indexOf(p?.piece);
      if (k >= 0) set(ch + k, p.row, p.col);
    }
    ch += this.pieces.length;
    for (const m of Array.isArray(view.marks) ? view.marks : []) {
      const k = MARK_TYPES.indexOf(m?.type);
      if (k >= 0) set(ch + k, m.row, m.col);
    }
    ch += MARK_TYPES.length;
    for (const t of Array.isArray(view.tint) ? view.tint : []) {
      if (t?.hover !== undefined) continue; // 마우스를 올렸을 때만 보이는 미리보기는 관측에 넣지 않습니다
      set(ch + (t?.color === 0 ? 0 : t?.color === 1 ? 1 : 2), t?.row, t?.col);
    }
    ch += 3;
    for (const t of Array.isArray(view.text) ? view.text : []) {
      const n = Number(t?.text);
      set(ch, t?.row, t?.col, Number.isFinite(n) ? n : 1);
    }
    ch += 1;
    if (player === 1) out.fill(1, ch * plane, (ch + 1) * plane);
    ch += 1;
    const o = this.observeChannels ? this.observe(pos) : [];
    for (let k = 0; k < this.observeChannels; k++) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = Number(o[k]?.[r]?.[c]);
          if (Number.isFinite(v)) out[(ch + k) * plane + r * cols + c] = v;
        }
      }
    }
    return out;
  }
}

/**
 * 학습할 때만 쓰는 무승부 규칙: 차례가 시작된 판이 세 번 나오거나 maxMoves수를 두면 끝냅니다 (체스의 반복 무승부처럼).
 * 양쪽이 같은 판을 오가면 maxActions까지 가서 학습이 아주 느려지기 때문입니다. 반복은 양쪽이 함께 만들어야 하므로
 * 이기고 있는 쪽은 피할 수 있습니다 (한 차례 안에서 맴도는 것은 env.apply가 막음).
 * 판마다 하나 만들고, 둘 판을 넣으면 끝낼지 알려 줍니다.
 */
export function drawRule(maxMoves) {
  const seen = new Map();
  return (pos) => {
    if (pos.moves >= maxMoves) return true;
    // 차례가 시작된 판만 셉니다. 기물을 고른 상태처럼 차례 중간의 판은 수가 아닙니다
    if (pos.turnHashes.length > 1) return false;
    const n = (seen.get(pos.hash) ?? 0) + 1;
    seen.set(pos.hash, n);
    return n >= 3;
  };
}
